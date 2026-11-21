'use strict';

/**
 * Mock provider: an in-memory simulation of tenants, environments and solutions so the
 * tool can be demoed and tested without a Power Platform subscription (MOCK_MODE=true).
 *
 * Built-in scenarios:
 *  - "Legacy Integration": excluding the plug-in assembly makes the import fail with a
 *    missing-dependency error (shows the error popup).
 *  - "Core Components" is installed as MANAGED in "Fabrikam Production"; importing it as
 *    unmanaged there is rejected by the pre-flight check.
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { AuthRequiredError } = require('../auth');
const { componentTypeName } = require('../componentTypes');
const { assessCanvasApp, classifyFlowError } = require('../configuration');

const SPEED = Math.max(0.01, parseFloat(process.env.MOCK_SPEED || '1'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const guid = () => crypto.randomUUID();

class MockError extends Error {
  constructor(message, status = 400, details) { super(message); this.status = status; this.details = details; }
}

// ---------------------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------------------

const TENANTS = {
  contoso: { tenantId: '72f988bf-0000-4000-8000-000000000001', displayName: 'Contoso Ltd', defaultDomain: 'contoso.onmicrosoft.com' },
  contosoLabs: { tenantId: '72f988bf-0000-4000-8000-000000000002', displayName: 'Contoso Labs', defaultDomain: 'contosolabs.onmicrosoft.com' },
  fabrikam: { tenantId: 'a1b2c3d4-0000-4000-8000-000000000003', displayName: 'Fabrikam Inc', defaultDomain: 'fabrikam.onmicrosoft.com' },
  northwind: { tenantId: 'a1b2c3d4-0000-4000-8000-000000000004', displayName: 'Northwind Traders', defaultDomain: 'northwind.onmicrosoft.com' },
};

const ACCOUNTS = {
  source: { username: 'admin@contoso.onmicrosoft.com', name: 'Contoso Admin', homeTenantId: TENANTS.contoso.tenantId, tenants: ['contoso', 'contosoLabs', 'fabrikam'] },
  target: { username: 'admin@fabrikam.onmicrosoft.com', name: 'Fabrikam Admin', homeTenantId: TENANTS.fabrikam.tenantId, tenants: ['fabrikam', 'northwind'] },
};

function env(tenantKey, uniqueName, name, region = 'unitedstates') {
  return {
    id: guid(), environmentId: guid(), name, uniqueName,
    url: `https://${uniqueName}.crm.dynamics.com`, region, version: '9.2.25104.172', state: 'Ready',
    tenantId: TENANTS[tenantKey].tenantId,
  };
}

const ENVIRONMENTS = {
  [TENANTS.contoso.tenantId]: [env('contoso', 'contoso-dev', 'Contoso Development'), env('contoso', 'contoso-test', 'Contoso Test'), env('contoso', 'contoso-uat', 'Contoso UAT'), env('contoso', 'contoso-prod', 'Contoso Production')],
  [TENANTS.contosoLabs.tenantId]: [env('contosoLabs', 'contosolabs-sandbox', 'Labs Sandbox', 'europe')],
  [TENANTS.fabrikam.tenantId]: [env('fabrikam', 'fabrikam-dev', 'Fabrikam Development'), env('fabrikam', 'fabrikam-prod', 'Fabrikam Production')],
  [TENANTS.northwind.tenantId]: [env('northwind', 'northwind-main', 'Northwind Main', 'unitedkingdom')],
};

const PUBLISHER = { id: guid(), uniqueName: 'contoso', displayName: 'Contoso', prefix: 'cr' };

const daysAgo = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();

function c(componentType, displayName, name, extra = {}) {
  return { id: guid(), objectId: guid(), componentType, typeName: componentTypeName(componentType, { 10021: 'Connection Reference', 10029: 'Cloud Flow' }), displayName, name, rootComponentBehavior: componentType === 1 ? 0 : null, parentId: null, ...extra };
}

// Components that exist in Contoso Development but are not in any solution (Active layer),
// used to demo missing-dependency detection.
const spConnection = c(10021, 'SharePoint connection', 'cr_sharedsharepointonline_6a422', { typeName: 'Connection Reference', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' });
const childFlow = c(29, 'Calculate deal discount (child flow)', 'Calculate deal discount', { typeName: 'Cloud Flow', dependsOn: [spConnection.objectId] });
const ACTIVE_POOL = new Map(); // envId -> [component]

function buildSalesHub() {
  const account = c(1, 'Customer Account', 'cr_customeraccount', { rootComponentBehavior: 1 });
  const items = [
    account,
    c(2, 'Credit Limit', 'cr_creditlimit', { parentId: account.id }),
    c(2, 'Account Tier', 'cr_accounttier', { parentId: account.id }),
    c(60, 'Customer Account Main Form', 'Main', { parentId: account.id }),
    c(26, 'Active Customer Accounts', 'Active Customer Accounts', { parentId: account.id }),
    c(1, 'Opportunity Line', 'cr_opportunityline'),
    c(1, 'Price Rule', 'cr_pricerule'),
    c(9, 'Region', 'cr_region'),
    c(80, 'Sales Hub', 'cr_SalesHub'),
    c(62, 'Sales Hub Site Map', 'cr_SalesHub'),
    c(300, 'Sales Mobile', 'cr_salesmobile_8a1f2', { canvas: { lastSaved: daysAgo(2), lastPublished: daysAgo(2) } }),
    c(29, 'Notify owner on large deal', 'Notify owner on large deal', { typeName: 'Cloud Flow' }),
    c(29, 'Nightly price sync', 'Nightly price sync', { typeName: 'Cloud Flow', dependsOn: [childFlow.objectId] }),
    c(10021, 'Dataverse connection', 'cr_sharedcommondataserviceforapps_1a2b3', { typeName: 'Connection Reference', connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }),
    c(10021, 'Office 365 Outlook connection', 'cr_sharedoffice365_4c5d6', { typeName: 'Connection Reference', connectorId: '/providers/Microsoft.PowerApps/apis/shared_office365' }),
    c(380, 'Pricing API Base URL', 'cr_PricingApiBaseUrl', { envType: 100000000, defaultValue: 'https://pricing.contoso.com/api' }),
    c(380, 'Max discount (%)', 'cr_MaxDiscount', { envType: 100000001, defaultValue: '15' }),
    c(61, 'cr_/scripts/account.js', 'cr_/scripts/account.js'),
    c(20, 'Sales Representative', 'Sales Representative'),
    c(59, 'Pipeline by Stage', 'Pipeline by Stage'),
  ];
  return items;
}

function buildLegacy() {
  const assembly = c(91, 'Contoso.Legacy.Plugins', 'Contoso.Legacy.Plugins, Version=1.0.0.0');
  const type = c(90, 'Contoso.Legacy.Plugins.OrderSync', 'Contoso.Legacy.Plugins.OrderSync', { dependsOn: [assembly.objectId] });
  const step = c(92, 'OrderSync: Create of cr_legacyorder', 'OrderSync: Create of cr_legacyorder', { dependsOn: [type.objectId] });
  return [c(1, 'Legacy Order', 'cr_legacyorder'), assembly, type, step, c(95, 'Legacy ERP Service Bus', 'Legacy ERP Service Bus'), c(61, 'cr_/html/legacy.html', 'cr_/html/legacy.html')];
}

function buildCore() {
  return [c(1, 'Configuration Setting', 'cr_configurationsetting'), c(9, 'Status Reason Ext', 'cr_statusreasonext'), c(380, 'Feature Flags', 'cr_FeatureFlags'), c(381, 'Feature Flags (value)', 'cr_FeatureFlags')];
}

function buildFieldInspections() {
  const conn = c(10021, 'Dataverse connection (inspections)', 'cr_sharedcommondataserviceforapps_9f8e7', { typeName: 'Connection Reference', connectorId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' });
  return [
    c(1, 'Inspection', 'cr_inspection'),
    // Saved an hour ago but last published three days ago: the publish check blocks this one.
    c(300, 'Field Inspection App', 'cr_fieldinspectionapp_5d2a1', { canvas: { lastSaved: daysAgo(0, 1), lastPublished: daysAgo(3) } }),
    conn,
    c(29, 'Notify supervisor of failed inspection', 'Notify supervisor of failed inspection', { typeName: 'Cloud Flow', dependsOn: [conn.objectId] }),
    c(380, 'Inspection photo library', 'cr_InspectionPhotoLibrary', { envType: 100000004, defaultValue: '' }),
  ];
}

// Many connection references of a few connector types (demo of the grouped Connections step).
function buildHrSystem() {
  const ref = (display, logical, connector) => c(10021, display, logical, { typeName: 'Connection Reference', connectorId: `/providers/Microsoft.PowerApps/apis/${connector}` });
  const sp = ['', 'HR_System-13b17', 'HR_System-205ed', 'HR_System-20de7', 'HR_System-412ae', 'HR_System-50648', 'HR_System-5727d', 'HR_System-6d77c', 'HR_System-91022',
    'HR_System-958e3', 'HR_System-a53e8', 'HR_System-c0643', 'HR_System-e3ed0', 'HR_System-e7cfb', 'HR_System-eafe7', 'HR_System-f070b', 'HR_System-fdf83', 'Leave requests-0aa31', 'Onboarding-77c02'];
  return [
    c(1, 'Employee', 'cr_employee'),
    c(300, 'HR System', 'cr_hrsystem_3c9d1', { canvas: { lastSaved: daysAgo(1), lastPublished: daysAgo(1) } }),
    ...sp.map((suffix, i) => ref(suffix ? `SharePoint ${suffix}` : 'SharePoint', `new_sharedsharepointonline_${(0x1d7af + i * 4099).toString(16).slice(-5)}`, 'shared_sharepointonline')),
    ref('Office 365 Outlook', 'new_sharedoffice365_5ef21', 'shared_office365'),
    ref('Office 365 Outlook HR_System-a12f0', 'new_sharedoffice365_a12f0', 'shared_office365'),
    ref('OneDrive for Business HR_System-ca697', 'new_sharedonedriveforbusiness_ca697', 'shared_onedriveforbusiness'),
    ref('Microsoft Teams Notifications-74c8b', 'new_sharedteams_74c8b', 'shared_teams'),
    c(29, 'New hire onboarding', 'New hire onboarding', { typeName: 'Cloud Flow' }),
    c(380, 'SharepointURL', 'new_SharepointURL', { envType: 100000000, defaultValue: 'https://contoso.sharepoint.com/sites/HumanResources/Shared%20Documents/Onboarding/Templates' }),
  ];
}

function solution(uniqueName, displayName, version, components, extra = {}) {
  return { id: guid(), uniqueName, displayName, version, isManaged: false, description: '', installedOn: new Date(Date.now() - 86400000 * 30).toISOString(), modifiedOn: new Date().toISOString(), publisher: PUBLISHER, components, ...extra };
}

const SOLUTIONS = new Map(); // envId -> [solution]
for (const list of Object.values(ENVIRONMENTS)) for (const e of list) SOLUTIONS.set(e.id, []);

const contosoDev = ENVIRONMENTS[TENANTS.contoso.tenantId][0];
SOLUTIONS.set(contosoDev.id, [
  solution('ContosoSalesHub', 'Contoso Sales Hub', '1.4.2.0', buildSalesHub(), { description: 'Model-driven sales app, canvas companion app and flows' }),
  solution('LegacyIntegration', 'Legacy Integration', '2.0.0.3', buildLegacy(), { description: 'Plug-ins for the legacy ERP (try excluding the plug-in assembly)' }),
  solution('CoreComponents', 'Core Components', '1.0.0.12', buildCore()),
  solution('FieldInspections', 'Field Inspections', '1.1.0.0', buildFieldInspections(), { description: 'Canvas app with unpublished changes (demo of the publish check)' }),
  solution('HR_System', 'HR System', '1.0.0.1', buildHrSystem(), { description: '23 connection references of 4 connector types (demo of grouped connections)' }),
  solution('MicrosoftFlowSolution', 'Common Data Services Default Solution', '1.0.0.0', [c(29, 'Sample flow', 'Sample flow')]),
  solution('msdyn_AppFrameworkInfraExtensions', 'App Framework Infra Extensions', '1.0.0.6', [c(61, 'msdyn_/infra.js', 'msdyn_/infra.js')], { isManaged: true, publisher: { id: guid(), uniqueName: 'microsoftdynamics', displayName: 'Dynamics 365', prefix: 'msdyn' } }),
]);
ACTIVE_POOL.set(contosoDev.id, [spConnection, childFlow]);

// Per-environment state of connection references and environment variable values.
const CONN_STATE = new Map(); // `${envId}|${logicalName}` -> connectionId
const ENV_VALUES = new Map(); // `${envId}|${schemaName}` -> value
CONN_STATE.set(`${contosoDev.id}|cr_sharedcommondataserviceforapps_1a2b3`, 'shared-commondataserviceforapps-dev-1');
CONN_STATE.set(`${contosoDev.id}|cr_sharedoffice365_4c5d6`, 'shared-office365-dev-1');
CONN_STATE.set(`${contosoDev.id}|cr_sharedsharepointonline_6a422`, 'shared-sharepointonline-dev-1');
ENV_VALUES.set(`${contosoDev.id}|cr_PricingApiBaseUrl`, 'https://pricing-dev.contoso.com/api');

const CONNECTOR_LABELS = {
  shared_commondataserviceforapps: 'Microsoft Dataverse',
  shared_office365: 'Office 365 Outlook',
  shared_sharepointonline: 'SharePoint',
  shared_onedriveforbusiness: 'OneDrive for Business',
  shared_teams: 'Microsoft Teams',
};

function mockConnections(environment, connector) {
  const label = CONNECTOR_LABELS[connector] || connector;
  const short = environment.uniqueName.split('-').pop();
  const owner = environment.tenantId === TENANTS.fabrikam.tenantId || environment.tenantId === TENANTS.northwind.tenantId ? ACCOUNTS.target.username : ACCOUNTS.source.username;
  return [
    { id: `${connector.replace(/_/g, '-')}-${short}-1`, displayName: `${label} (${owner})`, status: 'Connected', connected: true, createdBy: owner },
    { id: `${connector.replace(/_/g, '-')}-${short}-2`, displayName: `${label} – service account`, status: connector === 'shared_sharepointonline' ? 'Error' : 'Connected', connected: connector !== 'shared_sharepointonline', createdBy: `svc-integration@${owner.split('@')[1]}` },
  ];
}
const fabrikamProd = ENVIRONMENTS[TENANTS.fabrikam.tenantId][1];
SOLUTIONS.set(fabrikamProd.id, [solution('CoreComponents', 'Core Components', '1.0.0.9', buildCore(), { isManaged: true })]);

// ---------------------------------------------------------------------------------------
// Mock auth (same interface as src/auth.js)
// ---------------------------------------------------------------------------------------

// Demo sign-ins, per workspace (each user of a hosted migrator signs in separately).
const signedInByWs = new Map();
const signedInFor = () => {
  const k = require('../workspace').key();
  if (!signedInByWs.has(k)) signedInByWs.set(k, { source: false, target: false });
  return signedInByWs.get(k);
};

const mockAuth = {
  async getLoginUrl(slot) { return `/auth/callback?mock=1&slot=${encodeURIComponent(slot)}`; },
  async handleCallback(query) {
    if (!ACCOUNTS[query.slot]) throw new Error('Unknown slot');
    signedInFor()[query.slot] = true;
    return { slot: query.slot, account: describe(query.slot) };
  },
  getStatus() {
    const signedIn = signedInFor();
    return Object.fromEntries(Object.keys(signedIn).map((s) => [s, { signedIn: signedIn[s], account: signedIn[s] ? describe(s) : null }]));
  },
  async signOut(slot) { signedInFor()[slot] = false; },
};

function describe(slot) {
  const a = ACCOUNTS[slot];
  return { username: a.username, name: a.name, homeTenantId: a.homeTenantId };
}

function requireSignIn(slot, tenantId) {
  if (!signedInFor()[slot]) throw new AuthRequiredError(slot, tenantId);
  if (tenantId && !ACCOUNTS[slot].tenants.some((k) => TENANTS[k].tenantId === tenantId)) {
    throw new MockError(`The account ${ACCOUNTS[slot].username} has no access to tenant ${tenantId}.`, 403);
  }
}

// ---------------------------------------------------------------------------------------
// Directory + Dataverse client
// ---------------------------------------------------------------------------------------

class Directory {
  constructor(slot) { this.slot = slot; }

  async listTenants() {
    requireSignIn(this.slot);
    await sleep(300);
    const home = ACCOUNTS[this.slot].homeTenantId;
    return ACCOUNTS[this.slot].tenants.map((k) => ({ ...TENANTS[k], isHome: TENANTS[k].tenantId === home }));
  }

  async listEnvironments(tenantId) {
    requireSignIn(this.slot, tenantId);
    await sleep(400);
    return (ENVIRONMENTS[tenantId] || []).map((e) => ({ ...e }));
  }
}

const publicSolution = ({ components, ...s }) => ({ ...s });

class MockDataverseClient {
  constructor(slot, tenantId, environment) {
    this.slot = slot;
    this.tenantId = tenantId;
    this.env = environment;
    if (!SOLUTIONS.has(environment.id)) throw new MockError('Environment not found', 404);
  }

  get solutions() { return SOLUTIONS.get(this.env.id); }

  find(id) {
    const s = this.solutions.find((x) => x.id === id);
    if (!s) throw new MockError(`Solution ${id} was not found in ${this.env.name}.`, 404);
    return s;
  }

  async listSolutions() {
    requireSignIn(this.slot, this.tenantId);
    await sleep(350);
    return this.solutions.map(publicSolution).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getSolution(id) { return publicSolution(this.find(id)); }

  async findSolutionByUniqueName(uniqueName) {
    const s = this.solutions.find((x) => x.uniqueName.toLowerCase() === uniqueName.toLowerCase());
    return s ? publicSolution(s) : null;
  }

  async listComponents(solutionId) {
    requireSignIn(this.slot, this.tenantId);
    await sleep(450);
    return this.find(solutionId).components.map(({ dependsOn, ...comp }) => ({ ...comp }));
  }


  envComponents() {
    const seen = new Map();
    for (const comp of [...this.solutions.flatMap((s) => s.components), ...(ACTIVE_POOL.get(this.env.id) || [])]) {
      if (!seen.has(comp.objectId)) seen.set(comp.objectId, comp);
    }
    return [...seen.values()];
  }

  async connectionReferences({ ids, logicalNames }) {
    await sleep(150);
    const want = ids ? new Set(ids.map((x) => x.toLowerCase())) : null;
    const names = logicalNames ? new Set(logicalNames.map((x) => x.toLowerCase())) : null;
    return this.envComponents()
      .filter((x) => x.typeName === 'Connection Reference')
      .filter((x) => (want ? want.has(x.objectId.toLowerCase()) : names ? names.has(x.name.toLowerCase()) : false))
      .map((x) => ({ id: x.objectId, logicalName: x.name, displayName: x.displayName, connectorId: x.connectorId, connectionId: CONN_STATE.get(`${this.env.id}|${x.name}`) || null }));
  }

  async environmentVariables({ ids, schemaNames }) {
    await sleep(150);
    const want = ids ? new Set(ids.map((x) => x.toLowerCase())) : null;
    const names = schemaNames ? new Set(schemaNames.map((x) => x.toLowerCase())) : null;
    return this.envComponents()
      .filter((x) => x.componentType === 380)
      .filter((x) => (want ? want.has(x.objectId.toLowerCase()) : names ? names.has(x.name.toLowerCase()) : false))
      .map((x) => {
        const key = `${this.env.id}|${x.name}`;
        return { id: x.objectId, schemaName: x.name, displayName: x.displayName, type: x.envType || 100000000, defaultValue: x.defaultValue ?? null, value: ENV_VALUES.has(key) ? ENV_VALUES.get(key) : null, valueId: ENV_VALUES.has(key) ? key : null };
      });
  }

  async setConnectionReference(logicalName, connectionId) {
    const [ref] = await this.connectionReferences({ logicalNames: [logicalName] });
    if (!ref) throw new MockError(`Connection reference ${logicalName} does not exist in ${this.env.name}.`, 404);
    if (ref.connectionId === connectionId) return 'unchanged';
    if (/-2$/.test(connectionId) && /sharepoint/.test(connectionId)) throw new MockError('The connection is in an error state (credentials expired). Fix or recreate it in the target environment.', 400);
    CONN_STATE.set(`${this.env.id}|${logicalName}`, connectionId);
    return 'updated';
  }

  async setEnvironmentVariableValue(schemaName, value) {
    const [def] = await this.environmentVariables({ schemaNames: [schemaName] });
    if (!def) throw new MockError(`Environment variable ${schemaName} does not exist in ${this.env.name}.`, 404);
    const key = `${this.env.id}|${def.schemaName}`;
    const had = ENV_VALUES.has(key);
    if (had && ENV_VALUES.get(key) === value) return 'unchanged';
    ENV_VALUES.set(key, value);
    return had ? 'updated' : 'created';
  }

  async activateSolutionFlows(solutionId) {
    await sleep(200);
    const sol = this.find(solutionId);
    const refs = sol.components.filter((x) => x.typeName === 'Connection Reference');
    const unbound = refs.filter((r) => !CONN_STATE.get(`${this.env.id}|${r.name}`));
    return sol.components.filter((x) => x.typeName === 'Cloud Flow').map((f) => (unbound.length
      ? { name: f.displayName, ...classifyFlowError('A connector was imported, however the related connection references need connections created and then any dependent flows can be started.') }
      : { name: f.displayName, result: 'activated' }));
  }

  async listConnections(connector) {
    await sleep(250);
    if (!/^[\w.-]+$/.test(connector)) throw new MockError('Invalid connector name.', 400);
    return mockConnections(this.env, connector);
  }

  async canvasAppStatus(apps) {
    await sleep(300);
    return apps.map((a) => {
      const comp = this.findComponent(a.objectId);
      const cv = (comp && comp.canvas) || {};
      const verdict = assessCanvasApp({ properties: { lastPublishTime: cv.lastPublished, lastModifiedTime: cv.lastSaved } }, null);
      return {
        objectId: a.objectId, appId: a.objectId, displayName: comp ? comp.displayName : a.displayName, name: comp ? comp.name : '',
        ...verdict, reason: '', stepUp: null,
        editUrl: `https://make.powerapps.com/e/${this.env.environmentId}/canvas/?action=edit&app-id=${encodeURIComponent(`/providers/Microsoft.PowerApps/apps/${a.objectId}`)}`,
      };
    });
  }

  async publishAll() { await sleep(1500); }

  async createSolution({ uniqueName, displayName, publisherId, version, description }) {
    await sleep(400);
    if (this.solutions.some((s) => s.uniqueName.toLowerCase() === uniqueName.toLowerCase())) {
      throw new MockError(`A solution with the unique name ${uniqueName} already exists.`);
    }
    const s = solution(uniqueName, displayName, version, [], { description, publisher: { ...PUBLISHER, id: publisherId } });
    this.solutions.push(s);
    return s.id;
  }

  async addComponent({ objectId, solutionUniqueName }) {
    await sleep(120);
    const target = this.solutions.find((s) => s.uniqueName === solutionUniqueName);
    if (!target) throw new MockError(`Solution ${solutionUniqueName} not found.`, 404);
    const comp = this.findComponent(objectId);
    if (!comp) throw new MockError(`Component ${objectId} not found.`, 404);
    if (!target.components.includes(comp)) target.components.push(comp);
  }

  findComponent(objectId) {
    for (const s of this.solutions) {
      const comp = s.components.find((x) => x.objectId === objectId);
      if (comp) return comp;
    }
    return (ACTIVE_POOL.get(this.env.id) || []).find((x) => x.objectId === objectId) || null;
  }

  async retrieveMissingDependencies(uniqueName) {
    await sleep(300);
    const s = this.solutions.find((x) => x.uniqueName === uniqueName);
    if (!s) throw new MockError(`Solution ${uniqueName} not found.`, 404);
    const inSolution = new Set(s.components.map((x) => x.objectId));
    const out = [];
    for (const comp of s.components) {
      for (const dep of comp.dependsOn || []) {
        if (inSolution.has(dep)) continue;
        const req = this.findComponent(dep);
        out.push({ requiredId: dep, requiredType: req ? req.componentType : 0, dependentId: comp.objectId, dependentType: comp.componentType });
      }
    }
    return out;
  }

  async retrieveRequiredComponents(objectId, componentType) {
    const comp = this.findComponent(objectId);
    return ((comp && comp.dependsOn) || []).map((dep) => {
      const req = this.findComponent(dep);
      return { requiredId: dep, requiredType: req ? req.componentType : 0, dependentId: objectId, dependentType: componentType };
    });
  }

  async componentSolutions(objectId) {
    const out = this.solutions.filter((s) => s.components.some((x) => x.objectId === objectId))
      .map((s) => ({ uniqueName: s.uniqueName, displayName: s.displayName, isManaged: s.isManaged }));
    if ((ACTIVE_POOL.get(this.env.id) || []).some((x) => x.objectId === objectId)) out.push({ uniqueName: 'Active', displayName: 'Active Solution', isManaged: false });
    return out;
  }

  async describeComponent(objectId, type) {
    const comp = this.findComponent(objectId);
    return comp ? { id: objectId, type: comp.componentType, typeName: comp.typeName, displayName: comp.displayName } : { id: objectId, type, typeName: componentTypeName(type), displayName: objectId };
  }

  async deleteSolution(id) {
    await sleep(300);
    SOLUTIONS.set(this.env.id, this.solutions.filter((s) => s.id !== id));
  }

  async exportSolution(uniqueName, managed, onProgress) {
    const s = this.solutions.find((x) => x.uniqueName === uniqueName);
    if (!s) throw new MockError(`Solution ${uniqueName} not found.`, 404);
    for (let p = 10; p <= 90; p += 20) { onProgress && onProgress(p, 'Exporting…'); await sleep(450); }
    return buildPackage(s, managed);
  }

  async importSolution(buffer, opts, onProgress) {
    const zip = new AdmZip(buffer);
    const manifest = zip.readAsText('solution.xml');
    const uniqueName = manifest.match(/<UniqueName>([^<]*)<\/UniqueName>/)[1];
    const displayName = (manifest.match(/<LocalizedName\s+description="([^"]*)"/) || [])[1] || uniqueName;
    const version = manifest.match(/<Version>([^<]*)<\/Version>/)[1];
    const managed = /<Managed>1<\/Managed>/.test(manifest);
    const components = JSON.parse(zip.readAsText('mock-components.json'));
    const importJobId = guid();

    const included = new Set(components.map((x) => x.objectId));
    const missing = [];
    for (const comp of components) {
      for (const dep of comp.dependsOn || []) {
        if (!included.has(dep)) missing.push(comp);
      }
    }

    const results = components.map((comp) => ({ comp, result: 'success' }));
    for (let p = 0; p <= 100; p += 10) {
      onProgress && onProgress(p, `Importing… ${p}%`);
      await sleep(350);
      if (missing.length && p >= 40) {
        const job = { results: missing.map((m) => ({ comp: m, result: 'failure', message: `Missing dependency: ${m.typeName} "${m.displayName}" requires a component that is not present in the target environment or the solution.` })) };
        IMPORT_JOBS.set(importJobId, job);
        const err = new MockError(
          `Solution manifest import: FAILURE: The following solution cannot be imported: ${uniqueName}. Some dependencies are missing. ` +
          `The missing dependencies are: ${missing.map((m) => `${m.typeName} "${m.displayName}"`).join('; ')}.`, 500);
        err.importJobId = importJobId;
        throw err;
      }
    }
    // Settings passed with the import (connection references / environment variable values).
    const cp = opts.componentParameters || {};
    for (const m of cp.connectionReferences || []) if (m.connectionId) CONN_STATE.set(`${this.env.id}|${m.logicalName}`, m.connectionId);
    for (const v of cp.environmentVariables || []) if (v.value !== undefined && v.value !== null) ENV_VALUES.set(`${this.env.id}|${v.schemaName}`, String(v.value));
    // Flows whose connection references have no connection can't be turned on.
    const unbound = components.filter((x) => x.typeName === 'Connection Reference' && !CONN_STATE.get(`${this.env.id}|${x.name}`));
    for (const r of results) {
      if (r.comp.typeName === 'Cloud Flow' && opts.publishWorkflows && unbound.length) { r.result = 'failure'; r.message = `The flow could not be activated because connection reference "${unbound[0].displayName}" has no connection in this environment.`; }
    }
    IMPORT_JOBS.set(importJobId, { results });

    const existing = this.solutions.find((x) => x.uniqueName.toLowerCase() === uniqueName.toLowerCase());
    const comps = components.map(({ dependsOn, ...rest }) => ({ ...rest }));
    if (existing) Object.assign(existing, { version, displayName, components: comps, modifiedOn: new Date().toISOString() });
    else this.solutions.push(solution(uniqueName, displayName, version, comps, { isManaged: managed }));
    return { importJobId };
  }

  async getImportJobResults(importJobId) {
    const job = IMPORT_JOBS.get(importJobId);
    if (!job) throw new MockError('Import job not found', 404);
    const counts = { success: 0, warning: 0, failure: 0 };
    const issues = [];
    for (const r of job.results) {
      counts[r.result]++;
      if (r.result !== 'success') issues.push({ level: r.result, component: `${r.comp.typeName}: ${r.comp.displayName}`, message: r.message });
    }
    return { counts, issues, progress: 100 };
  }

  async getImportLog(importJobId) {
    const job = IMPORT_JOBS.get(importJobId);
    if (!job) throw new MockError('Import job not found', 404);
    const rows = job.results.map((r) => `<Row><Cell><Data ss:Type="String">${r.comp.typeName}</Data></Cell><Cell><Data ss:Type="String">${r.comp.displayName}</Data></Cell><Cell><Data ss:Type="String">${r.result}</Data></Cell><Cell><Data ss:Type="String">${r.message || ''}</Data></Cell></Row>`).join('');
    return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Components"><Table><Row><Cell><Data ss:Type="String">Type</Data></Cell><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">Result</Data></Cell><Cell><Data ss:Type="String">Details</Data></Cell></Row>${rows}</Table></Worksheet></Workbook>`;
  }
}

const IMPORT_JOBS = new Map();

// A minimal .msapp (itself a zip) with the parts the migrator reads: header, properties, screens.
function mockMsapp(comp) {
  const z = new AdmZip();
  const saved = new Date((comp.canvas && comp.canvas.lastPublished) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(saved.getUTCMonth() + 1)}/${pad(saved.getUTCDate())}/${saved.getUTCFullYear()} ${pad(saved.getUTCHours())}:${pad(saved.getUTCMinutes())}:${pad(saved.getUTCSeconds())}`;
  z.addFile('Header.json', Buffer.from(JSON.stringify({ DocVersion: '1.346', LastSavedDateTimeUTC: stamp })));
  z.addFile('Properties.json', Buffer.from(JSON.stringify({ Name: comp.displayName })));
  const ctl = (name, template) => Buffer.from(JSON.stringify({ TopParent: { Name: name, Template: { Name: template, Id: `http://microsoft.com/appmagic/${template}` } } }));
  z.addFile('Controls/1.json', ctl('App', 'appinfo'));
  (comp.canvas && comp.canvas.screens ? comp.canvas.screens : ['HomeScreen', 'DetailScreen', 'EditScreen'])
    .forEach((n, i) => z.addFile(`Controls/${i + 2}.json`, ctl(n, 'screen')));
  return z.toBuffer();
}

function buildPackage(s, managed) {
  const zip = new AdmZip();
  const solutionXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.25104.172" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive">
  <SolutionManifest>
    <UniqueName>${s.uniqueName}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${s.displayName.replace(/"/g, '&quot;')}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${s.version}</Version>
    <Managed>${managed ? 1 : 0}</Managed>
    <Publisher>
      <UniqueName>${s.publisher.uniqueName}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${s.publisher.displayName}" languagecode="1033" />
      </LocalizedNames>
      <CustomizationPrefix>${s.publisher.prefix}</CustomizationPrefix>
    </Publisher>
    <RootComponents />
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
  const connRefs = s.components.filter((x) => x.typeName === 'Connection Reference')
    .map((x) => `<connectionreference connectionreferencelogicalname="${x.name}"><connectionreferencedisplayname>${x.displayName}</connectionreferencedisplayname></connectionreference>`).join('');
  zip.addFile('solution.xml', Buffer.from(solutionXml, 'utf8'));
  zip.addFile('customizations.xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?><ImportExportXml><Entities /><connectionreferences>${connRefs}</connectionreferences></ImportExportXml>`, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" /></Types>', 'utf8'));
  for (const x of s.components) {
    if (x.componentType === 380) zip.addFile(`environmentvariabledefinitions/${x.name}/environmentvariabledefinition.xml`, Buffer.from('<environmentvariabledefinition />'));
    if (x.componentType === 300) zip.addFile(`CanvasApps/${x.name}_DocumentUri.msapp`, mockMsapp(x));
    if (x.typeName === 'Cloud Flow') zip.addFile(`Workflows/${x.name.replace(/\W+/g, '')}-${x.objectId.toUpperCase()}.json`, Buffer.from('{}'));
  }
  zip.addFile('mock-components.json', Buffer.from(JSON.stringify(s.components), 'utf8'));
  return zip.toBuffer();
}

// Demo/test helper: "publish" a canvas app (as if done in Power Apps Studio).
function publishCanvasApp(displayName) {
  for (const list of SOLUTIONS.values()) {
    for (const s of list) {
      for (const comp of s.components) {
        if (comp.componentType === 300 && comp.displayName === displayName && comp.canvas) {
          comp.canvas.lastPublished = new Date().toISOString();
          comp.canvas.lastSaved = comp.canvas.lastPublished;
          return true;
        }
      }
    }
  }
  return false;
}

module.exports = {
  name: 'mock',
  publishCanvasApp,
  auth: mockAuth,
  tenants: Object.values(TENANTS),
  directory: (slot) => new Directory(slot),
  dataverse: (slot, tenantId, environment) => new MockDataverseClient(slot, tenantId, environment),
};
