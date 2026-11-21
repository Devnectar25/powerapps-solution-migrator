'use strict';

/**
 * Migration engine. Provider-agnostic: works against the real Dataverse provider or the mock.
 *
 * Pipeline
 *   1. validate        – pre-flight checks (source solution, target conflicts)
 *   2. publish         – (optional) publish all customizations in the source
 *   3. filter          – only when components are excluded: build a temporary solution in the
 *                        source that contains just the selected components
 *   3b. dependencies   – find required components that are not in the solution (connection
 *                        references, child flows, …); optionally add them to the temporary copy
 *   4. export          – export (managed / unmanaged) via ExportSolutionAsync
 *   5. cleanup         – delete the temporary solution container (components are untouched)
 *   6. package         – set final unique/display name in solution.xml, inspect the package
 *   7. import          – ImportSolutionAsync into the target, with progress from importjob
 *   8. publishTarget   – (optional, unmanaged only) publish all customizations in the target
 *   9. verify          – read import job results, confirm the solution exists in the target
 */

const crypto = require('crypto');
const { UNIQUE_NAME_RE, renameSolution, inspectPackage, readManifest } = require('./solutionPackage');
const dependencies = require('./dependencies');
const configuration = require('./configuration');
const store = require('./store');

const STEP_DEFS = [
  { key: 'validate', label: 'Validate source and target', weight: 4 },
  { key: 'publish', label: 'Publish customizations in source', weight: 8 },
  { key: 'filter', label: 'Build migration copy of the solution', weight: 14 },
  { key: 'dependencies', label: 'Check for missing required components', weight: 6 },
  { key: 'export', label: 'Export solution from source', weight: 24 },
  { key: 'cleanup', label: 'Remove temporary solution from source', weight: 3 },
  { key: 'package', label: 'Prepare solution package', weight: 3 },
  { key: 'import', label: 'Import solution into target', weight: 36 },
  { key: 'configure', label: 'Apply connections and environment variable values', weight: 4 },
  { key: 'publishTarget', label: 'Publish customizations in target', weight: 5 },
  { key: 'verify', label: 'Verify import results', weight: 3 },
];

const migrations = new Map();

class CancelledError extends Error {
  constructor() { super('Stopped by the user.'); this.name = 'CancelledError'; }
}

// Throws at a safe point when the user asked to stop. Never called while the import runs:
// Dataverse can't cancel an import safely, so a stop during import takes effect right after it.
function checkStop(m) {
  if (m._internal.stopRequested) throw new CancelledError();
}

/** Ask a running migration to stop. Returns the updated view, or null if not found. */
// A run is visible to the colleagues of the organization that started it; only the person who
// started it can stop it (their workspace holds the Microsoft sign-ins it uses).
const workspace = require('./workspace');
const visible = (m) => m && (m.org || 'local') === workspace.org();

function requestStop(id) {
  const m = migrations.get(id);
  if (!visible(m)) return null;
  if (m.workspace && m.workspace !== workspace.key()) {
    throw Object.assign(new Error('Only the person who started this migration can stop it.'), { status: 403 });
  }
  if (m.status !== 'running') {
    throw Object.assign(new Error('This migration is not running.'), { status: 409 });
  }
  if (!m._internal.stopRequested) {
    m._internal.stopRequested = true;
    m.stopRequested = true;
    const imp = step(m, 'import'); // Package only runs have no import step
    const importing = Boolean(imp && imp.status === 'running');
    log(m, 'warning', importing
      ? 'Stop requested. The import into the target is already running and cannot be stopped safely; the migration stops right after it.'
      : 'Stop requested. Stopping at the next safe point.');
  }
  return publicView(m);
}

class ValidationError extends Error {
  constructor(message, extra) { super(message); this.status = 400; this.name = 'ValidationError'; Object.assign(this, extra || {}); }
}

function publicView(m) {
  const { _internal, ...rest } = m;
  // A stopped migration shows how much of the whole run was done; otherwise skipped steps don't count.
  const active = m.status === 'cancelled' ? m.steps : m.steps.filter((s) => s.status !== 'skipped');
  const total = active.reduce((a, s) => a + s.weight, 0) || 1;
  const done = active.reduce((a, s) => a + (s.status === 'done' ? s.weight : s.status === 'running' || s.status === 'failed' ? s.weight * (s.progress || 0) / 100 : 0), 0);
  return { ...rest, progress: m.status === 'succeeded' ? 100 : Math.min(99, Math.round((done / total) * 100)), hasPackage: Boolean(_internal.package), hasImportLog: Boolean(_internal.importJobId) };
}

function getMigration(id) {
  const m = migrations.get(id);
  if (m) return visible(m) ? publicView(m) : null;
  return store.getRun(id); // limited to the current organization
}

// Saves the run to the history file (called at start and at the end).
function persist(m) {
  try {
    const { hasPackage, hasImportLog, ...record } = publicView(m);
    store.saveRun(record);
  } catch (err) {
    console.warn(`Could not save migration history: ${err.message}`);
  }
}

