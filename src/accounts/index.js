'use strict';

/**
 * User registration & organization profiles.
 *
 * When switched on (Supabase configured, or demo mode), people must register their organization,
 * verify their work email and be an active member of their organization before they can use the
 * migrator. Microsoft sign-in for Power Platform is unchanged and still happens inside the tool.
 *
 * Sessions: the browser only gets an HttpOnly cookie with a random session id. The Supabase access
 * and refresh tokens stay on this server. "Keep me signed in" stores the refresh token in
 * data/account-sessions.json (readable by this user only) so the tool can be restarted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const rules = require('./rules');

const { AccountError } = rules;
const COOKIE = 'psm_sid';
const REMEMBER_DAYS = 30;
const ACCOUNT_TTL_MS = 30 * 1000;

let backend = null;
let backendKey = null;
const sessions = new Map(); // sid -> session

// --- configuration -------------------------------------------------------------------------------
function mode() {
  // A hosted migrator is always behind registration: without it, everyone would share one workspace.
  if (config.registration === 'off' && !config.hosted) return 'off';
  if (config.supabaseUrl && config.supabaseAnonKey) return 'supabase';
  if (config.mockMode && config.registration !== 'off') return 'demo';
  return config.registration === 'on' || config.hosted ? 'misconfigured' : 'off';
}
const enabled = () => mode() !== 'off';

function getBackend() {
  const m = mode();
  const key = `${m}|${config.supabaseUrl}|${config.supabaseAnonKey}`;
  if (backend && backendKey === key) return backend;
  backendKey = key;
  sessions.clear();
  if (m === 'supabase') backend = require('./supabase').create({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey });
  else if (m === 'demo') backend = require('./mock').create({ seed: true });
  else backend = null;
  if (m !== 'demo') loadRemembered();
  return backend;
}
function requireBackend() {
  const b = getBackend();
  if (!b) throw new AccountError('Registration is switched on, but Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on the Settings page or in .env.', 503);
  return b;
}

// --- remembered sessions (refresh tokens on disk, this machine only) --------------------------------
const rememberFile = () => path.join(config.dataDir, 'account-sessions.json');
function loadRemembered() {
  try {
    const all = JSON.parse(fs.readFileSync(rememberFile(), 'utf8'));
    for (const [sid, s] of Object.entries(all)) {
      if (s.key === backendKey && s.until > Date.now()) sessions.set(sid, { refreshToken: s.refreshToken, accessToken: null, expiresAt: 0, user: s.user, remember: true, until: s.until });
    }
  } catch { /* none yet */ }
}
function saveRemembered() {
  if (mode() === 'demo') return; // the demo backend lives in memory only
  const out = {};
  for (const [sid, s] of sessions) if (s.remember && s.refreshToken) out[sid] = { refreshToken: s.refreshToken, user: s.user, until: s.until, key: backendKey };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${rememberFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, rememberFile());
  } catch (err) { console.warn(`Could not save sign-in sessions: ${err.message}`); }
}

