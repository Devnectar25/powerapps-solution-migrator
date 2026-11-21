'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./src/config');
const network = require('./src/network');

network.setupNetwork();
const realAuth = require('./src/auth');
const migration = require('./src/migration');
const configuration = require('./src/configuration');
const store = require('./src/store');
const settings = require('./src/settings');
const lifecycle = require('./src/lifecycle');
const accounts = require('./src/accounts');
const workspace = require('./src/workspace');
const fs = require('fs');

const provider = config.mockMode ? require('./src/providers/mock') : require('./src/providers/dataverse');
const auth = config.mockMode ? provider.auth : realAuth;

const app = express();
app.disable('x-powered-by');
if (config.hosted) {
  // Behind the hosting platform's HTTPS front end (Azure App Service, a container platform, Vercel proxy).
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set({
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
}
// Health probe for the hosting platform (no data, no sign-in).
app.get('/healthz', (req, res) => res.json({ ok: true, hosted: config.hosted }));
app.use(express.json({ limit: '1mb' }));

// Only this app's own page may change things. A web page on another site can't add this header
// to a cross-site request without a CORS preflight, which this server never approves, so
// websites you visit can't change settings or start migrations behind your back.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Sent by navigator.sendBeacon when the tab closes (beacons can't add headers). It can only
  // remove the page id it names, which other sites can't know, so it is safe to accept.
  if (req.path === '/session/closed') return next();
  const origin = req.get('origin');
  const host = req.get('host');
  const fwdHost = req.get('x-forwarded-host');
  // Behind a proxy (for example Vercel forwarding the public address to the server), the page's
  // origin is the public address (APP_URL), not the server's own host name.
  const sameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`
    || (config.appUrl && origin === new URL(config.appUrl).origin) || (config.hosted && fwdHost && origin === `https://${fwdHost}`);
  if (req.get('x-psm-request') !== '1' || !sameOrigin) {
    return res.status(403).json({ error: { message: 'Request refused: it did not come from the migrator page.' } });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// User registration & organization profiles: account routes, then the access gate for the tool.
if (!config.hosted) app.set('trust proxy', 'loopback');
app.use('/api/account', accounts.router);
app.use(accounts.gate());
// Each signed-in user works in their own workspace (Microsoft sign-ins, migrations); profiles and
// history are shared within their organization. Without registration: one local workspace.
app.use((req, res, next) => {
  const a = req.account;
  if (!a || !a.userId) return workspace.run(workspace.LOCAL, next);
  return workspace.run({ key: `u:${a.userId}`, org: a.orgId ? `o:${a.orgId}` : `u:${a.userId}`, user: a }, next);
});

// --- caches (single-user local tool) -------------------------------------------------------
// Per workspace (one per user when hosted): tenants and environments each signed-in account can see.
const caches = new Map(); // workspace key -> { tenants: Map(slot -> [tenant]), envs: Map(`${slot}|${tenantId}` -> [env]), lastUser: {} }
const wsCache = () => {
  const k = workspace.key();
  if (!caches.has(k)) caches.set(k, { tenants: new Map(), envs: new Map(), lastUser: {} });
  return caches.get(k);
};

const SLOT_RE = /^(source|target)$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function checkSlot(slot) {
  if (!SLOT_RE.test(slot)) throw badRequest(`Invalid connection "${slot}".`);
  return slot;
}

function checkGuid(v, what) {
  if (!GUID_RE.test(v || '')) throw badRequest(`Invalid ${what}.`);
  return v.toLowerCase();
}

async function getEnvironment(slot, tenantId, envId) {
  const key = `${slot}|${tenantId}`;
  if (!wsCache().envs.has(key)) wsCache().envs.set(key, await provider.directory(slot).listEnvironments(tenantId));
  const env = wsCache().envs.get(key).find((e) => e.id.toLowerCase() === envId.toLowerCase());
  if (!env) throw Object.assign(new Error('Environment not found. Refresh the environment list.'), { status: 404 });
  return env;
}

function tenantInfo(slot, tenantId) {
  const t = (wsCache().tenants.get(slot) || []).find((x) => x.tenantId.toLowerCase() === tenantId.toLowerCase());
  return { tenantId, displayName: (t && t.displayName) || tenantId, defaultDomain: (t && t.defaultDomain) || '' };
}

// Only scopes for the Microsoft services this tool calls may be requested at sign-in.
function isAllowedScope(scope) {
  if (scope === `${config.armUrl}/user_impersonation` || scope === `${config.discoveryUrl}/.default` || scope === config.powerAppsScope) return true;
  const m = scope.match(/^https:\/\/([a-z0-9.-]+)\/\.default$/i);
  return Boolean(m && config.dataverseHostSuffixes.some((s) => m[1].toLowerCase().endsWith(s)));
}

function sanitizeConfiguration(c) {
  if (!c || typeof c !== 'object') return { skipped: true, connectionReferences: [], environmentVariables: [] };
  const str = (v, max = 500) => String(v ?? '').slice(0, max);
  return {
    skipped: Boolean(c.skipped),
    connectionReferences: (Array.isArray(c.connectionReferences) ? c.connectionReferences : []).slice(0, 500)
      .filter((x) => x && x.logicalName && x.connectionId)
      .map((x) => ({ logicalName: str(x.logicalName, 200), displayName: str(x.displayName, 200), connectorId: str(x.connectorId, 300), connectionId: str(x.connectionId, 200), connectionName: str(x.connectionName, 200) })),
    environmentVariables: (Array.isArray(c.environmentVariables) ? c.environmentVariables : []).slice(0, 500)
      .filter((x) => x && x.schemaName && x.value !== undefined && x.value !== null)
      .map((x) => ({ schemaName: str(x.schemaName, 200), displayName: str(x.displayName, 200), value: str(x.value, 100000) })),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- config & auth ----------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ mockMode: config.mockMode, configured: config.isConfigured, redirectUri: config.redirectUri, autoExit: lifecycle.enabled(), registration: accounts.enabled(), hosted: config.hosted, serverless: config.serverless });
});

// The page's "I'm still open" signal; when every page is closed the migrator stops (AUTO_EXIT).
app.post('/api/session/heartbeat', (req, res) => {
  lifecycle.heartbeat(req.body && req.body.id);
  res.json({ ok: true, migrationRunning: migration.isRunning() });
});
app.post('/api/session/closed', express.text({ type: '*/*' }), (req, res) => {
  let id = null;
  try { id = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}).id; } catch { /* ignore */ }
  lifecycle.closed(id);
  res.status(204).end();
});

