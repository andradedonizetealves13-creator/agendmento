'use strict';
/**
 * Notificações push do Primstav (Firebase Cloud Messaging).
 *
 *  registerPushToken  (callable)  guarda o aparelho de quem é da equipe da empresa
 *  onAgendamentoGravado (banco)   avisa NOVO AGENDAMENTO e CANCELAMENTO
 *  avisarSinalExpirando (agenda)  roda a cada minuto e avisa 15 min antes de o sinal expirar
 *
 * Quem recebe: administradores recebem tudo; profissionais recebem só os da própria agenda.
 * Dados no banco (somente o servidor lê/grava – as regras devem negar para o cliente):
 *   agendapro_saas/pushTokens/{slug}/{hash} = { token, uid, role, employeeId, ts }
 *   agendapro_saas/pushQueue/{id}           = { slug, appId, dueAt, deadline, sent }
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) admin.initializeApp();
const db = admin.database();

const BASE = 'agendapro_saas';
const REGION = 'us-central1';
const TZ = 'America/Sao_Paulo';
const AVISO_MIN = 15;                 // minutos antes do fim do prazo do sinal
const MAX_TOKENS_POR_LOGIN = 5;
const SLUG_RE = /^[^.$#\[\]\/]+$/;

const lower = (v) => String(v || '').toLowerCase();
const toList = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []));
const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');

function fmtData(a) {
  const [y, m, d] = String(a.date || '').split('-');
  return d && m ? `${d}/${m} às ${a.time || ''}` : String(a.time || '');
}
function servicos(a) {
  const n = a.proceduresNames || a.procedureNames || a.services;
  return Array.isArray(n) ? n.join(', ') : (n || '');
}
function resumo(a) {
  return [a.clientName || 'Cliente', servicos(a), fmtData(a)].filter(Boolean).join(' · ');
}

// ---------- registrar aparelho ----------
exports.registerPushToken = onCall({ region: REGION, cors: true, maxInstances: 10 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta para continuar.');
  const { slug, token } = request.data || {};
  if (typeof slug !== 'string' || !slug || slug.length > 100 || !SLUG_RE.test(slug)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new HttpsError('invalid-argument', 'Token inválido.');

  const uid = request.auth.uid;
  const staff = (request.auth.token && request.auth.token.staff) || {};
  const role = staff[slug];                       // claim gravado pelo syncRole
  if (role !== 'admin' && role !== 'employee') throw new HttpsError('permission-denied', 'Este login não pertence à empresa.');

  let employeeId = uid;
  if (role === 'employee') {
    const t = (await db.ref(`${BASE}/tenants/${slug}/employees`).once('value')).val();
    const email = lower(request.auth.token.email);
    const emp = toList(t).find((e) => e && (String(e.uid || '') === uid || (email && lower(e.email) === email)));
    if (emp && emp.id) employeeId = String(emp.id);
  }

  const ref = db.ref(`${BASE}/pushTokens/${slug}`);
  await ref.child(hash(token)).set({ token, uid, role, employeeId, ts: Date.now() });

  // mantém no máximo N aparelhos por login (apaga os mais antigos)
  const mine = (await ref.orderByChild('uid').equalTo(uid).once('value')).val() || {};
  const keys = Object.keys(mine).sort((a, b) => (mine[b].ts || 0) - (mine[a].ts || 0));
  await Promise.all(keys.slice(MAX_TOKENS_POR_LOGIN).map((k) => ref.child(k).remove()));
  return { ok: true };
});

// ---------- envio ----------
async function enviar(slug, agendamento, msg) {
  const snap = await db.ref(`${BASE}/pushTokens/${slug}`).once('value');
  const todos = snap.val() || {};
  const alvo = Object.keys(todos).filter((k) => {
    const x = todos[k];
    return x && x.token && (x.role === 'admin' || String(x.employeeId) === String(agendamento.employeeId));
  });
  if (!alvo.length) return;

  const res = await admin.messaging().sendEachForMulticast({
    tokens: alvo.map((k) => todos[k].token),
    data: {                                         // só "data": o sw.js monta a notificação com a logo
      title: msg.title, body: msg.body, tag: msg.tag, tipo: msg.tipo,
      url: '/painel_do_profissional.html', icon: '/icons/icon-192.png'
    },
    webpush: { headers: { Urgency: 'high', TTL: '3600' } },
    android: { priority: 'high' }
  });

  // remove aparelhos que não existem mais
  const remover = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') remover.push(alvo[i]);
  });
  await Promise.all(remover.map((k) => db.ref(`${BASE}/pushTokens/${slug}/${k}`).remove()));
}

// ---------- novo agendamento / cancelamento / fila do sinal ----------
exports.onAgendamentoGravado = onValueWritten(
  { ref: `/${BASE}/tenants/{slug}/appointments/{idx}`, region: REGION },
  async (event) => {
    const { slug } = event.params;
    const antes = event.data.before.val();
    const depois = event.data.after.val();
    if (!depois) return;

    const queue = db.ref(`${BASE}/pushQueue/${slug}__${depois.id}`);

    // sinal: entra na fila (se pendente) ou sai dela (se já confirmou/cancelou)
    if (depois.status === 'pendente' && depois.depositDeadline) {
      const fim = new Date(depois.depositDeadline).getTime();
      if (fim && !(await queue.once('value')).exists()) {
        await queue.set({ slug, appId: depois.id, deadline: fim, dueAt: fim - AVISO_MIN * 60000, sent: false });
      }
    } else {
      await queue.remove();
    }

    // novo agendamento: posição que estava vazia e agora tem agendamento
    if (!antes && depois.status !== 'cancelado') {
      const pendente = depois.status === 'pendente';
      await enviar(slug, depois, {
        tipo: 'novo', tag: `novo-${depois.id}`,
        title: pendente ? 'Novo agendamento (aguardando sinal)' : 'Novo agendamento',
        body: resumo(depois)
      });
      return;
    }

    // cancelamento
    if (antes && antes.id === depois.id && antes.status !== 'cancelado' && depois.status === 'cancelado') {
      await enviar(slug, depois, { tipo: 'cancelado', tag: `cancelado-${depois.id}`, title: 'Agendamento cancelado', body: resumo(depois) });
    }
  }
);

// ---------- 15 min antes de o sinal expirar ----------
exports.avisarSinalExpirando = onSchedule({ schedule: 'every 1 minutes', region: REGION, timeZone: TZ, maxInstances: 1 }, async () => {
  const agora = Date.now();
  const due = (await db.ref(`${BASE}/pushQueue`).orderByChild('dueAt').endAt(agora).once('value')).val() || {};
  for (const id of Object.keys(due)) {
    const q = due[id];
    const ref = db.ref(`${BASE}/pushQueue/${id}`);
    try {
      if (q.sent) { await ref.remove(); continue; }                 // limpeza
      if (q.deadline <= agora) { await ref.remove(); continue; }    // já expirou, não avisa

      const lista = toList((await db.ref(`${BASE}/tenants/${q.slug}/appointments`).once('value')).val());
      const a = lista.find((x) => x.id === q.appId);
      if (!a || a.status !== 'pendente') { await ref.remove(); continue; }

      const fim = a.depositDeadline ? new Date(a.depositDeadline).getTime() : q.deadline;
      if (fim - agora > AVISO_MIN * 60000) { await ref.update({ deadline: fim, dueAt: fim - AVISO_MIN * 60000 }); continue; } // prazo foi alterado

      const min = Math.max(1, Math.round((fim - agora) / 60000));
      const ate = new Date(fim).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
      await ref.update({ sent: true, dueAt: fim + 24 * 3600 * 1000 });  // marca antes de enviar: nunca avisa duas vezes
      await enviar(q.slug, a, {
        tipo: 'sinal_expirando', tag: `sinal-${a.id}`,
        title: `Sinal expira em ${min} min`,
        body: `${resumo(a)} — confirme o pagamento até ${ate} ou o horário será liberado.`
      });
    } catch (e) {
      console.error('avisarSinalExpirando', id, e);
    }
  }
});
