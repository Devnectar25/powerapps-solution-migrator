'use strict';

/**
 * Connection references, environment variables and the canvas-app publish check.
 */

const ENV_VAR_TYPES = {
  100000000: 'Text',
  100000001: 'Number',
  100000002: 'Yes/No',
  100000003: 'JSON',
  100000004: 'Data source',
  100000005: 'Secret',
};

const connectorName = (connectorId) => String(connectorId || '').split('/').filter(Boolean).pop() || '';

/**
 * Builds the "Connections & variables" step data.
 * @param src  source client, @param tgt target client
 * @param solution  { id, uniqueName }
 * @param components  listComponents() result for the solution
 */
async function getSolutionConfiguration(src, tgt, solution, components) {
  const objectIds = components.map((c) => c.objectId);

  // Connection references in the solution, plus ones the solution needs but doesn't contain
  // (these are added automatically during migration when that option is on).
  let refs = await src.connectionReferences({ ids: objectIds });
  const inSolution = new Set(refs.map((r) => r.id.toLowerCase()));
  try {
    // Follow the chain a few levels: a flow may need a child flow that needs a connection reference.
    const inSolutionObjects = new Set(objectIds.map((x) => String(x).toLowerCase()));
    const seen = new Set();
    let frontier = (await src.retrieveMissingDependencies(solution.uniqueName))
      .filter((m) => m.requiredId && !inSolutionObjects.has(String(m.requiredId).toLowerCase()));
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next = [];
      for (const m of frontier) {
        const key = String(m.requiredId).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (typeof src.retrieveRequiredComponents === 'function') {
          const req = await src.retrieveRequiredComponents(m.requiredId, m.requiredType).catch(() => []);
          next.push(...req.filter((r) => r.requiredId && !inSolutionObjects.has(String(r.requiredId).toLowerCase())));
        }
      }
      frontier = next;
    }
    const extraIds = [...seen].filter((id) => !inSolution.has(id));
    if (extraIds.length) refs = refs.concat((await src.connectionReferences({ ids: extraIds })).map((r) => ({ ...r, notInSolution: true })));
  } catch { /* dependency check is best effort here */ }

  const envVars = await src.environmentVariables({ ids: objectIds });

  const [targetRefs, targetVars] = await Promise.all([
    refs.length ? tgt.connectionReferences({ logicalNames: refs.map((r) => r.logicalName) }).catch(() => []) : [],
    envVars.length ? tgt.environmentVariables({ schemaNames: envVars.map((v) => v.schemaName) }).catch(() => []) : [],
  ]);
  const tRef = new Map(targetRefs.map((r) => [r.logicalName.toLowerCase(), r]));
  const tVar = new Map(targetVars.map((v) => [v.schemaName.toLowerCase(), v]));

  return {
    connectionReferences: refs.map((r) => {
      const t = tRef.get(r.logicalName.toLowerCase());
      return {
        logicalName: r.logicalName,
        displayName: r.displayName || r.logicalName,
        connectorId: r.connectorId,
        connectorName: connectorName(r.connectorId),
        notInSolution: Boolean(r.notInSolution),
        sourceConnectionId: r.connectionId || null,
        targetConnectionId: t ? t.connectionId || null : null,
        existsInTarget: Boolean(t),
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    environmentVariables: envVars.map((v) => {
      const t = tVar.get(v.schemaName.toLowerCase());
      return {
        schemaName: v.schemaName,
        displayName: v.displayName || v.schemaName,
        type: v.type,
        typeName: ENV_VAR_TYPES[v.type] || 'Text',
        defaultValue: v.defaultValue ?? null,
        sourceValue: v.value ?? null,
        targetValue: t ? (t.value ?? null) : null,
        targetDefaultValue: t ? (t.defaultValue ?? null) : null,
        existsInTarget: Boolean(t),
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

const SLACK_MS = 60 * 1000;
const time = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };

/**
 * Decides whether a canvas app has saved changes that were never published.
 * @param {object} app  Power Apps API app resource (with $expand=unpublishedAppDefinition) or null
 * @param {object} row  Dataverse canvasapps row (appversion, lastpublishtime) or null
 * @returns {{state:'published'|'unpublished'|'unknown', lastSaved, lastPublished, evidence}}
 */
function latest(values) {
  let best = null;
  let bestTime = null;
  for (const v of values) {
    const t = time(v);
    if (t !== null && (bestTime === null || t > bestTime)) { best = v; bestTime = t; }
  }
  return best;
}

function assessCanvasApp(app, row) {
  if (app && app.properties) {
    const p = app.properties;
    const def = p.appDefinition && (p.appDefinition.properties || p.appDefinition);
    const draft = p.unpublishedAppDefinition && (p.unpublishedAppDefinition.properties || p.unpublishedAppDefinition);
    // Publish time can be reported in several places, and not all of them are updated
    // immediately (or at all) after a publish. Any of them proves a publish, so use the latest.
    const dataversePublish = row ? row.lastpublishtime : null;
    const lastPublished = latest([p.lastPublishTime, def && def.lastPublishTime, draft && draft.lastPublishTime, dataversePublish]) || p.appVersion || null;
    const lastSaved = latest([draft && draft.lastModifiedTime, draft && draft.appVersion, p.lastModifiedTime]);
    const tp = time(lastPublished);
    const ts = time(lastSaved);
    const evidence = lastPublished && lastPublished === dataversePublish && dataversePublish !== p.lastPublishTime ? 'Power Apps service + Dataverse' : 'Power Apps service';
    if (tp !== null && ts !== null) {
      return { state: ts > tp + SLACK_MS ? 'unpublished' : 'published', lastSaved, lastPublished, evidence };
    }
    if (draft && tp === null) return { state: 'unpublished', lastSaved, lastPublished, evidence };
  }
  if (row) {
    const tp = time(row.lastpublishtime);
    const ts = time(row.appversion);
    if (tp !== null && ts !== null && ts > tp + SLACK_MS) {
      return { state: 'unpublished', lastSaved: row.appversion, lastPublished: row.lastpublishtime, evidence: 'Dataverse' };
    }
    // Dataverse only stores the published version, so equal times prove nothing about drafts
    // saved in Power Apps Studio. Treat it as unverified.
    return {
      state: 'unknown', lastSaved: null, lastPublished: row.lastpublishtime || null, evidence: 'Dataverse',
      note: 'only Dataverse could be read, and Dataverse does not show changes saved in Power Apps Studio but not published',
    };
  }
  return { state: 'unknown', lastSaved: null, lastPublished: null, evidence: null };
}

/**
 * Runs the canvas-app publish check for the canvas apps among `components`.
 * Returns { status: 'none'|'ok'|'unpublished'|'unverified', apps: [...], message, stepUp }
 */
async function checkCanvasApps(src, components) {
  const canvas = components.filter((c) => c.componentType === 300);
  if (!canvas.length) return { status: 'none', apps: [], message: 'The solution has no canvas apps.' };
  const apps = await src.canvasAppStatus(canvas.map((c) => ({ objectId: c.objectId, displayName: c.displayName })));
  const unpublished = apps.filter((a) => a.state === 'unpublished');
  const unknown = apps.filter((a) => a.state === 'unknown');
  if (unpublished.length) {
    return {
      status: 'unpublished',
      apps,
      message: `${unpublished.length} canvas app(s) have saved changes that are not published. A solution export only contains the published version, so these changes (for example new screens) would be missing in the target. Publish ${unpublished.length > 1 ? 'them' : 'it'} in the source, then check again.`,
    };
  }
  if (unknown.length) {
    const stepUp = unknown.find((a) => a.stepUp);
    return {
      status: 'unverified',
      apps,
      stepUp: stepUp ? stepUp.stepUp : null,
      message: `The publish state of ${unknown.length} canvas app(s) could not be verified${unknown[0].reason ? ` (${unknown[0].reason})` : ''}. Confirm that the latest version of each app is published before continuing.`,
    };
  }
  return { status: 'ok', apps, message: `All ${apps.length} canvas app(s) are published.` };
}

/** Turns a "turn flow on" error into something actionable. */
function classifyFlowError(message) {
  const msg = String(message || '');
  if (/connection references? need connections|connectionreference.*(has no|without) connection|no connection in this environment|ConnectionNotConfigured|has no connection/i.test(msg)) {
    return {
      result: 'action',
      message: "Not turned on yet: at least one of the flow's connection references has no connection in the target. Pick a connection for it on the Connections & variables step (or in the target's solution), then turn the flow on.",
      details: msg,
    };
  }
  if (/Unauthorized|Forbidden|status code '?40[13]/i.test(msg) && /dynamic operation|GetTable|GetItems|GetDataset|sharepoint|excel|onedrive/i.test(msg)) {
    return {
      result: 'action',
      message: "The flow's connection can't open a resource the flow uses (for example a SharePoint site or list). For a cross-tenant move, point the environment variables (site URL and the list / table IDs) to resources in the target tenant that the connection's account can access, then turn the flow on.",
      details: msg,
    };
  }
  return { result: 'failed', message: msg };
}

// Import results about connections / turning flows on are configuration to do in the target,
// not failures of the migration itself.
const CONFIG_ISSUE_RE = /connection ?references?|need(s|ed)? connections?|has no connection|without (a )?connection|connection.{0,40}(not (configured|found|valid)|invalid)|ConnectionNotConfigured|InvalidOpenApiFlow|could not be (turned on|activated|enabled|started)|failed to (activate|turn on|enable|start)|dynamic operation request.{0,120}(Unauthorized|Forbidden)/i;

function reclassifyImportResults(results) {
  if (!results) return results;
  const issues = results.issues.map((i) => (CONFIG_ISSUE_RE.test(i.message || '')
    ? { ...i, level: 'action', originalLevel: i.level }
    : i));
  const moved = issues.filter((i) => i.level === 'action');
  const counts = {
    ...results.counts,
    failure: Math.max(0, results.counts.failure - moved.filter((i) => i.originalLevel === 'failure').length),
    warning: Math.max(0, results.counts.warning - moved.filter((i) => i.originalLevel === 'warning').length),
    action: moved.length,
  };
  return { ...results, issues, counts };
}

/**
 * What still has to be configured in the target after a successful import: connection
 * references without a connection, environment variables without any value, flows not on.
 */
async function collectActionRequired(tgt, inventory, configResults, importResults) {
  const out = { connectionReferences: [], environmentVariables: [], flows: [] };
  const refs = inventory.connectionReferenceNames || [];
  if (refs.length) {
    try {
      const inTarget = await tgt.connectionReferences({ logicalNames: refs.map((r) => r.logicalName) });
      for (const r of inTarget) {
        if (!r.connectionId) out.connectionReferences.push({ name: r.displayName || r.logicalName, logicalName: r.logicalName, connector: connectorName(r.connectorId) });
      }
    } catch { /* best effort */ }
  }
  const vars = inventory.environmentVariableNames || [];
  if (vars.length) {
    try {
      const inTarget = await tgt.environmentVariables({ schemaNames: vars });
      const empty = (v) => v === null || v === undefined || v === '';
      for (const v of inTarget) {
        if (empty(v.value) && empty(v.defaultValue)) out.environmentVariables.push({ name: v.displayName || v.schemaName, schemaName: v.schemaName });
      }
    } catch { /* best effort */ }
  }
  const seen = new Set();
  for (const f of (configResults && configResults.flows) || []) {
    if (f.result !== 'action') continue;
    seen.add(String(f.name).toLowerCase());
    out.flows.push({ name: f.name, message: f.message });
  }
  for (const i of (importResults && importResults.issues) || []) {
    if (i.level !== 'action') continue;
    const name = String(i.component || '').replace(/^[^:]*:\s*/, '');
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.flows.push({ name: name || i.component, message: i.message });
  }
  out.total = out.connectionReferences.length + out.environmentVariables.length + out.flows.length;
  return out;
}

module.exports = { reclassifyImportResults, collectActionRequired, getSolutionConfiguration, checkCanvasApps, assessCanvasApp, classifyFlowError, ENV_VAR_TYPES, connectorName };
