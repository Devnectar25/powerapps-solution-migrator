'use strict';

process.env.MOCK_MODE = 'true';
process.env.MOCK_SPEED = '0.01';
process.env.MOCK_REGISTRATION = 'off'; // these tests cover the migrator itself; see accounts.test.js
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'psm-test-'));
process.env.ENV_FILE = require('path').join(process.env.DATA_DIR, 'test.env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const AdmZip = require('adm-zip');

const { renameSolution, readManifest, inspectPackage } = require('../src/solutionPackage');
const { parseImportJobData } = require('../src/providers/dataverse');
const app = require('../server');

const SOLUTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml><SolutionManifest><UniqueName>OldName</UniqueName>
<LocalizedNames><LocalizedName description="Old Name" languagecode="1033" /></LocalizedNames>
<Version>1.2.3.4</Version><Managed>0</Managed>
<Publisher><UniqueName>contoso</UniqueName><LocalizedNames><LocalizedName description="Contoso" languagecode="1033" /></LocalizedNames></Publisher>
</SolutionManifest></ImportExportXml>`;

function pkg() {
  const z = new AdmZip();
  z.addFile('solution.xml', Buffer.from(`﻿${SOLUTION_XML}`));
  z.addFile('customizations.xml', Buffer.from('<x><connectionreference a="1"/><connectionreference a="2"/></x>'));
  z.addFile('environmentvariabledefinitions/cr_A/environmentvariabledefinition.xml', Buffer.from('<e/>'));
  return z.toBuffer();
}

test('renameSolution changes only the solution header, not the publisher', () => {
  const out = renameSolution(pkg(), { uniqueName: 'NewName', displayName: 'New & "Shiny"' });
  const m = readManifest(out);
  assert.equal(m.uniqueName, 'NewName');
  assert.equal(m.displayName, 'New &amp; &quot;Shiny&quot;');
  assert.equal(m.version, '1.2.3.4');
  const xml = new AdmZip(out).readAsText('solution.xml');
  assert.match(xml, /<Publisher><UniqueName>contoso<\/UniqueName><LocalizedNames><LocalizedName description="Contoso"/);
});

test('renameSolution rejects invalid unique names', () => {
  assert.throws(() => renameSolution(pkg(), { uniqueName: '1bad-name' }), /not a valid solution unique name/);
});

test('inspectPackage counts connection references and environment variables', () => {
  const info = inspectPackage(pkg());
  assert.equal(info.connectionReferences, 2);
  assert.equal(info.environmentVariables, 1);
});

test('parseImportJobData counts results and collects failures', () => {
  const xml = `<importexportxml><entities>
    <entity id="account" LocalizedName="Account"><result result="success" errorcode="0" errortext="" /></entity>
    <entity id="cr_x" LocalizedName="X"><result result="failure" errorcode="0x8004" errortext="Missing &quot;dep&quot;" /></entity>
  </entities><workflows><workflow name="Flow A"><result result="warning" errorcode="1" errortext="Not activated"/></workflow></workflows></importexportxml>`;
  const r = parseImportJobData(xml);
  assert.deepEqual(r.counts, { success: 1, warning: 1, failure: 1 });
  assert.equal(r.issues[0].message, 'Missing "dep"');
  assert.equal(r.issues[0].component, 'entity: X');
});

// --- end-to-end against the mock provider through the HTTP API --------------------------------

let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = async (p) => { const r = await fetch(base + p); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error.message), { status: r.status }); return j; };
const H = { 'Content-Type': 'application/json', 'X-PSM-Request': '1' };
// Completed = imported and verified; 'attention' means it worked but something needs configuring.
const assertCompleted = (m) => assert.ok(['succeeded', 'attention'].includes(m.status), JSON.stringify(m.error || m.status));
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

async function waitFor(id) {
  for (let i = 0; i < 500; i++) {
    const m = await get(`/api/migrations/${id}`);
    if (m.status !== 'running') return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

async function setup(slot) {
  await fetch(`${base}/auth/login?slot=${slot}`); // mock sign-in (follows redirect to callback)
  const tenants = await get(`/api/${slot}/tenants`);
  return tenants;
}

test('requires sign-in before listing tenants', async () => {
  await assert.rejects(get('/api/target/tenants'), (e) => e.status === 401);
});

test('same-tenant migration with exclusions and rename', async () => {
  const tenants = await setup('source');
  const contoso = tenants.find((t) => t.displayName === 'Contoso Ltd');
  const envs = await get(`/api/source/tenants/${contoso.tenantId}/environments`);
  const dev = envs.find((e) => e.name === 'Contoso Development');
  const testEnv = envs.find((e) => e.name === 'Contoso Test');
  const sols = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const comps = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${sales.id}/components`);
  const exclude = comps.filter((c) => c.typeName === 'Chart' || c.typeName === 'Security Role').map((c) => c.id);

  const { status, body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: testEnv.id },
    solutionId: sales.id,
    excludedComponentIds: exclude,
    rename: { enabled: true, uniqueName: 'ContosoSalesLite', displayName: 'Contoso Sales Lite' },
    options: { managed: true },
  });
  assert.equal(status, 202);
  const m = await waitFor(body.id);
  assertCompleted(m);
  assert.equal(m.summary.components.excluded, 2);
  assert.equal(m.summary.components.included, comps.length - 2);
  assert.equal(m.summary.targetSolution.uniqueName, 'ContosoSalesLite');
  assert.equal(m.summary.crossTenant, false);
  assert.equal(m.steps.find((s) => s.key === 'filter').status, 'done');
  // "Nightly price sync" needs a child flow that needs a SharePoint connection reference;
  // neither is in the solution, so both are added to the migrated copy.
  assert.deepEqual(m.summary.components.addedDependencies.map((a) => a.displayName).sort(),
    ['Calculate deal discount (child flow)', 'SharePoint connection']);
  assert.equal(m.steps.find((s) => s.key === 'dependencies').status, 'done');

  // Temporary solution removed from source, original untouched.
  const after = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  assert.equal(after.length, sols.length);
  const target = await get(`/api/source/tenants/${contoso.tenantId}/environments/${testEnv.id}/solutions`);
  assert.ok(target.some((s) => s.uniqueName === 'ContosoSalesLite' && s.isManaged));

  const pkgRes = await fetch(`${base}/api/migrations/${m.id}/package`);
  assert.equal(pkgRes.status, 200);
  assert.equal(readManifest(Buffer.from(await pkgRes.arrayBuffer())).uniqueName, 'ContosoSalesLite');
});

