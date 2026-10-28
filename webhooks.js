// functions/webhooks.js
// Webhooks cadastrados no Portal do Desenvolvedor (painel). Cada webhook tem:
//   nome, ação (evento) que o dispara, endpoint, chave opcional e mensagem com {variáveis}.
//
// No index.js:  Object.assign(exports, require('./webhooks'));
// Deploy:       firebase deploy --only functions
//
// ONDE FICAM OS DADOS
//   Segredo (endpoint + chave): agendapro_saas/providerSecrets/{slug}/webhooks/{id}   <- só o servidor lê/grava
//   Público (nome, ação, mensagem, host): agendapro_saas/providers/{slug}/webhooks/{id} <- o painel mostra
// Rules do Realtime Database: "providerSecrets" com ".read": false e ".write": false.

const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.database();

const EVENTS = ['pix_gerado', 'agendamento_criado', 'agendamento_confirmado', 'agendamento_cancelado', 'agendamento_realizado'];

// ---------- variáveis das mensagens: {nome}, {data}... ----------
const VAR_NAMES = ['nome', 'primeiro_nome', 'telefone', 'empresa', 'data', 'data_curta', 'dia_semana', 'horario',
  'procedimentos', 'profissional', 'duracao', 'valor_total', 'valor_sinal', 'prazo', 'pix_copia_cola', 'id_agendamento'];
const BRACES = /\{\s*([^{}]*?)\s*\}/g;

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const toBR = (d) => (d.length <= 11 ? '55' + d : d);
const money = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');
const TZ = 'America/Sao_Paulo';

