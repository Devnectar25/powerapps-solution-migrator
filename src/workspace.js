'use strict';

/**
 * Per-user isolation. Every request runs inside a workspace context:
 *   key  - whose Microsoft sign-ins, tenant lists and running migrations these are
 *   org  - whose saved profiles, history and packages these are (shared within an organization)
 * On your own computer without registration there is one workspace ('local'), exactly as before.
 * With registration (and always when hosted), each signed-in user has their own workspace, and
 * profiles/history are shared with the colleagues of their organization only.
 *
 * AsyncLocalStorage carries the context into everything a request starts, including a
 * migration that keeps running in the background after the request has been answered.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const LOCAL = Object.freeze({ key: 'local', org: 'local', user: null });

const current = () => als.getStore() || LOCAL;

module.exports = {
  LOCAL,
  current,
  key: () => current().key,
  org: () => current().org,
  run: (ctx, fn) => als.run({ ...LOCAL, ...ctx }, fn),
};