test('pre-flight catches an excluded component that a selected one needs (nothing exported)', async () => {
  const srcTenants = await setup('source');
  const tgtTenants = await setup('target');
  const contoso = srcTenants.find((t) => t.displayName === 'Contoso Ltd');
  const northwind = tgtTenants.find((t) => t.displayName === 'Northwind Traders');
  const dev = (await get(`/api/source/tenants/${contoso.tenantId}/environments`)).find((e) => e.name === 'Contoso Development');
  const nw = (await get(`/api/target/tenants/${northwind.tenantId}/environments`))[0];
  const sols = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  const legacy = sols.find((s) => s.uniqueName === 'LegacyIntegration');
  const comps = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${legacy.id}/components`);
  const asm = comps.find((c) => c.typeName === 'Plug-in Assembly');

  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'target', tenantId: northwind.tenantId, envId: nw.id },
    solutionId: legacy.id,
    excludedComponentIds: [asm.id],
  });
  const m = await waitFor(body.id);
  assert.equal(m.status, 'failed');
  assert.equal(m.crossTenant, true);
  assert.match(m.error.message, /missing/i);
  assert.equal(m.steps.find((s) => s.key === 'dependencies').status, 'failed');
  assert.notEqual(m.steps.find((s) => s.key === 'export').status, 'done');
  const md = m.error.missingDependencies;
  assert.equal(md.length, 1);
  assert.equal(md[0].resolution, 'excluded');
  assert.equal(md[0].required.displayName, 'Contoso.Legacy.Plugins');
  assert.match(md[0].dependents[0].displayName, /OrderSync/);
  // Temporary solution must still be cleaned up after a failure.
  const after = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  assert.equal(after.length, sols.length);
});

test('pre-flight rejects unmanaged import over a managed solution', async () => {
  const srcTenants = await setup('source');
  const tgtTenants = await setup('target');
  const contoso = srcTenants.find((t) => t.displayName === 'Contoso Ltd');
  const fabrikam = tgtTenants.find((t) => t.displayName === 'Fabrikam Inc');
  const dev = (await get(`/api/source/tenants/${contoso.tenantId}/environments`)).find((e) => e.name === 'Contoso Development');
  const prod = (await get(`/api/target/tenants/${fabrikam.tenantId}/environments`)).find((e) => e.name === 'Fabrikam Production');
  const core = (await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`)).find((s) => s.uniqueName === 'CoreComponents');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'target', tenantId: fabrikam.tenantId, envId: prod.id },
    solutionId: core.id,
    options: { managed: false },
  });
  const m = await waitFor(body.id);
  assert.equal(m.status, 'failed');
  assert.match(m.error.message, /MANAGED solution/);
  assert.equal(m.steps.find((s) => s.key === 'validate').status, 'failed');
});

test('rejects same source and target environment', async () => {
  const tenants = await setup('source');
  const contoso = tenants.find((t) => t.displayName === 'Contoso Ltd');
  const dev = (await get(`/api/source/tenants/${contoso.tenantId}/environments`))[0];
  const sol = (await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`))[0];
  const { status, body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    solutionId: sol.id,
  });
  assert.equal(status, 400);
  assert.match(body.error.message, /must be different/);
});

test('missing dependencies fail fast when auto-include is off, and are added when on', async () => {
  const tenants = await setup('source');
  const contoso = tenants.find((t) => t.displayName === 'Contoso Ltd');
  const envs = await get(`/api/source/tenants/${contoso.tenantId}/environments`);
  const dev = envs.find((e) => e.name === 'Contoso Development');
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const sols = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const base = {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: sales.id,
  };

  const off = await waitFor((await post('/api/migrations', { ...base, options: { includeMissingDependencies: false } })).body.id);
  assert.equal(off.status, 'failed');
  assert.equal(off.steps.find((s) => s.key === 'dependencies').status, 'failed');
  assert.equal(off.error.missingDependencies[0].required.displayName, 'Calculate deal discount (child flow)');
  assert.equal(off.error.missingDependencies[0].resolution, 'add');

  // No exclusions: a copy is created only because required components must be added.
  const on = await waitFor((await post('/api/migrations', base)).body.id);
  assertCompleted(on);
  assert.equal(on.steps.find((s) => s.key === 'filter').status, 'done');
  assert.equal(on.summary.components.addedDependencies.length, 2);
  const after = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  assert.equal(after.length, sols.length, 'temporary copy removed');
  const original = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${sales.id}/components`);
  assert.ok(!original.some((c) => c.displayName === 'SharePoint connection'), 'original solution unchanged');
});

