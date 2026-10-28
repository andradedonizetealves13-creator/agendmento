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

async function postWebhook(cfg, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) throw new Error('O endpoint respondeu ' + res.status);
  } finally { clearTimeout(timer); }
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
  try {
    await postWebhook(cfg, {
      event: 'pix.test', org: slug, phone: '', clientName: 'Teste',
      message: '✅ Teste do aviso de Pix: se você recebeu isto, o webhook está funcionando.',
      pixCode: '00020126TESTE',
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

    const prazo = a.depositDeadline
      ? new Date(a.depositDeadline).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
      : '';
    const message =
      `Olá, ${String(a.clientName || '').split(' ')[0]}! 💜\n\n` +
      `Seu horário está reservado:\n📅 ${dateBR(a.date)} às ${a.time}\n💅 ${(a.proceduresNames || []).join(', ')}\n\n` +
      `Para confirmar, pague o sinal de *${money(a.depositAmount)}* por Pix.\n` +
      (prazo ? `⏰ Pague até ${prazo}.\n` : '') +
      `\nCopie o código que vou enviar na próxima mensagem e cole no app do seu banco (Pix copia e cola) 👇`;

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
