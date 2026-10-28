// functions/whatsappPix.js
// Dispara uma mensagem no WhatsApp assim que o Pix de um agendamento é gerado.
//
// Como funciona: o seu mpCreatePix já grava o código "copia e cola" em
//   agendapro_saas/tenants/{org}/appointments/{id}/mpPixCode
// Esta função "escuta" esse campo. Quando ele aparece, ela envia o WhatsApp.
//
// No index.js:  Object.assign(exports, require('./whatsappPix'));
// Instalar:     firebase functions:secrets:set WA_API_KEY
//               (opcional) firebase functions:config / .env com WA_API_URL e WA_INSTANCE

const { onValueCreated } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');

const WA_API_KEY = defineSecret('WA_API_KEY');
const WA_API_URL = process.env.WA_API_URL || 'https://SUA-EVOLUTION-API.com'; // troque
const WA_INSTANCE = process.env.WA_INSTANCE || 'minha-instancia';              // troque

// ---- Envio (exemplo: Evolution API). Para outro provedor, mude só esta função ----
async function sendWhatsApp(phone, text) {
  const res = await fetch(`${WA_API_URL}/message/sendText/${WA_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: WA_API_KEY.value() },
    body: JSON.stringify({ number: phone, text }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
}

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const toBR = (d) => (d.length <= 11 ? '55' + d : d); // DDD + número -> 55 + DDD + número
const dateBR = (iso) => String(iso || '').split('-').reverse().join('/');
const money = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');

exports.whatsappPixGerado = onValueCreated(
  {
    ref: '/agendapro_saas/tenants/{org}/appointments/{key}/mpPixCode',
    secrets: [WA_API_KEY],
    // region: 'us-central1', // deve ser a mesma região do seu Realtime Database
  },
  async (event) => {
    const pixCode = event.data.val();
    if (!pixCode) return;

    // lê o agendamento inteiro (pai do campo mpPixCode)
    const snap = await event.data.ref.parent.get();
    const a = snap.val() || {};

    const phone = onlyDigits(a.clientPhone);
    if (phone.length < 10) return console.warn('Agendamento sem telefone válido', event.params.key);

    // evita enviar duas vezes se o Pix for regerado
    if (a.waPixSentAt) return;

    const msg =
      `Olá, ${String(a.clientName || '').split(' ')[0]}! 💜\n\n` +
      `Seu horário está reservado:\n` +
      `📅 ${dateBR(a.date)} às ${a.time}\n` +
      `💅 ${(a.proceduresNames || []).join(', ')}\n\n` +
      `Para confirmar, pague o sinal de *${money(a.depositAmount)}* por Pix.\n` +
      (a.depositDeadline
        ? `⏰ Pague até ${new Date(a.depositDeadline).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}.\n`
        : '') +
      `\nCopie o código abaixo e cole no app do seu banco (Pix copia e cola) 👇`;

    const to = toBR(phone);
    await sendWhatsApp(to, msg);
    await sendWhatsApp(to, pixCode); // em mensagem separada: fica fácil de copiar

    await event.data.ref.parent.child('waPixSentAt').set(new Date().toISOString());
  }
);