test('parses the MissingDependencies XML from an import failure', () => {
  const { parseImportMissingDependencies } = require('../src/dependencies');
  const msg = 'Operation failed: Solution manifest import: FAILURE: The following solution cannot be imported: HR_System_new. Some dependencies are missing. The missing dependencies are : <MissingDependencies canResolveAllMissingDependencies="False"><MissingDependency canResolveMissingDependency="False"><Required type="connectionreference" displayName="new_sharedsharepointonline_6a422" solution="Active" id.connectionreferencelogicalname="new_sharedsharepointonline_6a422" /><Dependent type="29" displayName="HR - Create Employee After Joining Letter" id="{ae6ded5c-369b-f111-b8db-7ced8d764aea}" /></MissingDependency><MissingDependency canResolveMissingDependency="False"><Required type="29" displayName="RefreshCostModelDashboard" solution="Active" id="{f4ed2d8c-1ed1-f111-a05a-7ced8d7548c2}" /><Dependent type="300" schemaName="new_costmodelapp_cb761" displayName="CostModel_App" /></MissingDependency></MissingDependencies> , ProductUpdatesOnly : False';
  const r = parseImportMissingDependencies(msg);
  assert.equal(r.missingDependencies.length, 2);
  assert.equal(r.missingDependencies[0].required.typeName, 'Connection Reference');
  assert.equal(r.missingDependencies[0].dependents[0].displayName, 'HR - Create Employee After Joining Letter');
  assert.equal(r.missingDependencies[1].dependents[0].typeName, 'Canvas App');
  assert.equal(r.missingDependencies[0].resolution, 'add');
  assert.doesNotMatch(r.summary, /<Missing/);
});

// --- canvas check, connections & variables, profiles & history ---------------------------------

const { assessCanvasApp } = require('../src/configuration');

test('assessCanvasApp compares last saved and last published times', () => {
  const pub = '2026-11-10T10:00:00Z';
  assert.equal(assessCanvasApp({ properties: { lastPublishTime: pub, lastModifiedTime: '2026-11-10T10:00:30Z' } }, null).state, 'published');
  assert.equal(assessCanvasApp({ properties: { lastPublishTime: pub, lastModifiedTime: '2026-11-12T08:00:00Z' } }, null).state, 'unpublished');
  assert.equal(assessCanvasApp({ properties: { lastPublishTime: pub, appVersion: pub, unpublishedAppDefinition: { properties: { lastModifiedTime: '2026-11-11T00:00:00Z' } } } }, null).state, 'unpublished');
  assert.equal(assessCanvasApp(null, { appversion: '2026-11-12T00:00:00Z', lastpublishtime: pub }).state, 'unpublished');
  assert.equal(assessCanvasApp(null, null).state, 'unknown');
});

async function contosoDev() {
  const tenants = await setup('source');
  const contoso = tenants.find((t) => t.displayName === 'Contoso Ltd');
  const envs = await get(`/api/source/tenants/${contoso.tenantId}/environments`);
  const dev = envs.find((e) => e.name === 'Contoso Development');
  const sols = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  return { contoso, envs, dev, sols };
}

test('canvas check blocks a solution whose app has unpublished changes', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const field = sols.find((s) => s.uniqueName === 'FieldInspections');
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const base = `/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`;
  const bad = (await post(`${base}/${field.id}/canvas-check`, {})).body;
  assert.equal(bad.status, 'unpublished');
  assert.equal(bad.apps[0].displayName, 'Field Inspection App');
  assert.ok(bad.apps[0].editUrl);
  assert.equal((await post(`${base}/${sales.id}/canvas-check`, {})).body.status, 'ok');

  // The engine enforces it too (mandatory), even if the UI is bypassed.
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: field.id,
    options: { acknowledgeUnverifiedCanvasApps: true },
  });
  const m = await waitFor(body.id);
  assert.equal(m.status, 'failed');
  assert.equal(m.steps.find((s) => s.key === 'validate').status, 'failed');
  assert.equal(m.error.canvasApps[0].state, 'unpublished');
  assert.notEqual(m.steps.find((s) => s.key === 'export').status, 'done');
});

