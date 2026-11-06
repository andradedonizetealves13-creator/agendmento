/* Primstav - ações de assinatura (cancelar, reativar, alterar plano)
 * As regras do banco só deixam o dono da plataforma gravar em billing/*; por isso o painel chama esta função,
 * que confere se quem pediu é o administrador da empresa e grava com permissão de servidor. */
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const MAX = { individual: 1, equipe: 3, crescimento: 6, avancado: 10 };
// R$ 19,99 com 1 profissional + R$ 15 por profissional extra (+ R$ 15 no Prime). Anual = 10x o mensal.
const preco = (max, nivel) => +(19.99 + 15 * (max - 1) + (nivel === 'automacao' ? 15 : 0)).toFixed(2);
const fail = (code, msg) => { throw new functions.https.HttpsError(code, msg); };

exports.assinaturaAcao = functions.https.onCall(async (data, context) => {
  if (!context.auth) fail('unauthenticated', 'Entre na sua conta para continuar.');
  const slug = String((data && data.slug) || '');
  if (!slug || /[.#$\[\]\/]/.test(slug)) fail('invalid-argument', 'Empresa inválida.');
  const db = admin.database();
  const adminId = (await db.ref(`agendapro_saas/tenants/${slug}/admin/id`).get()).val();
  if (adminId !== context.auth.uid) fail('permission-denied', 'Só o administrador da empresa pode alterar a assinatura.');

  const ref = db.ref(`agendapro_saas/billing/${slug}/assinatura`);
  const s = (await ref.get()).val();
  if (!s) fail('not-found', 'Assinatura não encontrada.');
  const acao = String(data.acao || '');

  if (acao === 'cancelar') {
    if (s.status === 'cancelada') return { ok: true };
    await ref.update({ status: 'cancelada', statusAnterior: s.status || 'trial', canceladoEm: Date.now() });
    return { ok: true, acessoAte: s.acessoAte || null };
  }

  if (acao === 'reativar') {
    if (s.status !== 'cancelada') return { ok: true };
    if (!s.acessoAte || s.acessoAte <= Date.now()) fail('failed-precondition', 'O período de acesso já terminou. Fale com o suporte para renovar.');
    await ref.update({ status: s.statusAnterior || 'trial', canceladoEm: null, reativadoEm: Date.now() });
    return { ok: true };
  }

  if (acao === 'alterar') {
    const plano = String(data.plano || ''), nivel = data.nivel === 'automacao' ? 'automacao' : 'basico';
    if (!MAX[plano]) fail('invalid-argument', 'Plano inválido.');
    if (s.status === 'cancelada') fail('failed-precondition', 'Reative a assinatura antes de mudar de plano.');
    const empregados = (await db.ref(`agendapro_saas/tenants/${slug}/employees`).get()).numChildren();
    if (MAX[plano] < 1 + empregados) fail('failed-precondition', `Você tem ${1 + empregados} profissionais (contando com você). Remova profissionais antes de reduzir o plano.`);
    const m = preco(MAX[plano], nivel);
    await ref.update({ plano, nivel, maxProfissionais: MAX[plano], valor: s.ciclo === 'anual' ? +(m * 10).toFixed(2) : m, alteradoEm: Date.now() });
    return { ok: true };
  }

  fail('invalid-argument', 'Ação inválida.');
});
