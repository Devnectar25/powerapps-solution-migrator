'use strict';

/**
 * Stops the migrator when its browser tab is closed (only when started by Start-Migrator.cmd,
 * which sets AUTO_EXIT=1). Pages send a heartbeat; when no page is left, the server exits after a
 * short grace period, so that a reload doesn't stop it.
 *
 * Never stops while a migration is running or a Microsoft sign-in is in progress.
 */

const num = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const HEARTBEAT_TIMEOUT_MS = num(process.env.AUTO_EXIT_TIMEOUT_MS, 90 * 1000); // hidden tabs may tick only once a minute
const GRACE_MS = num(process.env.AUTO_EXIT_GRACE_MS, 10 * 1000);                // time for a reload to reconnect
const CHECK_MS = num(process.env.AUTO_EXIT_CHECK_MS, 2 * 1000);

const clients = new Map(); // page id -> last heartbeat time
let everConnected = false;
let idleSince = null;
let timer = null;

function enabled() {
  return process.env.AUTO_EXIT === '1';
}

function heartbeat(id) {
  if (!id) return;
  clients.set(String(id).slice(0, 64), Date.now());
  everConnected = true;
  idleSince = null;
}

function closed(id) {
  if (id) clients.delete(String(id).slice(0, 64));
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isBusy  true while something must not be interrupted
 * @param {() => void} opts.onExit
 */
function start({ isBusy, onExit, now = Date.now, graceMs = GRACE_MS, timeoutMs = HEARTBEAT_TIMEOUT_MS, checkMs = CHECK_MS, force = false }) {
  if ((!enabled() && !force) || timer) return;
  timer = setInterval(() => {
    const t = now();
    for (const [id, seen] of clients) if (t - seen > timeoutMs) clients.delete(id);
    if (!everConnected || clients.size > 0) { idleSince = null; return; }
    if (isBusy()) { idleSince = null; return; }
    if (idleSince === null) { idleSince = t; return; }
    if (t - idleSince >= graceMs) {
      clearInterval(timer);
      timer = null;
      onExit();
    }
  }, checkMs);
  timer.unref();
}

function status() {
  return { enabled: enabled(), pages: clients.size };
}

function _reset() {
  clients.clear();
  everConnected = false;
  idleSince = null;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { enabled, heartbeat, closed, start, status, _reset };
