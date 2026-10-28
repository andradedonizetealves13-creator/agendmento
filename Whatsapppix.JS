// functions/whatsappPix.js
// Webhook do Pix: quando o Pix de um agendamento é gerado, envia os dados para o
// endpoint que o administrador cadastrou no painel (card "Aviso do Pix no WhatsApp").
//
// No index.js:  Object.assign(exports, require('./whatsappPix'));
// Deploy:       firebase deploy --only functions
//
// ONDE FICAM OS DADOS
//   Segredo (endpoint + chave):  agendapro_saas/providerSecrets/{slug}/wa   <- só o servidor lê/grava
//   Status público (sem segredo): agendapro_saas/providers/{slug}/wa        <- o painel mostra o status
// IMPORTANTE nas Rules do Realtime Database: "providerSecrets" com ".read": false e ".write": false.

const { onValueCreated } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.database();

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const toBR = (d) => (d.length <= 11 ? '55' + d : d);
const dateBR = (iso) => String(iso || '').split('-').reverse().join('/');
const money = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');

// ---------- segurança: só admin, com a senha digitada agora há pouco ----------
async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre novamente.');
  const slug = String((request.data || {}).slug || '');
  if (!slug) throw new HttpsError('invalid-argument', 'Organização não informada.');
  // login recente (o painel pede a senha e renova o token antes de chamar)
  const authTime = Number(request.auth.token.auth_time || 0) * 1000;
  if (Date.now() - authTime > 5 * 60 * 1000) throw new HttpsError('permission-denied', 'Confirme a senha novamente.');
  // TODO: troque esta checagem pela MESMA que o seu mpConnect usa para validar que
  // request.auth.uid é administrador da organização "slug".
  // (reaproveite a função auxiliar que já existe no seu backend)
  return slug;
}

const isZapi = (url) => /(^|\.)z-api\.io$/i.test(new URL(url).hostname);

async function postJson(cfg, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) { if (isZapi(cfg.url)) headers['Client-Token'] = cfg.token; else headers.Authorization = 'Bearer ' + cfg.token; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error('O endpoint respondeu ' + res.status + ' ' + (await res.text()).slice(0, 200));
  } finally { clearTimeout(timer); }
}

// Z-API: envia direto no formato dela ({phone, message}), em 2 mensagens (texto + código Pix).
// Qualquer outro endpoint (n8n, Make...): envia o JSON completo uma vez.
async function postWebhook(cfg, payload) {
  if (isZapi(cfg.url)) {
    if (!payload.phone) throw new Error('Sem telefone para enviar.');
    await postJson(cfg, { phone: payload.phone, message: payload.message });
    if (payload.messagePix) await postJson(cfg, { phone: payload.phone, message: payload.messagePix });
    return;
  }
  await postJson(cfg, payload);
}

// ---------- chamadas do painel ----------
exports.waConnect = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const url = String(request.data.url || '').trim();
  const token = String(request.data.token || '').trim();
  let host;
  try { const u = new URL(url); if (u.protocol !== 'https:') throw 0; host = u.host; }
  catch (_) { throw new HttpsError('invalid-argument', 'O endpoint precisa ser um link https:// válido.'); }
  await db().ref(`agendapro_saas/providerSecrets/${slug}/wa`).set({ url, token, updatedAt: new Date().toISOString() });
  await db().ref(`agendapro_saas/providers/${slug}/wa`).set({ active: true, host, hasToken: !!token, connectedAt: new Date().toISOString() });
  return { ok: true };
});

exports.waDisconnect = onCall(async (request) => {
  const slug = await assertAdmin(request);
  await db().ref(`agendapro_saas/providerSecrets/${slug}/wa`).remove();
  await db().ref(`agendapro_saas/providers/${slug}/wa`).remove();
  return { ok: true };
});

exports.waTest = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const snap = await db().ref(`agendapro_saas/providerSecrets/${slug}/wa`).get();
  const cfg = snap.val();
  if (!cfg || !cfg.url) throw new HttpsError('failed-precondition', 'Configure o endpoint primeiro.');
  const tn = (await db().ref(`agendapro_saas/tenants/${slug}`).get()).val() || {};
  const ph = onlyDigits(tn.companyPhone || tn.phone || tn.whatsapp);
  if (isZapi(cfg.url) && ph.length < 10) throw new HttpsError('failed-precondition', 'Cadastre o telefone/WhatsApp da empresa para receber o teste.');
  try {
    await postWebhook(cfg, {
      event: 'pix.test', org: slug, phone: ph ? toBR(ph) : '', clientName: 'Teste',
      message: '✅ Teste do aviso de Pix: se você recebeu isto, a integração está funcionando.',
      messagePix: '00020126TESTE-NAO-PAGUE',
      pixCode: '00020126TESTE-NAO-PAGUE',
    });
  } catch (e) { throw new HttpsError('unavailable', 'Não foi possível chamar o endpoint: ' + e.message); }
  return { ok: true };
});

// ---------- gatilho: Pix gerado ----------
exports.whatsappPixGerado = onValueCreated(
  {
    ref: '/agendapro_saas/tenants/{org}/appointments/{key}/mpPixCode',
    // region: 'us-central1', // use a mesma região do seu Realtime Database
  },
  async (event) => {
    const pixCode = event.data.val();
    if (!pixCode) return;
    const org = event.params.org;

    const cfgSnap = await db().ref(`agendapro_saas/providerSecrets/${org}/wa`).get();
    const cfg = cfgSnap.val();
    if (!cfg || !cfg.url) return; // organização sem webhook configurado

    const aptRef = event.data.ref.parent;
    const a = (await aptRef.get()).val() || {};
    if (a.waPixSentAt) return; // não envia duas vezes se o Pix for regerado

    const phone = onlyDigits(a.clientPhone);
    if (phone.length < 10) return console.warn('Agendamento sem telefone válido', event.params.key);

    const nome = String(a.clientName || '').trim().split(' ')[0];
    const tenantName = (await db().ref(`agendapro_saas/tenants/${org}/name`).get()).val() || 'nosso estúdio';
    const dataCurta = String(a.date || '').split('-').reverse().slice(0, 2).join('/'); // 2026-11-20 -> 20/11
    const procedimento = (a.proceduresNames || []).join(' + ');

    const message =
      `Oii, Tudo bem, ${nome}?\n\n` +
      `Passando para confirmar seu agendamento aqui no ${tenantName}! ✨\n\n` +
      `📅 Data: ${dataCurta}\n` +
      `⏰ Horário: ${a.time}\n` +
      `🖊️ Procedimento: ${procedimento}\n\n` +
      `Para confirmar e garantir a reserva do seu horário, é necessário realizar o pagamento do sinal. \n` +
      `Assim que realizar o pagamento, peço que me envie o comprovante por aqui, combinado? \n\n` +
      `Qualquer dúvida, estou à disposição! Será um prazer te receber no ${tenantName}!`;

    await postWebhook(cfg, {
      event: 'pix.generated',
      org,
      appointmentId: a.id || event.params.key,
      phone: toBR(phone),
      clientName: a.clientName || '',
      date: a.date || '', time: a.time || '',
      services: a.proceduresNames || [],
      amount: Number(a.depositAmount || 0),
      deadline: a.depositDeadline || '',
      pixCode,
      message,          // texto pronto para enviar
      messagePix: pixCode, // 2ª mensagem: só o código, fácil de copiar
    });

    await aptRef.child('waPixSentAt').set(new Date().toISOString());
  }
);
