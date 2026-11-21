'use strict';

/**
 * Supabase backend: Supabase Auth (GoTrue) for sign-up / sign-in / email verification / password
 * reset, and PostgREST RPC calls to the functions in supabase/schema.sql. Only the public anon key is
 * used; all data access runs as the signed-in user, so Row Level Security applies.
 */

const { AccountError } = require('./rules');

function create({ url, anonKey }) {
  const base = String(url).replace(/\/$/, '');
  // The key always goes in the apikey header. Authorization carries only a signed-in user's token:
  // the newer publishable keys (sb_publishable_…) are not JWTs and are rejected there.
  const headers = (token) => ({ apikey: anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json' });

  async function call(method, path, { token, body, query } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    let res;
    try {
      res = await fetch(`${base}${path}${qs}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new AccountError(`The account service (Supabase) could not be reached: ${err.cause ? err.cause.message || err.cause.code : err.message}.`, 503);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) throw toError(res.status, json, text);
    return json;
  }

  function toError(status, json, text) {
    const j = json || {};
    const code = j.error_code || j.code || j.error || '';
    const msg = j.msg || j.message || j.error_description || j.hint || text || `HTTP ${status}`;
    const known = {
      invalid_credentials: ['Email or password is not correct.', 401],
      invalid_grant: ['Email or password is not correct.', 401],
      email_not_confirmed: ['Verify your email address first: open the link in the email we sent you.', 403],
      user_already_exists: ['An account with this email already exists. Sign in instead.', 409],
      weak_password: [`The password is too weak: ${msg}`, 400],
      over_email_send_rate_limit: ['Too many emails were sent. Wait a few minutes and try again.', 429],
      over_request_rate_limit: ['Too many attempts. Wait a few minutes and try again.', 429],
      bad_jwt: ['Your session has expired. Sign in again.', 401],
      session_not_found: ['Your session has expired. Sign in again.', 401],
      refresh_token_not_found: ['Your session has expired. Sign in again.', 401],
      PGRST202: ['The registration database is not set up. Run supabase/schema.sql in your Supabase project (see SUPABASE_SETUP.md).', 503],
      '42883': ['The registration database is not set up. Run supabase/schema.sql in your Supabase project (see SUPABASE_SETUP.md).', 503],
    }[code];
    if (known) return new AccountError(known[0], known[1], { code });
    if (/^(28000|22023|42501|P0001)$/.test(code)) return new AccountError(msg, code === '42501' ? 403 : 400, { code });
    if (status === 401 || status === 403) return new AccountError('Your session has expired. Sign in again.', 401, { code });
    return new AccountError(`The account service reported an error: ${msg}`, status >= 500 ? 502 : 400, { code });
  }

  const session = (j) => ({
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
    user: j.user ? { id: j.user.id, email: j.user.email, confirmed: Boolean(j.user.email_confirmed_at || j.user.confirmed_at) } : null,
  });

  return {
    kind: 'supabase',
    async signUp({ email, password, data, redirectTo }) {
      const j = await call('POST', '/auth/v1/signup', { body: { email, password, data }, query: { redirect_to: redirectTo } });
      // With email confirmation on, no session is returned until the email link is opened.
      return { needsConfirmation: !j || !j.access_token };
    },
    async signIn(email, password) { return session(await call('POST', '/auth/v1/token', { query: { grant_type: 'password' }, body: { email, password } })); },
    async refresh(refreshToken) { return session(await call('POST', '/auth/v1/token', { query: { grant_type: 'refresh_token' }, body: { refresh_token: refreshToken } })); },
    async getUser(accessToken) {
      const u = await call('GET', '/auth/v1/user', { token: accessToken });
      return { id: u.id, email: u.email, confirmed: Boolean(u.email_confirmed_at || u.confirmed_at) };
    },
    async signOut(accessToken) { await call('POST', '/auth/v1/logout', { token: accessToken }).catch(() => {}); },
    async resendConfirmation(email, redirectTo) { await call('POST', '/auth/v1/resend', { body: { type: 'signup', email }, query: { redirect_to: redirectTo } }); },
    async recover(email, redirectTo) { await call('POST', '/auth/v1/recover', { body: { email }, query: { redirect_to: redirectTo } }); },
    async updatePassword(accessToken, password) { await call('PUT', '/auth/v1/user', { token: accessToken, body: { password } }); },
    async rpc(accessToken, name, args = {}) { return call('POST', `/rest/v1/rpc/${name}`, { token: accessToken, body: args }); },
    async organizationExists(domain) { return Boolean(await call('POST', '/rest/v1/rpc/psm_organization_exists', { body: { p_domain: domain } })); },
  };
}

module.exports = { create };
