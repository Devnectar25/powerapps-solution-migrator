'use strict';

/**
 * Used by the start scripts: is everything needed to run the migrator installed?
 *   node scripts/check-deps.js          exit 0 = ready, 1 = run "npm install", 2 = Node.js too old
 *   node scripts/check-deps.js --stamp  record that the current dependency list is installed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stampFile = path.join(root, 'node_modules', '.migrator-deps');
const wanted = crypto.createHash('sha256').update(JSON.stringify(pkg.dependencies || {})).digest('hex');

function status() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const missing = Object.keys(pkg.dependencies || {}).filter((name) => {
    try { require.resolve(`${name}/package.json`, { paths: [root] }); return false; } catch { return true; }
  });
  let stamp = null;
  try { stamp = fs.readFileSync(stampFile, 'utf8').trim(); } catch { /* none yet */ }
  return {
    node: process.versions.node,
    nodeOk: major >= 18,
    missing,
    // The dependency list changed since the last install (an update added or upgraded one).
    outdated: !missing.length && stamp !== null && stamp !== wanted,
    ready: major >= 18 && !missing.length && (stamp === null || stamp === wanted),
  };
}

module.exports = { status };

if (require.main === module) {
  if (process.argv.includes('--stamp')) {
    fs.writeFileSync(stampFile, wanted);
    process.exit(0);
  }
  const s = status();
  if (!s.nodeOk) {
    console.error(`Node.js ${s.node} is too old. Install Node.js 22 LTS or newer from https://nodejs.org`);
    process.exit(2);
  }
  if (s.missing.length) console.log(`Components to install: ${s.missing.join(', ')}`);
  else if (s.outdated) console.log('Components changed in this version and need updating.');
  process.exit(s.ready ? 0 : 1);
}