test('configuration lists connection references, variables and target connections', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const test = envs.find((e) => e.name === 'Contoso Test');
  const q = `targetSlot=source&targetTenantId=${contoso.tenantId}&targetEnvId=${test.id}`;
  const cfg = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${sales.id}/configuration?${q}`);
  assert.deepEqual(cfg.connectionReferences.map((r) => r.logicalName).sort(),
    ['cr_sharedcommondataserviceforapps_1a2b3', 'cr_sharedoffice365_4c5d6', 'cr_sharedsharepointonline_6a422']);
  assert.equal(cfg.connectionReferences.find((r) => r.connectorName === 'shared_sharepointonline').notInSolution, true);
  assert.deepEqual(cfg.environmentVariables.map((v) => v.schemaName).sort(), ['cr_MaxDiscount', 'cr_PricingApiBaseUrl']);
  assert.equal(cfg.environmentVariables.find((v) => v.schemaName === 'cr_PricingApiBaseUrl').sourceValue, 'https://pricing-dev.contoso.com/api');
  const conns = await get(`/api/source/tenants/${contoso.tenantId}/environments/${test.id}/connections?connector=shared_office365`);
  assert.equal(conns.length, 2);
});

test('migration applies connections and variable values, saves history and profile last run', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const test = envs.find((e) => e.name === 'Contoso Test');
  const API = '/providers/Microsoft.PowerApps/apis/';

  const profileBody = {
    name: 'Sales Hub to Test', mode: 'same',
    source: { tenantId: contoso.tenantId, tenantName: 'Contoso Ltd', envId: dev.id, envName: dev.name, envUrl: dev.url },
    target: { tenantId: contoso.tenantId, tenantName: 'Contoso Ltd', envId: test.id, envName: test.name, envUrl: test.url },
    solution: { uniqueName: 'ContosoSalesHub', displayName: 'Contoso Sales Hub' },
    excludedObjectIds: [], rename: { enabled: false }, options: { managed: false }, configuration: { skipped: false, mappings: {}, values: {} },
  };
  const created = await post('/api/profiles', profileBody);
  assert.equal(created.status, 201);
  assert.equal((await post('/api/profiles', profileBody)).status, 409, 'duplicate names are rejected');

  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: test.id },
    solutionId: sales.id,
    profile: { id: created.body.id, name: created.body.name },
    configuration: {
      skipped: false,
      connectionReferences: [
        { logicalName: 'cr_sharedcommondataserviceforapps_1a2b3', connectorId: `${API}shared_commondataserviceforapps`, connectionId: 'shared-commondataserviceforapps-test-1', connectionName: 'Dataverse' },
        { logicalName: 'cr_sharedoffice365_4c5d6', connectorId: `${API}shared_office365`, connectionId: 'shared-office365-test-1', connectionName: 'Outlook' },
        { logicalName: 'cr_sharedsharepointonline_6a422', connectorId: `${API}shared_sharepointonline`, connectionId: 'shared-sharepointonline-test-1', connectionName: 'SharePoint' },
      ],
      environmentVariables: [{ schemaName: 'cr_PricingApiBaseUrl', value: 'https://pricing-test.contoso.com/api' }],
    },
  });
  const m = await waitFor(body.id);
  assertCompleted(m);
  assert.equal(m.steps.find((s) => s.key === 'configure').status, 'done');
  const cr = m.summary.configuration;
  assert.equal(cr.connectionReferences.length, 3);
  assert.ok(cr.connectionReferences.every((x) => x.result !== 'failed'));
  assert.equal(cr.environmentVariables[0].schemaName, 'cr_PricingApiBaseUrl');
  assert.ok(cr.flows.length >= 2 && cr.flows.every((f) => f.result === 'activated'));
  assert.equal(m.summary.importResults.counts.warning, 0, 'flows start because their connections were supplied');

  // Values really are in the target now.
  const q = `targetSlot=source&targetTenantId=${contoso.tenantId}&targetEnvId=${test.id}`;
  const cfg = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${sales.id}/configuration?${q}`);
  assert.equal(cfg.environmentVariables.find((v) => v.schemaName === 'cr_PricingApiBaseUrl').targetValue, 'https://pricing-test.contoso.com/api');

  // History survives in the store and links to the profile.
  const history = await get('/api/history');
  const row = history.find((r) => r.id === m.id);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.profile.name, 'Sales Hub to Test');
  assert.equal(row.startedBy, 'admin@contoso.onmicrosoft.com');
  assert.equal(row.hasPackage, true);
  const profiles = await get('/api/profiles');
  assert.equal(profiles.find((p) => p.id === created.body.id).lastRun.id, m.id);
  const pkg = await fetch(`${base}/api/migrations/${m.id}/package`);
  assert.equal(pkg.status, 200);

  const del = await fetch(`${base}/api/profiles/${created.body.id}`, { method: 'DELETE', headers: H });
  assert.equal(del.status, 204);
});

test('skipping the configuration step skips applying settings', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const core = sols.find((s) => s.uniqueName === 'CoreComponents');
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: core.id,
    configuration: { skipped: true, environmentVariables: [{ schemaName: 'cr_FeatureFlags', value: 'x' }] },
  });
  const m = await waitFor(body.id);
  assertCompleted(m);
  const st = m.steps.find((s) => s.key === 'configure');
  assert.equal(st.status, 'skipped');
  assert.match(st.detail, /Skipped by user/);
});

