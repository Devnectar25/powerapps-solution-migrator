'use strict';

// Hosted mode: many users on one server. Each user has their own Microsoft sign-ins and running
// migrations; profiles and history are shared only within an organization.
process.env.MOCK_MODE = 'true';
process.env.MOCK_SPEED = '0.01';
process.env.HOSTED = 'true';
process.env.APP_URL = 'https://migrator.example.com';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'psm-host-'));
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

function browser() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { 'X-PSM-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) { const m = set.match(/psm_sid=([^;]*)/); if (m) cookie = m[1] ? `psm_sid=${m[1]}` : ''; }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
    return { status: r.status, body: json, location: r.headers.get('location'), headers: r.headers };
  };
  return {
    get: (p, h) => req('GET', p, null, h), post: (p, b, h) => req('POST', p, b || {}, h), put: (p, b) => req('PUT', p, b), del: (p) => req('DELETE', p),
    // Microsoft sign-in (demo): /auth/login redirects to the callback, which completes it.
    async msSignIn(slot) { const r = await req('GET', `/auth/login?slot=${slot}`); assert.equal(r.status, 302); await req('GET', r.location); },
  };
}

async function login(b, email, password = 'DemoPass2026') {
  const r = await b.post('/api/account/login', { email, password });
  assert.equal(r.body.state, 'active', JSON.stringify(r.body));
}

async function registerOrg(b, email, orgName, domain) {
  const r = await b.post('/api/account/register', { orgName, orgDomain: domain, orgType: 'Enterprise', orgLocation: 'Paris', fullName: 'Fiona', email, designation: 'CIO', password: 'Strong-Pass-2026' });
  const v = await b.get(r.body.demoVerifyUrl);
  const f = new URLSearchParams(v.location.split('#')[1]);
  const s = await b.post('/api/account/session', { accessToken: f.get('access_token'), refreshToken: f.get('refresh_token'), type: 'signup' });
  assert.equal(s.body.state, 'active');
}

const owner = browser(); // admin@contoso.com, owner of Contoso Ltd
const colleague = browser(); // lee.chen@contoso.com, same organization
const outsider = browser(); // fiona@fabrikam.com, another organization
let runId;

test('hosted mode: health check, security headers, settings locked, registration always on', async () => {
  const h = await owner.get('/healthz');
  assert.deepEqual(h.body, { ok: true, hosted: true });
  assert.match(h.headers.get('strict-transport-security'), /max-age/);
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
  const cfg = await owner.get('/api/config');
  assert.equal(cfg.body.hosted, true);
  assert.equal(cfg.body.registration, true);
  assert.equal(cfg.body.redirectUri, 'https://migrator.example.com/auth/callback');
  assert.equal((await owner.get('/api/history')).status, 401);

  await login(owner, 'admin@contoso.com');
  const s = await owner.get('/api/settings');
  assert.equal(s.body.hosted, true);
  assert.equal(s.body.envFile, undefined, 'no server paths for users');
  const put = await owner.put('/api/settings', { clientId: '3d7c1ae2-f89d-4d8f-ad33-662f352bceb5' });
  assert.equal(put.status, 403);
});

test('a request from the public address (behind a proxy) is accepted; another site is refused', async () => {
  const ok = await owner.post('/api/account/logout', {}, { Origin: 'https://migrator.example.com' });
  assert.equal(ok.status, 200);
  await login(owner, 'admin@contoso.com');
  const bad = await owner.post('/api/account/logout', {}, { Origin: 'https://evil.example.net' });
  assert.equal(bad.status, 403);
});

test('Microsoft sign-ins are per user', async () => {
  const members = (await owner.get('/api/account/members')).body;
  const lee = members.find((m) => m.email === 'lee.chen@contoso.com');
  await owner.post(`/api/account/members/${lee.user_id}`, { status: 'active' });
  await login(colleague, 'lee.chen@contoso.com');
  await registerOrg(outsider, 'fiona@fabrikam.com', 'Fabrikam', 'fabrikam.com');

  await owner.msSignIn('source');
  assert.equal((await owner.get('/api/auth/status')).body.source.signedIn, true);
  assert.equal((await colleague.get('/api/auth/status')).body.source.signedIn, false, 'a colleague does not get the owner\'s Microsoft sign-in');
  assert.equal((await outsider.get('/api/auth/status')).body.source.signedIn, false);
  assert.equal((await outsider.get('/api/source/tenants')).status, 401, 'no tenants without your own Microsoft sign-in');
});

test('migrations: visible to the organization, stoppable only by the person who started them', async () => {
  const tenants = (await owner.get('/api/source/tenants')).body;
  const contoso = tenants.find((t) => t.displayName === 'Contoso Ltd');
  const envs = (await owner.get(`/api/source/tenants/${contoso.tenantId}/environments`)).body;
  const dev = envs.find((e) => e.name === 'Contoso Development');
  const tst = envs.find((e) => e.name === 'Contoso Test');
  const sols = (await owner.get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`)).body;
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const start = await owner.post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: tst.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'HostedRun', displayName: 'Hosted run' },
    configuration: { skipped: true },
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  runId = start.body.id;
  assert.equal(start.body.appUser.email, 'admin@contoso.com');

  assert.equal((await outsider.get(`/api/migrations/${runId}`)).status, 404, 'another organization cannot see it');
  assert.equal((await outsider.post(`/api/migrations/${runId}/stop`)).status, 404);
  assert.equal((await colleague.get(`/api/migrations/${runId}`)).status, 200, 'a colleague can follow it');
  const stop = await colleague.post(`/api/migrations/${runId}/stop`);
  assert.equal(stop.status, 403);
  assert.match(stop.body.error.message, /Only the person who started/);

  for (let i = 0; i < 400; i++) {
    const m = await owner.get(`/api/migrations/${runId}`);
    if (m.body.status !== 'running') { assert.ok(['succeeded', 'attention'].includes(m.body.status), JSON.stringify(m.body.error)); break; }
    await new Promise((r) => setTimeout(r, 25));
  }
});

test('history, packages and profiles are shared within the organization only', async () => {
  assert.ok((await owner.get('/api/history')).body.some((r) => r.id === runId));
  assert.ok((await colleague.get('/api/history')).body.some((r) => r.id === runId));
  assert.deepEqual((await outsider.get('/api/history')).body, []);
  assert.equal((await outsider.get(`/api/migrations/${runId}/package`)).status, 404);
  assert.equal((await colleague.get(`/api/migrations/${runId}/package`)).status, 200);
  assert.equal((await outsider.del(`/api/history/${runId}`)).status, 404);

  const prof = { name: 'Contoso nightly', mode: 'same', source: { tenantId: 'x', envId: 'y' }, target: { tenantId: 'x', envId: 'z' }, solution: { uniqueName: 'ContosoSalesHub', displayName: 'Contoso Sales Hub' } };
  const saved = await owner.post('/api/profiles', prof);
  assert.equal(saved.status, 201);
  assert.ok((await colleague.get('/api/profiles')).body.some((p) => p.id === saved.body.id));
  assert.deepEqual((await outsider.get('/api/profiles')).body, []);
  assert.equal((await outsider.del(`/api/profiles/${saved.body.id}`)).status, 404);
  const same = await outsider.post('/api/profiles', prof);
  assert.equal(same.status, 201, 'profile names only need to be unique within an organization');
});