app.get('/api/auth/status', (req, res) => res.json(auth.getStatus()));

app.get('/auth/login', wrap(async (req, res) => {
  if (!config.isConfigured) throw badRequest('CLIENT_ID is not configured. See README.md › Configuration.');
  const slot = checkSlot(req.query.slot);
  const tenant = req.query.tenant ? String(req.query.tenant) : undefined;
  if (tenant && !GUID_RE.test(tenant) && !/^[a-z0-9.-]+$/i.test(tenant)) throw badRequest('Invalid tenant.');
  const scope = req.query.scope ? String(req.query.scope) : undefined;
  if (scope && !isAllowedScope(scope)) throw badRequest('Invalid scope.');
  res.redirect(await auth.getLoginUrl(slot, tenant, { scope, popup: req.query.popup === '1' }));
}));

// Opens a Power Apps maker link as the source or target account: a quick Microsoft sign-in with
// that account (usually no prompt) makes it the active one, then the browser goes on to Power Apps.
app.get('/auth/open', wrap(async (req, res) => {
  const slot = checkSlot(String(req.query.slot || ''));
  const tenant = String(req.query.tenant || '');
  const next = String(req.query.next || '');
  if (!next.startsWith(`${config.makerPortalUrl}/`)) throw badRequest('Only Power Apps maker portal links can be opened this way.');
  if (tenant && !GUID_RE.test(tenant)) throw badRequest('Invalid tenant.');
  const account = (auth.getStatus()[slot] || {}).account;
  if (config.mockMode || !account) return res.redirect(next);
  res.redirect(await auth.getLoginUrl(slot, tenant || undefined, { next }));
}));

