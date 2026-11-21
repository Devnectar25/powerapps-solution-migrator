'use strict';

/**
 * Missing-dependency analysis.
 *
 * A solution "misses" a dependency when one of its components (e.g. a cloud flow) needs a
 * component that is not in the solution (e.g. a connection reference or a child flow that only
 * lives in the environment's default/Active layer). The import into another environment then
 * fails with "Some dependencies are missing".
 *
 * Before exporting, the migrator asks the source for these (RetrieveMissingDependencies) and
 * classifies every required component:
 *   add       – unmanaged component that exists in the source: can be added to the migrated copy
 *   excluded  – the user unchecked it on the Components step, but something selected needs it
 *   managed   – belongs to a managed solution that is not installed in the target
 *   notFound  – referenced but no longer present in the source
 * Required components from managed solutions that the target already has are not a problem.
 */

const { componentTypeName } = require('./componentTypes');

const ALWAYS_PRESENT = new Set(['system', 'active', 'basic', 'default']);

class DependencyError extends Error {
  constructor(message, missingDependencies) {
    super(message);
    this.name = 'DependencyError';
    this.status = 400;
    this.missingDependencies = missingDependencies;
  }
}

/**
 * @param {object} src  source DataverseClient
 * @param {object} tgt  target DataverseClient
 * @param {Array<{requiredId,requiredType,dependentId,dependentType}>} missing
 * @param {Set<string>} excludedObjectIds  lower-case object ids the user excluded
 */