// --- cookies & sessions -------------------------------------------------------------------------------
function readSid(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}
function setCookie(req, res, sid, remember) {
  const parts = [`${COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (req.secure || req.get('x-forwarded-proto') === 'https') parts.push('Secure');
  if (remember) parts.push(`Max-Age=${REMEMBER_DAYS * 86400}`);
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res) { res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

function startSession(req, res, s, remember) {
  const old = readSid(req);
  if (old) sessions.delete(old);
  const sid = crypto.randomBytes(32).toString('base64url');
  const session = { ...s, remember: Boolean(remember), until: Date.now() + REMEMBER_DAYS * 86400000, account: null, accountAt: 0 };
  sessions.set(sid, session);
  setCookie(req, res, sid, remember);
  if (remember) saveRemembered();
  return session;
}

async function currentSession(req) {
  if (!enabled()) return null;
  const sid = readSid(req);
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (!s.accessToken || s.expiresAt - 60000 < Date.now()) {
    try {
      const fresh = await requireBackend().refresh(s.refreshToken);
      Object.assign(s, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt, user: fresh.user || s.user });
      if (s.remember) saveRemembered();
    } catch (err) {
      if (err.status === 401) { sessions.delete(sid); if (s.remember) saveRemembered(); return null; }
      throw err;
    }
  }
  s.sid = sid;
  return s;
}

// Loads the account; on the first sign-in after email verification this completes the registration.
async function loadAccount(s, force) {
  if (!force && s.account && Date.now() - s.accountAt < ACCOUNT_TTL_MS) return s.account;
  const b = requireBackend();
  let acc = await b.rpc(s.accessToken, 'psm_get_my_account');
  if (!acc || !acc.membership) acc = await b.rpc(s.accessToken, 'psm_complete_registration');
  s.account = acc;
  s.accountAt = Date.now();
  return acc;
}

const stateOf = (acc) => (!acc || !acc.membership ? 'incomplete' : acc.membership.status);

// Loads the account for a status answer; a registration problem is reported instead of failing.
async function accountFor(s, force) {
  try { return { acc: await loadAccount(s, force) }; } catch (err) {
    if (err.status === 401 || err.status >= 500) throw err;
    return { acc: null, error: err.message };
  }
}

function publicStatus(s, acc, accountError) {
  const b = getBackend();
  const out = { enabled: enabled(), backend: b ? b.kind : null, misconfigured: mode() === 'misconfigured', signedIn: Boolean(s), orgTypes: rules.ORG_TYPES };
  if (b && b.kind === 'demo') out.demo = { email: b.demoAccount.email, password: b.demoAccount.password };
  if (s) {
    out.user = { email: s.user && s.user.email };
    out.account = acc || null;
    out.state = stateOf(acc);
    out.isAdmin = Boolean(acc && acc.membership && acc.membership.status === 'active' && ['owner', 'admin'].includes(acc.membership.role));
    out.recovery = Boolean(s.recovery);
    if (accountError) out.accountError = accountError;
  }
  return out;
}

// --- simple rate limits (per IP, per action) ------------------------------------------------------
const hits = new Map();
function limit(req, action, max, minutes, extra = '') {
  const key = `${action}|${req.ip}|${extra}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => t > now - minutes * 60000);
  if (list.length >= max) throw new AccountError(`Too many attempts. Wait ${minutes} minutes and try again.`, 429);
  list.push(now);
  hits.set(key, list);
}

