'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
// Keys set in the real environment (not from .env); they take precedence over .env.
const fromEnvironment = new Set(Object.keys(process.env).filter((k) => String(process.env[k]).trim() !== ''));

// Minimal .env loader (no extra dependency). Existing environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.search(/\s#/); // strip trailing comments
    if (hash >= 0 && !/^["']/.test(value)) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_FILE);

const bool = (v, d = false) => (v === undefined || String(v).trim() === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d = '') => (v === undefined ? d : String(v).trim());

const port = parseInt(str(process.env.PORT, '3000') || '3000', 10);
// Hosted for many users (a server on the internet) instead of one person's computer.
const hosted = bool(process.env.HOSTED);
const appUrl = str(process.env.APP_URL).replace(/\/$/, '');

const config = {
  port,
  hosted,
  // Serverless platforms (Vercel, AWS Lambda) stop the process after each request: long-running
  // migrations, in-memory sign-ins and local files can't work there.
  serverless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY),
  host: process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1'),
  mockMode: bool(process.env.MOCK_MODE),

  // Entra ID (Azure AD) app registration. Must be multi-tenant for cross-tenant migrations.
  clientId: str(process.env.CLIENT_ID),
  clientSecret: str(process.env.CLIENT_SECRET), // optional: only when registered as a "Web" (confidential) app
  redirectUri: process.env.REDIRECT_URI || (appUrl ? `${appUrl}/auth/callback` : `http://localhost:${port}/auth/callback`),
  authorityHost: (process.env.AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/$/, ''),

  // Endpoints (override for sovereign clouds, e.g. GCC High / China).
  armUrl: (process.env.ARM_URL || 'https://management.azure.com').replace(/\/$/, ''),
  discoveryUrl: (process.env.DISCOVERY_URL || 'https://globaldisco.crm.dynamics.com').replace(/\/$/, ''),
  // Bearer tokens are only ever sent to hosts ending with one of these suffixes.
  dataverseHostSuffixes: (process.env.DATAVERSE_HOST_SUFFIXES ||
    '.dynamics.com,.crm.dynamics.cn,.crm.microsoftdynamics.us,.crm.appsplatform.us,.crm.microsoftdynamics.de')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Network: corporate proxy (e.g. http://proxy.company.com:8080) and OS certificate store.
  proxyUrl: str(process.env.PROXY_URL),
  useSystemCa: bool(process.env.USE_SYSTEM_CA, true),

  // Power Apps service API (connections, canvas app publish state). Needs the "PowerApps Service"
  // delegated permission on the app registration.
  powerAppsApiUrl: (process.env.POWERAPPS_API_URL || 'https://api.powerapps.com').replace(/\/$/, ''),
  powerAppsScope: process.env.POWERAPPS_SCOPE || 'https://service.powerapps.com//.default',
  makerPortalUrl: (process.env.MAKER_PORTAL_URL || 'https://make.powerapps.com').replace(/\/$/, ''),

  // Local storage for saved profiles and migration history.
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  keepPackages: parseInt(process.env.KEEP_PACKAGES || '10', 10), // newest N solution packages kept on disk
  historyLimit: parseInt(process.env.HISTORY_LIMIT || '500', 10),

  // How long one HTTP request may wait for Dataverse to answer. Importing a large solution
  // can take many minutes before Dataverse replies to the upload (Node's default is 5 minutes).
  requestTimeoutMinutes: parseInt(process.env.REQUEST_TIMEOUT_MINUTES || '60', 10),

  // User registration & organization profiles (Supabase). REGISTRATION: auto (on when Supabase is
  // configured; in demo mode a built-in demo backend is used), on, or off.
  supabaseUrl: str(process.env.SUPABASE_URL).replace(/\/$/, ''),
  supabaseAnonKey: str(process.env.SUPABASE_ANON_KEY),
  registration: (bool(process.env.MOCK_MODE) && /^off$/i.test(str(process.env.MOCK_REGISTRATION))) ? 'off'
    : (/^(on|off)$/i.test(str(process.env.REGISTRATION)) ? str(process.env.REGISTRATION).toLowerCase() : 'auto'),
  // Public address of the tool, used in the links of verification and password-reset emails.
  appUrl,

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
  asyncTimeoutMinutes: parseInt(process.env.ASYNC_TIMEOUT_MINUTES || '120', 10),
};

config.envFile = ENV_FILE;
config.isFromEnvironment = (key) => fromEnvironment.has(key);
Object.defineProperty(config, 'isConfigured', {
  enumerable: true,
  get() { return config.mockMode || Boolean(config.clientId); },
});

module.exports = config;
