'use strict';

// On serverless hosting (Vercel), migrations are refused with a clear message instead of
// starting and then being cut off mid-import.
process.env.MOCK_MODE = 'true';
process.env.MOCK_REGISTRATION = 'off';
process.env.VERCEL = '1';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'psm-sl-'));
process.env.ENV_FILE = require('path').join(process.env.DATA_DIR, 'test.env');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../server');

test('serverless hosting is detected and migrations are refused with a clear message', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.serverless, true);
    const r = await fetch(`${base}/api/migrations`, { method: 'POST', headers: { 'X-PSM-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error.message, /serverless functions/);
  } finally { server.close(); }
});