test('runs that were in progress when the server stopped are marked interrupted', () => {
  const fs = require('fs');
  const path = require('path');
  const store = require('../src/store');
  const file = path.join(process.env.DATA_DIR, 'history.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = '00000000-0000-4000-8000-00000000abcd';
  all.unshift({ id, status: 'running', startedAt: new Date().toISOString(), request: {}, steps: [], logs: [] });
  fs.writeFileSync(file, JSON.stringify(all));
  store._reset();
  assert.equal(store.listRuns().find((r) => r.id === id).status, 'interrupted');
});

// --- large imports: long timeouts and recovery when the upload response is lost --------------

test('network setup uses a long request timeout (not Node\'s 5 minutes)', () => {
  const net = require('../src/network').setupNetwork();
  assert.ok(net.requestTimeoutMinutes >= 30);
});

test('resumeImport follows the import job when the ImportSolutionAsync response was lost', async () => {
  const { DataverseClient } = require('../src/providers/dataverse');
  const config = require('../src/config');
  config.pollIntervalMs = 1;
  const jobId = '11111111-2222-4333-8444-555555555555';
  let polls = 0;
  const stub = {
    all: async (path) => {
      assert.match(path, /^importjobs\?.*createdon ge /);
      return [
        { importjobid: 'aaaaaaaa-0000-4000-8000-000000000000', solutionname: 'OtherSolution', completedon: null },
        { importjobid: jobId, solutionname: 'SKD_Training_System_New', progress: 10, completedon: null },
      ];
    },
    call: async (path) => {
      assert.ok(path.startsWith(`importjobs(${jobId})`));
      polls++;
      return polls < 3 ? { progress: 40 * polls, completedon: null } : { progress: 100, completedon: new Date().toISOString() };
    },
    getImportJobResults: async () => ({ counts: { success: 10, warning: 0, failure: 0 }, issues: [] }),
  };
  const progress = [];
  const r = await DataverseClient.prototype.resumeImport.call(stub, new Date().toISOString(), 'SKD_Training_System_New', (p, d) => progress.push(d));
  assert.equal(r.importJobId, jobId);
  assert.equal(r.resumed, true);
  assert.ok(progress.some((d) => /re-established/.test(d)));

  // A failed import is reported as a failure, with the job id for the log.
  stub.getImportJobResults = async () => ({ counts: { success: 1, warning: 0, failure: 1 }, issues: [{ level: 'failure', component: 'solutionManifest', message: 'Missing dependency' }] });
  polls = 0;
  await assert.rejects(DataverseClient.prototype.resumeImport.call(stub, new Date().toISOString(), 'SKD_Training_System_New', () => {}),
    (e) => /Missing dependency/.test(e.message) && e.importJobId === jobId);

  // No import started: a clear error after the search window.
  const empty = { all: async () => [], call: async () => ({}) };
  await assert.rejects(DataverseClient.prototype.resumeImport.call(empty, new Date().toISOString(), 'X', () => {}, { findMinutes: 0 }), /no import was started/);
});

// --- fixes from the real-tenant error log ----------------------------------------------------

test('Dataverse alone cannot prove a canvas app is published', () => {
  const t = '2026-04-10T14:19:58Z';
  const r = assessCanvasApp(null, { appversion: t, lastpublishtime: t });
  assert.equal(r.state, 'unknown');
  assert.match(r.note, /Dataverse does not show changes saved/);
});

test('flow activation errors are classified into actionable messages', () => {
  const { classifyFlowError } = require('../src/configuration');
  const waiting = classifyFlowError('A connector was imported, however the related connection references need connections created and then any dependent flows can be started.');
  assert.equal(waiting.result, 'action');
  const unauthorized = classifyFlowError("Flow client error returned with status code 'BadRequest' ... The dynamic operation request to API 'sharepointonline' operation 'GetTable' failed with status code 'Unauthorized'.");
  assert.equal(unauthorized.result, 'action');
  assert.match(unauthorized.message, /SharePoint site or list/);
  assert.match(unauthorized.details, /GetTable/);
  assert.equal(classifyFlowError('Something else').message, 'Something else');
});

test('summary lists the canvas apps in the package with their screens; unmapped flows need a connection', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'ContosoSalesHubPartial', displayName: 'Sales Hub (partial)' },
    configuration: {
      skipped: false,
      connectionReferences: [{ logicalName: 'cr_sharedoffice365_4c5d6', connectorId: '/providers/Microsoft.PowerApps/apis/shared_office365', connectionId: 'shared-office365-uat-1', connectionName: 'Outlook' }],
    },
  });
  const m = await waitFor(body.id);
  assertCompleted(m);
  const apps = m.summary.package.canvasAppDetails;
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'Sales Mobile');
  assert.deepEqual(apps[0].screens, ['DetailScreen', 'EditScreen', 'HomeScreen']);
  assert.ok(apps[0].savedUtc);
  assert.ok(m.logs.some((l) => /Canvas app "Sales Mobile" in package: 3 screen/.test(l.message)));
  // Two connection references were left unmapped, so flows wait for connections (not "failed").
  assert.ok(m.summary.configuration.flows.length > 0);
  assert.ok(m.summary.configuration.flows.every((f) => f.result === 'action'), JSON.stringify(m.summary.configuration.flows));
});

test('a publish recorded in Dataverse counts even if the service still reports an older publish time', () => {
  // A_test from the real tenant: saved 3:45:06 PM (the save Studio does when publishing),
  // the service still said "last published 3:35:20 PM", and Dataverse had the real publish.
  const app = { properties: { lastModifiedTime: '2026-11-16T15:45:06Z', lastPublishTime: '2026-11-16T15:35:20Z' } };
  const row = { appversion: '2026-11-16T15:45:06Z', lastpublishtime: '2026-11-16T15:45:12Z' };
  const r = assessCanvasApp(app, row);
  assert.equal(r.state, 'published');
  assert.equal(r.lastPublished, '2026-11-16T15:45:12Z');
  assert.match(r.evidence, /Dataverse/);
  // Without any newer publish anywhere, it is still flagged.
  assert.equal(assessCanvasApp(app, { lastpublishtime: '2026-11-16T15:35:20Z' }).state, 'unpublished');
  // The nested appDefinition publish time is used too.
  assert.equal(assessCanvasApp({ properties: { ...app.properties, appDefinition: { properties: { lastPublishTime: '2026-11-16T15:45:12Z' } } } }, null).state, 'published');
});