const appUrl = (req) => (config.appUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- routes: /api/account/* -----------------------------------------------------------------------
const router = express.Router();

router.get('/status', wrap(async (req, res) => {
  if (!enabled()) return res.json({ enabled: false });
  const s = await currentSession(req).catch(() => null);
  if (!s || s.recovery) return res.json(publicStatus(s, null));
  const { acc, error } = await accountFor(s, req.query.refresh === '1');
  res.json(publicStatus(s, acc, error));
}));

router.get('/org-exists', wrap(async (req, res) => {
  limit(req, 'org-exists', 60, 10);
  const domain = rules.normalizeDomain(req.query.domain);
  if (!rules.DOMAIN_RE.test(domain)) return res.json({ exists: false, valid: false });
  res.json({ exists: await requireBackend().organizationExists(domain), valid: true, freeMail: rules.isFreeMail(domain) });
}));

router.post('/register', wrap(async (req, res) => {
  const r = rules.validateRegistration(req.body); // invalid forms don't count against the limit
  limit(req, 'register', 20, 60);
  const b = requireBackend();
  const { email, ...meta } = r;
  const out = await b.signUp({ email, password: req.body.password, data: meta, redirectTo: `${appUrl(req)}/` });
  const reply = { ok: true, email, needsConfirmation: out.needsConfirmation, existingOrganization: await b.organizationExists(r.org_domain).catch(() => null) };
  if (out.demoVerifyToken) reply.demoVerifyUrl = `/api/account/demo-verify?token=${encodeURIComponent(out.demoVerifyToken)}`;
  res.status(201).json(reply);
}));

// Demo mode only: stands in for the link in the verification email.
router.get('/demo-verify', wrap(async (req, res) => {
  const b = requireBackend();
  if (b.kind !== 'demo') return res.status(404).end();
  const s = await b.demoVerify(String(req.query.token || ''));
  res.redirect(`/#access_token=${encodeURIComponent(s.accessToken)}&refresh_token=${encodeURIComponent(s.refreshToken)}&type=signup`);
}));

router.post('/login', wrap(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!rules.EMAIL_RE.test(email) || !password) throw new AccountError('Enter your work email and password.');
  limit(req, 'login', 8, 10, email);
  const s = startSession(req, res, await requireBackend().signIn(email, password), Boolean(req.body.remember));
  const { acc, error } = await accountFor(s, true);
  res.json(publicStatus(s, acc, error));
}));

// After the email link (verification or password reset): Supabase sends the user back to the
// tool with tokens in the URL fragment, which the page posts here once.
router.post('/session', wrap(async (req, res) => {
  limit(req, 'session', 20, 10);
  const b = requireBackend();
  const accessToken = String((req.body && req.body.accessToken) || '');
  const refreshToken = String((req.body && req.body.refreshToken) || '');
  if (!accessToken || !refreshToken || accessToken.length > 4096 || refreshToken.length > 1024) throw new AccountError('The link is not valid. Sign in instead.');
  const user = await b.getUser(accessToken); // validates the token with the account service
  const s = startSession(req, res, { accessToken, refreshToken, expiresAt: Date.now() + 50 * 60000, user }, false);
  s.recovery = req.body.type === 'recovery';
  if (s.recovery) return res.json(publicStatus(s, null));
  const { acc, error } = await accountFor(s, true);
  res.json(publicStatus(s, acc, error));
}));

router.post('/logout', wrap(async (req, res) => {
  const sid = readSid(req);
  const s = sid && sessions.get(sid);
  if (s) {
    sessions.delete(sid);
    if (s.remember) saveRemembered();
    if (s.accessToken && getBackend()) await getBackend().signOut(s.accessToken);
  }
  clearCookie(res);
  res.json({ ok: true });
}));

router.post('/resend', wrap(async (req, res) => {
  limit(req, 'resend', 4, 60);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!rules.EMAIL_RE.test(email)) throw new AccountError('Enter your work email.');
  await requireBackend().resendConfirmation(email, `${appUrl(req)}/`);
  res.json({ ok: true });
}));

router.post('/recover', wrap(async (req, res) => {
  limit(req, 'recover', 5, 60);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!rules.EMAIL_RE.test(email)) throw new AccountError('Enter your work email.');
  const out = await requireBackend().recover(email, `${appUrl(req)}/`) || {};
  // The same answer whether or not the email is registered.
  const reply = { ok: true };
  if (out.demoRecovery) reply.demoResetUrl = `/#access_token=${encodeURIComponent(out.demoRecovery.accessToken)}&refresh_token=${encodeURIComponent(out.demoRecovery.refreshToken)}&type=recovery`;
  res.json(reply);
}));

async function signedIn(req) {
  const s = await currentSession(req);
  if (!s) throw new AccountError('Sign in first.', 401);
  return s;
}

router.post('/password', wrap(async (req, res) => {
  const s = await signedIn(req);
  const password = rules.checkPassword(req.body && req.body.password);
  await requireBackend().updatePassword(s.accessToken, password);
  s.recovery = false;
  const { acc, error } = await accountFor(s, true);
  res.json(publicStatus(s, acc, error));
}));

router.put('/profile', wrap(async (req, res) => {
  const s = await signedIn(req);
  const b = req.body || {};
  const fullName = rules.clean(b.fullName, 120);
  const designation = rules.clean(b.designation, 120);
  const phone = rules.clean(b.phone, 30);
  if (fullName.length < 2) throw new AccountError('Enter your full name.', 400, { field: 'fullName' });
  if (designation.length < 2) throw new AccountError('Enter your designation or role.', 400, { field: 'designation' });
  if (phone && !rules.PHONE_RE.test(phone)) throw new AccountError('Enter a valid contact number, or leave it empty.', 400, { field: 'phone' });
  s.account = await requireBackend().rpc(s.accessToken, 'psm_update_my_profile', { p_full_name: fullName, p_designation: designation, p_phone: phone });
  s.accountAt = Date.now();
  res.json(publicStatus(s, s.account));
}));

router.put('/organization', wrap(async (req, res) => {
  const s = await signedIn(req);
  const b = req.body || {};
  const name = rules.clean(b.name, 200);
  const orgType = rules.clean(b.orgType, 60);
  const location = rules.clean(b.location, 120);
  if (name.length < 2) throw new AccountError('Enter the organization name.', 400, { field: 'orgName' });
  if (!rules.ORG_TYPES.includes(orgType)) throw new AccountError('Choose the organization type.', 400, { field: 'orgType' });
  if (location.length < 2) throw new AccountError('Enter the organization location.', 400, { field: 'orgLocation' });
  s.account = await requireBackend().rpc(s.accessToken, 'psm_update_organization', { p_name: name, p_org_type: orgType, p_location: location });
  s.accountAt = Date.now();
  res.json(publicStatus(s, s.account));
}));

router.get('/members', wrap(async (req, res) => {
  const s = await signedIn(req);
  res.json(await requireBackend().rpc(s.accessToken, 'psm_list_members'));
}));

router.post('/members/:userId', wrap(async (req, res) => {
  const s = await signedIn(req);
  const userId = String(req.params.userId);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new AccountError('Invalid user.');
  const status = req.body && req.body.status ? String(req.body.status) : null;
  const role = req.body && req.body.role ? String(req.body.role) : null;
  if (status && !['active', 'rejected', 'suspended', 'pending'].includes(status)) throw new AccountError('Invalid status.');
  if (role && !['owner', 'admin', 'member'].includes(role)) throw new AccountError('Invalid role.');
  res.json(await requireBackend().rpc(s.accessToken, 'psm_set_member', { p_user: userId, p_status: status, p_role: role }));
}));

// --- access gate ------------------------------------------------------------------------------------
// Everything except the page itself, /api/config and the account routes needs an active member.
const OPEN_API = [/^\/api\/config$/, /^\/api\/account(\/|$)/, /^\/api\/session\//];

function gate() {
  return wrap(async (req, res, next) => {
    if (!enabled()) return next();
    const isApi = req.path.startsWith('/api/');
    const isAuth = req.path.startsWith('/auth/');
    if (!isApi && !isAuth) return next();
    if (isApi && OPEN_API.some((re) => re.test(req.path))) return next();
    // Switched on but not configured: only Settings is reachable, so it can be fixed from the page.
    if (mode() === 'misconfigured' && /^\/api\/settings$/.test(req.path)) return next();
    const s = await currentSession(req).catch(() => null);
    const acc = s ? await loadAccount(s).catch(() => null) : null;
    if (s && !s.recovery && stateOf(acc) === 'active') {
      req.account = {
        userId: s.user && s.user.id,
        orgId: acc.organization && acc.organization.id,
        email: s.user && s.user.email,
        name: acc.profile && acc.profile.full_name,
        organization: acc.organization && acc.organization.name,
        role: acc.membership.role,
      };
      return next();
    }
    const message = !s ? 'Sign in to the PowerApps Solution Migrator first.' : 'Your account is not active yet.';
    if (isApi) return res.status(401).json({ error: { message, accountRequired: true, status: 401 } });
    return res.status(401).type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign in required</title><body style="font-family:sans-serif;padding:24px">${message} <a href="/">Open the migrator</a>.</body>`);
  });
}

module.exports = { router, gate, enabled, mode, _sessions: sessions, _reset: () => { backend = null; backendKey = null; sessions.clear(); hits.clear(); } };
