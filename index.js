// Primstav — Cloud Functions
// 1) syncRole: confere no servidor se o login é admin/profissional da organização e grava o papel
//    no próprio login (custom claims: { staff: { "<slug>": "admin" | "employee" } }).
// 2) sendReminders: todo dia, avisa por e-mail os clientes que têm horário confirmado amanhã.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const TENANTS = 'agendapro_saas/tenants';
const TZ = 'America/Sao_Paulo';

const toList = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []));
const lower = (v) => String(v || '').toLowerCase().trim();

function roleInTenant(t, uid, email) {
  if (!t) return null;
  const a = t.admin || {};
  if (a.id === uid || (a.email && lower(a.email) === email && email)) return { role: 'admin', id: a.id || uid };
  const emp = toList(t.employees).find((e) => e.uid === uid || e.id === uid || (e.email && lower(e.email) === email && email));
  if (emp) return { role: 'employee', id: emp.id };
  return null;
}

exports.syncRole = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Faça login primeiro.');
  const uid = req.auth.uid;
  const email = lower(req.auth.token.email);
  const db = admin.database();
  let slug = req.data && typeof req.data.slug === 'string' ? req.data.slug : null;
  let found = null;

  if (slug) {
    if (/[.$#\[\]\/]/.test(slug)) throw new HttpsError('invalid-argument', 'Organização inválida.');
    const t = (await db.ref(`${TENANTS}/${slug}`).get()).val();
    const r = roleInTenant(t, uid, email);
    if (r) found = { slug, ...r };
  } else {
    const all = (await db.ref(TENANTS).get()).val() || {};
    for (const s of Object.keys(all)) {
      const r = roleInTenant(all[s], uid, email);
      if (r) { found = { slug: s, ...r }; break; }
    }
  }

  if (!found) return { role: 'client' };   // cliente comum: não recebe papel especial

  const user = await admin.auth().getUser(uid);
  const claims = user.customClaims || {};
  const staff = { ...(claims.staff || {}), [found.slug]: found.role };
  await admin.auth().setCustomUserClaims(uid, { ...claims, staff });
  return found;   // { slug, role, id }
});

// ---- Lembretes automáticos (e-mail pela extensão "Trigger Email from Firestore") ----
// Requer: plano Blaze, Firestore ativo e a extensão instalada com a coleção "mail".
// WhatsApp exige um provedor de envio (ex.: API oficial da Meta); isso é um passo à parte.
function dateInTz(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

exports.sendReminders = onSchedule({ schedule: 'every day 09:00', timeZone: TZ }, async () => {
  const db = admin.database();
  const fs = admin.firestore();
  const tomorrow = dateInTz(1);
  const all = (await db.ref(TENANTS).get()).val() || {};

  for (const slug of Object.keys(all)) {
    const t = all[slug];
    const clients = toList(t.clients);
    const apps = Array.isArray(t.appointments) ? t.appointments : Object.values(t.appointments || {});
    const keys = Array.isArray(t.appointments) ? apps.map((_, i) => String(i)) : Object.keys(t.appointments || {});

    for (let i = 0; i < apps.length; i++) {
      const a = apps[i];
      if (!a || a.date !== tomorrow || a.status === 'cancelado' || a.status === 'nao_compareceu' || a.status === 'pendente' || a.reminderSentAt) continue;
      const c = clients.find((x) => x.id === a.clientId);
      if (!c || !c.email) continue;
      const when = `${a.date.split('-').reverse().join('/')} às ${a.time}`;
      await fs.collection('mail').add({
        to: c.email,
        message: {
          subject: `Lembrete: seu horário amanhã às ${a.time} — ${t.name || ''}`,
          html: `<p>Olá, ${String(a.beneficiaryName || a.clientName || '').replace(/</g, '')}!</p>` +
                `<p>Lembrando do seu horário em <b>${when}</b> (${(a.proceduresNames || []).join(', ')}) em <b>${String(t.name || '').replace(/</g, '')}</b>.</p>` +
                `<p>Precisa remarcar? Acesse o link de agendamento da empresa.</p>`
        }
      });
      await db.ref(`${TENANTS}/${slug}/appointments/${keys[i]}/reminderSentAt`).set(new Date().toISOString());
    }
  }
});