test('the user can confirm published apps and continue; the confirmation is logged', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const field = sols.find((s) => s.uniqueName === 'FieldInspections');
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: field.id,
    rename: { enabled: true, uniqueName: 'FieldInspectionsOverride', displayName: 'Field Inspections (override)' },
    options: { overrideCanvasCheck: true, includeMissingDependencies: true },
    configuration: { skipped: true },
  });
  const m = await waitFor(body.id);
  assert.notEqual(m.steps.find((s) => s.key === 'validate').status, 'failed', JSON.stringify(m.error));
  assert.ok(m.logs.some((l) => l.level === 'warning' && /user confirmed the apps are published/.test(l.message)));
});

test('skipped connections are "action required", not failures; real failures stay failures', async () => {
  const { reclassifyImportResults } = require('../src/configuration');
  const r = reclassifyImportResults({
    counts: { success: 5, warning: 1, failure: 2 },
    issues: [
      { level: 'failure', component: 'workflow: Daily sync', message: 'The flow could not be activated because connection reference "SharePoint" has no connection in this environment.' },
      { level: 'failure', component: 'entity: cr_order', message: 'Attribute cr_total cannot be created: a column with this name already exists.' },
      { level: 'warning', component: 'workflow: Notify', message: 'A connector was imported, however the related connection references need connections created.' },
    ],
  });
  assert.deepEqual(r.counts, { success: 5, warning: 0, failure: 1, action: 2 });
  assert.equal(r.issues[1].level, 'failure', 'a real error stays a failure');

  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const prod = envs.find((e) => e.name === 'Contoso Production');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: prod.id },
    solutionId: sales.id,
    configuration: { skipped: true },
  });
  const m = await waitFor(body.id);
  assertCompleted(m);
  const s = m.summary;
  assert.equal(s.configurationSkipped, true);
  assert.equal(s.importResults.counts.failure, 0, 'flows that could not start are not counted as failures');
  assert.ok(s.importResults.counts.action >= 1);
  assert.equal(s.actionRequired.connectionReferences.length, 3, JSON.stringify(s.actionRequired));
  assert.ok(s.actionRequired.flows.length >= 2);
  assert.match(m.steps.find((x) => x.key === 'verify').detail, /0 failed · \d+ need configuration/);
});

// --- settings page ------------------------------------------------------------------------------

test('updateEnvText replaces, removes and appends keys and keeps everything else', () => {
  const { updateEnvText } = require('../src/settings');
  const before = '# my settings\nCLIENT_ID=old\nPORT=3000\nCLIENT_SECRET=abc\nCLIENT_ID=dup\n';
  const after = updateEnvText(before, { CLIENT_ID: '11111111-2222-4333-8444-555555555555', CLIENT_SECRET: null, PROXY_URL: 'http://p:8080' });
  assert.equal(after, '# my settings\nCLIENT_ID=11111111-2222-4333-8444-555555555555\nPORT=3000\nPROXY_URL=http://p:8080\n');
});

test('settings can be saved from the UI, only by the app page', async () => {
  const fs = require('fs');
  const id = '3d7c1ae2-f89d-4d8f-ad33-662f352bceb5';
  const put = (body, headers = H) => fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify(body) });

  // No header (a request another website could make): refused.
  assert.equal((await put({ clientId: id }, { 'Content-Type': 'application/json' })).status, 403);
  // Header present but from another origin: refused.
  assert.equal((await put({ clientId: id }, { ...H, Origin: 'https://evil.example' })).status, 403);
  // Invalid ID: rejected with a helpful message.
  const bad = await put({ clientId: 'not-a-guid' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /Application \(client\) ID/);

  const ok = await put({ clientId: id, clientSecret: 'my~secret.value' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.clientId, id);
  assert.equal(body.hasClientSecret, true);
  assert.equal(body.changed, true);
  const text = fs.readFileSync(process.env.ENV_FILE, 'utf8');
  assert.match(text, new RegExp(`^CLIENT_ID=${id}$`, 'm'));
  assert.match(text, /^CLIENT_SECRET=my~secret\.value$/m);
  assert.equal((await get('/api/settings')).clientId, id);
  assert.equal((await get('/api/settings')).hasClientSecret, true, 'the secret itself is never returned');
  assert.equal(JSON.stringify(await get('/api/settings')).includes('my~secret'), false);

  const removed = await (await put({ clientId: id, removeClientSecret: true })).json();
  assert.equal(removed.hasClientSecret, false);
  assert.doesNotMatch(fs.readFileSync(process.env.ENV_FILE, 'utf8'), /CLIENT_SECRET/);
});

// --- closing the tab stops the migrator ------------------------------------------------------

test('stops when every page is closed, but not on reload, before any page, or while busy', async () => {
  const lifecycle = require('../src/lifecycle');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (busy = () => false) => {
    lifecycle._reset();
    const result = { exited: false };
    lifecycle.start({ force: true, graceMs: 60, timeoutMs: 1000, checkMs: 10, isBusy: busy, onExit: () => { result.exited = true; } });
    return result;
  };

  let r = run();
  await wait(150);
  assert.equal(r.exited, false, 'does not stop before the browser has connected');

  r = run();
  lifecycle.heartbeat('tab-1');
  lifecycle.closed('tab-1');
  lifecycle.heartbeat('tab-1-reloaded'); // a reload reconnects within the grace period
  await wait(150);
  assert.equal(r.exited, false, 'a reload keeps it running');
  lifecycle.closed('tab-1-reloaded');
  await wait(150);
  assert.equal(r.exited, true, 'closing the last tab stops it');

  let busy = true;
  r = run(() => busy);
  lifecycle.heartbeat('tab-2');
  lifecycle.closed('tab-2');
  await wait(150);
  assert.equal(r.exited, false, 'never stops during a migration or sign-in');
  busy = false;
  await wait(150);
  assert.equal(r.exited, true, 'stops once the migration has finished');
  lifecycle._reset();
});

