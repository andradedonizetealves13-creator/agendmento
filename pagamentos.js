'use strict';
/**
 * Pagamento automático do sinal por Pix (Mercado Pago).
 *
 * Funções exportadas:
 *   mpConnect     (callable)  admin conecta a conta (exige senha do login digitada há poucos minutos)
 *   mpDisconnect  (callable)  admin desconecta (mesma exigência)
 *   mpCreatePix   (callable)  cliente gera a cobrança Pix do próprio agendamento pendente
 *   mpWebhook     (HTTP)      Mercado Pago avisa que o Pix foi pago
 *
 * Onde ficam os dados no Realtime Database:
 *   agendapro_saas/secrets/{slug}/mercadopago   token da empresa (NUNCA legível por navegador)
 *   agendapro_saas/payments/{paymentId}         índice interno: { slug, appId, amount }  (só servidor)
 *   agendapro_saas/providers/{slug}             sinalizador público: { type, active, last4, connectedAt }
 *
 * Não precisa instalar nada novo: usa firebase-functions (v2) e firebase-admin, que você já tem.
 * Requer Node 18 ou superior (fetch nativo) e plano Blaze.
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db = admin.database();

const BASE = 'agendapro_saas';
const REGION = 'us-central1';            // o painel e o portal chamam a região padrão (us-central1)
const MP_API = 'https://api.mercadopago.com';
const FRESH_LOGIN_SECONDS = 300;         // a senha precisa ter sido digitada há no máximo 5 minutos
const SLUG_RE = /^[^.$#\[\]\/]+$/;

const opts = { region: REGION, cors: true };

// ------------------------------------------------------------------ utilidades
function toList(v) { return Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []); }
function timeToMins(t) { const [h, m] = String(t).split(':'); return parseInt(h, 10) * 60 + parseInt(m, 10); }
function cleanSlug(slug) {
  if (typeof slug !== 'string' || !slug || slug.length > 100 || !SLUG_RE.test(slug)) {
    throw new HttpsError('invalid-argument', 'Empresa inválida.');
  }
  return slug;
}
async function readTenant(slug) {
  const snap = await db.ref(`${BASE}/tenants/${slug}`).once('value');
  const t = snap.val();
  if (!t) throw new HttpsError('not-found', 'Empresa não encontrada.');
  return t;
}
function isTenantAdmin(request, slug, tenant) {
  const tok = request.auth.token || {};
  const uid = request.auth.uid;
  // 1) papel gravado pela função syncRole (custom claim "staff")
  const claim = tok.staff && tok.staff[slug];
  if (claim === 'admin' || (claim && typeof claim === 'object' && claim.role === 'admin')) return true;
  // 2) cadastro do administrador na empresa
  const a = (tenant && tenant.admin) || {};
  if ([a.id, a.uid, a.authUid].some(v => v && String(v) === uid)) return true;
  if (a.email && tok.email && String(a.email).toLowerCase() === String(tok.email).toLowerCase()) return true;
  return false;
}
// exige: logado + administrador da empresa + senha (ou Google) confirmada agora há pouco
async function requireFreshAdmin(request, rawSlug) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta para continuar.');
  const slug = cleanSlug(rawSlug);
  const tenant = await readTenant(slug);
  if (!isTenantAdmin(request, slug, tenant)) {
    throw new HttpsError('permission-denied', 'Só o administrador da empresa pode alterar o pagamento automático.');
  }
  const authTime = Number(request.auth.token.auth_time || 0);
  if (!authTime || (Date.now() / 1000 - authTime) > FRESH_LOGIN_SECONDS) {
    throw new HttpsError('failed-precondition', 'Confirme sua senha para continuar.');
  }
  return { slug, tenant };
}
// o token só é guardado se o banco estiver protegido (sem leitura pública da pasta de segredos)
async function assertDatabaseIsLocked() {
  let url = (admin.app().options && admin.app().options.databaseURL) || '';
  if (!url) { try { url = JSON.parse(process.env.FIREBASE_CONFIG || '{}').databaseURL || ''; } catch (_) {} }
  if (!url) url = `https://${process.env.GCLOUD_PROJECT}-default-rtdb.firebaseio.com`;
  let res;
  try { res = await fetch(`${url.replace(/\/$/, '')}/${BASE}/secrets/_probe.json?shallow=true`); }
  catch (_) { throw new HttpsError('unavailable', 'Não foi possível verificar as regras do banco. Tente de novo.'); }
  if (res.status !== 401 && res.status !== 403) {
    throw new HttpsError('failed-precondition',
      'O banco de dados está com regras abertas. Publique o database.rules.json (veja o LEIA-ME) antes de conectar o Mercado Pago.');
  }
}
async function mpFetch(token, path, init = {}) {
  const res = await fetch(MP_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, body };
}
async function getToken(slug) {
  const snap = await db.ref(`${BASE}/secrets/${slug}/mercadopago`).once('value');
  const v = snap.val();
  return v && v.accessToken ? String(v.accessToken) : null;
}
function brOffsetIso(date) {              // Mercado Pago pede a data com fuso (Brasil: -03:00)
  const d = new Date(date.getTime() - 3 * 3600000);
  return d.toISOString().replace('Z', '').replace(/\.\d+$/, '.000') + '-03:00';
}
function isExpiredPending(a) {
  if (!a || a.status !== 'pendente') return false;
  if (a.depositDeadline && new Date(a.depositDeadline) < new Date()) return true;
  return new Date(`${a.date}T${a.time}`) < new Date();
}
function isBusy(a) {
  return a.status !== 'cancelado' && a.status !== 'nao_compareceu' && !isExpiredPending(a);
}
// valor do sinal recalculado NO SERVIDOR (o cliente não consegue alterar)
function calcDeposit(tenant, app) {
  const dep = (tenant.rules && tenant.rules.deposit) || {};
  if (dep.enabled !== true) return null;
  const percent = Number(dep.percent) > 0 ? Number(dep.percent) : 30;
  const chosen = toList(app.procedureIds).map(String);
  if (!chosen.length) return null;
  const procIds = toList(dep.procedureIds).map(String);
  const procs = toList(tenant.procedures).filter(p => chosen.includes(String(p.id)));
  const required = procs.filter(p => dep.all === true || procIds.includes(String(p.id)));
  if (!required.length) return null;
  const base = required.reduce((s, p) => s + (Number(p.price) || 0), 0);
  const amount = Math.round(base * percent) / 100;
  if (!(amount > 0)) return null;
  let hours = (dep.expiryHours === undefined || dep.expiryHours === null || dep.expiryHours === '' || isNaN(Number(dep.expiryHours)))
    ? 2 : Math.max(0, Number(dep.expiryHours));
  if (hours === 0) hours = 24;            // "sem prazo" no painel: a cobrança Pix dura 24h
  hours = Math.min(Math.max(hours, 0.5), 720);   // Pix: mínimo 30 min
  return { amount, percent, hours };
}
// altera um agendamento de forma atômica; fn recebe a lista e o item, devolve false para abortar
async function mutateAppointment(slug, appId, fn) {
  let found = false;
  const result = await db.ref(`${BASE}/tenants/${slug}/appointments`).transaction((cur) => {
    found = false;
    if (!cur) return;
    const list = toList(cur);
    const item = list.find(a => a.id === appId);
    if (!item) return;
    found = true;
    if (fn(item, list) === false) return;
    return list;
  });
  return { committed: result.committed && found, found };
}

// ------------------------------------------------------------------ conectar / desconectar
exports.mpConnect = onCall(opts, async (request) => {
  const { slug } = await requireFreshAdmin(request, request.data && request.data.slug);
  const accessToken = String((request.data && request.data.accessToken) || '').trim();
  if (!/^APP_USR-[A-Za-z0-9_-]{20,}$/.test(accessToken)) {
    throw new HttpsError('invalid-argument', 'Cole o Access Token de PRODUÇÃO do Mercado Pago (começa com APP_USR-).');
  }
  await assertDatabaseIsLocked();

  const me = await mpFetch(accessToken, '/users/me');
  if (!me.ok || !me.body || !me.body.id) {
    throw new HttpsError('invalid-argument', 'O Mercado Pago não aceitou este token. Confira se copiou o Access Token de produção.');
  }
  const last4 = accessToken.slice(-4);
  const label = String(me.body.nickname || me.body.email || me.body.id).slice(0, 60);
  const now = new Date().toISOString();

  await db.ref(`${BASE}/secrets/${slug}/mercadopago`).set({
    accessToken, last4, accountId: String(me.body.id), connectedAt: now, connectedBy: request.auth.uid
  });
  await db.ref(`${BASE}/providers/${slug}`).set({ type: 'mercadopago', active: true, last4, label, connectedAt: now });
  return { ok: true, last4, label, connectedAt: now };
});

exports.mpDisconnect = onCall(opts, async (request) => {
  const { slug } = await requireFreshAdmin(request, request.data && request.data.slug);
  await db.ref(`${BASE}/providers/${slug}`).remove();
  await db.ref(`${BASE}/secrets/${slug}/mercadopago`).remove();
  return { ok: true };
});

// ------------------------------------------------------------------ cobrança do cliente
exports.mpCreatePix = onCall(opts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta para pagar o sinal.');
  const slug = cleanSlug(request.data && request.data.slug);
  const appId = String((request.data && request.data.appId) || '');
  if (!appId || appId.length > 100) throw new HttpsError('invalid-argument', 'Agendamento inválido.');

  const tenant = await readTenant(slug);
  const prov = (await db.ref(`${BASE}/providers/${slug}`).once('value')).val();
  const token = prov && prov.active ? await getToken(slug) : null;
  if (!token) throw new HttpsError('failed-precondition', 'O pagamento automático não está ativo nesta empresa.');

  const app = toList(tenant.appointments).find(a => a.id === appId);
  if (!app) throw new HttpsError('not-found', 'Agendamento não encontrado.');
  if (app.clientId !== request.auth.uid) throw new HttpsError('permission-denied', 'Este agendamento não é seu.');
  if (app.status !== 'pendente') throw new HttpsError('failed-precondition', 'Este agendamento não está aguardando sinal.');
  if (isExpiredPending(app)) throw new HttpsError('failed-precondition', 'O prazo para pagar o sinal terminou. Faça um novo agendamento.');

  // já existe cobrança válida: devolve a mesma (não cria outra)
  if (app.mpPaymentId && app.mpPixCode) {
    return { pixCode: app.mpPixCode, amount: Number(app.depositAmount), deadline: app.depositDeadline || null, paymentId: app.mpPaymentId };
  }

  const dep = calcDeposit(tenant, app);
  if (!dep) throw new HttpsError('failed-precondition', 'Este agendamento não exige sinal.');
  const deadline = new Date(Date.now() + dep.hours * 3600000);

  const projectId = process.env.GCLOUD_PROJECT;
  const webhookBase = process.env.MP_WEBHOOK_URL || `https://${REGION}-${projectId}.cloudfunctions.net/mpWebhook`;
  const email = (request.auth.token && request.auth.token.email) || (tenant.admin && tenant.admin.email) || 'cliente@example.com';
  const firstName = String(app.clientName || 'Cliente').split(' ')[0].slice(0, 40);

  const idem = crypto.createHash('sha1').update(`${slug}:${appId}`).digest('hex');
  const pay = await mpFetch(token, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': idem },
    body: JSON.stringify({
      transaction_amount: dep.amount,
      description: `Sinal - ${String(tenant.name || 'Agendamento').slice(0, 80)}`,
      payment_method_id: 'pix',
      date_of_expiration: brOffsetIso(deadline),
      external_reference: appId,
      notification_url: `${webhookBase}?slug=${encodeURIComponent(slug)}`,
      payer: { email, first_name: firstName }
    })
  });
  const td = pay.body && pay.body.point_of_interaction && pay.body.point_of_interaction.transaction_data;
  if (!pay.ok || !td || !td.qr_code || !pay.body.id) {
    console.error('Mercado Pago recusou a cobrança', pay.status, JSON.stringify(pay.body || {}).slice(0, 800));
    throw new HttpsError('internal', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }
  const paymentId = String(pay.body.id);

  await db.ref(`${BASE}/payments/${paymentId}`).set({ slug, appId, amount: dep.amount, createdAt: new Date().toISOString() });
  const upd = await mutateAppointment(slug, appId, (item) => {
    if (item.status !== 'pendente') return false;
    item.depositRequired = true;
    item.depositAmount = dep.amount;
    item.depositPercent = dep.percent;
    item.depositDeadline = deadline.toISOString();
    item.pixProvider = 'mercadopago';
    item.mpPaymentId = paymentId;
    item.mpPixCode = td.qr_code;
  });
  if (!upd.committed) throw new HttpsError('aborted', 'O agendamento mudou enquanto o Pix era gerado. Confira em "Meus horários".');

  return { pixCode: td.qr_code, amount: dep.amount, deadline: deadline.toISOString(), paymentId };
});

// ------------------------------------------------------------------ aviso do Mercado Pago
exports.mpWebhook = onRequest({ region: REGION }, async (req, res) => {
  try {
    const slug = String(req.query.slug || '');
    if (!slug || slug.length > 100 || !SLUG_RE.test(slug)) return res.status(400).send('slug');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const type = String(req.query.type || body.type || req.query.topic || body.topic || '');
    const paymentId = String(req.query['data.id'] || (body.data && body.data.id) || (type === 'payment' && req.query.id) || '');
    if (type !== 'payment' || !/^\d+$/.test(paymentId)) return res.status(200).send('ignorado');

    // o aviso não é confiável por si só: só vale o que o Mercado Pago responder ao consultarmos com o token da empresa
    const idx = (await db.ref(`${BASE}/payments/${paymentId}`).once('value')).val();
    if (!idx) return res.status(404).send('pagamento desconhecido');   // o MP tenta de novo
    if (idx.slug !== slug) return res.status(200).send('ignorado');

    const token = await getToken(slug);
    if (!token) return res.status(200).send('sem token');

    const p = await mpFetch(token, `/v1/payments/${paymentId}`);
    if (!p.ok || !p.body) return res.status(502).send('consulta falhou');   // o MP tenta de novo
    const pay = p.body;
    if (String(pay.id) !== paymentId) return res.status(200).send('ignorado');
    if (String(pay.external_reference) !== String(idx.appId)) return res.status(200).send('ignorado');
    if (pay.payment_method_id !== 'pix') return res.status(200).send('ignorado');
    if (pay.status !== 'approved') return res.status(200).send('ainda nao pago');
    const paid = Number(pay.transaction_amount);
    if (!(paid + 0.001 >= Number(idx.amount))) {
      console.error('Valor pago menor que o sinal', paymentId, paid, idx.amount);
      return res.status(200).send('valor divergente');
    }

    await confirmPayment(slug, String(idx.appId), paymentId, paid);
    return res.status(200).send('ok');
  } catch (e) {
    console.error('mpWebhook erro', e);
    return res.status(500).send('erro');
  }
});

async function confirmPayment(slug, appId, paymentId, paidAmount) {
  const now = new Date();
  await mutateAppointment(slug, appId, (item, list) => {
    if (String(item.mpPaymentId) !== paymentId) return false;          // este Pix não é deste agendamento
    if (item.status === 'agendado' && item.depositPaidVia === 'mercadopago') return false;   // já confirmado (aviso repetido)

    const alert = (type) => {
      item.paymentAlert = type;
      item.paymentAlertAt = now.toISOString();
      item.paidAmount = paidAmount;
      item.depositPaidAt = now.toISOString();
      delete item.paymentAlertResolved;
    };

    if (item.status === 'cancelado' || item.status === 'nao_compareceu') { alert('paid_cancelled'); return true; }
    if (item.status !== 'pendente') return false;

    const expired = isExpiredPending(item);
    if (expired) {
      if (new Date(`${item.date}T${item.time}`) < now) { alert('late_past'); return true; }
      const s = timeToMins(item.time), e = s + (Number(item.totalDuration) || 0);
      const clash = list.some(a => a.id !== item.id && a.employeeId === item.employeeId && a.date === item.date && isBusy(a)
        && s < timeToMins(a.time) + (Number(a.totalDuration) || 0) && e > timeToMins(a.time));
      if (clash) { alert('late_conflict'); return true; }
    }
    item.status = 'agendado';
    item.depositPaid = Math.min(paidAmount, Number(item.depositAmount) || paidAmount);
    item.depositPaidAt = now.toISOString();
    item.depositPaidVia = 'mercadopago';
    delete item.paymentAlert;
    return true;
  });
}
