// Primstav — Cloud Functions
// 1) syncRole: confere no servidor se o login é admin/profissional da organização e grava o papel
//    no próprio login (custom claims: { staff: { "<slug>": "admin" | "employee" } }).
// 2) sendReminders: todo dia, avisa por e-mail os clientes que têm horário confirmado amanhã.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const TENANTS = 'agendapro_saas/tenants';
const TZ = 'America/Sao_Paulo';

const toList = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []));
const lower = (v) => String(v || '').toLowerCase().trim();

// syncRole (papel do login) e pagamentos (Mercado Pago) vivem em arquivos próprios
exports.syncRole = require('./roles').syncRole;
Object.assign(exports, require('./pagamentos'));

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