// --- stop a running migration ---------------------------------------------------------------

test('stop before the import: nothing reaches the target and the temporary copy is removed', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const test = envs.find((e) => e.name === 'Contoso Test');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: test.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'StoppedEarly', displayName: 'Stopped early' },
    configuration: { skipped: true },
  });
  const stop = await post(`/api/migrations/${body.id}/stop`, {});
  assert.equal(stop.status, 200);
  assert.equal(stop.body.stopRequested, true);
  const m = await waitFor(body.id);
  assert.equal(m.status, 'cancelled');
  assert.match(m.error.message, /Nothing was imported/);
  assert.notEqual(m.steps.find((s) => s.key === 'import').status, 'done');
  const after = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  assert.equal(after.length, sols.length, 'no temporary copy left in the source');
  const target = await get(`/api/source/tenants/${contoso.tenantId}/environments/${test.id}/solutions`);
  assert.ok(!target.some((s) => s.uniqueName === 'StoppedEarly'));
  assert.equal((await post(`/api/migrations/${body.id}/stop`, {})).status, 409, 'cannot stop a finished migration');
  assert.equal((await get('/api/history')).find((r) => r.id === m.id).status, 'cancelled');
});

test('stop during the import: the import finishes, the remaining steps are skipped', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const uat = envs.find((e) => e.name === 'Contoso UAT');
  const { body } = await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: uat.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'StoppedDuringImport', displayName: 'Stopped during import' },
    configuration: { skipped: true },
  });
  let v;
  for (let i = 0; i < 2000; i++) {
    v = await get(`/api/migrations/${body.id}`);
    if (v.steps.find((s) => s.key === 'import').status === 'running' || v.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(v.steps.find((s) => s.key === 'import').status, 'running', 'reached the import step');
  await post(`/api/migrations/${body.id}/stop`, {});
  const m = await waitFor(body.id);
  assert.equal(m.status, 'cancelled');
  assert.equal(m.steps.find((s) => s.key === 'import').status, 'done', 'the import was not interrupted');
  assert.equal(m.steps.find((s) => s.key === 'verify').status, 'skipped');
  assert.match(m.error.message, /after the import finished/);
});

// --- issue list: names, existing solution, verified outcome ---------------------------------

test('component type names match Power Apps (Table, Cloud Flow), not Dataverse internals', () => {
  const { friendlyTypeName, WORKFLOW_CATEGORIES } = require('../src/componentTypes');
  assert.equal(friendlyTypeName(1, 'Entity'), 'Table');
  assert.equal(friendlyTypeName(2, 'Attribute'), 'Column');
  assert.equal(friendlyTypeName(10021, 'Connection Reference'), 'Connection Reference');
  assert.equal(friendlyTypeName(10500, 'Entity'), 'Table');
  assert.equal(WORKFLOW_CATEGORIES[5], 'Cloud Flow');
  assert.equal(WORKFLOW_CATEGORIES[0], 'Classic Workflow');
  assert.equal(WORKFLOW_CATEGORIES[2], 'Business Rule');
});

test('an existing solution in the target is only updated after explicit confirmation', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const core = sols.find((s) => s.uniqueName === 'CoreComponents');
  const test = envs.find((e) => e.name === 'Contoso Test');
  const base = {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: test.id },
    solutionId: core.id,
    rename: { enabled: true, uniqueName: 'CoreTwice', displayName: 'Core twice' },
    configuration: { skipped: true },
  };
  const first = await waitFor((await post('/api/migrations', base)).body.id);
  assertCompleted(first);
  const exists = await get(`/api/source/tenants/${contoso.tenantId}/environments/${test.id}/solution-by-name/CoreTwice`);
  assert.equal(exists.exists, true);
  assert.equal((await get(`/api/source/tenants/${contoso.tenantId}/environments/${test.id}/solution-by-name/NotThere`)).exists, false);

  const unconfirmed = await waitFor((await post('/api/migrations', base)).body.id);
  assert.equal(unconfirmed.status, 'failed');
  assert.match(unconfirmed.error.message, /already has a solution named "CoreTwice".*Update the existing solution/);

  const confirmed = await waitFor((await post('/api/migrations', { ...base, options: { confirmUpdateExisting: true } })).body.id);
  assertCompleted(confirmed);
  assert.equal(confirmed.summary.operation, 'Updated existing solution');
});