function listMigrations() {
  return [...migrations.values()].filter(visible).map(publicView).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function isRunning() {
  return [...migrations.values()].some((m) => m.status === 'running');
}

function getInternal(id) {
  const m = migrations.get(id);
  return visible(m) ? m._internal : null;
}

/**
 * Validates the request synchronously (fast checks) and starts the pipeline in the background.
 *
 * @param {object} req
 * @param {{slot,tenant,env}} req.source  tenant = {tenantId, displayName}, env = environment object
 * @param {{slot,tenant,env}} req.target
 * @param {string} req.solutionId
 * @param {string[]} req.excludedComponentIds  solutioncomponent ids to exclude
 * @param {{enabled:boolean, uniqueName?:string, displayName?:string}} req.rename
 * @param {object} req.options  managed, overwriteUnmanagedCustomizations, publishWorkflows, publishBeforeExport, publishAfterImport
 * @param {object} provider
 */
function startMigration(req, provider) {
  if (!req.source || !req.source.env) throw new ValidationError('Select a source environment.');
  const packageOnly = Boolean(req.packageOnly);
  if (packageOnly) req.target = null;
  else if (!req.target || !req.target.env) throw new ValidationError('Select a target environment.');
  if (!req.solutionId) throw new ValidationError('Select a solution to migrate.');
  if (!packageOnly && req.source.env.url.toLowerCase() === req.target.env.url.toLowerCase()) {
    throw new ValidationError('The source and target environments must be different.');
  }
  const rename = req.rename && req.rename.enabled ? req.rename : null;
  if (rename) {
    if (!rename.uniqueName || !UNIQUE_NAME_RE.test(rename.uniqueName)) {
      throw new ValidationError('The new solution name must start with a letter or underscore and contain only letters, digits and underscores (max 65 characters).');
    }
  }
  const options = {
    managed: false,
    overwriteUnmanagedCustomizations: true,
    publishWorkflows: true,
    publishBeforeExport: true,
    publishAfterImport: true,
    includeMissingDependencies: true,
    acknowledgeUnverifiedCanvasApps: false,
    confirmUpdateExisting: false,
    overrideCanvasCheck: false,
    ...(req.options || {}),
  };
  const cfg = req.configuration || {};
  const configurationRequest = {
    skipped: Boolean(cfg.skipped),
    connectionReferences: cfg.skipped ? [] : (cfg.connectionReferences || []).filter((c) => c && c.logicalName && c.connectionId),
    environmentVariables: cfg.skipped ? [] : (cfg.environmentVariables || []).filter((v) => v && v.schemaName && v.value !== undefined && v.value !== null),
  };
  const crossTenant = packageOnly ? false : req.source.tenant.tenantId.toLowerCase() !== req.target.tenant.tenantId.toLowerCase();

  const id = crypto.randomUUID();
  const m = {
    id,
    workspace: workspace.key(),
    org: workspace.org(),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    crossTenant,
    packageOnly,
    request: {
      source: { tenant: req.source.tenant, environment: pickEnv(req.source.env) },
      target: packageOnly ? null : { tenant: req.target.tenant, environment: pickEnv(req.target.env) },
      solutionId: req.solutionId,
      excludedComponentIds: req.excludedComponentIds || [],
      rename,
      options,
      configuration: configurationRequest,
    },
    profile: req.profile || null,
    startedBy: req.startedBy || null,
    appUser: req.appUser || null, // migrator account (registration) that started the run
    steps: stepDefs(packageOnly).map((s) => ({ ...s, status: 'pending', progress: 0, detail: '', startedAt: null, finishedAt: null })),
    logs: [],
    error: null,
    summary: null,
    _internal: { package: null, packageName: null, importJobId: null, targetClient: null },
  };
  migrations.set(id, m);
  persist(m);

  run(m, req, provider).catch(() => { /* errors are recorded on the migration */ });
  return publicView(m);
}

// Package only: the steps up to the finished package; nothing runs in a target.
const PACKAGE_ONLY_KEYS = new Set(['validate', 'publish', 'filter', 'dependencies', 'export', 'cleanup', 'package']);
function stepDefs(packageOnly) {
  if (!packageOnly) return STEP_DEFS;
  return STEP_DEFS.filter((s) => PACKAGE_ONLY_KEYS.has(s.key))
    .map((s) => (s.key === 'validate' ? { ...s, label: 'Validate source solution' } : s.key === 'package' ? { ...s, label: 'Prepare solution package for download' } : s));
}

function pickEnv(e) {
  return { id: e.id, environmentId: e.environmentId || null, name: e.name, url: e.url, region: e.region };
}

function log(m, level, message) {
  m.logs.push({ ts: new Date().toISOString(), level, message });
}

function step(m, key) {
  return m.steps.find((s) => s.key === key);
}

function begin(m, key, detail = '') {
  checkStop(m);
  const s = step(m, key);
  Object.assign(s, { status: 'running', progress: 0, detail, startedAt: new Date().toISOString() });
  log(m, 'info', `${s.label}${detail ? ` — ${detail}` : ''}`);
  return s;
}

function finish(m, key, detail) {
  const s = step(m, key);
  Object.assign(s, { status: 'done', progress: 100, finishedAt: new Date().toISOString() });
  if (detail !== undefined) s.detail = detail;
}

function skip(m, key, detail) {
  Object.assign(step(m, key), { status: 'skipped', detail });
}

async function run(m, req, provider) {
  const { options, rename, excludedComponentIds } = m.request;
  const src = provider.dataverse(req.source.slot, req.source.tenant.tenantId, req.source.env);
  const packageOnly = Boolean(m.packageOnly);
  const tgt = packageOnly ? null : provider.dataverse(req.target.slot, req.target.tenant.tenantId, req.target.env);
  m._internal.targetClient = tgt;

  let currentKey = 'validate';
  let tempSolution = null;
  const t0 = Date.now();

  const cleanupTemp = async () => {
    if (!tempSolution) return;
    const s = tempSolution;
    tempSolution = null;
    await src.deleteSolution(s.id);
    log(m, 'info', `Temporary solution ${s.uniqueName} deleted from source.`);
  };

  try {
    // 1. Validate --------------------------------------------------------------------------
    begin(m, 'validate', 'Reading source solution');
    const solution = await src.getSolution(req.solutionId);
    if (solution.isManaged) throw new ValidationError(`"${solution.displayName}" is a managed solution. Managed solutions cannot be exported; migrate it from the environment where it is developed (unmanaged).`);
    const components = await src.listComponents(solution.id);
    const excluded = new Set(excludedComponentIds.map((x) => x.toLowerCase()));
    const included = components.filter((c) => !excluded.has(String(c.id).toLowerCase()));
    const excludedList = components.filter((c) => excluded.has(String(c.id).toLowerCase()));
    if (!included.length) throw new ValidationError('All components are excluded. Select at least one component to migrate.');

    // Mandatory: canvas apps must be published, or the export carries an older version.
    step(m, 'validate').detail = 'Checking that canvas apps are published';
    const canvasCheck = await configuration.checkCanvasApps(src, included);
    m.canvasCheck = canvasCheck;
    if (canvasCheck.status === 'unpublished') {
      if (!options.overrideCanvasCheck) throw new ValidationError(canvasCheck.message, { canvasApps: canvasCheck.apps });
      log(m, 'warning', `Canvas app check reported unpublished changes, but the user confirmed the apps are published and chose to continue: ${canvasCheck.apps.filter((a) => a.state === 'unpublished').map((a) => a.displayName).join(', ')}.`);
    }
    if (canvasCheck.status === 'unverified') {
      if (!options.acknowledgeUnverifiedCanvasApps) {
        throw new ValidationError(`${canvasCheck.message} Tick the confirmation on the Options & review step to continue.`, { canvasApps: canvasCheck.apps });
      }
      log(m, 'warning', `Canvas app publish state not verified; continuing because the user confirmed the apps are published (${canvasCheck.apps.map((a) => a.displayName).join(', ')}).`);
    } else if (canvasCheck.status === 'ok') {
      log(m, 'info', canvasCheck.message);
    }

    const finalUniqueName = rename ? rename.uniqueName : solution.uniqueName;
    const finalDisplayName = rename ? (rename.displayName || rename.uniqueName) : solution.displayName;
    step(m, 'validate').progress = 50;

    const existing = packageOnly ? null : await tgt.findSolutionByUniqueName(finalUniqueName);
    let operation = packageOnly ? 'package' : 'install';
    if (existing) {
      const cmp = compareVersions(solution.version, existing.version);
      if (cmp < 0 && options.managed) {
        throw new ValidationError(`The target already has "${finalUniqueName}" v${existing.version}, which is newer than v${solution.version}. A managed solution can't be imported over a newer version. Increase the version in the source, or use "Create with a different name".`);
      }
      if (existing.isManaged && !options.managed) {
        throw new ValidationError(`The target environment already has a MANAGED solution named "${finalUniqueName}". An unmanaged solution with the same name cannot be imported over it. Export as managed, or use "Create with a different name".`);
      }
      if (!existing.isManaged && options.managed) {
        throw new ValidationError(`The target environment already has an UNMANAGED solution named "${finalUniqueName}". A managed solution with the same name cannot be imported over it. Import as unmanaged, or use "Create with a different name".`);
      }
      if (!options.confirmUpdateExisting) {
        throw new ValidationError(`The target already has a solution named "${finalUniqueName}" (v${existing.version}). Confirm "Update the existing solution" on the Options & review step, or use "Create with a different name".`);
      }
      operation = 'update';
      log(m, 'info', `Target already contains "${finalUniqueName}" v${existing.version}; it will be updated to v${solution.version}.`);
    }
    m.plan = {
      solution: { uniqueName: solution.uniqueName, displayName: solution.displayName, version: solution.version, publisher: solution.publisher && solution.publisher.displayName },
      finalUniqueName, finalDisplayName, operation,
      componentCounts: { total: components.length, included: included.length, excluded: excludedList.length },
    };
    finish(m, 'validate', `${included.length} of ${components.length} components selected · ${packageOnly ? 'package only, no import' : operation === 'update' ? `updates existing v${existing.version}` : 'new install in target'}`);

    // 2. Publish source ----------------------------------------------------------------------
    currentKey = 'publish';
    if (options.publishBeforeExport) {
      begin(m, 'publish', req.source.env.name);
      await src.publishAll();
      finish(m, 'publish', 'All customizations published');
    } else skip(m, 'publish', 'Disabled in options');

    // 3. Filter --------------------------------------------------------------------------------
    currentKey = 'filter';
    let exportName = solution.uniqueName;
    // Creates the temporary copy with the selected components. Used when components are
    // excluded, and when required components must be added (the original is never modified).
    const createTempCopy = async (s) => {
      const tempName = `${solution.uniqueName.slice(0, 40)}_mig_${Date.now().toString(36)}`;
      const tempId = await src.createSolution({
        uniqueName: tempName,
        displayName: `${solution.displayName} (migration copy)`,
        publisherId: solution.publisher.id,
        version: solution.version,
        description: `Temporary solution created by PowerApps Solution Migrator (${m.id}). Safe to delete.`,
      });
      tempSolution = { id: tempId, uniqueName: tempName };
      log(m, 'info', `Temporary solution ${tempName} created in source.`);

      const includedIds = new Set(included.map((c) => c.id));
      const roots = included.filter((c) => !c.parentId || !includedIds.has(c.parentId));
      const children = included.filter((c) => c.parentId && includedIds.has(c.parentId));
      const ordered = [...roots, ...children];
      let n = 0;
      for (const c of ordered) {
        checkStop(m);
        const hasExplicitChildren = components.some((x) => x.parentId === c.id);
        await src.addComponent({
          objectId: c.objectId,
          componentType: c.componentType,
          solutionUniqueName: tempName,
          // Tables that include "all subcomponents" keep that behaviour; otherwise only the
          // explicitly selected subcomponents are added.
          doNotIncludeSubcomponents: c.componentType === 1 ? (c.rootComponentBehavior !== 0 || hasExplicitChildren) : false,
        });
        n++;
        if (s) {
          s.progress = Math.round((n / ordered.length) * 100);
          s.detail = `Added ${n} of ${ordered.length} components`;
        }
      }
      exportName = tempName;
    };

    if (excludedList.length) {
      const s = begin(m, 'filter', `Excluding ${excludedList.length} component(s)`);
      await createTempCopy(s);
      finish(m, 'filter');
    } else skip(m, 'filter', 'All components selected — exporting the original solution');

    // 3b. Missing dependencies -------------------------------------------------------------------
    currentKey = 'dependencies';
    const dep = begin(m, 'dependencies', 'Looking for required components that are not in the solution');
    const addedDependencies = [];
    const prerequisites = [];
    const excludedObjectIds = new Set(excludedList.map((c) => String(c.objectId).toLowerCase()));
    const caches = {};
    const addedIds = new Set();
    let checked = false;
    for (let round = 1; round <= 6; round++) {
      checkStop(m);
      let missing;
      try {
        missing = await src.retrieveMissingDependencies(exportName);
      } catch (err) {
        log(m, 'warning', `Could not check dependencies before export (${err.message}). The import will report any that are missing.`);
        break;
      }
      let analysis = await dependencies.analyse(src, tgt, missing, excludedObjectIds, caches);
      if (packageOnly) {
        // No target to check: a component from a managed solution becomes a prerequisite for whoever imports the package.
        for (const a of analysis.filter((x) => x.resolution === 'managed')) {
          const key = String(a.required.id).toLowerCase();
          if (!prerequisites.some((p) => p.key === key)) {
            prerequisites.push({ key, typeName: a.required.typeName, displayName: a.required.displayName, message: a.message.replace('Install that solution in the target environment first.', 'The environment you import into must have that solution installed.'), neededBy: a.dependents.map((d) => d.displayName) });
            log(m, 'warning', `Prerequisite for importing the package: ${a.required.typeName} "${a.required.displayName}". ${a.message}`);
          }
        }
        analysis = analysis.filter((x) => x.resolution !== 'managed');
      }
      const addable = analysis.filter((a) => a.resolution === 'add' && !addedIds.has(String(a.required.id).toLowerCase()));
      const blockers = analysis.filter((a) => a.resolution !== 'add' || addedIds.has(String(a.required.id).toLowerCase()));
      if (!blockers.length && !addable.length) { checked = true; break; }
      if (blockers.length || !options.includeMissingDependencies) {
        const list = options.includeMissingDependencies ? blockers : analysis;
        throw new dependencies.DependencyError(
          `${list.length} component(s) that the solution needs are missing from it, so the import would fail. Nothing was exported or imported. See the table below for how to fix each one${options.includeMissingDependencies ? '' : ', or turn on "Include missing required components" in Options'}.`,
          list,
        );
      }
      if (!tempSolution) {
        const f = begin(m, 'filter', 'Creating a copy so required components can be added (the original solution is not changed)');
        await createTempCopy(f);
        finish(m, 'filter', 'Copy created to add required components (original solution unchanged)');
        dep.status = 'running';
        currentKey = 'dependencies';
      }
      for (const a of addable) {
        await src.addComponent({ objectId: a.required.id, componentType: a.required.type, solutionUniqueName: exportName, doNotIncludeSubcomponents: false });
        addedIds.add(String(a.required.id).toLowerCase());
        addedDependencies.push({ typeName: a.required.typeName, displayName: a.required.displayName, neededBy: a.dependents.map((d) => d.displayName) });
        log(m, 'info', `Added required ${a.required.typeName} "${a.required.displayName}" (needed by ${a.dependents.map((d) => d.displayName).join(', ') || 'the solution'}).`);
      }
      dep.detail = `Added ${addedDependencies.length} required component(s), checking again…`;
      dep.progress = Math.min(90, round * 20);
    }
    if (!checked && addedDependencies.length && options.includeMissingDependencies) {
      log(m, 'warning', 'Stopped adding required components after 6 rounds; the import will report anything still missing.');
    }
    m.plan.addedDependencies = addedDependencies;
    finish(m, 'dependencies', addedDependencies.length
      ? `Added ${addedDependencies.length} required component(s): ${addedDependencies.map((a) => a.displayName).join(', ')}`
      : checked ? 'No missing required components' : 'Check skipped');

    // 4. Export --------------------------------------------------------------------------------
    currentKey = 'export';
    const ex = begin(m, 'export', `${options.managed ? 'Managed' : 'Unmanaged'} export of ${exportName}`);
    let pkg = await src.exportSolution(exportName, options.managed, (p, detail) => {
      checkStop(m);
      if (p !== null && p !== undefined) ex.progress = p;
      if (detail) ex.detail = detail;
    });
    finish(m, 'export', `${(pkg.length / 1024).toFixed(1)} KB exported`);

    // 5. Cleanup -------------------------------------------------------------------------------
    currentKey = 'cleanup';
    if (tempSolution) {
      begin(m, 'cleanup', tempSolution.uniqueName);
      await cleanupTemp();
      finish(m, 'cleanup', 'Temporary solution removed (components were not affected)');
    } else skip(m, 'cleanup', 'No temporary solution was created');

    // 6. Package -------------------------------------------------------------------------------
    currentKey = 'package';
    begin(m, 'package');
    const manifest = readManifest(pkg);
    if (manifest.uniqueName !== finalUniqueName || manifest.displayName !== finalDisplayName) {
      pkg = renameSolution(pkg, { uniqueName: finalUniqueName, displayName: finalDisplayName });
      log(m, 'info', `Package renamed to ${finalUniqueName} ("${finalDisplayName}").`);
    }
    const inventory = inspectPackage(pkg);
    for (const a of inventory.canvasAppDetails || []) {
      log(m, 'info', `Canvas app "${a.name}" in package: ${a.screens.length} screen(s)${a.savedUtc ? `, version saved ${a.savedUtc} UTC` : ''}${a.screens.length ? ` (${a.screens.join(', ')})` : ''}.`);
    }
    m._internal.package = pkg;
    m._internal.packageName = `${finalUniqueName}_${solution.version.replace(/\./g, '_')}${options.managed ? '_managed' : ''}.zip`;
    try { store.savePackage(m.id, pkg, m._internal.packageName); } catch (err) { log(m, 'warning', `Could not save the package to history: ${err.message}`); }
    finish(m, 'package', `${finalUniqueName} v${solution.version}${rename ? ' (renamed)' : ''}`);

    if (packageOnly) {
      m.summary = buildPackageSummary(m, { solution, components, included, excludedList, addedDependencies, prerequisites, finalUniqueName, finalDisplayName, inventory, size: pkg.length, durationMs: Date.now() - t0 });
      m.outcome = 'package';
      m.status = 'succeeded';
      m.summary.outcome = m.outcome;
      log(m, 'info', `Package ready: ${m._internal.packageName} (${(pkg.length / 1024).toFixed(1)} KB). Nothing was imported.`);
      return;
    }

    // 7. Import --------------------------------------------------------------------------------
    currentKey = 'import';
    const im = begin(m, 'import', `Importing into ${req.target.env.name}`);
    const settings = m.request.configuration;
    const { importJobId } = await tgt.importSolution(pkg, {
      ...options,
      componentParameters: { connectionReferences: settings.connectionReferences, environmentVariables: settings.environmentVariables },
    }, (p, detail) => {
      if (p !== null && p !== undefined) im.progress = p;
      if (detail) im.detail = detail;
    });
    m._internal.importJobId = importJobId;
    finish(m, 'import', 'Import completed');
    m._internal.importDone = true;

    // 7b. Connections & environment variables ----------------------------------------------------
    currentKey = 'configure';
    let configResults = null;
    if (settings.connectionReferences.length || settings.environmentVariables.length) {
      const st = begin(m, 'configure', `${settings.connectionReferences.length} connection reference(s), ${settings.environmentVariables.length} environment variable(s)`);
      configResults = { connectionReferences: [], environmentVariables: [], flows: [] };
      const total = settings.connectionReferences.length + settings.environmentVariables.length;
      let n = 0;
      for (const c of settings.connectionReferences) {
        try {
          const result = await tgt.setConnectionReference(c.logicalName, c.connectionId);
          configResults.connectionReferences.push({ name: c.displayName || c.logicalName, logicalName: c.logicalName, connection: c.connectionName || c.connectionId, result });
        } catch (err) {
          configResults.connectionReferences.push({ name: c.displayName || c.logicalName, logicalName: c.logicalName, connection: c.connectionName || c.connectionId, result: 'failed', message: err.message });
          log(m, 'warning', `Could not bind connection reference ${c.logicalName}: ${err.message}`);
        }
        st.progress = Math.round((++n / total) * 80);
      }
      for (const v of settings.environmentVariables) {
        try {
          const result = await tgt.setEnvironmentVariableValue(v.schemaName, String(v.value));
          configResults.environmentVariables.push({ name: v.displayName || v.schemaName, schemaName: v.schemaName, result });
        } catch (err) {
          configResults.environmentVariables.push({ name: v.displayName || v.schemaName, schemaName: v.schemaName, result: 'failed', message: err.message });
          log(m, 'warning', `Could not set environment variable ${v.schemaName}: ${err.message}`);
        }
        st.progress = Math.round((++n / total) * 80);
      }
      // Flows that couldn't start during import (no connection yet) can be turned on now.
      if (options.publishWorkflows && settings.connectionReferences.length) {
        const target = await tgt.findSolutionByUniqueName(finalUniqueName).catch(() => null);
        if (target) {
          try { configResults.flows = await tgt.activateSolutionFlows(target.id); } catch (err) {
            log(m, 'warning', `Could not turn on flows: ${err.message}`);
          }
        }
      }
      const failed = [...configResults.connectionReferences, ...configResults.environmentVariables, ...configResults.flows].filter((r) => r.result === 'failed').length;
      finish(m, 'configure', failed ? `Done with ${failed} problem(s), see the summary` : `Applied ${total} setting(s)${configResults.flows.length ? ` · ${configResults.flows.filter((f) => f.result === 'activated').length} flow(s) turned on` : ''}`);
    } else skip(m, 'configure', settings.skipped ? 'Skipped by user' : 'No connection mappings or values entered');

    // 8. Publish target ------------------------------------------------------------------------
    currentKey = 'publishTarget';
    if (options.publishAfterImport && !options.managed) {
      begin(m, 'publishTarget', req.target.env.name);
      await tgt.publishAll();
      finish(m, 'publishTarget', 'All customizations published');
    } else skip(m, 'publishTarget', options.managed ? 'Not required for managed solutions' : 'Disabled in options');

    // 9. Verify --------------------------------------------------------------------------------
    currentKey = 'verify';
    begin(m, 'verify');
    let importResults = null;
    try { importResults = importJobId ? configuration.reclassifyImportResults(await tgt.getImportJobResults(importJobId)) : null; } catch (err) {
      log(m, 'warning', `Could not read import job results: ${err.message}`);
    }
    const actionRequired = await configuration.collectActionRequired(tgt, inventory, configResults, importResults).catch(() => null);
    if (actionRequired && actionRequired.total) log(m, 'warning', `${actionRequired.total} item(s) need configuration in ${req.target.env.name} (connections, environment variable values or flows to turn on).`);
    // Verify in the target itself before reporting success.
    const installed = await tgt.findSolutionByUniqueName(finalUniqueName);
    if (!installed) {
      throw new Error(`Verification failed: the import reported success, but the solution "${finalUniqueName}" was not found in ${req.target.env.name}. Check the solution history in the target.`);
    }
    const versionOk = compareVersions(installed.version, solution.version) === 0;
    if (!versionOk) log(m, 'warning', `Verification: ${req.target.env.name} shows "${finalUniqueName}" v${installed.version}, expected v${solution.version}.`);
    else log(m, 'info', `Verified: "${finalUniqueName}" v${installed.version} is in ${req.target.env.name}.`);
    finish(m, 'verify', importResults
      ? `${importResults.counts.success} succeeded · ${importResults.counts.failure} failed${actionRequired && actionRequired.total ? ` · ${actionRequired.total} need configuration` : ''}${importResults.counts.warning ? ` · ${importResults.counts.warning} warnings` : ''}`
      : 'Done');

    const failureItems = collectFailures(importResults, configResults, versionOk ? null : { expected: solution.version, actual: installed.version, name: finalUniqueName });
    m.summary = buildSummary(m, { failureItems, verification: { installed: true, version: installed.version, expectedVersion: solution.version, versionOk }, actionRequired, configResults, solution, components, included, excludedList, addedDependencies, finalUniqueName, finalDisplayName, operation, inventory, importResults, installed, durationMs: Date.now() - t0 });
    // Full success only when nothing failed and nothing is left to configure.
    const actions = actionRequired ? actionRequired.total : 0;
    m.outcome = failureItems.length ? 'errors' : actions ? 'action' : 'ok';
    m.status = m.outcome === 'ok' ? 'succeeded' : 'attention';
    m.summary.outcome = m.outcome;
    log(m, m.outcome === 'ok' ? 'info' : 'warning', m.outcome === 'ok'
      ? 'Migration completed successfully and verified in the target.'
      : m.outcome === 'action'
        ? `Migration successful and verified in the target; ${actions} item(s) require configuration there.`
        : `Migration completed with errors: ${failureItems.length} problem(s), see Failures.`);
  } catch (err) {
    if (err instanceof CancelledError) {
      const s = step(m, currentKey);
      if (s.status === 'running' || s.status === 'pending') Object.assign(s, { status: 'skipped', detail: 'Stopped', finishedAt: new Date().toISOString() });
      m.status = 'cancelled';
      m.error = {
        step: s.label,
        cancelled: true,
        message: packageOnly
          ? 'Stopped by you. No package was created, and the source solution is unchanged.'
          : m._internal.importDone
          ? `Stopped by you after the import finished. The solution is in ${req.target.env.name}, but the remaining steps (connections and variables, publishing, verification) were skipped.`
          : `Stopped by you. Nothing was imported into ${req.target.env.name}.`,
      };
      log(m, 'warning', m.error.message);
      try { await cleanupTemp(); } catch (e) { log(m, 'warning', `Could not delete the temporary solution: ${e.message}. Delete it manually from the source environment.`); }
      for (const st of m.steps) if (st.status === 'pending') st.status = 'skipped';
      return;
    }
    const s = step(m, currentKey);
    s.status = 'failed';
    s.finishedAt = new Date().toISOString();
    m.status = 'failed';
    m.error = { step: s.label, message: err.message || String(err), details: formatDetails(err.details), issues: [], missingDependencies: err.missingDependencies || null, canvasApps: err.canvasApps || null };
    if (!m.error.missingDependencies) {
      const parsed = dependencies.parseImportMissingDependencies(m.error.message);
      if (parsed) {
        m.error.details = m.error.message + (m.error.details ? `\n\n${m.error.details}` : '');
        m.error.message = parsed.summary;
        m.error.missingDependencies = parsed.missingDependencies;
      }
    }
    log(m, 'error', `${s.label} failed: ${m.error.message}`);

    const importJobId = err.importJobId || m._internal.importJobId;
    if (importJobId && tgt) {
      m._internal.importJobId = importJobId;
      try {
        const results = await tgt.getImportJobResults(importJobId);
        m.error.issues = results.issues.filter((i) => i.level === 'failure').slice(0, 50);
      } catch { /* ignore */ }
    }
    try { await cleanupTemp(); } catch (e) { log(m, 'warning', `Could not delete the temporary solution: ${e.message}. Delete it manually from the source environment.`); }
    for (const st of m.steps) if (st.status === 'pending') st.status = 'skipped';
    throw err;
  } finally {
    m.finishedAt = new Date().toISOString();
    if (m._internal.importJobId && tgt) {
      try { store.saveImportLog(m.id, await tgt.getImportLog(m._internal.importJobId)); } catch { /* log may not exist yet */ }
    }
    persist(m);
  }
}

/** Everything that went wrong after the import started, as one list. */
function collectFailures(importResults, configResults, versionMismatch) {
  const out = [];
  for (const i of (importResults && importResults.issues) || []) {
    if (i.level === 'failure') out.push({ source: 'Import', name: i.component, message: i.message });
  }
  if (configResults) {
    for (const c of configResults.connectionReferences) if (c.result === 'failed') out.push({ source: 'Connection reference', name: c.name, message: c.message });
    for (const v of configResults.environmentVariables) if (v.result === 'failed') out.push({ source: 'Environment variable', name: v.name, message: v.message });
    for (const f of configResults.flows || []) if (f.result === 'failed') out.push({ source: 'Cloud flow', name: f.name, message: f.message, details: f.details });
  }
  if (versionMismatch) {
    out.push({ source: 'Verification', name: versionMismatch.name, message: `The target shows version ${versionMismatch.actual}, but ${versionMismatch.expected} was imported.` });
  }
  return out;
}

/** -1 / 0 / 1 comparing dotted versions like 1.0.0.12 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function formatDetails(details) {
  if (!details) return '';
  if (typeof details === 'string') return details.slice(0, 4000);
  try { return JSON.stringify(details, null, 2).slice(0, 4000); } catch { return ''; }
}

function buildSummary(m, x) {
  const { options, source, target } = m.request;
  const recommendations = [];
  const cr = x.configResults;
  const boundRefs = cr ? cr.connectionReferences.filter((c) => c.result !== 'failed').length : 0;
  const ar = x.actionRequired;
  if (!ar && x.inventory.connectionReferences > boundRefs) recommendations.push(`${x.inventory.connectionReferences - boundRefs} connection reference(s): create or select connections in ${target.environment.name} and bind them (Solutions › ${x.finalDisplayName} › Connection references).`);
  if (!ar && x.inventory.environmentVariables && !(cr && cr.environmentVariables.length)) recommendations.push(`${x.inventory.environmentVariables} environment variable(s): review their current values in ${target.environment.name}.`);
  const flowsOn = cr && cr.flows ? cr.flows.filter((f) => f.result === 'activated').length : 0;
  if (!ar && x.inventory.flows > flowsOn && !(cr && cr.flows && cr.flows.length && cr.flows.every((f) => f.result === 'activated'))) recommendations.push(`${x.inventory.flows} cloud flow(s): confirm they are turned on once connections are configured.`);
  if (x.inventory.canvasApps && m.crossTenant) recommendations.push(`${x.inventory.canvasApps} canvas app(s): share them with users of the ${target.tenant.displayName} tenant.`);
  if (m.crossTenant) recommendations.push('Cross-tenant move: security role assignments, users/teams, and data rows are not part of a solution and must be set up in the target tenant.');

  return {
    configuration: x.configResults || null,
    source: { tenant: source.tenant.displayName, environment: source.environment.name, url: source.environment.url },
    target: { tenant: target.tenant.displayName, environment: target.environment.name, url: target.environment.url },
    crossTenant: m.crossTenant,
    sourceSolution: { uniqueName: x.solution.uniqueName, displayName: x.solution.displayName, version: x.solution.version },
    targetSolution: { uniqueName: x.finalUniqueName, displayName: x.finalDisplayName, version: x.solution.version, id: x.installed && x.installed.id, managed: Boolean(options.managed) },
    renamed: x.finalUniqueName !== x.solution.uniqueName || x.finalDisplayName !== x.solution.displayName,
    operation: x.operation === 'update' ? 'Updated existing solution' : 'Installed new solution',
    components: {
      total: x.components.length,
      included: x.included.length,
      excluded: x.excludedList.length,
      excludedList: x.excludedList.map((c) => ({ typeName: c.typeName, displayName: c.displayName })),
      addedDependencies: x.addedDependencies || [],
      byType: countBy(x.included, (c) => c.typeName),
      includedList: x.included.slice(0, 5000).map((c) => ({ typeName: c.typeName, displayName: c.displayName, name: c.name && c.name !== c.displayName ? c.name : '' })),
    },
    package: x.inventory,
    importResults: x.importResults,
    failureItems: x.failureItems || [],
    verification: x.verification || null,
    outcome: m.outcome || 'ok',
    actionRequired: ar || null,
    configurationSkipped: Boolean(m.request.configuration && m.request.configuration.skipped),
    targetSolutionsUrl: target.environment.environmentId ? `${require('./config').makerPortalUrl}/environments/${target.environment.environmentId}/solutions` : null,
    durationMs: x.durationMs,
    steps: m.steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail, durationMs: s.startedAt && s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : null })),
    recommendations,
  };
}

function buildPackageSummary(m, x) {
  const { options, source } = m.request;
  const recommendations = [
    `Import the package in the target environment: Power Apps › Solutions › Import solution, and choose ${m._internal.packageName}.`,
  ];
  if (x.inventory.connectionReferences) recommendations.push(`${x.inventory.connectionReferences} connection reference(s): the importer chooses or creates connections during the import.`);
  if (x.inventory.environmentVariables) recommendations.push(`${x.inventory.environmentVariables} environment variable(s): the importer enters their values during the import.`);
  if (x.inventory.canvasApps) recommendations.push(`${x.inventory.canvasApps} canvas app(s): share them with the users of the target environment after the import.`);
  if (x.prerequisites.length) recommendations.push(`${x.prerequisites.length} prerequisite(s): the target environment must already have the managed solutions listed under "Prerequisites".`);
  return {
    packageOnly: true,
    source: { tenant: source.tenant.displayName, environment: source.environment.name, url: source.environment.url },
    target: null,
    crossTenant: false,
    sourceSolution: { uniqueName: x.solution.uniqueName, displayName: x.solution.displayName, version: x.solution.version },
    targetSolution: { uniqueName: x.finalUniqueName, displayName: x.finalDisplayName, version: x.solution.version, managed: Boolean(options.managed) },
    renamed: x.finalUniqueName !== x.solution.uniqueName || x.finalDisplayName !== x.solution.displayName,
    operation: 'Package created (not imported)',
    packageFile: { name: m._internal.packageName, sizeBytes: x.size },
    prerequisites: x.prerequisites.map(({ key, ...p }) => p),
    components: {
      total: x.components.length,
      included: x.included.length,
      excluded: x.excludedList.length,
      excludedList: x.excludedList.map((c) => ({ typeName: c.typeName, displayName: c.displayName })),
      addedDependencies: x.addedDependencies || [],
      byType: countBy(x.included, (c) => c.typeName),
      includedList: x.included.slice(0, 5000).map((c) => ({ typeName: c.typeName, displayName: c.displayName, name: c.name && c.name !== c.displayName ? c.name : '' })),
    },
    package: x.inventory,
    importResults: null,
    failureItems: [],
    verification: null,
    actionRequired: null,
    configuration: null,
    configurationSkipped: true,
    targetSolutionsUrl: null,
    durationMs: x.durationMs,
    steps: m.steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail, durationMs: s.startedAt && s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : null })),
    recommendations,
  };
}

function countBy(items, fn) {
  const out = {};
  for (const i of items) out[fn(i)] = (out[fn(i)] || 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

module.exports = { compareVersions, requestStop, isRunning, startMigration, getMigration, listMigrations, getInternal, ValidationError, STEP_DEFS };
