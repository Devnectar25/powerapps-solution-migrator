'use strict';

// User registration & organization profiles: demo backend (same rules as supabase/schema.sql)
// through the HTTP API, plus the Supabase connector against a fake Supabase server.
process.env.MOCK_MODE = 'true';
process.env.MOCK_SPEED = '0.01';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'psm-acc-'));
process.env.ENV_FILE = require('path').join(process.env.DATA_DIR, 'test.env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../server');

let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// A tiny browser: keeps the session cookie, sends the same-origin header like the page does.
function browser() {
  let cookie = '';
  const req = async (method, p, body, extra = {}) => {
    const r = await fetch(base + p, {
      method,
      redirect: 'manual',
      headers: { 'X-PSM-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) { const m = set.match(/psm_sid=([^;]*)/); if (m) cookie = m[1] ? `psm_sid=${m[1]}` : ''; }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: r.status, body: json, location: r.headers.get('location'), setCookie: set };
  };
  return { get: (p) => req('GET', p), post: (p, b, h) => req('POST', p, b || {}, h), put: (p, b) => req('PUT', p, b) };
}

const reg = (o = {}) => ({
  orgName: 'Powercraft', orgDomain: 'powercraft.co', orgType: 'Microsoft partner / consultancy', orgLocation: 'Pune, India',
  fullName: 'Vinod Mahajan', email: 'vinod@powercraft.co', designation: 'Director', phone: '+91 98765 43210', password: 'Strong-Pass-2026', ...o,
});

// Registers, opens the (demo) verification link and posts the tokens like the page does.
async function registerAndVerify(b, data) {
  const r = await b.post('/api/account/register', data);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await b.get(r.body.demoVerifyUrl);
  assert.equal(v.status, 302);
  const frag = new URLSearchParams(v.location.split('#')[1]);
  return b.post('/api/account/session', { accessToken: frag.get('access_token'), refreshToken: frag.get('refresh_token'), type: frag.get('type') });
}

test('the tool is locked until the user is signed in and active', async () => {
  const b = browser();
  assert.equal((await b.get('/api/config')).body.registration, true);
  const st = await b.get('/api/account/status');
  assert.equal(st.body.enabled, true);
  assert.equal(st.body.signedIn, false);
  assert.equal(st.body.backend, 'demo');
  for (const p of ['/api/auth/status', '/api/history', '/api/profiles', '/api/settings']) {
    const r = await b.get(p);
    assert.equal(r.status, 401, p);
    assert.equal(r.body.error.accountRequired, true);
  }
  assert.equal((await b.get('/auth/login?slot=source')).status, 401);
  assert.equal((await b.get('/')).status, 200, 'the page itself loads (it shows the sign-in screen)');
});

test('registration form is validated: work email, matching domain, strong password', async () => {
  const b = browser();
  const cases = [
    [{ email: 'vinod@gmail.com' }, 'email', /official work email/],
    [{ email: 'vinod@contoso.com' }, 'email', /must match the organization domain/],
    [{ orgDomain: 'gmail.com', email: 'x@gmail.com' }, 'orgDomain', /Personal email domains/],
    [{ password: 'short' }, 'password', /at least 10/],
    [{ password: 'alllowercase123' }, 'password', /upper-case/],
    [{ orgType: 'Spaceship' }, 'orgType', /organization type/],
    [{ phone: 'call me' }, 'phone', /valid contact number/],
  ];
  for (const [o, field, msg] of cases) {
    const r = await b.post('/api/account/register', reg(o));
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.body.error.field, field);
    assert.match(r.body.error.message, msg);
  }
  const ok = await b.post('/api/account/register', reg({ orgDomain: 'https://www.Example-Org.com/', email: 'Ann@Example-Org.com', fullName: 'Ann' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.email, 'ann@example-org.com');
});

let ownerBrowser;
let pendingUserId;

test('first user of a domain verifies the email, creates the organization and becomes owner', async () => {
  const b = browser();
  const r = await b.post('/api/account/register', reg());
  assert.equal(r.body.needsConfirmation, true);
  assert.equal(r.body.existingOrganization, false);
  const early = await b.post('/api/account/login', { email: 'vinod@powercraft.co', password: 'Strong-Pass-2026' });
  assert.equal(early.status, 403);
  assert.match(early.body.error.message, /Verify your email/);
  const v = await b.get(r.body.demoVerifyUrl);
  const frag = new URLSearchParams(v.location.split('#')[1]);
  const s = await b.post('/api/account/session', { accessToken: frag.get('access_token'), refreshToken: frag.get('refresh_token'), type: 'signup' });
  assert.equal(s.status, 200);
  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /SameSite=Lax/);
  assert.equal(s.body.state, 'active');
  assert.equal(s.body.isAdmin, true);
  assert.equal(s.body.account.membership.role, 'owner');
  assert.equal(s.body.account.organization.name, 'Powercraft');
  assert.equal(s.body.account.profile.designation, 'Director');
  assert.ok(!JSON.stringify(s.body).includes(frag.get('access_token')), 'tokens never go back to the browser');
  assert.equal((await b.get('/api/history')).status, 200, 'the tool is open now');
  assert.equal((await b.get('/api/account/org-exists?domain=powercraft.co')).body.exists, true);
  ownerBrowser = b;
});

test('a colleague from the same domain joins as pending and is approved by the owner', async () => {
  const b = browser();
  const s = await registerAndVerify(b, reg({ fullName: 'Aniket Mali', email: 'aniket@powercraft.co', designation: 'Consultant', orgName: 'Powercraft Pvt Ltd', orgLocation: 'Mumbai' }));
  assert.equal(s.body.state, 'pending');
  assert.equal(s.body.account.organization.name, 'Powercraft', 'joins the existing organization, no duplicate');
  assert.equal((await b.get('/api/history')).status, 401, 'pending users cannot use the tool');
  assert.deepEqual((await b.get('/api/account/members')).body, [], 'non-admins see no member list');

  const list = (await ownerBrowser.get('/api/account/members')).body;
  assert.equal(list.length, 2);
  const aniket = list.find((m) => m.email === 'aniket@powercraft.co');
  assert.equal(aniket.status, 'pending');
  pendingUserId = aniket.user_id;
  const after = await ownerBrowser.post(`/api/account/members/${aniket.user_id}`, { status: 'active' });
  assert.equal(after.body.find((m) => m.email === 'aniket@powercraft.co').status, 'active');

  const st = await b.get('/api/account/status?refresh=1');
  assert.equal(st.body.state, 'active');
  assert.equal(st.body.isAdmin, false);
  assert.equal((await b.get('/api/history')).status, 200);
  const deny = await b.post(`/api/account/members/${pendingUserId}`, { role: 'admin' });
  assert.equal(deny.status, 403);
});

test('owners cannot change their own role; the last owner is protected; organizations are isolated', async () => {
  const me = (await ownerBrowser.get('/api/account/members')).body.find((m) => m.email === 'vinod@powercraft.co');
  const self = await ownerBrowser.post(`/api/account/members/${me.user_id}`, { role: 'member' });
  assert.equal(self.status, 403);
  assert.match(self.body.error.message, /own role/);

  const other = browser();
  const s = await registerAndVerify(other, reg({ orgName: 'Fabrikam', orgDomain: 'fabrikam.com', fullName: 'Fiona', email: 'fiona@fabrikam.com', designation: 'CIO', orgType: 'Enterprise', orgLocation: 'Paris' }));
  assert.equal(s.body.account.membership.role, 'owner');
  const list = (await other.get('/api/account/members')).body;
  assert.deepEqual(list.map((m) => m.email), ['fiona@fabrikam.com']);
  const cross = await other.post(`/api/account/members/${pendingUserId}`, { status: 'suspended' });
  assert.equal(cross.status, 403);
  assert.match(cross.body.error.message, /not in your organization/);
});

test('profile and organization details can be edited; only owners/admins edit the organization', async () => {
  const p = await ownerBrowser.put('/api/account/profile', { fullName: 'Vinod M', designation: 'Managing Director', phone: '' });
  assert.equal(p.body.account.profile.full_name, 'Vinod M');
  assert.equal(p.body.account.profile.phone, null);
  const o = await ownerBrowser.put('/api/account/organization', { name: 'Powercraft', orgType: 'Microsoft partner / consultancy', location: 'Pune, Maharashtra, India' });
  assert.equal(o.body.account.organization.location, 'Pune, Maharashtra, India');
  assert.equal((await ownerBrowser.put('/api/account/organization', { name: 'X', orgType: 'Enterprise', location: 'Y' })).status, 400);
});

test('sign out ends the session; password reset works; wrong passwords are rate limited', async () => {
  const b = browser();
  const login = await b.post('/api/account/login', { email: 'aniket@powercraft.co', password: 'Strong-Pass-2026' });
  assert.equal(login.body.state, 'active');
  await b.post('/api/account/logout');
  assert.equal((await b.get('/api/history')).status, 401);

  const rec = await b.post('/api/account/recover', { email: 'aniket@powercraft.co' });
  assert.ok(rec.body.demoResetUrl);
  assert.deepEqual((await b.post('/api/account/recover', { email: 'nobody@powercraft.co' })).body, { ok: true }, 'same answer for unknown emails');
  const frag = new URLSearchParams(rec.body.demoResetUrl.split('#')[1]);
  const s = await b.post('/api/account/session', { accessToken: frag.get('access_token'), refreshToken: frag.get('refresh_token'), type: 'recovery' });
  assert.equal(s.body.recovery, true);
  assert.equal((await b.get('/api/history')).status, 401, 'a reset link alone does not open the tool');
  assert.equal((await b.post('/api/account/password', { password: 'weak' })).status, 400);
  const changed = await b.post('/api/account/password', { password: 'New-Strong-Pass-2027' });
  assert.equal(changed.body.state, 'active');
  await b.post('/api/account/logout');
  assert.equal((await b.post('/api/account/login', { email: 'aniket@powercraft.co', password: 'Strong-Pass-2026' })).status, 401);
  assert.equal((await b.post('/api/account/login', { email: 'aniket@powercraft.co', password: 'New-Strong-Pass-2027' })).body.state, 'active');

  const c = browser();
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/account/login', { email: 'fiona@fabrikam.com', password: 'Wrong-Pass-0000' });
  assert.equal(last.status, 429);
});

test('account requests need the page header; the demo account and seeded pending request exist', async () => {
  const csrf = await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@contoso.com', password: 'DemoPass2026' }) });
  assert.equal(csrf.status, 403);
  const b = browser();
  const st = await b.get('/api/account/status');
  const demo = await b.post('/api/account/login', { email: st.body.demo.email, password: st.body.demo.password });
  assert.equal(demo.body.state, 'active');
  const lee = (await b.get('/api/account/members')).body.find((m) => m.email === 'lee.chen@contoso.com');
  assert.equal(lee.status, 'pending');
});

test('an active member reaches the migration API through the gate', async () => {
  const b = browser();
  await b.post('/api/account/login', { email: 'admin@contoso.com', password: 'DemoPass2026' });
  const r = await b.post('/api/migrations', {});
  assert.equal(r.status, 400, 'a validation error from the migration API, not 401 from the gate');
  assert.doesNotMatch(r.body.error.message, /Sign in to the PowerApps Solution Migrator/);
});

test('settings refuse the Supabase service-role key', async () => {
  const b = browser();
  await b.post('/api/account/login', { email: 'admin@contoso.com', password: 'DemoPass2026' });
  const fake = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;
  const bad = await b.put('/api/settings', { supabaseUrl: 'https://abcdefghijklmnop.supabase.co', supabaseAnonKey: fake({ role: 'service_role' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /service-role/);
  const badUrl = await b.put('/api/settings', { supabaseUrl: 'ftp://x' });
  assert.equal(badUrl.status, 400);
});

test('Supabase connector: request format and error messages (fake Supabase server)', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, apikey: req.headers.apikey, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url.startsWith('/auth/v1/signup')) return send(200, { id: 'u1', email: 'a@b.co' });
      if (req.url.startsWith('/auth/v1/token?grant_type=password')) {
        const b = JSON.parse(body);
        if (b.password !== 'Right-Pass-123') return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.co', email_confirmed_at: '2026-01-01' } });
      }
      if (req.url === '/rest/v1/rpc/psm_get_my_account') return send(200, { profile: null, membership: null, organization: null });
      if (req.url === '/rest/v1/rpc/psm_complete_registration') return send(400, { code: 'P0001', message: 'Your email domain (b.co) does not match the organization domain (c.co).' });
      if (req.url === '/rest/v1/rpc/psm_list_members') return send(404, { code: 'PGRST202', message: 'Could not find the function' });
      if (req.url === '/rest/v1/rpc/psm_organization_exists') return send(200, true);
      return send(404, {});
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const sb = require('../src/accounts/supabase').create({ url: `http://127.0.0.1:${fake.address().port}/`, anonKey: 'ANON' });
  try {
    const up = await sb.signUp({ email: 'a@b.co', password: 'Right-Pass-123', data: { org_domain: 'b.co' }, redirectTo: 'http://localhost:3000/' });
    assert.equal(up.needsConfirmation, true);
    assert.equal(seen[0].url, '/auth/v1/signup?redirect_to=http%3A%2F%2Flocalhost%3A3000%2F');
    assert.equal(seen[0].apikey, 'ANON');
    assert.deepEqual(seen[0].body, { email: 'a@b.co', password: 'Right-Pass-123', data: { org_domain: 'b.co' } });
    await assert.rejects(sb.signIn('a@b.co', 'wrong'), (e) => e.status === 401 && /not correct/.test(e.message));
    const s = await sb.signIn('a@b.co', 'Right-Pass-123');
    assert.equal(s.accessToken, 'AT');
    assert.equal(s.user.confirmed, true);
    await sb.rpc('AT', 'psm_get_my_account');
    assert.equal(seen[seen.length - 1].auth, 'Bearer AT', 'data calls run as the signed-in user');
    await assert.rejects(sb.rpc('AT', 'psm_complete_registration'), (e) => e.status === 400 && /does not match/.test(e.message));
    await assert.rejects(sb.rpc('AT', 'psm_list_members'), (e) => e.status === 503 && /schema\.sql/.test(e.message));
    assert.equal(await sb.organizationExists('b.co'), true);
    assert.equal(seen[seen.length - 1].auth, undefined, 'anonymous calls send the key only in the apikey header');
    assert.equal(seen[seen.length - 1].apikey, 'ANON');
  } finally { fake.close(); }
});