test('"Succeeded" only when verified with nothing left to do; otherwise "Completed – action required"', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const core = sols.find((s) => s.uniqueName === 'CoreComponents');
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const test = envs.find((e) => e.name === 'Contoso Test');
  // Core Components: no connections and the variable has a default -> clean success.
  const clean = await waitFor((await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: test.id },
    solutionId: core.id,
    rename: { enabled: true, uniqueName: 'CoreClean', displayName: 'Core clean' },
    configuration: { skipped: true },
  })).body.id);
  // Feature Flags has no value and no default in the target, so that's an action item.
  assert.equal(clean.status, clean.summary.actionRequired.total ? 'attention' : 'succeeded');
  assert.equal(clean.summary.verification.installed, true);
  assert.equal(clean.summary.outcome, clean.outcome);
  assert.equal(clean.summary.verification.versionOk, true);

  // Contoso Production has no connections for these references (Contoso Test got them earlier).
  const prod = envs.find((e) => e.name === 'Contoso Production');
  const skipped = await waitFor((await post('/api/migrations', {
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: { slot: 'source', tenantId: contoso.tenantId, envId: prod.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'SalesActionRequired', displayName: 'Sales action required' },
    configuration: { skipped: true },
  })).body.id);
  assert.equal(skipped.status, 'attention');
  assert.equal(skipped.outcome, 'action');
  assert.equal(skipped.summary.outcome, 'action', 'the summary banner reads this: it must not say "successful"');
  assert.equal(skipped.summary.failureItems.length, 0);
  assert.ok(skipped.logs.some((l) => /Migration successful and verified in the target; \d+ item\(s\) require configuration/.test(l.message)));
});

test('package only: exports a filtered, renamed package without importing anywhere', async () => {
  const { contoso, envs, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const comps = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions/${sales.id}/components`);
  const exclude = comps.filter((c) => c.typeName === 'Chart').map((c) => c.id);
  const before = {};
  for (const e of envs) before[e.id] = (await get(`/api/source/tenants/${contoso.tenantId}/environments/${e.id}/solutions`)).length;

  const { status, body } = await post('/api/migrations', {
    mode: 'package',
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    target: null,
    solutionId: sales.id,
    excludedComponentIds: exclude,
    rename: { enabled: true, uniqueName: 'SalesHubAudit', displayName: 'Sales Hub (audit copy)' },
    options: { managed: true },
  });
  assert.equal(status, 202);
  assert.equal(body.packageOnly, true);
  assert.deepEqual(body.steps.map((s) => s.key), ['validate', 'publish', 'filter', 'dependencies', 'export', 'cleanup', 'package']);
  const m = await waitFor(body.id);
  assert.equal(m.status, 'succeeded', JSON.stringify(m.error));
  assert.equal(m.outcome, 'package');
  assert.equal(m.summary.packageOnly, true);
  assert.equal(m.summary.target, null);
  assert.equal(m.summary.components.excluded, exclude.length);
  assert.equal(m.summary.packageFile.name, 'SalesHubAudit_' + sales.version.replace(/\./g, '_') + '_managed.zip');
  assert.ok(m.summary.recommendations.some((r) => /Import solution/.test(r)));

  // Nothing imported anywhere; temporary copy removed from the source.
  for (const e of envs) {
    const now = await get(`/api/source/tenants/${contoso.tenantId}/environments/${e.id}/solutions`);
    assert.equal(now.length, before[e.id], `no change in ${e.name}`);
    assert.ok(!now.some((s) => s.uniqueName === 'SalesHubAudit'));
  }

  const res = await fetch(`${base}/api/migrations/${m.id}/package`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(readManifest(buf).uniqueName, 'SalesHubAudit');
  assert.equal((await fetch(`${base}/api/migrations/${m.id}/import-log`)).status, 404);

  const row = (await get('/api/history')).find((r) => r.id === m.id);
  assert.equal(row.packageOnly, true);
  assert.equal(row.outcome, 'package');
  assert.equal(row.target, null);
});

test('package only: profiles can be saved without a target', async () => {
  const { status, body } = await post('/api/profiles', {
    name: 'Audit package', mode: 'package',
    source: { tenantId: 'x', tenantName: 'Contoso', envId: 'y', envName: 'Dev' }, target: null,
    solution: { uniqueName: 'ContosoSalesHub', displayName: 'Contoso Sales Hub' },
  });
  assert.equal(status, 201, JSON.stringify(body));
  const bad = await post('/api/profiles', { name: 'No target', mode: 'same', source: {}, target: null, solution: { uniqueName: 'A' } });
  assert.equal(bad.status, 400);
});

test('package only: a component from a managed solution is reported, not looked up in a target', async () => {
  const { analyse } = require('../src/dependencies');
  const src = {
    describeComponent: async (id, type) => ({ id, type, typeName: 'Table', displayName: id === 'req' ? 'Base table' : 'My form' }),
    componentSolutions: async () => [{ uniqueName: 'BaseLib', displayName: 'Base Library', isManaged: true }],
  };
  const out = await analyse(src, null, [{ requiredId: 'req', requiredType: 1, dependentId: 'dep', dependentType: 60 }], new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].resolution, 'managed');
  assert.match(out[0].message, /Base Library/);
});

test('package only: stop works (there is no import step) and no package is created', async () => {
  const { contoso, dev, sols } = await contosoDev();
  const sales = sols.find((s) => s.uniqueName === 'ContosoSalesHub');
  const { body } = await post('/api/migrations', {
    mode: 'package',
    source: { slot: 'source', tenantId: contoso.tenantId, envId: dev.id },
    solutionId: sales.id,
    rename: { enabled: true, uniqueName: 'StoppedPackage', displayName: 'Stopped package' },
  });
  const stop = await post(`/api/migrations/${body.id}/stop`, {});
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body.stopRequested, true);
  const m = await waitFor(body.id);
  assert.equal(m.status, 'cancelled');
  assert.match(m.error.message, /No package was created/);
  const after = await get(`/api/source/tenants/${contoso.tenantId}/environments/${dev.id}/solutions`);
  assert.equal(after.length, sols.length, 'no temporary copy left in the source');
});
