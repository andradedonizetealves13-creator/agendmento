'use strict';
/**
 * syncRole (callable): confere no servidor se o login é administrador ou profissional de uma empresa
 * e grava o papel no próprio login (custom claim "staff": { [slug]: "admin" | "employee" }).
 * As regras do Realtime Database usam esse claim para liberar a gravação.
 *
 * Entrada:  { slug? }   (sem slug, a função procura a empresa pelo e-mail/uid do login)
 * Saída:    { slug, role, id }
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.database();

const BASE = 'agendapro_saas';
const SLUG_RE = /^[^.$#\[\]\/]+$/;

function toList(v) { return Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []); }
const lower = (v) => String(v || '').toLowerCase();

// devolve { role, id } se este login pertence à empresa; senão null.
// - admin: vale pelo uid gravado na criação da empresa (não depende de e-mail)
// - e-mail só vale se estiver VERIFICADO (senão qualquer um criaria conta com o e-mail de outra pessoa)
function matchTenant(tenant, uid, email, emailVerified) {
  if (!tenant) return null;
  const a = tenant.admin || {};
  if ([a.id, a.uid, a.authUid].some(v => v && String(v) === uid)) return { role: 'admin', id: uid };
  if (!email) return null;
  const byAdminEmail = lower(a.email) === email;
  const emp = toList(tenant.employees).find(e => lower(e.email) === email);
  if (!byAdminEmail && !emp) return null;
  if (!emailVerified) return { needsVerify: true };
  return byAdminEmail ? { role: 'admin', id: uid } : { role: 'employee', id: String(emp.id || uid) };
}

exports.syncRole = onCall({ region: 'us-central1', cors: true, maxInstances: 10 }, async (request) => {
  try {
    return await syncRoleImpl(request);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('syncRole falhou', e);
    throw new HttpsError('internal', 'Falha no servidor: ' + String((e && (e.code || e.message)) || e).slice(0, 200));
  }
});

async function syncRoleImpl(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre na sua conta para continuar.');
  const uid = request.auth.uid;
  const email = lower(request.auth.token && request.auth.token.email);
  const emailVerified = !!(request.auth.token && request.auth.token.email_verified);
  let pendingVerify = false;

  let slug = request.data && request.data.slug;
  let found = null;

  if (slug !== undefined && slug !== null && slug !== '') {
    if (typeof slug !== 'string' || slug.length > 100 || !SLUG_RE.test(slug)) {
      throw new HttpsError('invalid-argument', 'Empresa inválida.');
    }
    const t = (await db.ref(`${BASE}/tenants/${slug}`).once('value')).val();
    found = matchTenant(t, uid, email, emailVerified);
  } else {
    // atalho: empresas criadas com Google usam o e-mail como identificador
    if (email) {
      const guess = email.replace(/[^a-zA-Z0-9]/g, '_');
      const candidates = [guess, String(request.auth.token.email).replace(/[^a-zA-Z0-9]/g, '_')];
      for (const s of candidates) {
        const t = (await db.ref(`${BASE}/tenants/${s}`).once('value')).val();
        const m = matchTenant(t, uid, email, emailVerified);
        if (m && m.needsVerify) pendingVerify = true;
        else if (m) { slug = s; found = m; break; }
      }
    }
    if (!found) {
      const all = (await db.ref(`${BASE}/tenants`).once('value')).val() || {};
      for (const s of Object.keys(all)) {
        const m = matchTenant(all[s], uid, email, emailVerified);
        if (m && m.needsVerify) pendingVerify = true;
        else if (m) { slug = s; found = m; break; }
      }
    }
  }

  if (found && found.needsVerify) pendingVerify = true;
  if (pendingVerify && (!found || found.needsVerify)) {
    throw new HttpsError('failed-precondition', 'email-nao-verificado');
  }
  if (!found) throw new HttpsError('permission-denied', 'Este login não pertence a nenhuma empresa.');

  const user = await admin.auth().getUser(uid);
  const claims = Object.assign({}, user.customClaims || {});
  const staff = Object.assign({}, claims.staff || {});
  if (staff[slug] !== found.role) {
    staff[slug] = found.role;
    claims.staff = staff;
    await admin.auth().setCustomUserClaims(uid, claims);
  }
  return { slug, role: found.role, id: found.id };
}
