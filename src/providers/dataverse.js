'use strict';

/**
 * Real provider: talks to Azure Resource Manager (tenants), the Dataverse Global Discovery
 * Service (environments) and the Dataverse Web API (solutions, export, import).
 */

const config = require('../config');
const auth = require('../auth');
const network = require('../network');
const { assessCanvasApp, classifyFlowError } = require('../configuration');
const { readManifest } = require('../solutionPackage');
const { componentTypeName, friendlyTypeName, WORKFLOW_CATEGORIES } = require('../componentTypes');

const API = 'api/data/v9.2';

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertDataverseUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new ApiError(`Invalid environment URL: ${url}`, 400); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !config.dataverseHostSuffixes.some((s) => host.endsWith(s))) {
    throw new ApiError(`Refusing to send credentials to non-Dataverse host "${host}". Adjust DATAVERSE_HOST_SUFFIXES if this is a sovereign cloud.`, 400);
  }
  return `${u.protocol}//${u.host}`;
}

async function request(url, { method = 'GET', token, body, headers = {}, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const e = network.explain(err);
      const apiErr = new ApiError(`Could not connect to ${new URL(url).host}${e ? ` (${e.code}). ${e.hint}` : `: ${err.message}`}`, 502);
      apiErr.networkCode = e ? e.code : 'UNKNOWN';
      throw apiErr;
    }

    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
      await sleep((Number.isFinite(retryAfter) ? retryAfter : 2 ** attempt * 2) * 1000);
      continue;
    }

    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { /* not JSON */ } }

    if (!res.ok) {
      const e = json && json.error;
      const message = (e && (e.message || e.Message)) || (json && json.message) || text || res.statusText;
      if (res.status === 401) {
        throw new ApiError(`Access denied (401) calling ${new URL(url).host}: ${message}`, 401, json);
      }
      throw new ApiError(message, res.status, json || text);
    }
    return json;
  }
}

