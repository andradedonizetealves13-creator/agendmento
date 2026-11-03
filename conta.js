'use strict';
/**
 * Exclusão da conta (empresa) pelo próprio administrador.
 *   deleteOrganization (callable)  exige: logado + ADMIN da empresa + senha/Google confirmada há ≤ 5 min + texto "EXCLUIR"
 *
 * Apaga: tenants/{slug}, billing/{slug}, providers/{slug}, providerSecrets/{slug}, secrets/{slug} (token do Mercado Pago),
 *        pushTokens/{slug} e o índice de payments dessa empresa.
 * Também apaga o login (Firebase Auth) do administrador, SE ele não for equipe de outra empresa.
 * Não apaga: logins de funcionários e de clientes (podem existir em outras empresas).
 *
 * No index.js:  Object.assign(exports, require('./conta'));
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.database();

const BASE = 'agendapro_saas';
const SLUG_RE = /^[^.$#\[\]\/]+$/;
const FRESH_LOGIN_SECONDS = 300;

function isTenantAdmin(request, slug, tenant) {
  const tok = request.auth.token || {};
  const uid = request.auth.uid;
  const claim = tok.staff && tok.staff[slug];
  if (claim === 'admin' || (claim && typeof claim === 'object' && claim.role === 'admin')) return true;
  const a = (tenant && tenant.admin) || {};
  if ([a.id, a.uid, a.authUid].some((v) => v && String(v) === uid)) return true;
  if (a.email && tok.email && String(a.email).toLowerCase() === String(tok.email).toLowerCase()) return true;
  return false;
}

exports.deleteOrganization = onCall({ region: 'us-central1', cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta para continuar.');
  const d = request.data || {};
  const slug = String(d.slug || '');
  if (!slug || slug.length > 100 || !SLUG_RE.test(slug)) throw new HttpsError('invalid-argument', 'Empresa inválida.');
  if (d.confirm !== 'EXCLUIR') throw new HttpsError('invalid-argument', 'Digite EXCLUIR para confirmar.');

  const tenant = (await db().ref(`${BASE}/tenants/${slug}`).get()).val();
  if (!tenant) throw new HttpsError('not-found', 'Empresa não encontrada.');
  if (!isTenantAdmin(request, slug, tenant)) throw new HttpsError('permission-denied', 'Só o administrador da empresa pode excluir a conta.');
  const authTime = Number(request.auth.token.auth_time || 0);
  if (!authTime || Date.now() / 1000 - authTime > FRESH_LOGIN_SECONDS) throw new HttpsError('failed-precondition', 'Confirme sua senha para continuar.');

  const updates = {};
  ['tenants', 'billing', 'providers', 'providerSecrets', 'secrets', 'pushTokens'].forEach((p) => { updates[`${BASE}/${p}/${slug}`] = null; });
  try {
    const snap = await db().ref(`${BASE}/payments`).orderByChild('slug').equalTo(slug).get();
    snap.forEach((c) => { updates[`${BASE}/payments/${c.key}`] = null; });
  } catch (e) { console.warn('payments (índice):', e.message); }
  await db().ref().update(updates);

  // apaga o login só se ele não for equipe de outra empresa
  const staff = (request.auth.token && request.auth.token.staff) || {};
  const outras = Object.keys(staff).filter((k) => k !== slug);
  let authDeleted = false;
  if (!outras.length) {
    try { await admin.auth().deleteUser(request.auth.uid); authDeleted = true; }
    catch (e) { console.warn('deleteUser:', e.message); }
  }
  console.log(`Empresa ${slug} excluída pelo admin ${request.auth.uid}`);
  return { ok: true, authDeleted };
});
