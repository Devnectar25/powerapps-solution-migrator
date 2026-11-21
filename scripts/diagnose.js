'use strict';

/* Connectivity check: npm run diagnose */

const { execSync } = require('child_process');
const config = require('../src/config');
const network = require('../src/network');

const net = network.setupNetwork();

function systemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', { encoding: 'utf8' });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
    const server = (out.match(/ProxyServer\s+REG_SZ\s+(.+)/) || [])[1];
    const pac = (out.match(/AutoConfigURL\s+REG_SZ\s+(.+)/) || [])[1];
    return { enabled, server: server && server.trim(), pac: pac && pac.trim() };
  } catch { return null; }
}

(async () => {
  console.log('PowerApps Solution Migrator — connectivity check\n');
  console.log(`Node.js           ${process.version}`);
  console.log(`Mode              ${config.mockMode ? 'DEMO (MOCK_MODE=true)' : 'Real'}`);
  console.log(`CLIENT_ID         ${config.clientId || '(not set)'}`);
  console.log(`Redirect URI      ${config.redirectUri}`);
  console.log(`Proxy (Node)      ${net.proxy || '(none)'}`);
  console.log(`System certs      ${net.systemCa ? 'trusted' : 'not loaded'}`);
  net.notes.forEach((n) => console.log(`  note: ${n}`));

  const sp = systemProxy();
  if (sp && (sp.enabled || sp.pac)) {
    console.log(`Windows proxy     ${sp.enabled ? sp.server : '(off)'}${sp.pac ? `  · PAC script: ${sp.pac}` : ''}`);
    if (!net.proxy) console.log('  → Windows uses a proxy but Node.js does not. Add PROXY_URL=http://<that address> to .env.');
  }

  const targets = [
    `${config.authorityHost}/common/discovery/instance?api-version=1.1&authorization_endpoint=${config.authorityHost}/common/oauth2/v2.0/authorize`,
    `${config.discoveryUrl}/api/discovery/v2.0/Instances`,
    `${config.armUrl}/tenants?api-version=2022-12-01`,
  ];
  console.log('');
  let failed = 0;
  for (const url of targets) {
    const host = new URL(url).host;
    const r = await network.probe(url);
    if (!r) console.log(`  OK    ${host}`);
    else {
      failed++;
      console.log(`  FAIL  ${host}  ${r.code}: ${r.message}`);
      console.log(`        ${r.hint}`);
    }
  }
  console.log(failed ? '\nFix the failures above, restart the server (npm start) and sign in again.' : '\nAll endpoints are reachable.');
  process.exitCode = failed ? 1 : 0;
})();
