'use strict';

/**
 * Local persistence (JSON files under DATA_DIR) for saved profiles and migration history.
 *
 *   data/profiles.json        saved migration profiles
 *   data/history.json         one record per migration (status, steps, logs, summary, error)
 *   data/packages/<id>.zip    exported solution package (newest KEEP_PACKAGES runs)
 *   data/logs/<id>.xml        formatted import log (Excel XML)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ID_RE = /^[0-9a-f-]{36}$/i;

function dir(...parts) {
  const p = path.join(config.dataDir, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  const target = path.join(dir(), file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

function checkId(id) {
  if (!ID_RE.test(String(id || ''))) {
    const e = new Error('Invalid id.');
    e.status = 400;
    throw e;
  }
  return id;
}

// Profiles, history and packages belong to an organization (or to 'local' without registration).
// Every read and write is limited to the current workspace's organization.
const workspace = require('./workspace');
const orgOf = (r) => (r && r.org) || 'local';
const mine = (r) => orgOf(r) === workspace.org();

// --- profiles --------------------------------------------------------------------------------

function listProfiles() {
  return readJson('profiles.json', []).filter(mine).sort((a, b) => a.name.localeCompare(b.name));
}

function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || null;
}

function validateProfile(p) {
  if (!p || typeof p !== 'object') throw Object.assign(new Error('Invalid profile.'), { status: 400 });
  const name = String(p.name || '').trim();
  if (!name) throw Object.assign(new Error('Enter a profile name.'), { status: 400 });
  if (name.length > 120) throw Object.assign(new Error('The profile name is too long (max 120 characters).'), { status: 400 });
  if (!p.source || (!p.target && p.mode !== 'package') || !p.solution || !p.solution.uniqueName) {
    throw Object.assign(new Error('A profile needs a source, a target and a solution.'), { status: 400 });
  }
  const json = JSON.stringify(p);
  if (json.length > 512 * 1024) throw Object.assign(new Error('The profile is too large.'), { status: 400 });
  return { ...p, name };
}

function saveProfile(input, id) {
  const { org: _ignored, ...p } = validateProfile(input);
  const all = readJson('profiles.json', []);
  const now = new Date().toISOString();
  if (all.some((x) => mine(x) && x.name.toLowerCase() === p.name.toLowerCase() && x.id !== id)) {
    throw Object.assign(new Error(`A profile named "${p.name}" already exists.`), { status: 409 });
  }
  let saved;
  if (id) {
    checkId(id);
    const i = all.findIndex((x) => x.id === id && mine(x));
    if (i < 0) throw Object.assign(new Error('Profile not found.'), { status: 404 });
    saved = { ...p, id, org: workspace.org(), createdAt: all[i].createdAt, updatedAt: now };
    all[i] = saved;
  } else {
    saved = { ...p, id: crypto.randomUUID(), org: workspace.org(), createdAt: now, updatedAt: now };
    all.push(saved);
  }
  writeJson('profiles.json', all);
  return saved;
}

function deleteProfile(id) {
  checkId(id);
  const all = readJson('profiles.json', []);
  const next = all.filter((x) => !(x.id === id && mine(x)));
  if (next.length === all.length) throw Object.assign(new Error('Profile not found.'), { status: 404 });
  writeJson('profiles.json', next);
}

// --- history ---------------------------------------------------------------------------------

let historyCache = null;

function history() {
  if (!historyCache) {
    historyCache = readJson('history.json', []);
    // Runs that were in progress when the server stopped can never finish.
    let changed = false;
    for (const r of historyCache) {
      if (r.status === 'running') {
        r.status = 'interrupted';
        r.error = r.error || { step: 'Migration', message: 'The migrator was stopped while this migration was running. Check the target environment, then run it again.' };
        changed = true;
      }
    }
    if (changed) writeJson('history.json', historyCache);
  }
  return historyCache;
}

function saveRun(record) {
  const all = history();
  const i = all.findIndex((r) => r.id === record.id);
  if (i >= 0) all[i] = record; else all.unshift(record);
  all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (all.length > config.historyLimit) {
    for (const r of all.splice(config.historyLimit)) removeFiles(r.id);
  }
  writeJson('history.json', all);
}

function listRuns() {
  // Light-weight rows for the history table.
  return history().filter(mine).map((r) => ({
    id: r.id,
    status: r.status,
    outcome: r.outcome || null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    crossTenant: r.crossTenant,
    packageOnly: Boolean(r.packageOnly),
    startedBy: r.startedBy || null,
    appUser: r.appUser || null,
    profile: r.profile || null,
    source: r.request && r.request.source,
    target: r.request && r.request.target,
    solution: r.plan ? r.plan.solution : null,
    finalUniqueName: r.plan ? r.plan.finalUniqueName : null,
    componentCounts: r.plan ? r.plan.componentCounts : null,
    error: r.error ? { step: r.error.step, message: String(r.error.message || '').slice(0, 300) } : null,
    hasPackage: fs.existsSync(packagePath(r.id)),
    hasImportLog: fs.existsSync(importLogPath(r.id)),
  }));
}

function getRun(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const r = history().find((x) => x.id === id && mine(x));
  if (!r) return null;
  return { ...r, hasPackage: fs.existsSync(packagePath(id)), hasImportLog: fs.existsSync(importLogPath(id)) };
}

function deleteRun(id) {
  checkId(id);
  const all = history();
  const i = all.findIndex((r) => r.id === id && mine(r));
  if (i < 0) throw Object.assign(new Error('Migration not found.'), { status: 404 });
  if (all[i].status === 'running') throw Object.assign(new Error('A running migration cannot be deleted.'), { status: 409 });
  all.splice(i, 1);
  writeJson('history.json', all);
  removeFiles(id);
}

function packagePath(id) { return path.join(config.dataDir, 'packages', `${checkId(id)}.zip`); }
function importLogPath(id) { return path.join(config.dataDir, 'logs', `${checkId(id)}.xml`); }

function savePackage(id, buffer, fileName) {
  if (config.keepPackages <= 0) return;
  dir('packages');
  fs.writeFileSync(packagePath(id), buffer);
  fs.writeFileSync(`${packagePath(id)}.name`, fileName);
  fs.writeFileSync(`${packagePath(id)}.org`, workspace.org());
  // Keep only the newest N packages of this organization.
  const orgFile = (f) => { try { return fs.readFileSync(path.join(config.dataDir, 'packages', `${f}.org`), 'utf8'); } catch { return 'local'; } };
  const files = fs.readdirSync(dir('packages')).filter((f) => f.endsWith('.zip') && orgFile(f) === workspace.org())
    .map((f) => ({ f, t: fs.statSync(path.join(config.dataDir, 'packages', f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(config.keepPackages)) {
    for (const x of [f, `${f}.name`, `${f}.org`]) fs.rmSync(path.join(config.dataDir, 'packages', x), { force: true });
  }
}

function packageName(id) {
  try { return fs.readFileSync(`${packagePath(id)}.name`, 'utf8'); } catch { return `${id}.zip`; }
}

function saveImportLog(id, xml) {
  dir('logs');
  fs.writeFileSync(importLogPath(id), xml);
}

function removeFiles(id) {
  for (const f of [packagePath(id), `${packagePath(id)}.name`, `${packagePath(id)}.org`, importLogPath(id)]) fs.rmSync(f, { force: true });
}

module.exports = {
  listProfiles, getProfile, saveProfile, deleteProfile,
  saveRun, listRuns, getRun, deleteRun,
  savePackage, packagePath, packageName, saveImportLog, importLogPath,
  _reset: () => { historyCache = null; },
};