async function getAll(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const page = await request(next, { token, headers: { Prefer: 'odata.maxpagesize=5000' } });
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Directory: tenants & environments
// ---------------------------------------------------------------------------------------

class Directory {
  constructor(slot) {
    this.slot = slot;
  }

  async listTenants() {
    const account = auth.getAccount(this.slot);
    if (!account) throw new auth.AuthRequiredError(this.slot);
    const home = { tenantId: account.tenantId, displayName: 'Home tenant', defaultDomain: (account.username || '').split('@')[1] || '' };
    try {
      const token = await auth.getToken(this.slot, account.tenantId, `${config.armUrl}/user_impersonation`);
      const items = await getAll(`${config.armUrl}/tenants?api-version=2022-12-01`, token);
      const tenants = items.map((t) => ({
        tenantId: t.tenantId,
        displayName: t.displayName || t.defaultDomain || t.tenantId,
        defaultDomain: t.defaultDomain || (t.domains && t.domains[0]) || '',
        isHome: t.tenantId === account.tenantId,
      }));
      if (!tenants.some((t) => t.tenantId === account.tenantId)) tenants.unshift({ ...home, isHome: true });
      return tenants.sort((a, b) => (b.isHome - a.isHome) || a.displayName.localeCompare(b.displayName));
    } catch (err) {
      if (err instanceof auth.AuthRequiredError) {
        // E.g. Conditional Access demands MFA for Azure management. Don't block the user:
        // fall back to the home tenant and offer an MFA step-up to list all tenants.
        return [{ ...home, isHome: true, note: 'Only your home tenant is shown: listing all tenants requires multi-factor authentication.', stepUp: { tenantId: account.tenantId, scope: `${config.armUrl}/user_impersonation` } }];
      }
      // ARM may be blocked (no Azure Service Management permission); fall back to the home tenant.
      return [{ ...home, isHome: true, note: `Tenant list unavailable (${err.message}). Add other tenants manually.` }];
    }
  }

  async listEnvironments(tenantId) {
    const token = await auth.getToken(this.slot, tenantId, `${config.discoveryUrl}/.default`);
    const items = await getAll(`${config.discoveryUrl}/api/discovery/v2.0/Instances`, token);
    return items
      .filter((i) => !i.TenantId || i.TenantId.toLowerCase() === tenantId.toLowerCase())
      .map((i) => ({
        id: i.Id,
        environmentId: i.EnvironmentId || null,
        name: i.FriendlyName || i.UniqueName,
        uniqueName: i.UniqueName,
        url: i.Url,
        region: i.Region || '',
        version: i.Version || '',
        state: i.State === 0 ? 'Ready' : 'Disabled',
        tenantId: i.TenantId || tenantId,
      }))
      .filter((e) => { try { assertDataverseUrl(e.url); return true; } catch { return false; } })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------------------------
// Dataverse Web API client for one environment
// ---------------------------------------------------------------------------------------

class DataverseClient {
  constructor(slot, tenantId, env) {
    this.slot = slot;
    this.tenantId = tenantId;
    this.env = env;
    this.baseUrl = assertDataverseUrl(env.url);
  }

  async token() {
    return auth.getToken(this.slot, this.tenantId, `${this.baseUrl}/.default`);
  }

  async call(path, opts = {}) {
    return request(`${this.baseUrl}/${API}/${path}`, { ...opts, token: await this.token() });
  }

  async all(path) {
    return getAll(`${this.baseUrl}/${API}/${path}`, await this.token());
  }

  static mapSolution(s) {
    return {
      id: s.solutionid,
      uniqueName: s.uniquename,
      displayName: s.friendlyname,
      version: s.version,
      isManaged: Boolean(s.ismanaged),
      description: s.description || '',
      installedOn: s.installedon || null,
      modifiedOn: s.modifiedon || null,
      publisher: s.publisherid
        ? { id: s.publisherid.publisherid, uniqueName: s.publisherid.uniquename, displayName: s.publisherid.friendlyname, prefix: s.publisherid.customizationprefix }
        : { id: s._publisherid_value },
    };
  }

  static get SOLUTION_QUERY() {
    return '$select=solutionid,uniquename,friendlyname,version,ismanaged,description,installedon,modifiedon,_publisherid_value'
      + '&$expand=publisherid($select=publisherid,uniquename,friendlyname,customizationprefix)';
  }

  async listSolutions() {
    const rows = await this.all(`solutions?${DataverseClient.SOLUTION_QUERY}&$filter=isvisible eq true and uniquename ne 'Default'&$orderby=friendlyname`);
    return rows.map(DataverseClient.mapSolution);
  }

  async getSolution(id) {
    const row = await this.call(`solutions(${id})?${DataverseClient.SOLUTION_QUERY}`);
    return DataverseClient.mapSolution(row);
  }

  async findSolutionByUniqueName(uniqueName) {
    const safe = uniqueName.replace(/'/g, "''");
    const rows = await this.all(`solutions?${DataverseClient.SOLUTION_QUERY}&$filter=uniquename eq '${safe}'`);
    return rows.length ? DataverseClient.mapSolution(rows[0]) : null;
  }

  async dynamicComponentTypeNames() {
    try {
      const rows = await this.all('solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname');
      const out = {};
      for (const r of rows) out[r.solutioncomponenttype] = r.name || r.primaryentityname;
      return out;
    } catch { return {}; }
  }

  async componentSummaries(solutionId) {
    // Virtual table used by the maker portal; gives friendly names for every component type.
    try {
      const rows = await this.all(`msdyn_solutioncomponentsummaries?$filter=msdyn_solutionid eq ${solutionId}`);
      const map = new Map();
      for (const r of rows) {
        if (!r.msdyn_objectid) continue;
        map.set(String(r.msdyn_objectid).toLowerCase(), {
          displayName: r.msdyn_displayname || r.msdyn_name,
          name: r.msdyn_name || r.msdyn_uniquename || r.msdyn_schemaname,
          typeName: r.msdyn_componenttypename,
        });
      }
      return map;
    } catch { return new Map(); }
  }

  async listComponents(solutionId) {
    const [rows, summaries, typeNames] = await Promise.all([
      this.all(`solutioncomponents?$select=solutioncomponentid,componenttype,objectid,rootcomponentbehavior,rootsolutioncomponentid&$filter=_solutionid_value eq ${solutionId}`),
      this.componentSummaries(solutionId),
      this.dynamicComponentTypeNames(),
    ]);
    // "Process" covers cloud flows, classic workflows, business rules, actions, BPFs: tell them apart.
    const categories = await this.workflowCategories(rows.filter((r) => r.componenttype === 29).map((r) => r.objectid));
    return rows.map((r) => {
      const summary = summaries.get(String(r.objectid).toLowerCase()) || {};
      const category = categories.get(String(r.objectid).toLowerCase());
      return {
        id: r.solutioncomponentid,
        objectId: r.objectid,
        componentType: r.componenttype,
        typeName: r.componenttype === 29 && category !== undefined && WORKFLOW_CATEGORIES[category]
          ? WORKFLOW_CATEGORIES[category]
          : friendlyTypeName(r.componenttype, summary.typeName, typeNames),
        displayName: summary.displayName || summary.name || r.objectid,
        name: summary.name || '',
        rootComponentBehavior: r.rootcomponentbehavior ?? null,
        parentId: r.rootsolutioncomponentid || null,
      };
    });
  }

  async workflowCategories(ids) {
    const out = new Map();
    if (!ids.length) return out;
    try {
      const rows = await this.inChunks(ids, (chunk) => this.all(`workflows?$select=workflowid,category&$filter=${DataverseClient.orFilter('workflowid', chunk)}`));
      for (const r of rows) out.set(String(r.workflowid).toLowerCase(), r.category);
    } catch { /* fall back to "Process" */ }
    return out;
  }

  /** Required components that are not in the solution (dependency rows). */
  async retrieveMissingDependencies(solutionUniqueName) {
    const name = solutionUniqueName.replace(/'/g, "''");
    const res = await this.call(`RetrieveMissingDependencies(SolutionUniqueName=@p)?@p='${encodeURIComponent(name)}'`);
    const rows = res.value || (res.EntityCollection && (res.EntityCollection.Entities || res.EntityCollection)) || [];
    return rows.map((r) => ({
      requiredId: r.requiredcomponentobjectid,
      requiredType: r.requiredcomponenttype,
      dependentId: r.dependentcomponentobjectid,
      dependentType: r.dependentcomponenttype,
    }));
  }

  /** Components that one component requires (dependency rows). */
  async retrieveRequiredComponents(objectId, componentType) {
    const res = await this.call(`RetrieveRequiredComponents(ObjectId=@id,ComponentType=@t)?@id=${objectId}&@t=${Number(componentType)}`);
    const rows = res.value || (res.EntityCollection && (res.EntityCollection.Entities || res.EntityCollection)) || [];
    return rows.map((r) => ({ requiredId: r.requiredcomponentobjectid, requiredType: r.requiredcomponenttype, dependentId: r.dependentcomponentobjectid, dependentType: r.dependentcomponenttype }));
  }

  /** Solutions a component belongs to (in this environment). */
  async componentSolutions(objectId) {
    const rows = await this.all(`solutioncomponents?$select=componenttype&$filter=objectid eq ${objectId}&$expand=solutionid($select=uniquename,friendlyname,ismanaged)`);
    return rows.filter((r) => r.solutionid).map((r) => ({
      uniqueName: r.solutionid.uniquename, displayName: r.solutionid.friendlyname, isManaged: Boolean(r.solutionid.ismanaged),
    }));
  }

  /** Friendly name and type for any component (best effort). */
  async describeComponent(objectId, type) {
    if (!this._typeNames) this._typeNames = await this.dynamicComponentTypeNames();
    const base = { id: objectId, type, typeName: componentTypeName(type, this._typeNames), displayName: objectId };
    // 1. The maker portal's component summary table, scoped to the Default solution (contains everything).
    try {
      if (this._defaultSolutionId === undefined) {
        const d = await this.findSolutionByUniqueName('Default');
        this._defaultSolutionId = d ? d.id : null;
      }
      if (this._defaultSolutionId) {
        for (const filter of [`msdyn_objectid eq '${objectId}'`, `msdyn_objectid eq ${objectId}`]) {
          try {
            const rows = await this.all(`msdyn_solutioncomponentsummaries?$filter=msdyn_solutionid eq ${this._defaultSolutionId} and ${filter}`);
            if (rows.length) {
              const r = rows[0];
              let typeName = friendlyTypeName(type, r.msdyn_componenttypename, this._typeNames);
              if (type === 29) {
                const cat = (await this.workflowCategories([objectId])).get(String(objectId).toLowerCase());
                if (cat !== undefined && WORKFLOW_CATEGORIES[cat]) typeName = WORKFLOW_CATEGORIES[cat];
              }
              return { ...base, typeName, displayName: r.msdyn_displayname || r.msdyn_name || objectId, logicalName: r.msdyn_name || '' };
            }
            break;
          } catch { /* try the next filter form */ }
        }
      }
    } catch { /* fall through */ }
    // 2. Type-specific lookups for the usual suspects.
    const tries = [];
    if (type === 29) tries.push([`workflows(${objectId})?$select=name,category`, (r) => ({ displayName: r.name, typeName: r.category === 5 ? 'Cloud Flow' : 'Process' })]);
    if (type === 300) tries.push([`canvasapps(${objectId})?$select=displayname,name`, (r) => ({ displayName: r.displayname || r.name })]);
    if (type === 380) tries.push([`environmentvariabledefinitions(${objectId})?$select=displayname,schemaname`, (r) => ({ displayName: r.displayname || r.schemaname })]);
    if (type >= 10000) tries.push([`connectionreferences(${objectId})?$select=connectionreferencedisplayname,connectionreferencelogicalname`, (r) => ({ displayName: r.connectionreferencedisplayname || r.connectionreferencelogicalname, typeName: 'Connection Reference', logicalName: r.connectionreferencelogicalname })]);
    for (const [path, map] of tries) {
      try { return { ...base, ...map(await this.call(path)) }; } catch { /* next */ }
    }
    return base;
  }


  // --- connection references & environment variables ---------------------------------------

  static orFilter(field, values, quote) {
    return values.map((v) => `${field} eq ${quote ? `'${String(v).replace(/'/g, "''")}'` : v}`).join(' or ');
  }

  async inChunks(values, fn) {
    const out = [];
    for (let i = 0; i < values.length; i += 20) out.push(...await fn(values.slice(i, i + 20)));
    return out;
  }

  /** @param {{ids?: string[], logicalNames?: string[]}} q */
  async connectionReferences({ ids, logicalNames }) {
    const select = '$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid';
    const map = (r) => ({ id: r.connectionreferenceid, logicalName: r.connectionreferencelogicalname, displayName: r.connectionreferencedisplayname, connectorId: r.connectorid, connectionId: r.connectionid });
    if (ids && ids.length) {
      return (await this.inChunks(ids, (chunk) => this.all(`connectionreferences?${select}&$filter=${DataverseClient.orFilter('connectionreferenceid', chunk)}`))).map(map);
    }
    if (logicalNames && logicalNames.length) {
      return (await this.inChunks(logicalNames, (chunk) => this.all(`connectionreferences?${select}&$filter=${DataverseClient.orFilter('connectionreferencelogicalname', chunk, true)}`))).map(map);
    }
    return [];
  }

  /** @param {{ids?: string[], schemaNames?: string[]}} q */
  async environmentVariables({ ids, schemaNames }) {
    const q = '$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue'
      + '&$expand=environmentvariabledefinition_environmentvariablevalue($select=environmentvariablevalueid,value)';
    const map = (r) => {
      const v = (r.environmentvariabledefinition_environmentvariablevalue || [])[0];
      return { id: r.environmentvariabledefinitionid, schemaName: r.schemaname, displayName: r.displayname, type: r.type, defaultValue: r.defaultvalue, value: v ? v.value : null, valueId: v ? v.environmentvariablevalueid : null };
    };
    if (ids && ids.length) {
      return (await this.inChunks(ids, (chunk) => this.all(`environmentvariabledefinitions?${q}&$filter=${DataverseClient.orFilter('environmentvariabledefinitionid', chunk)}`))).map(map);
    }
    if (schemaNames && schemaNames.length) {
      return (await this.inChunks(schemaNames, (chunk) => this.all(`environmentvariabledefinitions?${q}&$filter=${DataverseClient.orFilter('schemaname', chunk, true)}`))).map(map);
    }
    return [];
  }

  /** Binds a connection reference (by logical name) to a connection. */
  async setConnectionReference(logicalName, connectionId) {
    const [ref] = await this.connectionReferences({ logicalNames: [logicalName] });
    if (!ref) throw new ApiError(`Connection reference ${logicalName} does not exist in ${this.env.name}.`, 404);
    if (ref.connectionId === connectionId) return 'unchanged';
    await this.call(`connectionreferences(${ref.id})`, { method: 'PATCH', body: { connectionid: connectionId } });
    return 'updated';
  }

  /** Creates or updates the current value of an environment variable. */
  async setEnvironmentVariableValue(schemaName, value) {
    const [def] = await this.environmentVariables({ schemaNames: [schemaName] });
    if (!def) throw new ApiError(`Environment variable ${schemaName} does not exist in ${this.env.name}.`, 404);
    if (def.valueId) {
      if (def.value === value) return 'unchanged';
      await this.call(`environmentvariablevalues(${def.valueId})`, { method: 'PATCH', body: { value } });
      return 'updated';
    }
    await this.call('environmentvariablevalues', {
      method: 'POST',
      body: { schemaname: schemaName, value, 'EnvironmentVariableDefinitionId@odata.bind': `/environmentvariabledefinitions(${def.id})` },
    });
    return 'created';
  }

  /** Turns on cloud flows of a solution that are off (e.g. after binding their connections). */
  async activateSolutionFlows(solutionId) {
    const comps = await this.all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutionId} and componenttype eq 29`);
    const results = [];
    for (const c of comps) {
      let wf;
      try { wf = await this.call(`workflows(${c.objectid})?$select=name,category,statecode`); } catch { continue; }
      if (wf.category !== 5 || wf.statecode !== 0) continue; // only cloud flows that are off
      try {
        await this.call(`workflows(${c.objectid})`, { method: 'PATCH', body: { statecode: 1, statuscode: 2 } });
        results.push({ name: wf.name, result: 'activated' });
      } catch (err) {
        results.push({ name: wf.name, ...classifyFlowError(err.message) });
      }
    }
    return results;
  }

  // --- Power Apps service API (connections, canvas apps) -----------------------------------

  async powerApps(path) {
    const token = await auth.getToken(this.slot, this.tenantId, config.powerAppsScope);
    const out = [];
    let next = `${config.powerAppsApiUrl}${path}`;
    let single = null;
    while (next) {
      // Always ask for fresh data: publish state changes must show up on the next check.
      const page = await request(next, { token, headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
      if (!page || !Array.isArray(page.value)) { single = page; break; }
      out.push(...page.value);
      next = page.nextLink || page['@odata.nextLink'] || null;
    }
    return single || out;
  }

  envFilter() {
    if (!this.env.environmentId) throw new ApiError(`The Power Platform environment ID of ${this.env.name} is unknown.`, 400);
    return `$filter=${encodeURIComponent(`environment eq '${this.env.environmentId}'`)}`;
  }

  /** Connections in this environment for a connector (e.g. shared_sharepointonline). */
  async listConnections(connector) {
    if (!/^[\w.-]+$/.test(connector)) throw new ApiError('Invalid connector name.', 400);
    const rows = await this.powerApps(`/providers/Microsoft.PowerApps/apis/${connector}/connections?api-version=2016-11-01&${this.envFilter()}`);
    return rows.map((c) => {
      const p = c.properties || {};
      const statuses = (p.statuses || []).map((x) => x.status).filter(Boolean);
      return {
        id: c.name,
        displayName: p.displayName || c.name,
        status: statuses.join(', ') || 'Unknown',
        connected: !statuses.length || statuses.every((x) => /connected/i.test(x) && !/error/i.test(x)),
        createdBy: p.createdBy ? (p.createdBy.displayName || p.createdBy.email || p.createdBy.userPrincipalName) : '',
      };
    });
  }

  /** Publish state of canvas apps (see configuration.assessCanvasApp). */
  async canvasAppStatus(apps) {
    const out = [];
    for (const a of apps) {
      let row = null;
      for (const select of ['canvasappid,name,displayname,appopenuri,appversion,lastpublishtime', 'canvasappid,name,displayname,appopenuri']) {
        try { row = await this.call(`canvasapps(${a.objectId})?$select=${select}`); break; } catch { /* try fewer columns */ }
      }
      const appId = row && row.appopenuri ? ((row.appopenuri.match(/\/a\/([0-9a-f-]{36})/i) || [])[1] || null) : null;
      let app = null;
      let reason = '';
      let stepUp = null;
      if (appId && this.env.environmentId) {
        try {
          app = await this.powerApps(`/providers/Microsoft.PowerApps/apps/${appId}?api-version=2016-11-01&$expand=unpublishedAppDefinition&${this.envFilter()}`);
        } catch (err) {
          if (err instanceof auth.AuthRequiredError) {
            reason = 'sign-in or consent is required for the Power Apps service';
            stepUp = { slot: this.slot, tenantId: this.tenantId, scope: config.powerAppsScope };
          } else if (err.status === 401 || err.status === 403) {
            reason = 'add the "PowerApps Service" permission to the app registration';
          } else reason = err.message;
        }
      } else if (!appId) reason = 'the app ID could not be read from Dataverse';
      else reason = 'the environment ID is unknown';
      const verdict = assessCanvasApp(app, row);
      // What the services returned, so a wrong verdict can be diagnosed from a screenshot.
      const p = app && app.properties;
      const sub = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : null);
      const def = p && p.appDefinition && (p.appDefinition.properties || p.appDefinition);
      const draft = p && p.unpublishedAppDefinition && (p.unpublishedAppDefinition.properties || p.unpublishedAppDefinition);
      const raw = {
        dataverse: sub(row, ['appversion', 'lastpublishtime']),
        service: p ? { ...sub(p, ['lastModifiedTime', 'lastPublishTime', 'appVersion', 'createdTime', 'lifeCycleId', 'status']), propertyNames: Object.keys(p).sort() } : null,
        appDefinition: sub(def, ['lastModifiedTime', 'lastPublishTime', 'appVersion', 'lifeCycleId']),
        unpublishedAppDefinition: sub(draft, ['lastModifiedTime', 'lastPublishTime', 'appVersion', 'lifeCycleId']),
      };
      if (verdict.state !== 'published' && app) {
        try {
          const versions = await this.powerApps(`/providers/Microsoft.PowerApps/apps/${appId}/versions?api-version=2016-11-01&${this.envFilter()}`);
          raw.versions = (Array.isArray(versions) ? versions : []).slice(0, 4).map((v) => ({
            name: v.name, ...sub(v.properties || {}, ['appVersion', 'lastModifiedTime', 'lastPublishTime', 'lifeCycleId', 'isPublished', 'published', 'status']),
            propertyNames: Object.keys(v.properties || {}).sort(),
          }));
        } catch (err) { raw.versions = `not available: ${err.message}`; }
      }
      out.push({
        raw,
        objectId: a.objectId,
        appId,
        displayName: (row && row.displayname) || a.displayName,
        name: row ? row.name : '',
        ...verdict,
        reason: verdict.state === 'unknown' ? [reason, verdict.note].filter(Boolean).join('; ') : '',
        stepUp: verdict.state === 'unknown' ? stepUp : null,
        editUrl: appId && this.env.environmentId
          ? `${config.makerPortalUrl}/e/${this.env.environmentId}/canvas/?action=edit&app-id=${encodeURIComponent(`/providers/Microsoft.PowerApps/apps/${appId}`)}`
          : null,
      });
    }
    return out;
  }

  async publishAll() {
    await this.call('PublishAllXml', { method: 'POST', body: {} });
  }

  async createSolution({ uniqueName, displayName, publisherId, version, description }) {
    const res = await request(`${this.baseUrl}/${API}/solutions`, {
      method: 'POST',
      token: await this.token(),
      headers: { Prefer: 'return=representation' },
      body: {
        uniquename: uniqueName,
        friendlyname: displayName,
        version,
        description: description || '',
        'publisherid@odata.bind': `/publishers(${publisherId})`,
      },
    });
    return res.solutionid;
  }

  async addComponent({ objectId, componentType, solutionUniqueName, doNotIncludeSubcomponents }) {
    await this.call('AddSolutionComponent', {
      method: 'POST',
      body: {
        ComponentId: objectId,
        ComponentType: componentType,
        SolutionUniqueName: solutionUniqueName,
        AddRequiredComponents: false,
        DoNotIncludeSubcomponents: Boolean(doNotIncludeSubcomponents),
      },
    });
  }

  async deleteSolution(id) {
    await this.call(`solutions(${id})`, { method: 'DELETE' });
  }

  async waitForAsyncOperation(asyncOperationId, onTick) {
    const deadline = Date.now() + config.asyncTimeoutMinutes * 60 * 1000;
    for (;;) {
      const op = await this.call(`asyncoperations(${asyncOperationId})?$select=statecode,statuscode,message,friendlymessage`);
      if (op.statecode === 3) {
        if (op.statuscode === 30) return op;
        const status = op.statuscode === 32 ? 'was canceled' : 'failed';
        throw new ApiError(`Operation ${status}: ${op.friendlymessage || op.message || 'no details returned'}`, 500, op.message);
      }
      if (Date.now() > deadline) throw new ApiError(`Timed out after ${config.asyncTimeoutMinutes} minutes waiting for the asynchronous operation.`, 504);
      if (onTick) await onTick(op);
      await sleep(config.pollIntervalMs);
    }
  }

  async exportSolution(uniqueName, managed, onProgress) {
    let res;
    try {
      res = await this.call('ExportSolutionAsync', { method: 'POST', body: { SolutionName: uniqueName, Managed: Boolean(managed) } });
    } catch (err) {
      // Older environments: fall back to the synchronous action.
      if (err.status === 404 || /ExportSolutionAsync|Resource not found/i.test(err.message)) {
        onProgress && onProgress(null, 'ExportSolutionAsync is unavailable, using synchronous export');
        const sync = await this.call('ExportSolution', { method: 'POST', body: { SolutionName: uniqueName, Managed: Boolean(managed) } });
        return Buffer.from(sync.ExportSolutionFile, 'base64');
      }
      throw err;
    }
    let ticks = 0;
    await this.waitForAsyncOperation(res.AsyncOperationId, () => {
      ticks++;
      onProgress && onProgress(Math.min(90, ticks * 8), 'Exporting…');
    });
    const data = await this.call('DownloadSolutionExportData', { method: 'POST', body: { ExportJobId: res.ExportJobId } });
    return Buffer.from(data.ExportSolutionFile, 'base64');
  }

  async importSolution(buffer, { overwriteUnmanagedCustomizations, publishWorkflows, componentParameters }, onProgress) {
    const body = {
      CustomizationFile: buffer.toString('base64'),
      OverwriteUnmanagedCustomizations: Boolean(overwriteUnmanagedCustomizations),
      PublishWorkflows: Boolean(publishWorkflows),
      ConvertToManaged: false,
      HoldingSolution: false,
      SkipProductUpdateDependencies: false,
    };
    // Connection references / environment variable values applied during import (same format
    // as a pac deployment-settings file). Anything not applied here is set after the import.
    const params = toComponentParameters(componentParameters);
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    let res;
    try {
      if (params.length) {
        try {
          res = await this.call('ImportSolutionAsync', { method: 'POST', body: { ...body, ComponentParameters: params } });
        } catch (err) {
          if (err.status !== 400) throw err;
          onProgress && onProgress(null, 'Import settings were not accepted with the package; they will be applied after the import');
        }
      }
      if (!res) res = await this.call('ImportSolutionAsync', { method: 'POST', body });
    } catch (err) {
      // The upload of a large package can outlast the connection. Dataverse usually received it
      // and is importing anyway, so find that import job and follow it instead of failing.
      if (!LOST_RESPONSE.has(err.networkCode)) throw err;
      let uniqueName = null;
      try { uniqueName = readManifest(buffer).uniqueName; } catch { /* ignore */ }
      onProgress && onProgress(null, 'The connection dropped while Dataverse was receiving the package. Looking for the import in the target…');
      return this.resumeImport(since, uniqueName, onProgress);
    }
    const importJobId = res.ImportJobKey;
    try {
      await this.waitForAsyncOperation(res.AsyncOperationId, async () => {
        if (!importJobId) return;
        try {
          const job = await this.call(`importjobs(${importJobId})?$select=progress`);
          onProgress && onProgress(Math.round(job.progress || 0), `Importing… ${Math.round(job.progress || 0)}%`);
        } catch { /* import job row is created lazily */ }
      });
    } catch (err) {
      err.importJobId = importJobId;
      throw err;
    }
    return { importJobId };
  }

  /**
   * Follows an import that was started but whose ImportSolutionAsync response was lost.
   * Finds the newest import job created since `sinceIso` (for `uniqueName`), polls it until it
   * completes, and throws if it failed.
   */
  async resumeImport(sinceIso, uniqueName, onProgress, { findMinutes = 5 } = {}) {
    const findDeadline = Date.now() + findMinutes * 60 * 1000;
    let job = null;
    while (!job) {
      const rows = await this.all(`importjobs?$select=importjobid,solutionname,progress,completedon,createdon&$filter=createdon ge ${sinceIso}&$orderby=createdon desc`);
      const name = (uniqueName || '').toLowerCase();
      job = rows.find((r) => name && String(r.solutionname || '').toLowerCase() === name)
        || rows.find((r) => !r.solutionname && !r.completedon)
        || null;
      if (job) break;
      if (Date.now() > findDeadline) {
        throw new ApiError('The connection to Dataverse dropped while the package was being uploaded, and no import was started in the target. Run the migration again; if it keeps happening, increase REQUEST_TIMEOUT_MINUTES in .env.', 504);
      }
      onProgress && onProgress(null, 'Waiting for the import to appear in the target…');
      await sleep(config.pollIntervalMs);
    }
    const importJobId = job.importjobid;
    onProgress && onProgress(Math.round(job.progress || 0), 'Import is running in the target (connection was re-established)');
    const deadline = Date.now() + config.asyncTimeoutMinutes * 60 * 1000;
    while (!job.completedon) {
      if (Date.now() > deadline) {
        const e = new ApiError(`Timed out after ${config.asyncTimeoutMinutes} minutes waiting for the import to finish. It may still be running; check the solution history in the target.`, 504);
        e.importJobId = importJobId;
        throw e;
      }
      await sleep(config.pollIntervalMs);
      job = await this.call(`importjobs(${importJobId})?$select=progress,completedon,solutionname`);
      onProgress && onProgress(Math.round(job.progress || 0), `Importing… ${Math.round(job.progress || 0)}%`);
    }
    const results = await this.getImportJobResults(importJobId).catch(() => null);
    if (results && results.counts.failure > 0) {
      const first = results.issues.find((i) => i.level === 'failure');
      const e = new ApiError(`The import failed${first ? `: ${first.component}: ${first.message}` : '.'}`, 500);
      e.importJobId = importJobId;
      throw e;
    }
    return { importJobId, resumed: true };
  }

  async getImportJobResults(importJobId) {
    const job = await this.call(`importjobs(${importJobId})?$select=data,progress,startedon,completedon,solutionname`);
    return { ...parseImportJobData(job.data || ''), progress: job.progress, startedOn: job.startedon, completedOn: job.completedon };
  }

  async getImportLog(importJobId) {
    const res = await this.call(`RetrieveFormattedImportJobResults(ImportJobId=${importJobId})`);
    return res.FormattedResults;
  }
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Parses importjob.data XML into success/warning/failure counts and messages. */
function parseImportJobData(xml) {
  const counts = { success: 0, warning: 0, failure: 0 };
  const issues = [];
  const re = /<(\w+)((?:\s+[\w:]+="[^"]*")*)\s*>\s*<result\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1], decodeXml(a[2])]));
    const el = attrs(m[2]);
    const result = attrs(m[3]);
    const kind = (result.result || '').toLowerCase();
    if (kind in counts) counts[kind]++;
    if (kind === 'failure' || kind === 'warning') {
      issues.push({
        level: kind,
        component: `${m[1]}${el.name || el.id ? `: ${el.LocalizedName || el.name || el.id}` : ''}`,
        message: result.errortext || result.errorcode || '',
      });
    }
  }
  return { counts, issues };
}

// Connection problems where the request may have reached Dataverse but the answer was lost.
const LOST_RESPONSE = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT']);

function toComponentParameters(cp) {
  if (!cp) return [];
  return [
    ...(cp.connectionReferences || []).filter((c) => c.connectionId).map((c) => ({
      '@odata.type': 'Microsoft.Dynamics.CRM.connectionreference',
      connectionreferencelogicalname: c.logicalName,
      connectionid: c.connectionId,
      connectorid: c.connectorId,
    })),
    ...(cp.environmentVariables || []).filter((v) => v.value !== undefined && v.value !== null).map((v) => ({
      '@odata.type': 'Microsoft.Dynamics.CRM.environmentvariablevalue',
      schemaname: v.schemaName,
      value: String(v.value),
    })),
  ];
}

module.exports = {
  name: 'dataverse',
  directory: (slot) => new Directory(slot),
  dataverse: (slot, tenantId, env) => new DataverseClient(slot, tenantId, env),
  parseImportJobData,
  ApiError,
  DataverseClient,
};