app.get('/auth/callback', async (req, res) => {
  // Sign-in started by /auth/open: continue to the Power Apps page whatever the outcome.
  const openNext = typeof auth.pendingNext === 'function' ? auth.pendingNext(String(req.query.state || '')) : null;
  if (openNext) {
    try { await auth.handleCallback(req.query); } catch (err) { console.warn(`Sign-in before opening Power Apps failed: ${err.message}`); }
    return res.redirect(openNext);
  }
  let payload;
  const popup = typeof auth.isPopupLogin === 'function' && auth.isPopupLogin(String(req.query.state || ''));
  try {
    const before = ((auth.getStatus()[req.query.slot || ''] || {}).account || {}).username;
    const result = await auth.handleCallback(req.query);
    // Only a different account invalidates the cached tenants / environments (not consent or MFA).
    const prior = before || wsCache().lastUser[result.slot];
    if (!prior || !result.account || prior.toLowerCase() !== String(result.account.username).toLowerCase()) {
      wsCache().tenants.delete(result.slot);
      for (const k of wsCache().envs.keys()) if (k.startsWith(`${result.slot}|`)) wsCache().envs.delete(k);
    }
    if (result.account) wsCache().lastUser[result.slot] = result.account.username;
    payload = { type: 'psm-auth', ok: true, slot: result.slot, account: result.account };
  } catch (err) {
    let message = err.message;
    if (/network_error|fetch failed|Request timeout/i.test(message)) {
      // MSAL hides the low-level cause; probe the token endpoint ourselves to find it.
      const p = await network.probe(`${config.authorityHost}/common/discovery/instance?api-version=1.1&authorization_endpoint=${config.authorityHost}/common/oauth2/v2.0/authorize`);
      message = p
        ? `The migrator server could not reach ${new URL(config.authorityHost).host} to complete sign-in (${p.code}: ${p.message}).\n\n${p.hint}\n\nRun "npm run diagnose" for a full connectivity check.`
        : `${message}\n\nThe server can reach ${new URL(config.authorityHost).host} now; please try signing in again. If it keeps failing, run "npm run diagnose".`;
    }
    payload = { type: 'psm-auth', ok: false, error: message };
  }
  payload.id = crypto.randomUUID();
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  // Popup: Microsoft's login page sets Cross-Origin-Opener-Policy, which severs window.opener.
  // So notify the main page through BroadcastChannel/localStorage (same origin), then close.
  // Full-page redirect (popup blocked): hand the result over via sessionStorage and go home.
  const script = popup
    ? `const p=${json};
try{const c=new BroadcastChannel('psm-auth');c.postMessage(p);c.close();}catch(e){}
try{localStorage.setItem('psm-auth-msg',JSON.stringify(p));localStorage.removeItem('psm-auth-msg');}catch(e){}
try{if(window.opener)window.opener.postMessage(p,location.origin);}catch(e){}
setTimeout(function(){window.close();},150);
setTimeout(function(){document.getElementById('m').hidden=false;},800);`
    : `const p=${json};try{sessionStorage.setItem('psm-auth',JSON.stringify(p));}catch(e){}location.replace('/');`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Sign-in | Powercraft</title><link rel="icon" type="image/svg+xml" href="/brand/powercraft-icon.svg"></head>
<body style="font-family:Poppins,system-ui,Segoe UI,sans-serif;margin:0;text-align:center;color:#110f1a;background:#fff7f5"><div style="background:#200a40;padding:16px"><img src="/brand/powercraft-logo-white.svg" alt="Powercraft" style="height:26px"></div><div style="padding:24px">
<p style="font-size:16px;font-weight:600">${payload.ok ? 'Signed in successfully.' : 'Sign-in failed.'}</p>
<div id="m" hidden><p>You can close this window and return to the migrator.</p>
<button onclick="window.close()" style="font:inherit;padding:8px 16px;border-radius:6px;border:0;background:#ff5126;color:#fff;cursor:pointer">Close window</button></div>
</div><script>${script}</script></body></html>`);
});

app.post('/api/auth/logout', wrap(async (req, res) => {
  const slot = checkSlot(req.body && req.body.slot);
  await auth.signOut(slot);
  wsCache().tenants.delete(slot);
  for (const k of wsCache().envs.keys()) if (k.startsWith(`${slot}|`)) wsCache().envs.delete(k);
  res.json(auth.getStatus());
}));

// --- directory --------------------------------------------------------------------------------
app.get('/api/tenants/resolve', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) throw badRequest('Enter a tenant ID or domain (e.g. contoso.onmicrosoft.com).');
  if (!GUID_RE.test(q) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(q)) throw badRequest('Enter a tenant ID (GUID) or a verified domain name.');
  if (config.mockMode) {
    const t = provider.tenants.find((x) => x.tenantId === q || x.defaultDomain === q);
    if (!t) throw Object.assign(new Error(`Tenant "${q}" was not found.`), { status: 404 });
    return res.json(t);
  }
  const r = await fetch(`${config.authorityHost}/${encodeURIComponent(q)}/v2.0/.well-known/openid-configuration`);
  if (!r.ok) throw Object.assign(new Error(`Tenant "${q}" was not found.`), { status: 404 });
  const meta = await r.json();
  const tenantId = (meta.issuer.match(/[0-9a-f-]{36}/i) || [])[0];
  if (!tenantId) throw new Error('Could not resolve the tenant ID.');
  res.json({ tenantId, displayName: GUID_RE.test(q) ? tenantId : q, defaultDomain: GUID_RE.test(q) ? '' : q });
}));

app.get('/api/:slot/tenants', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenants = await provider.directory(slot).listTenants();
  wsCache().tenants.set(slot, tenants);
  res.json(tenants);
}));

// Lets the UI register a manually added tenant so its display name appears in the summary.
app.post('/api/:slot/tenants', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const t = req.body || {};
  checkGuid(t.tenantId, 'tenant ID');
  const list = wsCache().tenants.get(slot) || [];
  if (!list.some((x) => x.tenantId.toLowerCase() === t.tenantId.toLowerCase())) {
    list.push({ tenantId: t.tenantId, displayName: String(t.displayName || t.tenantId).slice(0, 200), defaultDomain: String(t.defaultDomain || '').slice(0, 200), manual: true });
  }
  wsCache().tenants.set(slot, list);
  res.json(list);
}));

app.get('/api/:slot/tenants/:tenantId/environments', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const envs = await provider.directory(slot).listEnvironments(tenantId);
  wsCache().envs.set(`${slot}|${tenantId}`, envs);
  res.json(envs);
}));

app.get('/api/:slot/tenants/:tenantId/environments/:envId/solutions', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment(slot, tenantId, checkGuid(req.params.envId, 'environment ID'));
  res.json(await provider.dataverse(slot, tenantId, env).listSolutions());
}));

// Does a solution with this unique name exist in an environment? (target check on Options & review)
app.get('/api/:slot/tenants/:tenantId/environments/:envId/solution-by-name/:uniqueName', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment(slot, tenantId, checkGuid(req.params.envId, 'environment ID'));
  const name = String(req.params.uniqueName || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,64}$/.test(name)) throw badRequest('Invalid solution name.');
  const solution = await provider.dataverse(slot, tenantId, env).findSolutionByUniqueName(name);
  res.json({ exists: Boolean(solution), solution });
}));

app.get('/api/:slot/tenants/:tenantId/environments/:envId/solutions/:solutionId/components', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment(slot, tenantId, checkGuid(req.params.envId, 'environment ID'));
  res.json(await provider.dataverse(slot, tenantId, env).listComponents(checkGuid(req.params.solutionId, 'solution ID')));
}));

// Connection references & environment variables of a solution, with their state in the target.
app.get('/api/source/tenants/:tenantId/environments/:envId/solutions/:solutionId/configuration', wrap(async (req, res) => {
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment('source', tenantId, checkGuid(req.params.envId, 'environment ID'));
  const tSlot = checkSlot(String(req.query.targetSlot || ''));
  const tTenant = checkGuid(String(req.query.targetTenantId || ''), 'target tenant ID');
  const tEnv = await getEnvironment(tSlot, tTenant, checkGuid(String(req.query.targetEnvId || ''), 'target environment ID'));
  const src = provider.dataverse('source', tenantId, env);
  const tgt = provider.dataverse(tSlot, tTenant, tEnv);
  const solution = await src.getSolution(checkGuid(req.params.solutionId, 'solution ID'));
  const components = await src.listComponents(solution.id);
  const data = await configuration.getSolutionConfiguration(src, tgt, solution, components);
  res.json({ ...data, target: { environmentId: tEnv.environmentId || null, name: tEnv.name, connectionsUrl: tEnv.environmentId ? `${config.makerPortalUrl}/environments/${tEnv.environmentId}/connections` : null } });
}));

// Connections available in an environment for one connector.
app.get('/api/:slot/tenants/:tenantId/environments/:envId/connections', wrap(async (req, res) => {
  const slot = checkSlot(req.params.slot);
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment(slot, tenantId, checkGuid(req.params.envId, 'environment ID'));
  const connector = String(req.query.connector || '');
  try {
    res.json(await provider.dataverse(slot, tenantId, env).listConnections(connector));
  } catch (err) {
    if (err instanceof realAuth.AuthRequiredError) { err.scope = err.scope || config.powerAppsScope; throw err; }
    if (err.status === 401 || err.status === 403) {
      throw Object.assign(new Error(`Connections could not be listed: ${err.message}. Add the "PowerApps Service › User" delegated permission to the app registration, or paste the connection ID instead.`), { status: 403 });
    }
    throw err;
  }
}));

// Mandatory pre-migration check: are the solution's canvas apps published?
app.post('/api/source/tenants/:tenantId/environments/:envId/solutions/:solutionId/canvas-check', wrap(async (req, res) => {
  const tenantId = checkGuid(req.params.tenantId, 'tenant ID');
  const env = await getEnvironment('source', tenantId, checkGuid(req.params.envId, 'environment ID'));
  const src = provider.dataverse('source', tenantId, env);
  const excluded = new Set((Array.isArray(req.body && req.body.excludedComponentIds) ? req.body.excludedComponentIds : []).map((x) => String(x).toLowerCase()));
  const components = (await src.listComponents(checkGuid(req.params.solutionId, 'solution ID'))).filter((c) => !excluded.has(String(c.id).toLowerCase()));
  res.json(await configuration.checkCanvasApps(src, components));
}));

// Demo mode only: simulate publishing a canvas app in Studio.
if (config.mockMode) {
  app.post('/api/mock/publish-canvas-app', (req, res) => {
    const ok = provider.publishCanvasApp(String((req.body && req.body.displayName) || ''));
    res.status(ok ? 200 : 404).json({ published: ok });
  });
}

// --- settings (app registration) ---------------------------------------------------------------
app.get('/api/settings', (req, res) => res.json(settings.getSettings()));
app.put('/api/settings', wrap(async (req, res) => {
  // On a hosted server the settings belong to whoever runs the server, not to its users.
  if (config.hosted) throw Object.assign(new Error('This migrator is hosted: its settings are managed with environment variables on the server.'), { status: 403 });
  const { changed, settings: s } = settings.updateSettings(req.body);
  if (changed && !config.mockMode) {
    // A different app registration: existing sign-ins and caches belong to the old one.
    realAuth.reset();
    caches.clear();
  }
  res.json({ ...s, changed });
}));

// --- profiles -------------------------------------------------------------------------------------
app.get('/api/profiles', (req, res) => {
  const runs = store.listRuns();
  res.json(store.listProfiles().map((p) => {
    const last = runs.find((r) => r.profile && r.profile.id === p.id);
    return { ...p, lastRun: last ? { id: last.id, status: last.status, outcome: last.outcome, startedAt: last.startedAt } : null };
  }));
});
app.post('/api/profiles', wrap(async (req, res) => res.status(201).json(store.saveProfile(req.body))));
app.put('/api/profiles/:id', wrap(async (req, res) => res.json(store.saveProfile(req.body, req.params.id))));
app.delete('/api/profiles/:id', wrap(async (req, res) => { store.deleteProfile(req.params.id); res.status(204).end(); }));

// --- history --------------------------------------------------------------------------------------
app.get('/api/history', (req, res) => res.json(store.listRuns()));
app.delete('/api/history/:id', wrap(async (req, res) => { store.deleteRun(req.params.id); res.status(204).end(); }));

// --- migrations -------------------------------------------------------------------------------
app.post('/api/migrations', wrap(async (req, res) => {
  if (config.serverless) {
    throw Object.assign(new Error('Migrations can\'t run on this deployment: it runs on serverless functions (such as Vercel), which stop after each request, so a long export or import is cut off and its progress is lost. Run the migrator as a continuously running Node.js server (see DEPLOYMENT.md).'), { status: 503 });
  }
  const b = req.body || {};
  const side = async (s, name) => {
    if (!s) throw badRequest(`Missing ${name} selection.`);
    const slot = checkSlot(s.slot);
    const tenantId = checkGuid(s.tenantId, `${name} tenant`);
    const env = await getEnvironment(slot, tenantId, checkGuid(s.envId, `${name} environment`));
    const tenant = tenantInfo(slot, tenantId);
    if (tenant.displayName === tenantId && s.tenantName) tenant.displayName = String(s.tenantName).slice(0, 200);
    return { slot, tenant, env };
  };
  const packageOnly = b.mode === 'package';
  const source = await side(b.source, 'source');
  const target = packageOnly ? null : await side(b.target, 'target');
  const m = migration.startMigration({
    packageOnly,
    source,
    target,
    solutionId: checkGuid(b.solutionId, 'solution'),
    excludedComponentIds: Array.isArray(b.excludedComponentIds) ? b.excludedComponentIds.filter((x) => GUID_RE.test(x)) : [],
    rename: b.rename && b.rename.enabled
      ? { enabled: true, uniqueName: String(b.rename.uniqueName || '').trim(), displayName: String(b.rename.displayName || '').trim() }
      : null,
    options: {
      managed: Boolean(b.options && b.options.managed),
      overwriteUnmanagedCustomizations: b.options ? b.options.overwriteUnmanagedCustomizations !== false : true,
      publishWorkflows: b.options ? b.options.publishWorkflows !== false : true,
      publishBeforeExport: b.options ? b.options.publishBeforeExport !== false : true,
      publishAfterImport: b.options ? b.options.publishAfterImport !== false : true,
      includeMissingDependencies: b.options ? b.options.includeMissingDependencies !== false : true,
      acknowledgeUnverifiedCanvasApps: Boolean(b.options && b.options.acknowledgeUnverifiedCanvasApps),
      overrideCanvasCheck: Boolean(b.options && b.options.overrideCanvasCheck),
      confirmUpdateExisting: Boolean(b.options && b.options.confirmUpdateExisting),
    },
    configuration: sanitizeConfiguration(b.configuration),
    profile: b.profile && GUID_RE.test(b.profile.id || '') ? { id: b.profile.id, name: String(b.profile.name || '').slice(0, 120) } : null,
    startedBy: (auth.getStatus().source.account || {}).username || null,
    appUser: req.account || null,
  }, provider);
  res.status(202).json(m);
}));

app.get('/api/migrations', (req, res) => res.json(migration.listMigrations()));

app.post('/api/migrations/:id/stop', wrap(async (req, res) => {
  const m = migration.requestStop(req.params.id);
  if (!m) return res.status(404).json({ error: { message: 'Migration not found.' } });
  res.json(m);
}));

app.get('/api/migrations/:id', (req, res) => {
  const m = migration.getMigration(req.params.id);
  if (!m) return res.status(404).json({ error: { message: 'Migration not found.' } });
  res.json(m);
});

app.get('/api/migrations/:id/package', wrap(async (req, res) => {
  const i = migration.getInternal(req.params.id);
  if (i && i.package) return res.attachment(i.packageName).type('application/zip').send(i.package);
  if (!store.getRun(checkGuid(req.params.id, 'migration ID'))) return res.status(404).json({ error: { message: 'Migration not found.' } });
  const file = store.packagePath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: { message: 'The package for this migration is no longer available (only the newest packages are kept).' } });
  res.attachment(store.packageName(req.params.id)).type('application/zip').sendFile(file);
}));

app.get('/api/migrations/:id/import-log', wrap(async (req, res) => {
  if (!migration.getInternal(req.params.id) && !store.getRun(checkGuid(req.params.id, 'migration ID'))) return res.status(404).json({ error: { message: 'Migration not found.' } });
  const file = store.importLogPath(req.params.id);
  if (fs.existsSync(file)) return res.attachment(`ImportLog_${req.params.id}.xml`).type('application/xml').sendFile(file);
  const i = migration.getInternal(req.params.id);
  if (!i || !i.importJobId) return res.status(404).json({ error: { message: 'No import log available for this migration.' } });
  const xml = await i.targetClient.getImportLog(i.importJobId);
  res.attachment(`ImportLog_${i.importJobId}.xml`).type('application/xml').send(xml);
}));

// --- errors -------------------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: { message: `No route ${req.method} ${req.originalUrl}` } }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const body = { message: err.message || 'Unexpected error', status };
  if (err instanceof realAuth.AuthRequiredError) {
    body.authRequired = true;
    body.slot = err.slot;
    body.tenantId = err.tenantId || null;
    body.scope = err.scope || null;
    body.mfa = Boolean(err.mfa);
  }
  if (err.field) body.field = err.field;
  if (err.details && status >= 500) body.details = typeof err.details === 'string' ? err.details.slice(0, 2000) : err.details;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err.message);
  res.status(status).json({ error: body });
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* no browser launcher available; the URL is printed */ });
    child.unref();
  } catch { /* the URL is printed anyway */ }
}

if (require.main === module) {
  const url = `http://localhost:${config.port}`;
  const onListenError = (err) => {
    if (err.code === 'EADDRINUSE') {
      // Is it the migrator that's already running? Then just show it.
      fetch(`${url}/api/config`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json())
        .then((j) => {
          if (!j || typeof j.mockMode !== 'boolean') throw new Error('not the migrator');
          console.log(`The migrator is already running. Opening ${url}.`);
          if (process.env.OPEN_BROWSER === '1') openBrowser(url);
          process.exitCode = 0;
        })
        .catch(() => {
          console.error(`Port ${config.port} is used by another program. Set PORT=3001 (for example) in .env, and add the matching redirect URI (http://localhost:3001/auth/callback) to the app registration.`);
          process.exitCode = 1;
        });
      return;
    } else {
      console.error(`The migrator could not start: ${err.message}`);
    }
    process.exitCode = 1;
  };
  // Express 5 also calls this callback when listening fails, with the error.
  app.listen(config.port, config.host, (err) => {
    if (err) { onListenError(err); return; }
    console.log(`PowerApps Solution Migrator running at ${url}`);
    if (process.env.OPEN_BROWSER === '1') openBrowser(url);
    if (lifecycle.enabled()) {
      console.log('Closing the migrator tab in your browser stops the migrator (after any running migration finishes).');
      lifecycle.start({
        isBusy: () => migration.isRunning() || (!config.mockMode && realAuth.hasPendingLogin()),
        onExit: () => {
          console.log('The browser tab was closed: stopping the migrator.');
          process.exit(0);
        },
      });
    }
    const net = network.status();
    if (net.proxy) console.log(`Using proxy ${net.proxy}`);
    if (net.systemCa) console.log('Trusting the operating system certificate store.');
    console.log(`Request timeout: ${net.requestTimeoutMinutes} minutes.`);
    net.notes.forEach((n) => console.warn(`NOTE: ${n}`));
    if (config.mockMode) console.log('MOCK MODE: using simulated tenants, environments and solutions.');
    else if (config.clientId) console.log(`Real mode: app registration ${config.clientId}, redirect URI ${config.redirectUri}`);
    else if (!config.clientId) console.warn(`CLIENT_ID is not set yet: open ${url} and enter it under Settings.`);
  });
}

module.exports = app;