function unknownVars(text) {
  const bad = [];
  String(text || '').replace(BRACES, (m, n) => { if (!VAR_NAMES.includes(n.toLowerCase()) && !bad.includes(n)) bad.push(n); return m; });
  return bad;
}
// troca {variavel} pelo valor; o que não existir/estiver vazio vira texto vazio (nunca "undefined")
function renderTpl(tpl, ctx) {
  return String(tpl || '').replace(BRACES, (m, n) => {
    const v = ctx[n.toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  }).trim();
}

function buildCtx({ tenant, a, pixCode }) {
  const emps = Object.values(tenant.employees || {});
  const emp = emps.find((e) => e && e.id === a.employeeId);
  const profissional = emp ? emp.name : (tenant.admin && tenant.admin.name) || '';
  const [yy, mm, dd] = String(a.date || '').split('-');
  let dia = '';
  try { dia = new Date(`${a.date}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' }); } catch (_) {}
  const prazo = a.depositDeadline
    ? new Date(a.depositDeadline).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(', ', ' às ')
    : '';
  const nome = String(a.clientName || '').trim();
  return {
    nome, primeiro_nome: nome.split(' ')[0], telefone: a.clientPhone || '', empresa: tenant.name || '',
    data: dd ? `${dd}/${mm}/${yy}` : '', data_curta: dd ? `${dd}/${mm}` : '', dia_semana: dia, horario: a.time || '',
    procedimentos: (a.proceduresNames || []).join(' + '), profissional,
    duracao: a.totalDuration ? `${a.totalDuration} min` : '',
    valor_total: a.totalPrice != null ? money(a.totalPrice) : '', valor_sinal: a.depositAmount != null ? money(a.depositAmount) : '',
    prazo, pix_copia_cola: pixCode || a.mpPixCode || '', id_agendamento: a.id || '',
  };
}

// ---------- envio ----------
const isZapi = (url) => { try { return /(^|\.)z-api\.io$/i.test(new URL(url).hostname); } catch (_) { return false; } };

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

// Z-API: {phone, message} em até 2 mensagens. Outros endpoints: JSON completo, uma chamada.
async function deliver(cfg, w, event, ctx, phone) {
  const m1 = renderTpl(w.message, ctx), m2 = renderTpl(w.message2, ctx);
  if (isZapi(cfg.url)) {
    if (!phone) throw new Error('Sem telefone válido para enviar.');
    if (m1) await postJson(cfg, { phone, message: m1 });
    if (m2) await postJson(cfg, { phone, message: m2 });
    return;
  }
  await postJson(cfg, { event, webhook: w.name, phone, message: m1, message2: m2, data: ctx });
}

// dispara todos os webhooks ativos daquela ação; um erro não derruba os outros
async function fire(org, event, aptRef, a, extra) {
  const [pubSnap, secSnap, tenantSnap] = await Promise.all([
    db().ref(`agendapro_saas/providers/${org}/webhooks`).get(),
    db().ref(`agendapro_saas/providerSecrets/${org}/webhooks`).get(),
    db().ref(`agendapro_saas/tenants/${org}`).get(),
  ]);
  const pub = pubSnap.val() || {}, sec = secSnap.val() || {}, tenant = tenantSnap.val() || {};
  const ctx = buildCtx({ tenant, a, pixCode: extra && extra.pixCode });
  const digits = onlyDigits(a.clientPhone);
  const phone = digits.length >= 10 ? toBR(digits) : '';
  const sent = a.webhookSent || {};
  for (const [id, w] of Object.entries(pub)) {
    if (!w || w.event !== event || w.enabled === false || !sec[id] || !sec[id].url) continue;
    const mark = `${event}_${id}`;
    if (sent[mark]) continue; // já enviado antes
    try {
      await deliver(sec[id], w, event, ctx, phone);
      await aptRef.child('webhookSent').child(mark).set(new Date().toISOString());
    } catch (e) { console.error(`webhook ${id} (${event}) falhou:`, e.message); }
  }
}

// ---------- segurança: só admin, com a senha digitada agora há pouco ----------
async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre novamente.');
  const slug = String((request.data || {}).slug || '');
  if (!slug) throw new HttpsError('invalid-argument', 'Organização não informada.');
  const authTime = Number(request.auth.token.auth_time || 0) * 1000;
  if (Date.now() - authTime > 15 * 60 * 1000) throw new HttpsError('permission-denied', 'Confirme a senha novamente.');
  // TODO: troque esta checagem pela MESMA que o seu mpConnect usa para validar que
  // request.auth.uid é administrador da organização "slug".
  return slug;
}

// ---------- chamadas do painel ----------
exports.webhookSave = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const d = request.data || {};
  const name = String(d.name || '').trim().slice(0, 80);
  const event = String(d.event || '');
  const message = String(d.message || '').slice(0, 2000);
  const message2 = String(d.message2 || '').slice(0, 2000);
  if (!name) throw new HttpsError('invalid-argument', 'Dê um nome para o webhook.');
  if (!EVENTS.includes(event)) throw new HttpsError('invalid-argument', 'Ação inválida.');
  const bad = unknownVars(message + ' ' + message2);
  if (bad.length) throw new HttpsError('invalid-argument', 'Variáveis que não existem: ' + bad.map((b) => '{' + b + '}').join(', '));

  const id = d.id ? String(d.id) : db().ref().push().key;
  const secRef = db().ref(`agendapro_saas/providerSecrets/${slug}/webhooks/${id}`);
  const pubRef = db().ref(`agendapro_saas/providers/${slug}/webhooks/${id}`);
  const oldSec = (await secRef.get()).val() || {};
  const oldPub = (await pubRef.get()).val() || {};
  if (d.id && !oldSec.url) throw new HttpsError('not-found', 'Webhook não encontrado.');

  let url = String(d.url || '').trim() || oldSec.url || '';
  let host;
  try { const u = new URL(url); if (u.protocol !== 'https:') throw 0; host = u.host; }
  catch (_) { throw new HttpsError('invalid-argument', 'O endpoint precisa ser um link https:// válido.'); }
  const token = String(d.token || '').trim() || oldSec.token || '';
  if (isZapi(url) && !message.trim()) throw new HttpsError('invalid-argument', 'Para a Z-API, escreva a mensagem que será enviada.');

  await secRef.set({ url, token, updatedAt: new Date().toISOString() });
  await pubRef.set({
    name, event, message, message2, host, hasToken: !!token,
    enabled: d.enabled === false ? false : (oldPub.enabled !== false),
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, id };
});

exports.webhookToggle = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const id = String(request.data.id || '');
  const ref = db().ref(`agendapro_saas/providers/${slug}/webhooks/${id}`);
  if (!(await ref.get()).exists()) throw new HttpsError('not-found', 'Webhook não encontrado.');
  await ref.child('enabled').set(request.data.enabled !== false);
  return { ok: true };
});

exports.webhookDelete = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const id = String(request.data.id || '');
  await db().ref(`agendapro_saas/providerSecrets/${slug}/webhooks/${id}`).remove();
  await db().ref(`agendapro_saas/providers/${slug}/webhooks/${id}`).remove();
  return { ok: true };
});

exports.webhookTest = onCall(async (request) => {
  const slug = await assertAdmin(request);
  const id = String(request.data.id || '');
  const [pub, sec, tn] = await Promise.all([
    db().ref(`agendapro_saas/providers/${slug}/webhooks/${id}`).get(),
    db().ref(`agendapro_saas/providerSecrets/${slug}/webhooks/${id}`).get(),
    db().ref(`agendapro_saas/tenants/${slug}`).get(),
  ]);
  const w = pub.val(), cfg = sec.val(), tenant = tn.val() || {};
  if (!w || !cfg || !cfg.url) throw new HttpsError('not-found', 'Webhook não encontrado.');
  const ph = onlyDigits(tenant.companyPhone || tenant.phone || tenant.whatsapp);
  if (isZapi(cfg.url) && ph.length < 10) throw new HttpsError('failed-precondition', 'Cadastre o telefone/WhatsApp da empresa para receber o teste.');
  const sample = {
    clientName: 'Maria Souza', clientPhone: '(19) 98765-4321', date: '2026-11-20', time: '15:00',
    proceduresNames: ['Design', 'Henna'], totalDuration: 50, totalPrice: 45, depositAmount: 15.75,
    depositDeadline: new Date(Date.now() + 3600000).toISOString(), id: 'teste', employeeId: '',
  };
  const ctx = buildCtx({ tenant, a: sample, pixCode: '00020126TESTE-NAO-PAGUE' });
  try { await deliver(cfg, w, w.event, ctx, ph ? toBR(ph) : ''); }
  catch (e) { throw new HttpsError('unavailable', 'Não foi possível chamar o endpoint: ' + e.message); }
  return { ok: true };
});

// ---------- gatilhos (ações) ----------
const APT = '/agendapro_saas/tenants/{org}/appointments/{key}';

exports.webhookPixGerado = onValueCreated({ ref: APT + '/mpPixCode' }, async (event) => {
  const pixCode = event.data.val(); if (!pixCode) return;
  const aptRef = event.data.ref.parent;
  await fire(event.params.org, 'pix_gerado', aptRef, (await aptRef.get()).val() || {}, { pixCode });
});

exports.webhookAgendamentoCriado = onValueCreated({ ref: APT + '/createdAt' }, async (event) => {
  const aptRef = event.data.ref.parent;
  await fire(event.params.org, 'agendamento_criado', aptRef, (await aptRef.get()).val() || {});
});

exports.webhookStatusMudou = onValueWritten({ ref: APT + '/status' }, async (event) => {
  const before = event.data.before.val(), after = event.data.after.val();
  if (!after || before === after) return;
  let ev = null;
  if (after === 'agendado' && before === 'pendente') ev = 'agendamento_confirmado';
  else if (after === 'cancelado') ev = 'agendamento_cancelado';
  else if (after === 'realizado') ev = 'agendamento_realizado';
  if (!ev) return;
  const aptRef = event.data.after.ref.parent;
  await fire(event.params.org, ev, aptRef, (await aptRef.get()).val() || {});
});
