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

// devolve { role, id } se este login pertence à empresa; senão null
function matchTenant(tenant, uid, email) {
  if (!tenant) return null;
  const a = tenant.admin || {};
  if ([a.id, a.uid, a.authUid].some(v => v && String(v) === uid) || (email && lower(a.email) === email)) {
    return { role: 'admin', id: uid };
  }
  if (email) {
    const emp = toList(tenant.employees).find(e => lower(e.email) === email);
    if (emp) return { role: 'employee', id: String(emp.id || uid) };
  }
  return null;
}

exports.syncRole = onCall({ region: 'us-central1', cors: true }, async (request) => {
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

  let slug = request.data && request.data.slug;
  let found = null;

  if (slug !== undefined && slug !== null && slug !== '') {
    if (typeof slug !== 'string' || slug.length > 100 || !SLUG_RE.test(slug)) {
      throw new HttpsError('invalid-argument', 'Empresa inválida.');
    }
    const t = (await db.ref(`${BASE}/tenants/${slug}`).once('value')).val();
    found = matchTenant(t, uid, email);
  } else {
    // atalho: empresas criadas com Google usam o e-mail como identificador
    if (email) {
      const guess = email.replace(/[^a-zA-Z0-9]/g, '_');
      const candidates = [guess, String(request.auth.token.email).replace(/[^a-zA-Z0-9]/g, '_')];
      for (const s of candidates) {
        const t = (await db.ref(`${BASE}/tenants/${s}`).once('value')).val();
        const m = matchTenant(t, uid, email);
        if (m) { slug = s; found = m; break; }
      }
    }
    if (!found) {
      const all = (await db.ref(`${BASE}/tenants`).once('value')).val() || {};
      for (const s of Object.keys(all)) {
        const m = matchTenant(all[s], uid, email);
        if (m) { slug = s; found = m; break; }
      }
    }
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
