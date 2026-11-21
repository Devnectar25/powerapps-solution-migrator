'use strict';

/**
 * App-registration settings that can be edited from the UI. Changes are written to .env and
 * applied immediately (no restart): CLIENT_ID and the optional CLIENT_SECRET.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function systemInfo() {
  const pkg = require('../package.json');
  let deps = null;
  try { deps = require('../scripts/check-deps').status(); } catch { /* ignore */ }
  const versions = {};
  for (const name of Object.keys(pkg.dependencies || {})) {
    try { versions[name] = require(`${name}/package.json`).version; } catch { versions[name] = null; }
  }
  return {
    appVersion: pkg.version,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    dependencies: versions,
    dependenciesReady: deps ? deps.ready : true,
    dataDir: config.dataDir,
  };
}

function getSettings() {
  if (config.hosted) {
    // Users of a hosted migrator only see what's relevant to them, not server paths or keys.
    return { hosted: true, clientId: config.clientId, hasClientSecret: Boolean(config.clientSecret), redirectUri: config.redirectUri, mockMode: config.mockMode, registrationMode: require('./accounts').mode(), overriddenByEnvironment: [], system: { appVersion: require('../package.json').version } };
  }
  return {
    clientId: config.clientId,
    hasClientSecret: Boolean(config.clientSecret),
    redirectUri: config.redirectUri,
    envFile: config.envFile,
    envFileExists: fs.existsSync(config.envFile),
    mockMode: config.mockMode,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey, // public key (safe in a browser by design)
    registration: config.registration,
    registrationMode: require('./accounts').mode(),
    appUrl: config.appUrl,
    // Values set as real environment variables win over .env after a restart.
    overriddenByEnvironment: ['CLIENT_ID', 'CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'REGISTRATION'].filter((k) => config.isFromEnvironment(k)),
    system: systemInfo(),
  };
}

function quote(value) {
  if (!/[\s#"'=]/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** Sets (or, with null, removes) KEY=value lines in the .env text, keeping everything else. */
function updateEnvText(text, changes) {
  const lines = text ? text.split(/\r?\n/) : [];
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(changes, m[1])) {
      if (done.has(m[1])) continue; // drop duplicates of a key we set
      done.add(m[1]);
      if (changes[m[1]] !== null) out.push(`${m[1]}=${quote(changes[m[1]])}`);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const [k, v] of Object.entries(changes)) {
    if (!done.has(k) && v !== null) out.push(`${k}=${quote(v)}`);
  }
  return `${out.join('\n')}\n`;
}

function writeEnv(changes) {
  let text = '';
  if (fs.existsSync(config.envFile)) text = fs.readFileSync(config.envFile, 'utf8');
  else {
    const example = path.join(path.dirname(config.envFile), '.env.example');
    if (fs.existsSync(example)) text = fs.readFileSync(example, 'utf8');
  }
  const next = updateEnvText(text, changes);
  const tmp = `${config.envFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, config.envFile);
}

/**
 * @param {{clientId: string, clientSecret?: string, removeClientSecret?: boolean}} input
 * @returns {{changed: boolean, settings: object}}
 */
function updateSettings(input) {
  const b = input || {};
  const changes = {};
  if (b.registration !== undefined || b.supabaseUrl !== undefined || b.supabaseAnonKey !== undefined) Object.assign(changes, accountChanges(b));
  if (b.clientId !== undefined || !Object.keys(changes).length) {
    const clientId = String(b.clientId || '').trim();
    if (!GUID_RE.test(clientId)) {
      throw badRequest('Enter the Application (client) ID: a GUID such as 3d7c1ae2-f89d-4d8f-ad33-662f352bceb5, from the app registration\'s Overview page.');
    }
    if (clientId.toLowerCase() !== String(config.clientId || '').toLowerCase()) changes.CLIENT_ID = clientId;
  }
  if (b.removeClientSecret) {
    if (config.clientSecret) changes.CLIENT_SECRET = null;
  } else if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) {
    const secret = b.clientSecret.trim();
    if (secret.length > 512 || /[\r\n]/.test(secret) || (secret.includes('"') && secret.includes("'"))) throw badRequest('The client secret is not valid.');
    if (secret !== config.clientSecret) changes.CLIENT_SECRET = secret;
  }
  if (!Object.keys(changes).length) return { changed: false, settings: getSettings() };

  writeEnv(changes);
  if ('CLIENT_ID' in changes) { config.clientId = changes.CLIENT_ID; process.env.CLIENT_ID = changes.CLIENT_ID; }
  if ('SUPABASE_URL' in changes) { config.supabaseUrl = changes.SUPABASE_URL || ''; process.env.SUPABASE_URL = config.supabaseUrl; }
  if ('SUPABASE_ANON_KEY' in changes) { config.supabaseAnonKey = changes.SUPABASE_ANON_KEY || ''; process.env.SUPABASE_ANON_KEY = config.supabaseAnonKey; }
  if ('REGISTRATION' in changes) { config.registration = changes.REGISTRATION; process.env.REGISTRATION = changes.REGISTRATION; }
  if ('CLIENT_SECRET' in changes) {
    config.clientSecret = changes.CLIENT_SECRET || '';
    if (changes.CLIENT_SECRET) process.env.CLIENT_SECRET = changes.CLIENT_SECRET; else delete process.env.CLIENT_SECRET;
  }
  return { changed: true, settings: getSettings() };
}

// Supabase connection for user registration. The anon key is public by design (Row Level Security
// protects the data); the service-role key must never be entered here.
function accountChanges(b) {
  const changes = {};
  if (b.supabaseUrl !== undefined) {
    const url = String(b.supabaseUrl || '').trim().replace(/\/$/, '');
    if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
      throw badRequest('Enter the Supabase project URL, for example https://abcdefghijklmnop.supabase.co.');
    }
    if (url !== config.supabaseUrl) changes.SUPABASE_URL = url || null;
  }
  if (b.supabaseAnonKey !== undefined) {
    const key = String(b.supabaseAnonKey || '').trim();
    if (key && (key.length > 2048 || !/^[A-Za-z0-9._-]+$/.test(key))) throw badRequest('The Supabase anon (public) key is not valid.');
    if (/service_role/.test(Buffer.from((key.split('.')[1] || ''), 'base64').toString('utf8')) || /^sb_secret_/.test(key)) {
      throw badRequest('That is the service-role (secret) key. Enter the anon / publishable key instead: the secret key must never be stored in this tool.');
    }
    if (key !== config.supabaseAnonKey) changes.SUPABASE_ANON_KEY = key || null;
  }
  if (b.registration !== undefined) {
    const r = String(b.registration || 'auto').toLowerCase();
    if (!['auto', 'on', 'off'].includes(r)) throw badRequest('Registration must be auto, on or off.');
    if (r !== config.registration) changes.REGISTRATION = r;
  }
  return changes;
}

module.exports = { getSettings, updateSettings, updateEnvText, GUID_RE };