async function analyse(src, tgt, missing, excludedObjectIds, caches = {}) {
  caches.names = caches.names || new Map();
  caches.targetSolutions = caches.targetSolutions || new Map();
  const describe = async (id, type) => {
    const key = `${type}|${String(id).toLowerCase()}`;
    if (!caches.names.has(key)) caches.names.set(key, await src.describeComponent(id, type).catch(() => null));
    return caches.names.get(key) || { id, type, typeName: componentTypeName(type), displayName: id };
  };
  const targetHas = async (uniqueName) => {
    const key = uniqueName.toLowerCase();
    if (!tgt) return false; // package only: no target to look in
    if (!caches.targetSolutions.has(key)) caches.targetSolutions.set(key, Boolean(await tgt.findSolutionByUniqueName(uniqueName).catch(() => null)));
    return caches.targetSolutions.get(key);
  };

  // Group by required component.
  const groups = new Map();
  for (const d of missing) {
    if (!d.requiredId) continue;
    const key = String(d.requiredId).toLowerCase();
    if (!groups.has(key)) groups.set(key, { requiredId: d.requiredId, requiredType: d.requiredType, dependents: [] });
    const g = groups.get(key);
    if (d.dependentId && !g.dependents.some((x) => String(x.id).toLowerCase() === String(d.dependentId).toLowerCase())) {
      g.dependents.push({ id: d.dependentId, type: d.dependentType });
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const required = await describe(g.requiredId, g.requiredType);
    const dependents = [];
    for (const dep of g.dependents) dependents.push(await describe(dep.id, dep.type));
    const neededBy = dependents.map((d) => `${d.typeName} "${d.displayName}"`).join(', ') || 'a component in the solution';

    let resolution;
    let message;
    if (excludedObjectIds.has(String(g.requiredId).toLowerCase())) {
      resolution = 'excluded';
      message = `You excluded this component, but ${neededBy} needs it. Select it again on the Components step, or exclude ${dependents.length > 1 ? 'those components' : 'that component'} too.`;
    } else {
      const solutions = await src.componentSolutions(g.requiredId).catch(() => []);
      const managed = solutions.filter((s) => s.isManaged && !ALWAYS_PRESENT.has(String(s.uniqueName).toLowerCase()));
      const builtIn = solutions.some((s) => s.isManaged && ALWAYS_PRESENT.has(String(s.uniqueName).toLowerCase()));
      if (!solutions.length) {
        resolution = 'notFound';
        message = `This component no longer exists in the source environment. Recreate it, or remove the reference to it from ${neededBy}.`;
      } else if (managed.length) {
        let installed = false;
        for (const s of managed) if (await targetHas(s.uniqueName)) { installed = true; break; }
        if (installed) continue; // target already has the managed solution that provides it
        resolution = 'managed';
        message = `Provided by the managed solution "${managed[0].displayName || managed[0].uniqueName}". Install that solution in the target environment first.`;
      } else if (builtIn) {
        continue; // platform component, present everywhere
      } else {
        resolution = 'add';
        message = 'Exists in the source environment but is not part of the solution. It can be added to the migrated copy automatically.';
      }
    }
    out.push({ required, dependents, resolution, message });
  }
  return out;
}

const XML_TYPE_NAMES = { connectionreference: 'Connection Reference', environmentvariabledefinition: 'Environment Variable Definition' };

function attrs(s) {
  return Object.fromEntries([...String(s).matchAll(/([\w.:]+)="([^"]*)"/g)].map((a) => [a[1], a[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
}

function typeLabel(t) {
  if (t === undefined || t === null || t === '') return 'Component';
  if (/^\d+$/.test(String(t))) return componentTypeName(Number(t), { 29: 'Process / Cloud flow' });
  return XML_TYPE_NAMES[String(t).toLowerCase()] || String(t);
}

/**
 * Parses the <MissingDependencies> XML that Dataverse puts into an import failure message.
 * Returns { summary, missingDependencies } or null when the message has no such XML.
 */
function parseImportMissingDependencies(message) {
  const text = String(message || '');
  const start = text.indexOf('<MissingDependencies');
  if (start < 0) return null;
  const endTag = text.indexOf('</MissingDependencies>', start);
  const xml = endTag > 0 ? text.slice(start, endTag) : text.slice(start);
  const groups = new Map();
  for (const m of xml.matchAll(/<MissingDependency\b[^>]*>([\s\S]*?)<\/MissingDependency>/g)) {
    const req = (m[1].match(/<Required\s([^>]*?)\/?>/) || [])[1];
    const dep = (m[1].match(/<Dependent\s([^>]*?)\/?>/) || [])[1];
    if (!req) continue;
    const r = attrs(req);
    const d = dep ? attrs(dep) : null;
    const name = r.displayName || r.schemaName || r['id.connectionreferencelogicalname'] || r.id || '(unnamed)';
    const key = `${r.type}|${name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        required: { typeName: typeLabel(r.type), displayName: name, logicalName: r['id.connectionreferencelogicalname'] || r.schemaName || '', solution: r.solution || '' },
        dependents: [],
      });
    }
    if (d) {
      const dn = d.displayName || d.schemaName || d.id;
      const g = groups.get(key);
      if (!g.dependents.some((x) => x.displayName === dn)) g.dependents.push({ typeName: typeLabel(d.type), displayName: dn });
    }
  }
  if (!groups.size) return null;
  const missingDependencies = [...groups.values()].map((g) => {
    const neededBy = g.dependents.map((d) => `${d.typeName} "${d.displayName}"`).join(', ') || 'a component in the solution';
    const inSource = /^active$/i.test(g.required.solution);
    return {
      ...g,
      resolution: inSource ? 'add' : 'missing',
      message: inSource
        ? `Exists in the source environment but isn't in the solution, and ${neededBy} needs it. Turn on "Include missing required components" and run the migration again, or add it to the solution in the source.`
        : `Not present in the target environment. Add it to the solution, or install the solution that provides it in the target first.`,
    };
  });
  const summary = text.slice(0, start).replace(/[\s:]+$/, '');
  return { summary: `${summary}. ${missingDependencies.length} required component(s) are missing; see the table below.`, missingDependencies };
}

module.exports = { analyse, DependencyError, parseImportMissingDependencies };
