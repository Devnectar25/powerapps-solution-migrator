/* PowerApps Solution Migrator — front-end (vanilla JS, no build step). */
'use strict';

const STEPS = ['Source & target', 'Solution', 'Components', 'Connections & variables', 'Options & review', 'Migrate'];
const STEP = { CONNECT: 0, SOLUTION: 1, COMPONENTS: 2, CONFIG: 3, OPTIONS: 4, MIGRATE: 5 };
const DEFAULT_OPTIONS = { managed: false, overwriteUnmanagedCustomizations: true, publishWorkflows: true, publishBeforeExport: true, publishAfterImport: true, includeMissingDependencies: true };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;

const state = {
  config: { mockMode: false, configured: true },
  auth: { source: { signedIn: false }, target: { signedIn: false } },
  step: 0,
  mode: 'same', // 'same' | 'cross' | 'package' (export and download only, no target)
  source: side(),
  target: side(),
  solutions: [], solutionsFor: null, loadingSolutions: false, solutionSearch: '', solutionId: null,
  components: [], componentsFor: null, loadingComponents: false, excluded: new Set(), compSearch: '', compType: '', collapsed: new Set(),
  rename: { enabled: false, uniqueName: '', displayName: '', uniqueTouched: false },
  options: { ...DEFAULT_OPTIONS },
  cfg: newCfg(),
  canvas: newCanvas(),
  profile: null, // { id, name } when the wizard was loaded from / saved as a profile
  view: 'wizard', // 'wizard' | 'profiles' | 'history' | 'run'
  profiles: null, history: null, historyRun: null, historyFilter: { q: '', status: '' },
  migration: null, pollTimer: null, errorShownFor: null,
};

function newCfg() {
  return { key: null, loading: false, error: null, data: null, conns: {}, mappings: {}, values: {}, skipped: false };
}

function newCanvas() {
  return { key: null, loading: false, result: null, error: null, ack: false };
}

function side() {
  return { tenants: [], tenantId: '', envs: [], envId: '', loadingTenants: false, loadingEnvs: false, addingTenant: false, tenantNote: '', stepUp: null };
}

// --- helpers -------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const fmtDuration = (ms) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);
const targetSlot = () => (state.mode === 'same' ? 'source' : 'target');
const findEnv = (s) => s.envs.find((e) => e.id === s.envId);
const findTenant = (s) => s.tenants.find((t) => t.tenantId === s.tenantId);
const selectedSolution = () => state.solutions.find((s) => s.id === state.solutionId);
const targetTenantId = () => (state.mode === 'same' ? state.source.tenantId : state.target.tenantId);
const targetEnvs = () => (state.mode === 'same' ? state.source.envs.filter((e) => e.id !== state.source.envId) : state.target.envs);
const targetEnv = () => targetEnvs().find((e) => e.id === state.target.envId);
const pkgMode = () => state.mode === 'package';

class ApiError extends Error {
  constructor(body, status) {
    super(body.message || `Request failed (${status})`);
    Object.assign(this, body, { status });
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'X-PSM-Request': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 && json && json.error && json.error.accountRequired && typeof accountExpired === 'function') accountExpired();
    throw new ApiError((json && json.error) || { message: text || res.statusText }, res.status);
  }
  return json;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// --- error popup ------------------------------------------------------------------------------
function showError(err, title = 'Something went wrong') {
  if (err && err.accountRequired) return; // the sign-in screen is already shown
  const modal = $('#modal');
  modal.classList.remove('plain');
  $('#modalTitle').textContent = title;
  const issues = err.issues || [];
  $('#modalBody').innerHTML = `
    ${err.step ? `<p class="muted small" style="margin:0 0 8px">Failed step: <b>${esc(err.step)}</b></p>` : ''}
    <div class="message">${esc(err.message || String(err))}</div>
    ${renderMissingDependencies(err.missingDependencies)}
    ${renderCanvasAppsTable(err.canvasApps)}
    ${issues.length && !(err.missingDependencies && err.missingDependencies.length) ? `<h3 style="font-size:14px;margin:14px 0 6px">Failed components</h3>
      <table class="table small"><tbody>${issues.map((i) => `<tr><td><b>${esc(i.component)}</b><div class="muted">${esc(i.message)}</div></td></tr>`).join('')}</tbody></table>` : ''}
    ${err.details ? `<details style="margin-top:12px"><summary>Technical details</summary><pre>${esc(typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2))}</pre></details>` : ''}
    ${err.authRequired ? `<div class="notice warn" style="margin-top:12px">${err.mfa ? 'You will be asked to verify your identity (MFA) for the same account.' : 'Sign in again to continue.'} Your selections are kept.</div>` : ''}`;
  const actions = $('#modalActions');
  actions.innerHTML = '';
  if (err.authRequired) {
    const b = button(err.mfa ? 'Sign in with MFA' : 'Sign in', 'btn btn-primary', () => { closeModal(); signIn(err.slot, err.tenantId, err.scope); });
    actions.append(b);
  }
  if (err.importLogUrl) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = err.importLogUrl;
    a.textContent = 'Download import log';
    actions.append(a);
  }
  const close = button('Close', err.authRequired ? 'btn' : 'btn btn-primary', closeModal);
  actions.append(close);
  modal.hidden = false;
  close.focus();
}

const RESOLUTION_LABEL = {
  add: ['Can be added automatically', 'badge-ok'],
  excluded: ['You excluded it', 'badge-warn'],
  managed: ['Needs a managed solution', 'badge-err'],
  notFound: ['Not found in source', 'badge-err'],
  missing: ['Missing in target', 'badge-err'],
};

function renderMissingDependencies(list) {
  if (!list || !list.length) return '';
  return `<h3 style="font-size:14px;margin:16px 0 6px">Missing required components (${list.length})</h3>
    <table class="table small dep-table"><thead><tr><th>Missing component</th><th>Needed by</th></tr></thead><tbody>
    ${list.map((d) => {
      const [label, cls] = RESOLUTION_LABEL[d.resolution] || ['Missing', 'badge-err'];
      return `<tr><td><b>${esc(d.required.displayName)}</b><div class="muted">${esc(d.required.typeName)}</div>
          <span class="badge ${cls}" style="margin-top:4px">${esc(label)}</span></td>
        <td>${(d.dependents || []).map((x) => `<div>${esc(x.displayName)} <span class="muted">· ${esc(x.typeName)}</span></div>`).join('') || '<span class="muted">—</span>'}</td></tr>
        <tr class="dep-fix"><td colspan="2" class="muted">${esc(d.message)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function closeModal() { $('#modal').hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// --- auth ------------------------------------------------------------------------------------
function signIn(slot, tenant, scope) {
  const url = `/auth/login?slot=${encodeURIComponent(slot)}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`;
  if (state.config.mockMode) {
    // Instant sign-in in demo mode.
    fetch(url).then((r) => r.text()).then(() => onSignedIn({ ok: true, slot }));
    return;
  }
  const w = window.open(`${url}&popup=1`, 'psm-login', popupFeatures());
  if (!w) { leavingForSignIn = true; location.href = url; } // popup blocked: full-page sign-in, result handed back on return
}

function popupFeatures() {
  const width = 520;
  const height = 680;
  const left = Math.max(0, (window.screenX || 0) + (window.outerWidth - width) / 2);
  const top = Math.max(0, (window.screenY || 0) + (window.outerHeight - height) / 2);
  return `width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`;
}

// The sign-in popup reports back through any of these channels (Microsoft's login page
// severs window.opener, so BroadcastChannel / storage events are the reliable ones).
const handledAuth = new Set();
function receiveAuth(msg) {
  if (!msg || msg.type !== 'psm-auth' || (msg.id && handledAuth.has(msg.id))) return;
  if (msg.id) handledAuth.add(msg.id);
  const now = Date.now();
  if (msg.ok && receiveAuth.last && receiveAuth.last.slot === msg.slot && now - receiveAuth.last.at < 3000) return;
  receiveAuth.last = { slot: msg.slot, at: now };
  window.focus();
  onSignedIn(msg);
}
window.addEventListener('message', (e) => { if (e.origin === location.origin) receiveAuth(e.data); });
try { new BroadcastChannel('psm-auth').onmessage = (e) => receiveAuth(e.data); } catch { /* old browser */ }
window.addEventListener('storage', (e) => {
  if (e.key === 'psm-auth-msg' && e.newValue) { try { receiveAuth(JSON.parse(e.newValue)); } catch { /* ignore */ } }
});
// Last resort: when the user comes back to this tab, pick up a sign-in that wasn't reported.
window.addEventListener('focus', async () => {
  if (state.config.mockMode) return;
  try {
    const status = await api('/api/auth/status');
    for (const slot of ['source', 'target']) {
      const before = state.auth[slot] && state.auth[slot].account && state.auth[slot].account.username;
      const after = status[slot] && status[slot].account && status[slot].account.username;
      if (after && after !== before) receiveAuth({ type: 'psm-auth', ok: true, slot, id: `focus-${slot}-${after}` });
    }
  } catch { /* ignore */ }
});

async function onSignedIn(msg) {
  if (!msg.ok) { showError({ message: msg.error }, 'Sign-in failed'); return; }
  const before = state.auth[msg.slot] && state.auth[msg.slot].account && state.auth[msg.slot].account.username;
  state.auth = await api('/api/auth/status');
  const after = state.auth[msg.slot] && state.auth[msg.slot].account && state.auth[msg.slot].account.username;
  const s = msg.slot === 'source' ? state.source : state.target;
  // Same account signing in again (consent, MFA): keep every selection and retry what needed it.
  if (before && after && before.toLowerCase() === after.toLowerCase() && s.tenantId && !(state.view === 'wizard' && state.step === STEP.CONNECT)) {
    toast('Signed in. Retrying…');
    retryAfterSignIn();
    return;
  }
  const keepTenant = s.tenantId;
  Object.assign(s, side());
  render();
  await loadTenants(msg.slot, keepTenant);
}

function retryAfterSignIn() {
  if (state.view !== 'wizard') { render(); return; }
  if (state.step === STEP.SOLUTION) { state.solutionsFor = null; loadSolutions(); return; }
  if (state.step === STEP.COMPONENTS) { state.componentsFor = null; loadComponents(); return; }
  if (state.step === STEP.CONFIG) { loadConfiguration(true); return; }
  if (state.step === STEP.OPTIONS) { runCanvasCheck(true); return; }
  render();
}

async function signOut(slot) {
  state.auth = await api('/api/auth/logout', { method: 'POST', body: { slot } });
  Object.assign(slot === 'source' ? state.source : state.target, side());
  if (slot === 'source') { resetSolution(); if (state.mode === 'same') Object.assign(state.target, side()); }
  render();
}

// --- data loading ----------------------------------------------------------------------------
async function loadTenants(slot, preferTenantId) {
  const s = slot === 'source' ? state.source : state.target;
  s.loadingTenants = true; render();
  try {
    s.tenants = await api(`/api/${slot}/tenants`);
    s.tenantNote = (s.tenants.find((t) => t.note) || {}).note || '';
    s.stepUp = (s.tenants.find((t) => t.stepUp) || {}).stepUp || null;
    let pick = preferTenantId && s.tenants.some((t) => t.tenantId === preferTenantId) ? preferTenantId : '';
    if (!pick) {
      const candidates = slot === 'target' ? s.tenants.filter((t) => t.tenantId !== state.source.tenantId) : s.tenants;
      pick = candidates.length === 1 ? candidates[0].tenantId : (candidates.find((t) => t.isHome) || {}).tenantId || '';
    }
    s.tenantId = pick;
  } catch (err) { showError(err, 'Could not load tenants'); }
  s.loadingTenants = false;
  render();
  if (s.tenantId) await loadEnvironments(slot);
}

async function loadEnvironments(slot) {
  const s = slot === 'source' ? state.source : state.target;
  s.envs = []; s.envId = ''; s.loadingEnvs = true; render();
  try {
    s.envs = await api(`/api/${slot}/tenants/${s.tenantId}/environments`);
  } catch (err) { showError(err, 'Could not load environments'); }
  s.loadingEnvs = false;
  render();
}

async function loadSolutions() {
  const key = `${state.source.tenantId}|${state.source.envId}`;
  if (state.solutionsFor === key) return;
  state.loadingSolutions = true; state.solutions = []; render();
  try {
    state.solutions = await api(`/api/source/tenants/${state.source.tenantId}/environments/${state.source.envId}/solutions`);
    state.solutionsFor = key;
  } catch (err) { showError(err, 'Could not load solutions'); }
  state.loadingSolutions = false;
  render();
}

async function loadComponents() {
  if (state.componentsFor === state.solutionId) return;
  state.loadingComponents = true; state.components = []; render();
  try {
    state.components = await api(`/api/source/tenants/${state.source.tenantId}/environments/${state.source.envId}/solutions/${state.solutionId}/components`);
    state.componentsFor = state.solutionId;
    state.excluded = new Set(); // everything selected by default
    state.collapsed = new Set();
  } catch (err) { showError(err, 'Could not load solution components'); }
  state.loadingComponents = false;
  render();
}

function resetSolution() {
  Object.assign(state, { solutions: [], solutionsFor: null, solutionId: null, components: [], componentsFor: null, excluded: new Set() });
  state.rename = { enabled: false, uniqueName: '', displayName: '', uniqueTouched: false };
  state.cfg = newCfg();
  state.canvas = newCanvas();
  state.targetCheck = null;
  state.profile = null; // a different source/solution no longer matches the loaded profile
}

// --- navigation ------------------------------------------------------------------------------
function canEnter(step) {
  if (state.migration && state.migration.status === 'running') return step === STEP.MIGRATE;
  if (step === 0) return true;
  if (step >= 1 && !(state.source.envId && (pkgMode() || (state.target.envId && targetEnv())))) return false;
  if (step === STEP.CONFIG && pkgMode()) return false; // no target to connect to
  if (step >= 2 && !state.solutionId) return false;
  if (step >= 3 && (state.componentsFor !== state.solutionId || includedCount() === 0)) return false;
  if (step >= STEP.MIGRATE && !state.migration) return false;
  return true;
}

function go(step) {
  if (!canEnter(step)) return;
  state.view = 'wizard';
  state.step = step;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (step === STEP.SOLUTION) loadSolutions();
  if (step === STEP.COMPONENTS) loadComponents();
  if (step === STEP.CONFIG) loadConfiguration();
  if (step === STEP.OPTIONS) { runCanvasCheck(); if (!pkgMode()) runTargetCheck(true); }
}

function renderStepper() {
  const el = $('#stepper');
  const m = state.migration;
  const running = m && m.status === 'running';
  const action = running
    ? `<button type="button" class="btn btn-sm btn-danger" id="stopMig" ${m.stopRequested ? 'disabled' : ''}>${m.stopRequested ? '<span class="spinner"></span> Stopping…' : `■ ${btnLabels().stop}`}</button>`
    : `<button type="button" class="btn btn-sm" id="restartMig" title="Clear all selections and start again">↺ ${btnLabels().restart}</button>`;
  const labels = pkgMode() ? ['Source', 'Solution', 'Components', 'Connections & variables', 'Options & review', 'Create package'] : STEPS;
  el.innerHTML = `<div class="step-pills">${labels.map((label, i) => {
    const notNeeded = pkgMode() && i === STEP.CONFIG;
    const cls = notNeeded ? 'not-needed' : i === state.step ? 'active' : i < state.step ? 'done' : '';
    return `${i ? '<span class="step-sep"></span>' : ''}<button type="button" class="step-pill ${cls}" data-step="${i}" ${canEnter(i) ? '' : 'disabled'} ${i === state.step ? 'aria-current="step"' : ''} ${notNeeded ? 'title="Not needed for a package only: there is no target to connect to"' : ''}>
      <span class="num">${notNeeded ? '–' : i < state.step ? '✓' : i + 1}</span><span class="txt">${esc(label)}</span></button>`;
  }).join('')}</div><div class="stepper-actions">${action}</div>`;
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => go(+b.dataset.step)));
  const r = document.getElementById('restartMig');
  if (r) r.addEventListener('click', restartWizard);
  const s = document.getElementById('stopMig');
  if (s) s.addEventListener('click', stopMigration);
}

// Button labels: packaging terms in Package only mode, migration terms otherwise.
function btnLabels(m = state.migration) {
  const pkg = m && (state.view !== 'wizard' || state.step === STEP.MIGRATE) ? Boolean(m.packageOnly) : pkgMode();
  return pkg
    ? { pkg, stop: 'Stop package creation', restart: 'Restart packaging', another: 'Create another package' }
    : { pkg, stop: 'Stop migration', restart: 'Restart migration', another: 'Migrate another solution' };
}

function hasSelections() {
  return Boolean(state.source.tenantId || state.source.envId || state.target.envId || state.solutionId || state.migration || state.profile);
}

async function restartWizard() {
  if (hasSelections() && !await confirmModal(btnLabels().pkg ? 'Restart packaging?' : 'Restart the migration?',
    'All selections are cleared: environments, solution, components, connections, variables and options. You stay signed in. Saved profiles and history are not affected.', 'Restart')) return;
  clearTimeout(state.pollTimer);
  clearTimeout(state.canvas.timer);
  state.migration = null;
  state.mode = 'same';
  resetSolution();
  state.options = { ...DEFAULT_OPTIONS };
  state.compSearch = ''; state.compType = ''; state.solutionSearch = '';
  Object.assign(state.source, side());
  Object.assign(state.target, side());
  state.view = 'wizard';
  state.step = STEP.CONNECT;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Selections cleared. Start again by choosing the source and target.');
  if (state.auth.source.signedIn) loadTenants('source');
}

async function stopMigration() {
  const m = state.migration;
  if (!m || m.status !== 'running') return;
  const importStep = m.steps.find((x) => x.key === 'import');
  const importing = importStep && importStep.status === 'running';
  const importDone = importStep && importStep.status === 'done';
  const text = m.packageOnly
    ? 'The run stops at the next safe point. No package is created, and the temporary copy in the source is removed.'
    : importing
    ? `The import into ${m.request.target.environment.name} is already running and can't be stopped safely (that could leave the target half-updated). The migration will stop right after the import finishes; the remaining steps are skipped.`
    : importDone
      ? 'The solution is already imported. The remaining steps (connections and variables, publishing, verification) will be skipped.'
      : `The migration stops at the next safe point. Nothing is imported into ${m.request.target.environment.name}, and the temporary copy in the source is removed.`;
  if (!await confirmModal(m.packageOnly ? 'Stop package creation?' : 'Stop the migration?', text, m.packageOnly ? 'Stop package creation' : 'Stop migration')) return;
  try {
    state.migration = await api(`/api/migrations/${m.id}/stop`, { method: 'POST', body: {} });
    renderStepper();
    if (state.view === 'wizard' && state.step === STEP.MIGRATE) render();
  } catch (err) {
    if (err.status === 409) { // it finished while the confirmation was open
      toast(m.packageOnly ? 'Package creation had already finished.' : 'The migration had already finished.');
      poll();
      return;
    }
    showError(err, m.packageOnly ? 'Could not stop package creation' : 'Could not stop the migration');
  }
}

function render() {
  if (document.body.classList.contains('locked') && typeof renderAccountGate === 'function') return renderAccountGate();
  renderNav();
  const main = $('#main');
  $('#stepper').hidden = state.view !== 'wizard';
  if (state.view === 'profiles') return renderProfiles(main);
  if (state.view === 'history') return renderHistory(main);
  if (state.view === 'run') return renderMigration(main, state.historyRun, { fromHistory: true });
  if (state.view === 'settings') return renderSettings(main);
  if (state.view === 'account') return renderAccount(main);
  renderStepper();
  const renderers = [renderConnect, renderSolutions, renderComponents, renderConfiguration, renderOptions, renderMigration];
  renderers[state.step](main);
}

function renderNav() {
  document.querySelectorAll('[data-view]').forEach((b) => {
    const active = b.dataset.view === state.view || (b.dataset.view === 'history' && state.view === 'run');
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

function showView(view) {
  if (view === 'wizard') { state.view = 'wizard'; render(); return; }
  state.view = view;
  render();
  if (view === 'profiles') loadProfiles();
  if (view === 'history') loadHistory();
  if (view === 'settings') loadSettings();
  if (view === 'account') loadAccountPage();
}

// --- step 1: source & target ---------------------------------------------------------------
function renderConnect(main) {
  const srcEnv = findEnv(state.source);
  main.innerHTML = `
    <div class="page-head"><div><h2>${pkgMode() ? 'Where is the solution exported from?' : 'Where are you migrating from and to?'}</h2>
      <p>${pkgMode() ? 'Package only: pick the source tenant and environment. Nothing is imported.' : 'Choose the migration type, then pick the tenant and environment on each side.'}</p></div></div>

    <div class="segmented segmented-3" role="radiogroup" aria-label="Migration type">
      ${modeChoice('package', 'Package only (Download)', 'Create the solution file (filtered and renamed) for download, without importing it. For audits or manual deployment.')}
      ${modeChoice('same', 'Same tenant', 'Move a solution between two environments of one tenant (e.g. Dev → Test). One sign-in.')}
      ${modeChoice('cross', 'Cross tenant', 'Move a solution to an environment in another tenant. Sign in to each tenant separately.')}
    </div>

    <div class="grid-2 equal-cards" id="connectGrid" style="margin-top:16px">
      <section class="card" id="sourceCard">${sideCard('source')}</section>
      <section class="card" id="targetCard">${pkgMode() ? packageOnlyCard() : sideCard('target')}</section>
    </div>

    <div class="footer-bar">
      <span class="muted small">${pkgMode() ? (srcEnv ? `${esc(srcEnv.name)} → solution package (.zip)` : 'Select the source environment to continue.') : srcEnv && targetEnv() ? `${esc(srcEnv.name)} → ${esc(targetEnv().name)}` : 'Select both environments to continue.'}</span>
      <button class="btn btn-primary" id="next" ${canEnter(1) ? '' : 'disabled'}>Next: choose solution</button>
    </div>`;

  main.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
  $('#next').addEventListener('click', () => go(1));
  wireSide('source');
  if (!pkgMode()) wireSide('target');
}

function packageOnlyCard() {
  return `<h3>Output <span class="badge badge-accent">Package only</span></h3>
    <p class="card-sub">No target environment: nothing is imported anywhere</p>
    <div class="pkg-card-body">
      <div class="pkg-out"><div class="pkg-icon" aria-hidden="true">⬇</div><div><b>Solution package (.zip)</b>
        <div class="muted small">Ready to download when the run finishes. It is also kept in History.</div></div></div>
      <ul class="recs small pkg-notes">
        <li>Only the components you leave selected are included; your source solution is not changed.</li>
        <li>Optionally give the solution a new name; the package then imports under that name.</li>
        <li>Import it later in Power Apps (Solutions › Import solution), or hand it to the team that deploys it.</li>
      </ul>
    </div>`;
}

function modeChoice(value, title, desc) {
  const sel = state.mode === value;
  return `<label class="choice ${sel ? 'selected' : ''}"><input type="radio" name="mode" value="${value}" ${sel ? 'checked' : ''}>
    <span><strong>${title}</strong><span class="muted">${desc}</span></span></label>`;
}

function setMode(mode) {
  if (state.mode === mode) return;
  const wasPkg = state.mode === 'package';
  state.mode = mode;
  Object.assign(state.target, side());
  state.targetCheck = null;
  if (wasPkg || mode === 'package') state.cfg = newCfg();
  render();
  if (mode === 'cross' && state.auth.target.signedIn) loadTenants('target');
}

function sideCard(which) {
  const isTarget = which === 'target';
  const slot = isTarget ? targetSlot() : 'source';
  const s = state[which];
  const shared = isTarget && state.mode === 'same';
  const account = state.auth[slot];
  const title = isTarget ? 'Target' : 'Source';
  const sub = isTarget ? 'Where the solution will be imported' : 'Where the solution is exported from';

  let accountHtml;
  if (shared) {
    accountHtml = `<div class="notice"><span>Same tenant migration uses the <b>source</b> connection${account.signedIn ? ` (${esc(account.account.username)})` : ''}.</span></div>`;
  } else if (!account.signedIn) {
    accountHtml = `<div class="account"><div class="avatar" style="background:var(--border-strong)">?</div><div class="who"><div><b>Not signed in</b></div><div class="muted small">Sign in with a work account that can manage solutions${isTarget ? ' in the target tenant' : ''}.</div></div>
      <button class="btn btn-primary btn-sm" data-act="signin" ${state.config.configured ? '' : 'disabled'}>${state.config.mockMode ? 'Sign in (demo account)' : 'Sign in'}</button></div>`;
  } else {
    accountHtml = `<div class="account"><div class="avatar">${esc(initials(account.account.name))}</div><div class="who"><div><b>${esc(account.account.name)}</b></div><div class="muted small">${esc(account.account.username)}</div></div>
      <button class="btn btn-ghost btn-sm" data-act="signout">Sign out</button></div>`;
  }

  // Tenant selection
  let tenantHtml;
  if (shared) {
    const t = findTenant(state.source);
    tenantHtml = `<select class="input" disabled><option>${t ? esc(t.displayName) : '— select source tenant —'}</option></select>`;
  } else {
    const tenants = isTarget ? s.tenants.filter((t) => t.tenantId !== state.source.tenantId) : s.tenants;
    const signedIn = account.signedIn;
    tenantHtml = `<select class="input" data-act="tenant" ${signedIn && !s.loadingTenants ? '' : 'disabled'}>
        <option value="">${s.loadingTenants ? 'Loading tenants…' : signedIn ? '— select tenant —' : 'Sign in first'}</option>
        ${tenants.map((t) => `<option value="${esc(t.tenantId)}" ${t.tenantId === s.tenantId ? 'selected' : ''}>${esc(t.displayName)}${t.defaultDomain ? ` (${esc(t.defaultDomain)})` : ''}</option>`).join('')}
      </select>
      ${isTarget && s.tenants.length && !tenants.length ? '<div class="hint error">This account only has access to the source tenant. Sign in with an account from the target tenant, or add the tenant manually.</div>' : ''}
      ${s.tenantNote ? `<div class="hint">${esc(s.tenantNote)}${s.stepUp ? ' <button class="link-btn" data-act="stepup">Verify with MFA to list all tenants</button>' : ''}</div>` : ''}
      ${signedIn ? (s.addingTenant
        ? `<div class="row" style="margin-top:6px"><input class="input" data-act="tenant-q" placeholder="Tenant ID or domain, e.g. fabrikam.onmicrosoft.com" style="flex:1"><button class="btn btn-sm" data-act="tenant-add">Add</button><button class="btn btn-ghost btn-sm" data-act="tenant-cancel">Cancel</button></div>`
        : '<div class="hint"><button class="link-btn" data-act="tenant-new">+ Add a tenant by ID or domain</button></div>') : ''}`;
  }

  // Environment selection
  const envs = isTarget ? targetEnvs() : s.envs;
  const loadingEnvs = shared ? state.source.loadingEnvs : s.loadingEnvs;
  const tenantChosen = shared ? state.source.tenantId : s.tenantId;
  const env = isTarget ? targetEnv() : findEnv(s);
  const envHtml = `<select class="input" data-act="env" ${tenantChosen && !loadingEnvs && envs.length ? '' : 'disabled'}>
      <option value="">${loadingEnvs ? 'Loading environments…' : !tenantChosen ? 'Select a tenant first' : envs.length ? '— select environment —' : 'No Dataverse environments found'}</option>
      ${envs.map((e) => `<option value="${esc(e.id)}" ${env && e.id === env.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
    </select>
    ${env ? `<div class="hint mono">${esc(env.url)}${env.region ? ` · ${esc(env.region)}` : ''}</div>` : ''}`;

  return `<h3>${title} ${isTarget && state.mode === 'cross' ? '<span class="badge badge-accent">Cross tenant</span>' : ''}</h3>
    <p class="card-sub">${sub}</p>
    <div class="stack">
      <div class="field account-field"><span>User / Service Account</span>${accountHtml}</div>
      <label class="field"><span>Tenant</span>${tenantHtml}</label>
      <label class="field"><span>Environment</span>${envHtml}</label>
    </div>`;
}

function wireSide(which) {
  const card = $(`#${which}Card`);
  const isTarget = which === 'target';
  const slot = isTarget ? targetSlot() : 'source';
  const s = state[which];
  const on = (act, ev, fn) => { const el = card.querySelector(`[data-act="${act}"]`); if (el) el.addEventListener(ev, fn); };

  on('signin', 'click', () => signIn(slot));
  on('signout', 'click', () => signOut(slot));
  on('stepup', 'click', () => signIn(slot, s.stepUp.tenantId, s.stepUp.scope));
  on('tenant', 'change', (e) => {
    s.tenantId = e.target.value;
    if (!isTarget) {
      resetSolution();
      if (state.mode === 'same') Object.assign(state.target, side());
      else if (state.target.tenantId === s.tenantId) Object.assign(state.target, { tenantId: '', envs: [], envId: '' });
    }
    s.envs = []; s.envId = '';
    render();
    if (s.tenantId) loadEnvironments(slot);
  });
  on('env', 'change', (e) => {
    if (isTarget) state.target.envId = e.target.value;
    else {
      s.envId = e.target.value;
      resetSolution();
      if (state.mode === 'same' && state.target.envId === s.envId) state.target.envId = '';
    }
    render();
  });
  on('tenant-new', 'click', () => { s.addingTenant = true; render(); $(`#${which}Card [data-act="tenant-q"]`).focus(); });
  on('tenant-cancel', 'click', () => { s.addingTenant = false; render(); });
  const add = async () => {
    const q = card.querySelector('[data-act="tenant-q"]').value.trim();
    try {
      const t = await api(`/api/tenants/resolve?q=${encodeURIComponent(q)}`);
      if (isTarget && t.tenantId === state.source.tenantId) throw new Error('That is the source tenant. For a migration inside one tenant, choose "Same tenant".');
      s.tenants = await api(`/api/${slot}/tenants`, { method: 'POST', body: t });
      s.tenantId = t.tenantId;
      s.addingTenant = false;
      render();
      await loadEnvironments(slot);
    } catch (err) { showError(err, 'Could not add tenant'); }
  };
  on('tenant-add', 'click', add);
  on('tenant-q', 'keydown', (e) => { if (e.key === 'Enter') add(); });
}

// --- step 2: solution ------------------------------------------------------------------------
function renderSolutions(main) {
  const env = findEnv(state.source);
  main.innerHTML = `
    <div class="page-head"><div><h2>Select a solution</h2><p>Solutions in <b>${esc(env && env.name)}</b>. Only unmanaged solutions can be exported.</p></div>
      <button class="btn btn-sm" id="refresh">Refresh</button></div>
    <div class="toolbar"><input class="input" id="solSearch" type="search" placeholder="Search solutions" value="${esc(state.solutionSearch)}" aria-label="Search solutions">
      <select class="input sol-type" id="solType" aria-label="Filter by solution type">
        ${[['all', 'All Solutions'], ['managed', 'Managed'], ['unmanaged', 'Unmanaged']].map(([v, l]) => `<option value="${v}" ${(state.solutionType || 'all') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    <div class="list" id="solList"></div>
    <div class="footer-bar">
      <button class="btn" id="back">Back</button>
      <button class="btn btn-primary" id="next" ${state.solutionId ? '' : 'disabled'}>Next: choose components</button>
    </div>`;
  renderSolutionList();
  $('#solSearch').addEventListener('input', (e) => { state.solutionSearch = e.target.value; renderSolutionList(); });
  $('#solType').addEventListener('change', (e) => { state.solutionType = e.target.value; renderSolutionList(); });
  $('#refresh').addEventListener('click', () => { state.solutionsFor = null; loadSolutions(); });
  $('#back').addEventListener('click', () => go(0));
  $('#next').addEventListener('click', () => go(2));
}

function renderSolutionList() {
  const list = $('#solList');
  if (state.loadingSolutions) { list.innerHTML = '<div class="empty"><span class="spinner"></span> Loading solutions…</div>'; return; }
  const q = state.solutionSearch.toLowerCase();
  const type = state.solutionType || 'all';
  const rows = state.solutions.filter((s) => (type === 'all' || (type === 'managed') === Boolean(s.isManaged))
    && (!q || `${s.displayName} ${s.uniqueName} ${s.publisher && s.publisher.displayName}`.toLowerCase().includes(q)));
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${!state.solutions.length ? 'No solutions found in this environment.'
      : q ? 'No solutions match your search and filter.' : `No ${type} solutions in this environment.`}</div>`;
    return;
  }
  list.innerHTML = rows.map((s) => `
    <div class="list-row ${s.id === state.solutionId ? 'selected' : ''} ${s.isManaged ? 'disabled' : ''}" data-id="${esc(s.id)}" role="radio" aria-checked="${s.id === state.solutionId}" aria-disabled="${s.isManaged}" tabindex="${s.isManaged ? -1 : 0}" title="${s.isManaged ? 'Managed solutions cannot be exported' : ''}">
      <input type="radio" name="sol" ${s.id === state.solutionId ? 'checked' : ''} ${s.isManaged ? 'disabled' : ''} tabindex="-1" aria-hidden="true">
      <div class="main"><div class="title">${esc(s.displayName)}</div><div class="muted small mono">${esc(s.uniqueName)}</div>
        ${s.description ? `<div class="muted small">${esc(s.description)}</div>` : ''}</div>
      <div class="meta">
        <span class="badge">v${esc(s.version)}</span>
        ${s.publisher && s.publisher.displayName ? `<span class="badge">${esc(s.publisher.displayName)}</span>` : ''}
        ${s.isManaged ? '<span class="badge badge-warn">Managed</span>' : '<span class="badge badge-ok">Unmanaged</span>'}
      </div>
    </div>`).join('');
  list.querySelectorAll('.list-row:not(.disabled)').forEach((row) => {
    const pick = () => {
      if (state.solutionId !== row.dataset.id) {
        state.solutionId = row.dataset.id;
        state.profile = null;
        state.cfg = newCfg();
        state.componentsFor = null;
        state.rename = { enabled: false, uniqueName: '', displayName: '', uniqueTouched: false };
      }
      renderSolutionList();
      $('#next').disabled = false;
      renderStepper();
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); } });
  });
}

// --- step 3: components ----------------------------------------------------------------------
function includedCount() { return state.components.filter((c) => !state.excluded.has(c.id)).length; }

function componentTree() {
  const byId = new Map(state.components.map((c) => [c.id, c]));
  const children = new Map();
  const roots = [];
  for (const c of state.components) {
    if (c.parentId && byId.has(c.parentId)) {
      if (!children.has(c.parentId)) children.set(c.parentId, []);
      children.get(c.parentId).push(c);
    } else roots.push(c);
  }
  const groups = new Map();
  for (const r of roots) {
    if (!groups.has(r.typeName)) groups.set(r.typeName, []);
    groups.get(r.typeName).push(r);
  }
  const byName = (a, b) => String(a.displayName).localeCompare(String(b.displayName));
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, items]) => ({
    type, items: items.sort(byName).map((r) => ({ ...r, children: (children.get(r.id) || []).sort(byName) })),
  }));
}

function renderComponents(main) {
  const sol = selectedSolution();
  const types = [...new Set(state.components.map((c) => c.typeName))].sort();
  main.innerHTML = `
    <div class="page-head"><div><h2>Choose components</h2><p>All components of <b>${esc(sol && sol.displayName)}</b> are selected. Uncheck anything you don't want to migrate.</p></div>
      <span class="badge badge-accent" id="compCount"></span></div>
    <div class="toolbar">
      <input class="input" id="compSearch" type="search" placeholder="Search components" value="${esc(state.compSearch)}" aria-label="Search components">
      <select class="input" id="compType" aria-label="Filter by type"><option value="">All types</option>${types.map((t) => `<option ${t === state.compType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="selAll">Select all</button>
      <button class="btn btn-sm" id="selNone">Clear all</button>
    </div>
    <div id="compNotice"></div>
    <div class="list" id="compList" style="margin-top:12px"></div>
    <div class="footer-bar">
      <button class="btn" id="back">Back</button>
      <button class="btn btn-primary" id="next">${pkgMode() ? 'Next: options & review' : 'Next: connections & variables'}</button>
    </div>`;
  renderComponentList();
  $('#compSearch').addEventListener('input', (e) => { state.compSearch = e.target.value; renderComponentList(); });
  $('#compType').addEventListener('change', (e) => { state.compType = e.target.value; renderComponentList(); });
  $('#selAll').addEventListener('click', () => { state.excluded.clear(); renderComponentList(); });
  $('#selNone').addEventListener('click', () => { state.excluded = new Set(state.components.map((c) => c.id)); renderComponentList(); });
  $('#back').addEventListener('click', () => go(STEP.SOLUTION));
  $('#next').addEventListener('click', () => go(pkgMode() ? STEP.OPTIONS : STEP.CONFIG));
}

function renderComponentList() {
  const list = $('#compList');
  const inc = includedCount();
  const total = state.components.length;
  const exc = total - inc;
  $('#compCount').textContent = state.loadingComponents ? 'Loading…' : `${inc} of ${total} selected`;
  $('#next').disabled = state.loadingComponents || inc === 0;
  $('#compNotice').innerHTML = exc && !state.loadingComponents
    ? `<div class="notice warn"><span><b>${exc} component${exc > 1 ? 's' : ''} excluded.</b> During migration a temporary solution containing only the selected components is created in the source environment, exported and then deleted. The original solution is not changed. Excluding a component that others depend on can make the import fail.</span></div>`
    : '';
  renderStepper();

  if (state.loadingComponents) { list.innerHTML = '<div class="empty"><span class="spinner"></span> Loading components…</div>'; return; }
  if (!total) { list.innerHTML = '<div class="empty">This solution has no components.</div>'; return; }

  const q = state.compSearch.toLowerCase();
  const match = (c) => (!q || `${c.displayName} ${c.name} ${c.typeName}`.toLowerCase().includes(q));
  let html = '';
  for (const g of componentTree()) {
    if (state.compType && g.type !== state.compType) continue;
    const visible = g.items.filter((r) => match(r) || r.children.some(match));
    if (!visible.length) continue;
    const all = g.items.flatMap((r) => [r, ...r.children]);
    const nInc = all.filter((c) => !state.excluded.has(c.id)).length;
    const collapsed = state.collapsed.has(g.type) && !q;
    html += `<div class="group-head ${collapsed ? 'collapsed' : ''}" data-group="${esc(g.type)}">
      <input type="checkbox" data-gcheck="${esc(g.type)}" ${nInc === all.length ? 'checked' : ''} aria-label="Select all ${esc(g.type)}">
      <svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
      <span>${esc(g.type)}</span><span class="badge">${nInc}/${all.length}</span></div>`;
    if (collapsed) continue;
    for (const r of visible) {
      html += compRow(r, false);
      for (const ch of r.children) if (match(ch) || match(r)) html += compRow(ch, true);
    }
  }
  list.innerHTML = html || '<div class="empty">No components match your filter.</div>';

  list.querySelectorAll('[data-gcheck]').forEach((cb) => {
    const g = componentTree().find((x) => x.type === cb.dataset.gcheck);
    const all = g.items.flatMap((r) => [r, ...r.children]);
    const nInc = all.filter((c) => !state.excluded.has(c.id)).length;
    cb.indeterminate = nInc > 0 && nInc < all.length;
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (nInc === all.length) all.forEach((c) => state.excluded.add(c.id));
      else all.forEach((c) => state.excluded.delete(c.id));
      renderComponentList();
    });
  });
  list.querySelectorAll('.group-head').forEach((h) => h.addEventListener('click', () => {
    const t = h.dataset.group;
    if (state.collapsed.has(t)) state.collapsed.delete(t); else state.collapsed.add(t);
    renderComponentList();
  }));
  list.querySelectorAll('.comp-row').forEach((row) => {
    const toggle = () => { toggleComponent(row.dataset.id); renderComponentList(); };
    row.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') toggle(); });
    row.querySelector('input').addEventListener('change', toggle);
  });
}

function compRow(c, isChild) {
  const inc = !state.excluded.has(c.id);
  const behaviour = c.componentType === 1 && c.rootComponentBehavior === 0 ? '<span class="badge">All subcomponents</span>' : '';
  return `<label class="comp-row ${isChild ? 'child' : ''} ${inc ? '' : 'excluded'}" data-id="${esc(c.id)}">
    <input type="checkbox" ${inc ? 'checked' : ''} aria-label="Include ${esc(c.displayName)}">
    <span class="comp-name"><div>${esc(c.displayName)}</div>${c.name && c.name !== c.displayName ? `<div class="muted small mono">${esc(c.name)}</div>` : ''}</span>
    ${behaviour}${isChild ? `<span class="badge">${esc(c.typeName)}</span>` : ''}
  </label>`;
}

function toggleComponent(id) {
  const c = state.components.find((x) => x.id === id);
  if (!c) return;
  if (state.excluded.has(id)) {
    state.excluded.delete(id);
    if (c.parentId) state.excluded.delete(c.parentId); // a subcomponent needs its parent
  } else {
    state.excluded.add(id);
    state.components.filter((x) => x.parentId === id).forEach((x) => state.excluded.add(x.id));
  }
}

// --- step 4: options & review ----------------------------------------------------------------
function suggestUniqueName(display) {
  let base = display.replace(/[^A-Za-z0-9_]/g, '');
  if (!base) return '';
  if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
  return base.slice(0, 65);
}

function renameError() {
  const r = state.rename;
  if (!r.enabled) return '';
  if (!r.displayName.trim()) return 'Enter a display name.';
  if (!r.uniqueName) return 'Enter a unique name.';
  if (!NAME_RE.test(r.uniqueName)) return 'Use letters, digits and underscores only; start with a letter or underscore (max 65).';
  return '';
}

function renderOptions(main) {
  const sol = selectedSolution();
  const r = state.rename;
  const o = state.options;
  const err = renameError();
  const inc = includedCount();
  const total = state.components.length;
  const srcT = findTenant(state.source);
  const pkg = pkgMode();
  const tgtT = pkg ? null : state.mode === 'same' ? srcT : findTenant(state.target);
  const finalName = r.enabled ? (r.displayName || r.uniqueName || '—') : sol.displayName;
  const finalUnique = r.enabled ? (r.uniqueName || '—') : sol.uniqueName;

  main.innerHTML = `
    <div class="page-head"><div><h2>Options & review</h2><p>${pkg ? 'Decide how the package should be built, then create it.' : 'Decide how the solution should land in the target, then start the migration.'}</p></div></div>
    <div class="grid-2">
      <div class="stack">
        <section class="card">
          <h3>${pkg ? 'Solution name in the package' : 'Solution name in the target'}</h3>
          <p class="card-sub">${pkg ? 'Keep the original name, or rename the solution inside the package. It then imports under the new name.' : 'Keep the original name, or create the solution under a different name at the new location.'}</p>
          <div class="segmented" role="radiogroup">
            <label class="choice ${!r.enabled ? 'selected' : ''}"><input type="radio" name="rename" value="keep" ${!r.enabled ? 'checked' : ''}>
              <span><strong>Keep original name</strong><span class="muted mono">${esc(sol.uniqueName)}</span></span></label>
            <label class="choice ${r.enabled ? 'selected' : ''}"><input type="radio" name="rename" value="new" ${r.enabled ? 'checked' : ''}>
              <span><strong>Use a different name</strong><span class="muted">${pkg ? 'Renames the solution in the package' : 'Creates a new solution in the target'}</span></span></label>
          </div>
          <div class="stack name-fields" style="margin-top:14px">
            <label class="field"><span>Display name</span><input class="input ${r.enabled ? '' : 'readonly-field'}" id="rnDisplay" value="${esc(r.enabled ? r.displayName : sol.displayName)}" placeholder="e.g. ${esc(sol.displayName)} Fabrikam" maxlength="200" ${r.enabled ? '' : 'readonly title="Click to change the name"'}></label>
            <label class="field"><span>Unique name</span><input class="input mono ${r.enabled ? (err && r.uniqueName ? 'invalid' : '') : 'readonly-field'}" id="rnUnique" value="${esc(r.enabled ? r.uniqueName : sol.uniqueName)}" placeholder="e.g. ${esc(sol.uniqueName)}Fabrikam" maxlength="65" spellcheck="false" ${r.enabled ? '' : 'readonly title="Click to change the name"'}>
              <div class="hint ${r.enabled && err ? 'error' : ''}" id="rnHint">${esc(nameHint())}</div></label>
          </div>
          ${pkg ? '' : targetCheckCard()}
        </section>

        <section class="card">
          <h3>Package type</h3>
          <p class="card-sub">Managed is recommended for test and production environments.${pkg ? ' The person who imports the package cannot change this.' : ''}</p>
          <div class="segmented" role="radiogroup">
            <label class="choice ${!o.managed ? 'selected' : ''}"><input type="radio" name="pkg" value="unmanaged" ${!o.managed ? 'checked' : ''}><span><strong>Unmanaged</strong><span class="muted">Editable in the target</span></span></label>
            <label class="choice ${o.managed ? 'selected' : ''}"><input type="radio" name="pkg" value="managed" ${o.managed ? 'checked' : ''}><span><strong>Managed</strong><span class="muted">Locked; supports clean uninstall</span></span></label>
          </div>
        </section>

        <section class="card">
          <h3>${pkg ? 'Export options' : 'Export & import options'}</h3>
          ${optCheck('includeMissingDependencies', 'Include missing required components', 'Adds components the solution needs but doesn\'t contain, such as connection references and child flows, to the migrated copy. Your source solution isn\'t changed.')}
          ${optCheck('publishBeforeExport', 'Publish all customizations before export', 'Makes sure the latest changes in the source are included.')}
          ${pkg ? '<p class="muted small" style="margin:8px 0 0">Import options (overwrite customizations, activate flows, publish) are chosen by whoever imports the package.</p>' : `${optCheck('overwriteUnmanagedCustomizations', 'Overwrite unmanaged customizations', 'Replaces unmanaged changes in the target with the incoming version.')}
          ${optCheck('publishWorkflows', 'Activate processes and flows', 'Turns on classic workflows, plug-in steps and cloud flows after import.')}
          ${o.managed ? '' : optCheck('publishAfterImport', 'Publish all customizations after import', 'Required for unmanaged changes to become visible to users.')}`}
        </section>
      </div>

      <section class="card" style="align-self:start">
        <h3>Review</h3>
        <p class="card-sub">${pkg ? 'Package only: export and download, no import' : state.mode === 'cross' ? 'Cross-tenant migration' : 'Same-tenant migration'}</p>
        <div class="flow">
          <div class="end"><div class="lbl">From</div><div class="env">${esc(findEnv(state.source).name)}</div><div class="muted small">${esc(srcT && srcT.displayName)}</div></div>
          <div class="arrow" aria-hidden="true">→</div>
          ${pkg ? `<div class="end"><div class="lbl">To</div><div class="env">Solution package</div><div class="muted small mono file-name" id="rvFile" title="${esc(packageFileName())}">${breakableName(packageFileName())}</div></div>`
    : `<div class="end"><div class="lbl">To</div><div class="env">${esc(targetEnv().name)}</div><div class="muted small">${esc(tgtT && tgtT.displayName)}</div></div>`}
        </div>
        <dl class="kv" style="margin:16px 0">
          <dt>Solution</dt><dd>${esc(sol.displayName)} <span class="muted">v${esc(sol.version)}</span></dd>
          <dt>${pkg ? 'Named as' : 'Created as'}</dt><dd><span id="rvName">${esc(finalName)}</span><div class="muted small mono" id="rvUnique">${esc(finalUnique)}</div></dd>
          <dt>Components</dt><dd>${inc} of ${total} ${inc < total ? `<span class="badge badge-warn">${total - inc} excluded</span>` : '<span class="badge badge-ok">all</span>'}</dd>
          <dt>Package</dt><dd>${o.managed ? 'Managed' : 'Unmanaged'}</dd>
          ${pkg ? '<dt>Import</dt><dd>None: the package is only downloaded</dd>' : `<dt>Connections</dt><dd>${esc(configReviewText())}</dd>`}
          ${state.profile ? `<dt>Profile</dt><dd><span class="badge badge-accent">${esc(state.profile.name)}</span></dd>` : ''}
        </dl>
        ${canvasCheckCard()}
        ${state.mode === 'cross' ? '<div class="notice" style="margin-bottom:12px"><span>After a cross-tenant move you will need to create connections for connection references, set environment variable values and share apps with target users. The summary lists what applies.</span></div>' : ''}
        ${pkg ? '<div class="notice" style="margin-bottom:12px"><span>Connection references and environment variable values are set by whoever imports the package. The summary lists what they will need.</span></div>' : ''}
        <button class="btn btn-primary" id="start" style="width:100%" ${startBlocked() ? 'disabled' : ''}>${startLabel()}</button>
        <div class="row" style="margin-top:10px;justify-content:center">
          ${state.profile ? `<button class="btn btn-sm" id="saveProfile">Update profile</button><button class="btn btn-sm btn-ghost" id="saveProfileNew">Save as new profile</button>` : '<button class="btn btn-sm" id="saveProfileNew">Save as profile</button>'}
          <button class="btn btn-sm" data-report title="Download a PDF report of the current selections and checks">⬇ Download report (PDF)</button>
        </div>
      </section>
    </div>
    <div class="footer-bar"><button class="btn" id="back">Back</button></div>`;

  main.querySelectorAll('input[name=rename]').forEach((x) => x.addEventListener('change', () => {
    if (x.value === 'new') switchToRename('rnDisplay');
    else { r.enabled = false; render(); } // the fields show the original names again; typed values are kept for later
  }));
  if (!r.enabled) {
    // Clicking a read-only name field switches to "Use a different name" and makes it editable.
    ['rnDisplay', 'rnUnique'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); switchToRename(id); });
      el.addEventListener('keydown', (e) => { if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') { e.preventDefault(); switchToRename(id); } });
    });
  }
  main.querySelectorAll('input[name=pkg]').forEach((x) => x.addEventListener('change', () => { o.managed = x.value === 'managed'; render(); }));
  main.querySelectorAll('[data-opt]').forEach((x) => x.addEventListener('change', () => { o[x.dataset.opt] = x.checked; }));
  if (r.enabled) {
    const updateRenameUi = () => {
      const e = renameError();
      $('#rnHint').textContent = nameHint();
      $('#rnHint').classList.toggle('error', Boolean(e));
      $('#rnUnique').classList.toggle('invalid', Boolean(e) && Boolean(r.uniqueName));
      $('#start').disabled = startBlocked();
      if (!pkg) scheduleTargetCheck();
      else { const fn = document.getElementById('rvFile'); if (fn) { fn.innerHTML = breakableName(packageFileName()); fn.title = packageFileName(); } }
      $('#rvName').textContent = r.displayName || r.uniqueName || '—';
      $('#rvUnique').textContent = r.uniqueName || '—';
    };
    $('#rnDisplay').addEventListener('input', (e) => {
      r.displayName = e.target.value;
      if (!r.uniqueTouched) { r.uniqueName = suggestUniqueName(r.displayName); $('#rnUnique').value = r.uniqueName; }
      updateRenameUi();
    });
    $('#rnUnique').addEventListener('input', (e) => { r.uniqueName = e.target.value.trim(); r.uniqueTouched = true; updateRenameUi(); });
  }
  $('#back').addEventListener('click', () => go(pkg ? STEP.COMPONENTS : STEP.CONFIG));
  $('#start').addEventListener('click', startMigration);
  wireCanvasCheck();
  if (!pkg) {
    wireTargetCheck();
    runTargetCheck(); // name or package type may have changed
  }
  const sp = document.getElementById('saveProfile');
  if (sp) sp.addEventListener('click', () => saveProfile(false));
  $('#saveProfileNew').addEventListener('click', () => saveProfile(true));
  main.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => downloadReport(null, b)));
}

function nameHint() {
  if (!state.rename.enabled) return 'Original names (read-only). Click a field to change them; this switches to "Use a different name".';
  return renameError() || (state.rename.uniqueTouched
    ? 'Letters, digits and underscores. Components keep their publisher prefix.'
    : 'Filled in from the display name. You can edit it separately; letters, digits and underscores.');
}

// Switches to "Use a different name". Names typed earlier are kept; the first time, the original names are filled in.
function switchToRename(focusId) {
  const r = state.rename;
  const sol = selectedSolution();
  if (!r.displayName && !r.uniqueName && sol) { r.displayName = sol.displayName; r.uniqueName = sol.uniqueName; r.uniqueTouched = false; }
  r.enabled = true;
  render();
  const el = document.getElementById(focusId);
  if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* ignore */ } }
}

// Lets long file names wrap after "_" and "." without changing the name (copying it gives the exact text).
const breakableName = (name) => esc(name).replace(/([_.])/g, '$1<wbr>');

const startLabel = () => (pkgMode() ? 'Download Package' : 'Start migration');

// Same naming as the engine: <unique name>_<version>[_managed].zip
function packageFileName() {
  const sol = selectedSolution();
  if (!sol) return '';
  const name = state.rename.enabled ? (state.rename.uniqueName || sol.uniqueName) : sol.uniqueName;
  return `${name}_${String(sol.version).replace(/\./g, '_')}${state.options.managed ? '_managed' : ''}.zip`;
}

function optCheck(key, title, desc) {
  return `<label class="check"><input type="checkbox" data-opt="${key}" ${state.options[key] ? 'checked' : ''}><span><strong>${title}</strong><span class="muted small">${desc}</span></span></label>`;
}

// --- step 5: migration -----------------------------------------------------------------------
async function startMigration() {
  const btn = $('#start');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>&nbsp;Starting…';
  try {
    state.migration = await api('/api/migrations', {
      method: 'POST',
      body: {
        mode: pkgMode() ? 'package' : 'migrate',
        source: { slot: 'source', tenantId: state.source.tenantId, envId: state.source.envId, tenantName: (findTenant(state.source) || {}).displayName },
        target: pkgMode() ? null : { slot: targetSlot(), tenantId: targetTenantId(), envId: state.target.envId, tenantName: ((state.mode === 'same' ? findTenant(state.source) : findTenant(state.target)) || {}).displayName },
        solutionId: state.solutionId,
        excludedComponentIds: [...state.excluded],
        rename: state.rename.enabled ? { enabled: true, uniqueName: state.rename.uniqueName, displayName: state.rename.displayName.trim() } : { enabled: false },
        options: { ...state.options, acknowledgeUnverifiedCanvasApps: Boolean(state.canvas.ack), overrideCanvasCheck: Boolean(state.canvas.override), confirmUpdateExisting: Boolean(state.targetCheck && state.targetCheck.confirm) },
        configuration: pkgMode() ? { skipped: true, connectionReferences: [], environmentVariables: [] } : configurationPayload(),
        profile: state.profile,
      },
    });
    state.errorShownFor = null;
    state.targetCheck = null; // the target changes with this migration
    go(STEP.MIGRATE);
    poll();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = startLabel();
    showError(err, pkgMode() ? 'Could not create the package' : 'Could not start the migration');
  }
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.migration) return;
  try {
    state.migration = await api(`/api/migrations/${state.migration.id}`);
  } catch (err) {
    state.pollTimer = setTimeout(poll, 3000);
    return;
  }
  if (state.view === 'wizard' && state.step === STEP.MIGRATE) render();
  const m = state.migration;
  if (m.status === 'running') { state.pollTimer = setTimeout(poll, 1000); return; }
  renderStepper();
  if (m.status === 'failed' && state.errorShownFor !== m.id) {
    state.errorShownFor = m.id;
    showError({ ...m.error, importLogUrl: m.hasImportLog ? `/api/migrations/${m.id}/import-log` : null }, m.packageOnly ? 'Package could not be created' : 'Migration failed');
  }
  if (m.status === 'succeeded') toast(m.packageOnly ? 'Package ready to download' : 'Migration completed successfully');
  if (m.status === 'attention') toast(m.outcome === 'errors' ? 'Migration completed with errors' : 'Migration successful. Some items require configuration.');
  if (m.status === 'cancelled') toast(m.packageOnly ? 'Package creation stopped' : 'Migration stopped');
}

function renderMigration(main, m = state.migration, opts = {}) {
  if (!m) { main.innerHTML = '<div class="empty">No migration started.</div>'; return; }
  const running = m.status === 'running';
  const elapsed = (m.finishedAt ? Date.parse(m.finishedAt) : Date.now()) - Date.parse(m.startedAt);
  const progressCls = m.status === 'succeeded' ? 'ok' : m.status === 'failed' ? 'err' : m.status === 'cancelled' ? 'warn' : '';
  const plan = m.plan;
  const logOpen = document.querySelector('#logDetails') && document.querySelector('#logDetails').open;
  // Keep the live log where the user left it; follow new lines while it is scrolled to the bottom.
  const prevLog = document.getElementById('liveLog');
  const followLog = !prevLog || prevLog.scrollTop + prevLog.clientHeight >= prevLog.scrollHeight - 24;
  const prevLogTop = prevLog ? prevLog.scrollTop : 0;

  const stepsOpen = document.querySelector('#stepsDetails') && document.querySelector('#stepsDetails').open;
  const done = m.status === 'succeeded' || m.status === 'attention';
  const stepsList = `
      <ul class="steps" style="margin-top:12px">
        ${m.steps.map((s) => `<li class="${s.status}">
          <span class="icon">${s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : ''}</span>
          <div class="body"><div class="label">${esc(s.label)}</div>
            ${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''}
            ${s.status === 'running' && s.progress ? `<div class="progress thin"><div style="width:${s.progress}%"></div></div>` : ''}</div>
          <span class="time">${s.status === 'skipped' ? 'Skipped' : s.startedAt ? fmtDuration((s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.startedAt)) : ''}</span>
        </li>`).join('')}
      </ul>`;
  const logLines = m.logs.map((l) => `<div class="${l.level}">${esc(new Date(l.ts).toLocaleTimeString())}  ${esc(l.message)}</div>`).join('');
  const stepsAndLog = `${stepsList}
      <details id="logDetails" ${logOpen ? 'open' : ''} style="margin-top:8px"><summary>Activity log (${m.logs.length})</summary>
        <div class="log mono">${logLines}</div></details>`;
  if (done) {
    // The steps and log live under the "Total duration" tab of the summary.
    opts = { ...opts, stepsHtml: stepsAndLog, elapsed };
    return finishRender('');
  }
  const progressCard = `
    <section class="card">
      <div class="row" style="align-items:flex-end">
        <div><div class="muted small">${running ? (m.packageOnly ? 'Creating package' : 'Migration in progress') : m.status === 'succeeded' ? 'Completed' : 'Stopped'}</div>
          <div class="big-pct" id="pct">${m.progress}%</div></div>
        <span class="spacer"></span>
        <div class="muted small" style="text-align:right">${esc(m.request.source.environment.name)} → ${m.packageOnly ? 'solution package' : esc(m.request.target.environment.name)}<br>Elapsed ${fmtDuration(elapsed)}</div>
      </div>
      <div class="progress ${progressCls}" style="margin-top:10px" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.progress}"><div style="width:${m.progress}%"></div></div>
      ${plan ? `<p class="muted small" style="margin:10px 0 0">${esc(plan.solution.displayName)} v${esc(plan.solution.version)} → <b>${esc(plan.finalDisplayName)}</b> <span class="mono">(${esc(plan.finalUniqueName)})</span> · ${plan.componentCounts.included} of ${plan.componentCounts.total} components</p>` : ''}
      ${stepsList}
    </section>`;
  // Activity log in its own container beside the progress, always open and scrolling on its own.
  const logCard = `<section class="card log-card" aria-label="Activity log">
      <div class="log-card-head"><h3>Activity log</h3><span class="badge">${m.logs.length}</span>${running ? '<span class="live-dot" title="Updating live"></span>' : ''}</div>
      <div class="log mono" id="liveLog" tabindex="0">${logLines || '<div class="muted">Waiting for the first step…</div>'}</div>
    </section>`;
  return finishRender(`<div class="progress-layout">${progressCard}${logCard}</div>`);

  function finishRender(progressCardHtml) {

  let head = '';
  if (done) head = renderSummary(m, opts);
  else if (m.status === 'cancelled') {
    head = `<div class="hero warn"><div class="mark">■</div><div style="flex:1"><h2>${m.packageOnly ? 'Package creation stopped' : 'Migration stopped'}</h2><div>${esc(m.error.message)}</div></div></div>
      <div class="footer-bar" style="margin:12px 0 16px"><div class="row">
        ${m.hasImportLog ? `<a class="btn" href="/api/migrations/${m.id}/import-log">Download import log</a>` : ''}<button class="btn" data-report="run">⬇ Download report (PDF)</button></div>
        <div class="row">${opts.fromHistory ? '' : `<button class="btn" id="retry">Back to options</button><button class="btn btn-primary" id="restart2">${btnLabels(m).restart}</button>`}</div></div>`;
  } else if (m.status === 'failed' || m.status === 'interrupted') {
    head = `<div class="hero err"><div class="mark">!</div><div style="flex:1"><h2>${m.packageOnly ? 'Package could not be created' : 'Migration failed'}</h2><div>${esc(m.error.step)}: ${esc(m.error.message.length > 220 ? `${m.error.message.slice(0, 220)}…` : m.error.message)}</div></div>
      <button class="btn" id="showErr">View error</button></div>
      <div class="footer-bar" style="margin:12px 0 16px"><div class="row">
        ${m.hasImportLog ? `<a class="btn" href="/api/migrations/${m.id}/import-log">Download import log</a>` : ''}<button class="btn" data-report="run">⬇ Download report (PDF)</button></div>
        <div class="row">${opts.fromHistory ? '' : `<button class="btn" id="retry">Back to options</button><button class="btn btn-primary" id="newMig">${btnLabels(m).another}</button>`}</div></div>`;
  }

  main.innerHTML = `
    ${opts.fromHistory ? '<div style="margin-bottom:12px"><button class="btn btn-sm btn-ghost" id="backHistory">← Back to history</button></div>' : ''}
    <div class="page-head"><div><h2>${m.packageOnly ? (running ? 'Creating package…' : done ? 'Package summary' : 'Package result') : running ? 'Migrating…' : done ? 'Migration summary' : 'Migration result'}</h2>
      <p>${running ? 'You can keep this page open; progress updates automatically.' : `Started ${esc(new Date(m.startedAt).toLocaleString())}${m.startedBy ? ` by ${esc(m.startedBy)}` : ''}${m.profile ? ` · profile <b>${esc(m.profile.name)}</b>` : ''}`}</p></div>
      <div class="row page-head-actions">${done ? '<button type="button" class="btn btn-sm" data-report="run">⬇ Download report (PDF)</button>' : ''}
      ${opts.fromHistory ? '<button class="btn btn-sm" id="deleteRun">Delete from history</button>' : ''}</div></div>
    ${head}
    ${progressCardHtml}`;

  const liveLog = document.getElementById('liveLog');
  if (liveLog) liveLog.scrollTop = followLog ? liveLog.scrollHeight : prevLogTop;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('showErr', () => showError({ ...m.error, importLogUrl: m.hasImportLog ? `/api/migrations/${m.id}/import-log` : null }, m.packageOnly ? 'Package could not be created' : 'Migration failed'));
  on('retry', () => { state.migration = null; go(STEP.OPTIONS); });
  on('newMig', newMigration);
  on('newMig2', newMigration);
  on('restart2', restartWizard);
  on('gotoActions', () => { state.summaryTab = { id: m.id, tab: 'action' }; render(); });
  on('gotoImport', () => { state.summaryTab = { id: m.id, tab: 'import' }; render(); });
  document.querySelectorAll('.kpi-tab').forEach((b) => b.addEventListener('click', () => {
    state.summaryTab = { id: m.id, tab: b.dataset.tab };
    render();
  }));
  on('saveProfileSummary', () => saveProfile(true));
  document.querySelectorAll('[data-report="run"]').forEach((b) => b.addEventListener('click', () => downloadReport(m, b)));
  on('backHistory', () => showView('history'));
  on('deleteRun', async () => {
    if (!await confirmModal(m.packageOnly ? 'Delete this package run from history?' : 'Delete this migration from history?', m.packageOnly ? 'The record and its saved package are removed. The source solution is not affected.' : 'The record, its saved package and import log are removed. The solution in the target environment is not affected.', 'Delete')) return;
    try { await api(`/api/history/${m.id}`, { method: 'DELETE' }); toast('Deleted from history'); showView('history'); } catch (err) { showError(err, 'Could not delete'); }
  });
  }
}

function newMigration() {
  state.migration = null;
  state.profile = null;
  resetSolution();
  state.options = { ...DEFAULT_OPTIONS };
  state.compSearch = ''; state.compType = ''; state.solutionSearch = '';
  if (canEnter(STEP.SOLUTION)) go(STEP.SOLUTION); else go(STEP.CONNECT);
}

function renderSummary(m, opts = {}) {
  const s = m.summary;
  if (s.packageOnly) return renderPackageSummary(m, opts);
  const ir = s.importResults;
  const ar = s.actionRequired;
  const actions = ar ? ar.total : 0;
  // Failures = everything that went wrong (import, connections, variables, flows, verification).
  const failureItems = s.failureItems || (ir ? ir.issues.filter((i) => i.level === 'failure').map((i) => ({ source: 'Import', name: i.component, message: i.message })) : []);
  const warnings = ir ? ir.issues.filter((i) => i.level === 'warning') : [];
  const failures = failureItems.length;
  const added = (s.components.addedDependencies || []).length;
  const migrated = s.components.included + added;
  const outcome = s.outcome || (failures ? 'errors' : actions ? 'action' : 'ok');

  const tab = (state.summaryTab && state.summaryTab.id === m.id) ? state.summaryTab.tab : 'components';
  const kpi = (key, v, l, tone) => `<button type="button" class="kpi kpi-tab ${tone || ''} ${tab === key ? 'active' : ''}" data-tab="${key}" role="tab" aria-selected="${tab === key}">
      <div class="v">${v}</div><div class="l">${l}</div></button>`;

  const hero = outcome === 'ok'
    ? `<div class="hero ok"><div class="mark">✓</div><div style="flex:1"><h2>Migration successful: ${esc(s.targetSolution.displayName)} is in ${esc(s.target.environment)}</h2>
        <div>${esc(s.operation)} · v${esc(s.targetSolution.version)} · ${s.targetSolution.managed ? 'Managed' : 'Unmanaged'}${s.renamed ? ' · created with a new name' : ''} · verified in the target</div></div></div>`
    : outcome === 'action'
      ? `<div class="hero ok"><div class="mark">✓</div><div style="flex:1"><h2>Migration successful: ${esc(s.targetSolution.displayName)} is in ${esc(s.target.environment)}</h2>
        <div>${esc(s.operation)} · v${esc(s.targetSolution.version)} · ${s.targetSolution.managed ? 'Managed' : 'Unmanaged'}${s.renamed ? ' · created with a new name' : ''} · verified in the target</div></div></div>
        <div class="hero-note warn"><span class="ns-icon" aria-hidden="true">!</span><span><b>${actions} item(s) require configuration</b> in ${esc(s.target.environment)} before the solution works fully. <button type="button" class="link-btn" id="gotoActions">View Action required</button></span></div>`
      : `<div class="hero err"><div class="mark">!</div><div style="flex:1"><h2>Migration completed with errors</h2>
        <div>${esc(s.targetSolution.displayName)} was imported into ${esc(s.target.environment)}, but <b>${failures} problem(s)</b> occurred${actions ? ` and ${actions} item(s) need configuration` : ''}. See <b>Failures</b>.</div></div></div>`;

  let panel;
  if (tab === 'action') panel = renderActionRequired(s, m) || '<section class="card empty">Nothing to configure: all connections and variables are set.</section>';
  else if (tab === 'failures') panel = renderFailures(failureItems, warnings);
  else if (tab === 'duration') {
    panel = `<section class="card"><h3>Migration steps and activity log</h3>
      <p class="card-sub">${s.steps ? s.steps.filter((x) => x.status === 'done').length : ''} steps completed in ${fmtDuration(s.durationMs)}.</p>${opts.stepsHtml || ''}</section>`;
  } else panel = renderMigratedComponents(s, true);

  const details = detailsCard([
    `<dt>Type</dt><dd>${s.crossTenant ? 'Cross tenant' : 'Same tenant'}</dd>
     <dt>Source</dt><dd>${esc(s.source.environment)} <span class="muted">· ${esc(s.source.tenant)}</span><div class="muted small mono">${esc(s.source.url)}</div></dd>
     <dt>Target</dt><dd>${esc(s.target.environment)} <span class="muted">· ${esc(s.target.tenant)}</span><div class="muted small mono">${esc(s.target.url)}</div></dd>`,
    `<dt>Source solution</dt><dd>${esc(s.sourceSolution.displayName)} <span class="muted mono small">${esc(s.sourceSolution.uniqueName)}</span></dd>
     <dt>Target solution</dt><dd>${esc(s.targetSolution.displayName)} <span class="muted mono small">${esc(s.targetSolution.uniqueName)}</span></dd>
     ${s.verification ? `<dt>Verified</dt><dd>${s.verification.versionOk ? `Yes: v${esc(s.verification.version)} found in the target` : `<span style="color:var(--err)">Version mismatch: v${esc(s.verification.version)} in the target, v${esc(s.verification.expectedVersion)} expected</span>`}</dd>` : ''}
     <dt>Package</dt><dd>${fmtBytes(s.package.sizeBytes)}</dd>`,
  ], `${m.hasPackage ? `<a class="btn btn-sm btn-primary" href="/api/migrations/${m.id}/package">Download solution package</a>` : ''}
      ${m.hasImportLog ? `<a class="btn btn-sm" href="/api/migrations/${m.id}/import-log">Download import log</a>` : ''}`);

  return `
    ${hero}
    ${details}
    <div class="kpis" role="tablist" aria-label="Summary" style="margin:16px 0">
      ${kpi('components', migrated, 'Components migrated', 'tone-ok')}
      ${kpi('action', actions, 'Action required', actions ? 'tone-warn' : '')}
      ${kpi('failures', ir ? failures : '—', 'Failures', failures ? 'tone-err' : '')}
      ${kpi('duration', fmtDuration(s.durationMs), 'Total duration')}
    </div>
    <div class="summary-panel" role="tabpanel">${panel}</div>

    ${renderConfigResults(s.configuration)}
    ${renderPackageCanvasApps(s.package && s.package.canvasAppDetails)}

    ${s.recommendations.length ? `<section class="card" style="margin-bottom:16px"><h3>Good to know</h3><ul class="recs" style="margin-top:10px">${s.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}

    ${opts.fromHistory ? '' : `<div class="footer-bar" style="margin:0 0 16px"><span></span><div class="row">${state.profile ? '' : '<button class="btn" id="saveProfileSummary">Save as profile</button>'}<button class="btn btn-primary" id="newMig2">${btnLabels(m).another}</button></div></div>`}`;
}

// Details of a finished run, shown right below the result banners (two columns on wide screens).
function detailsCard(columns, buttons) {
  return `<section class="card details-card">
    <h3>Details</h3>
    <div class="details-grid">${columns.map((c) => `<dl class="kv">${c}</dl>`).join('')}</div>
    ${buttons && buttons.trim() ? `<div class="row" style="margin-top:14px">${buttons}</div>` : ''}
  </section>`;
}

function renderPackageSummary(m, opts) {
  const s = m.summary;
  const added = (s.components.addedDependencies || []).length;
  const tab = (state.summaryTab && state.summaryTab.id === m.id) ? state.summaryTab.tab : 'components';
  const prereq = s.prerequisites || [];
  const kpi = (key, v, l, tone) => `<button type="button" class="kpi kpi-tab ${tone || ''} ${tab === key ? 'active' : ''}" data-tab="${key}" role="tab" aria-selected="${tab === key}">
      <div class="v">${v}</div><div class="l">${l}</div></button>`;
  const inv = s.package || {};
  const importNeeds = [
    inv.connectionReferences ? ['Connection references', inv.connectionReferences, 'The importer picks or creates a connection for each one.'] : null,
    inv.environmentVariables ? ['Environment variables', inv.environmentVariables, 'The importer enters the values for the target.'] : null,
    inv.flows ? ['Cloud flows', inv.flows, 'Turned on after the import once their connections work.'] : null,
    inv.canvasApps ? ['Canvas apps', inv.canvasApps, 'Shared with the target users after the import.'] : null,
  ].filter(Boolean);
  let panel;
  if (tab === 'import') {
    panel = `<section class="card"><h3>What the importer needs (${importNeeds.length + prereq.length})</h3>
      <p class="card-sub">Hand these notes over together with the package.</p>
      ${prereq.length ? `<h4 class="sub-h">Prerequisites in the target environment</h4><table class="table small"><tbody>${prereq.map((p) => `<tr><td><span class="badge badge-warn">Prerequisite</span></td><td><b>${esc(p.displayName)}</b> <span class="muted small">· ${esc(p.typeName)}</span><div class="muted">${esc(p.message)}</div></td></tr>`).join('')}</tbody></table>` : ''}
      ${importNeeds.length ? `<table class="table small" style="margin-top:8px"><tbody>${importNeeds.map(([n, c, t]) => `<tr><td><b>${esc(n)}</b> <span class="badge">${c}</span><div class="muted">${esc(t)}</div></td></tr>`).join('')}</tbody></table>`
        : prereq.length ? '' : '<p class="muted">Nothing special: the package has no connection references, environment variables, flows or canvas apps.</p>'}
    </section>`;
  } else if (tab === 'duration') {
    panel = `<section class="card"><h3>Steps and activity log</h3>
      <p class="card-sub">${s.steps ? s.steps.filter((x) => x.status === 'done').length : ''} steps completed in ${fmtDuration(s.durationMs)}.</p>${opts.stepsHtml || ''}</section>`;
  } else panel = renderMigratedComponents(s, true, { title: 'Components in the package', badge: 'In package' });

  return `
    <div class="hero ok"><div class="mark">⬇</div><div style="flex:1"><h2>Package ready: ${esc(s.packageFile.name)}</h2>
      <div>${esc(s.targetSolution.displayName)} · v${esc(s.targetSolution.version)} · ${s.targetSolution.managed ? 'Managed' : 'Unmanaged'} · ${fmtBytes(s.packageFile.sizeBytes)}${s.renamed ? ' · renamed' : ''} · not imported anywhere</div></div>
      ${m.hasPackage ? `<a class="btn btn-primary" id="dlPackage" href="/api/migrations/${m.id}/package">Download package</a>` : '<span class="muted small">The package file is no longer kept.</span>'}</div>
    ${prereq.length ? `<div class="hero-note warn"><span class="ns-icon" aria-hidden="true">!</span><span><b>${prereq.length} prerequisite(s)</b> must already be installed where the package is imported. <button type="button" class="link-btn" id="gotoImport">View import notes</button></span></div>` : ''}
    ${detailsCard([
    `<dt>Type</dt><dd>Package only (no import)</dd>
     <dt>Source</dt><dd>${esc(s.source.environment)} <span class="muted">· ${esc(s.source.tenant)}</span><div class="muted small mono">${esc(s.source.url)}</div></dd>
     <dt>Source solution</dt><dd>${esc(s.sourceSolution.displayName)} <span class="muted mono small">${esc(s.sourceSolution.uniqueName)}</span></dd>`,
    `<dt>In the package</dt><dd>${esc(s.targetSolution.displayName)} <span class="muted mono small">${esc(s.targetSolution.uniqueName)}</span></dd>
     <dt>File</dt><dd class="mono small file-name">${breakableName(s.packageFile.name)}</dd>
     <dt>Size</dt><dd>${fmtBytes(s.packageFile.sizeBytes)}</dd>`,
  ], m.hasPackage ? `<a class="btn btn-sm btn-primary" href="/api/migrations/${m.id}/package">Download solution package</a>` : '')}
    <div class="kpis" role="tablist" aria-label="Summary" style="margin:16px 0">
      ${kpi('components', s.components.included + added, 'Components in package', 'tone-ok')}
      ${kpi('import', importNeeds.length + prereq.length, 'Import notes', prereq.length ? 'tone-warn' : '')}
      <div class="kpi"><div class="v">${fmtBytes(s.packageFile.sizeBytes)}</div><div class="l">Package size</div></div>
      ${kpi('duration', fmtDuration(s.durationMs), 'Total duration')}
    </div>
    <div class="summary-panel" role="tabpanel">${panel}</div>

    ${renderPackageCanvasApps(s.package && s.package.canvasAppDetails)}

    ${s.recommendations.length ? `<section class="card" style="margin-bottom:16px"><h3>Next steps</h3><ul class="recs" style="margin-top:10px">${s.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>` : ''}

    ${opts.fromHistory ? '' : `<div class="footer-bar" style="margin:0 0 16px"><span></span><div class="row">${state.profile ? '' : '<button class="btn" id="saveProfileSummary">Save as profile</button>'}<button class="btn btn-primary" id="newMig2">Create another package</button></div></div>`}`;
}

function renderFailures(items, warnings) {
  if (!items.length && !warnings.length) {
    return '<section class="card empty">No failures. Every step completed, and the solution was verified in the target.</section>';
  }
  return `<section class="card">
    <h3>Failures (${items.length})</h3>
    ${items.length ? `<table class="table small" style="margin-top:8px"><tbody>${items.map((f) => `<tr><td><span class="badge badge-err">Failed</span></td>
      <td><b>${esc(f.name)}</b> <span class="muted small">· ${esc(f.source)}</span><div class="muted">${esc(f.message || '')}</div>
      ${f.details ? `<details class="small"><summary class="muted">Technical details</summary><div class="mono wrap muted">${esc(f.details)}</div></details>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No failures.</p>'}
    ${warnings.length ? `<h3 style="margin-top:16px">Warnings (${warnings.length})</h3><table class="table small" style="margin-top:8px"><tbody>${warnings.map((i) => `<tr><td>${issueBadge(i.level)}</td><td><b>${esc(i.component)}</b><div class="muted">${esc(i.message)}</div></td></tr>`).join('')}</tbody></table>` : ''}
  </section>`;
}

function renderMigratedComponents(s, expanded, labels = {}) {
  const c = s.components;
  const added = c.addedDependencies || [];
  const total = c.included + added.length;
  // Group by type; runs saved before the component list existed only have counts.
  const groups = new Map();
  if (c.includedList) {
    for (const x of c.includedList) {
      if (!groups.has(x.typeName)) groups.set(x.typeName, []);
      groups.get(x.typeName).push(x);
    }
  }
  for (const x of added) {
    if (!groups.has(x.typeName)) groups.set(x.typeName, []);
    groups.get(x.typeName).push({ ...x, added: true });
  }
  const counts = c.includedList ? [...groups.entries()].map(([type, items]) => ({ type, count: items.length }))
    : c.byType.map((t) => ({ type: t.type, count: t.count + added.filter((a) => a.typeName === t.type).length }));
  counts.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const chips = counts.map((t) => `<span class="type-chip">${esc(t.type)} <b>${t.count}</b></span>`).join('');
  const list = c.includedList ? counts.map((t) => {
    const items = (groups.get(t.type) || []).slice().sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    return `<details class="type-group"><summary><span>${esc(t.type)}</span><span class="badge">${t.count}</span></summary>
      <ul class="comp-list">${items.map((x) => `<li><span>${esc(x.displayName)}</span>${x.name ? ` <span class="muted mono small">${esc(x.name)}</span>` : ''}
        ${x.added ? ` <span class="badge badge-accent" title="Needed by ${esc((x.neededBy || []).join(', '))}">Added automatically</span>` : ''}</li>`).join('')}</ul></details>`;
  }).join('') : '<p class="muted small">The component names were not recorded for this older run.</p>';
  return `<section class="card">
    <div class="row"><h3 style="flex:1">${esc(labels.title || 'Migrated components')} (${total})</h3><span class="badge badge-ok">${esc(labels.badge || 'Imported successfully')}</span></div>
    <div class="type-chips">${chips}</div>
    <details class="comp-details" ${expanded ? 'open' : ''}><summary>All ${total} components</summary>${list}</details>
    ${added.length ? `<p class="muted small" style="margin:8px 0 0">${added.length} required component(s) were added automatically because the solution needed them: ${added.map((a) => esc(a.displayName)).join(', ')}.</p>` : ''}
    ${c.excludedList.length ? `<details class="comp-details"><summary>${c.excludedList.length} component(s) excluded by you</summary>
      <ul class="comp-list">${c.excludedList.map((x) => `<li>${esc(x.displayName)} <span class="muted small">· ${esc(x.typeName)}</span></li>`).join('')}</ul></details>` : ''}
  </section>`;
}

// --- step 4: connections & environment variables (optional) -----------------------------------
const cfgKey = () => `${state.solutionId}|${targetSlot()}|${targetTenantId()}|${state.target.envId}`;

async function loadConfiguration(force) {
  const c = state.cfg;
  const key = cfgKey();
  if (!force && c.key === key && (c.data || c.loading)) return;
  Object.assign(c, { key, loading: true, error: null, data: null, conns: {} });
  render();
  try {
    const q = new URLSearchParams({ targetSlot: targetSlot(), targetTenantId: targetTenantId(), targetEnvId: state.target.envId });
    c.data = await api(`/api/source/tenants/${state.source.tenantId}/environments/${state.source.envId}/solutions/${state.solutionId}/configuration?${q}`);
  } catch (err) {
    c.error = err;
  }
  c.loading = false;
  if (state.step === STEP.CONFIG && state.view === 'wizard') render();
  if (c.data) {
    const connectors = [...new Set(c.data.connectionReferences.map((r) => r.connectorName).filter(Boolean))];
    await Promise.all(connectors.map((name) => loadConnections(name)));
  }
}

async function loadConnections(connector) {
  const c = state.cfg;
  c.conns[connector] = { loading: true, list: [], error: null };
  if (state.step === STEP.CONFIG) renderConfigBody();
  try {
    c.conns[connector].list = await api(`/api/${targetSlot()}/tenants/${targetTenantId()}/environments/${state.target.envId}/connections?connector=${encodeURIComponent(connector)}`);
  } catch (err) {
    c.conns[connector].error = err;
  }
  c.conns[connector].loading = false;
  autoSelectConnections(connector);
  if (state.step === STEP.CONFIG && state.view === 'wizard') renderConfigBody();
}

function configurationPayload() {
  const c = state.cfg;
  if (c.skipped) return { skipped: true, connectionReferences: [], environmentVariables: [] };
  return {
    skipped: false,
    connectionReferences: Object.entries(c.mappings).filter(([, v]) => v && v.connectionId)
      .map(([logicalName, v]) => ({ logicalName, displayName: v.displayName, connectorId: v.connectorId, connectionId: v.connectionId, connectionName: v.connectionName })),
    environmentVariables: Object.entries(c.values).filter(([, v]) => v && v.value !== '' && v.value !== null && v.value !== undefined)
      .map(([schemaName, v]) => ({ schemaName, displayName: v.displayName, value: v.value })),
  };
}

function configReviewText() {
  const c = state.cfg;
  if (c.skipped) return 'Skipped (configure later in the target)';
  const p = configurationPayload();
  const total = c.data ? c.data.connectionReferences.length : null;
  const vars = c.data ? c.data.environmentVariables.length : null;
  const refs = total === null ? `${p.connectionReferences.length} connection(s) set` : `${p.connectionReferences.length} of ${total} connection reference(s) set`;
  const vals = vars === null ? `${p.environmentVariables.length} value(s)` : `${p.environmentVariables.length} of ${vars} variable value(s)`;
  return `${refs} · ${vals}`;
}

function renderConfiguration(main) {
  const tEnv = targetEnv();
  main.innerHTML = `
    <div class="page-head"><div><h2>Connections & variables <span class="badge" style="vertical-align:3px">Optional</span></h2>
      <p>Choose the connections and environment variable values the solution should use in <b>${esc(tEnv && tEnv.name)}</b>. Anything you leave empty keeps its current value in the target, and you can set it there later.</p></div>
      <button class="btn btn-sm" id="cfgRefresh">Refresh</button></div>
    <div id="cfgBody"></div>
    <div class="footer-bar">
      <button class="btn" id="back">Back</button>
      <div class="row"><button class="btn" id="cfgSkip">Skip this step</button><button class="btn btn-primary" id="next">Next: options & review</button></div>
    </div>`;
  renderConfigBody();
  $('#back').addEventListener('click', () => go(STEP.COMPONENTS));
  $('#cfgRefresh').addEventListener('click', () => loadConfiguration(true));
  $('#cfgSkip').addEventListener('click', () => { state.cfg.skipped = true; go(STEP.OPTIONS); });
  $('#next').addEventListener('click', () => { state.cfg.skipped = false; go(STEP.OPTIONS); });
}

const ENV_TYPE = { BOOL: 100000002, JSON: 100000003, SECRET: 100000005, DATASOURCE: 100000004 };

function renderConfigBody() {
  const body = document.getElementById('cfgBody');
  if (!body) return;
  const c = state.cfg;
  if (c.loading) { body.innerHTML = '<div class="card empty"><span class="spinner"></span> Reading connection references and environment variables…</div>'; return; }
  if (c.error) {
    body.innerHTML = `<div class="notice err"><span><b>Could not read the solution's connections and variables.</b> ${esc(c.error.message)} You can skip this step and configure them in the target later.</span></div>
      <div class="row" style="margin-top:10px"><button class="btn btn-sm" id="cfgRetry">Try again</button>${c.error.authRequired ? '<button class="btn btn-sm btn-primary" id="cfgSignIn">Sign in</button>' : ''}</div>`;
    $('#cfgRetry').addEventListener('click', () => loadConfiguration(true));
    const si = document.getElementById('cfgSignIn');
    if (si) si.addEventListener('click', () => signIn(c.error.slot, c.error.tenantId, c.error.scope));
    return;
  }
  if (!c.data) { body.innerHTML = ''; return; }
  const { connectionReferences: refs, environmentVariables: vars, target } = c.data;
  if (!refs.length && !vars.length) {
    body.innerHTML = '<div class="card empty">This solution has no connection references or environment variables. Nothing to configure.</div>';
    return;
  }

  const varRows = vars.map((v) => {
    const val = c.values[v.schemaName] ? c.values[v.schemaName].value : '';
    const srcVal = v.sourceValue ?? v.defaultValue;
    let input;
    if (v.type === ENV_TYPE.BOOL) {
      input = `<select class="input" data-ev="${esc(v.schemaName)}"><option value="">— Keep target value —</option>
        <option value="yes" ${val === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${val === 'no' ? 'selected' : ''}>No</option></select>`;
    } else if (v.type === ENV_TYPE.JSON) {
      input = `<textarea class="input mono" rows="3" data-ev="${esc(v.schemaName)}" placeholder="Leave empty to keep the target value">${esc(val)}</textarea>`;
    } else {
      input = `<input class="input ${v.type === ENV_TYPE.SECRET ? 'mono' : ''}" data-ev="${esc(v.schemaName)}" value="${esc(val)}" placeholder="${v.type === ENV_TYPE.SECRET ? 'Key Vault secret reference' : 'Leave empty to keep the target value'}">`;
    }
    return `<tr>
      <td><b>${esc(v.displayName)}</b><div class="muted small mono">${esc(v.schemaName)}</div><span class="badge" style="margin-top:4px">${esc(v.typeName)}</span></td>
      <td class="small">${srcVal !== null && srcVal !== undefined && srcVal !== '' ? `<span class="mono wrap">${esc(String(srcVal).slice(0, 200))}</span>${v.sourceValue === null || v.sourceValue === undefined ? ' <span class="muted">(default)</span>' : ''}` : '<span class="muted">—</span>'}</td>
      <td class="small">${!v.existsInTarget ? '<span class="badge">New in target</span>' : v.targetValue !== null && v.targetValue !== undefined ? `<span class="mono wrap">${esc(String(v.targetValue).slice(0, 200))}</span>` : '<span class="muted">Not set</span>'}</td>
      <td style="min-width:220px">${input}
        ${srcVal !== null && srcVal !== undefined && srcVal !== '' && v.type !== ENV_TYPE.SECRET ? `<button class="link-btn small" data-copy="${esc(v.schemaName)}">Use source value</button>` : ''}</td></tr>`;
  }).join('');

  const connErr = Object.values(c.conns).map((x) => x.error).find(Boolean);
  const hasDataSource = vars.some((v) => v.type === ENV_TYPE.DATASOURCE);
  body.innerHTML = `
    ${connErr ? `<div class="notice ${connErr.authRequired ? 'warn' : 'err'}" style="margin-bottom:12px"><span><b>Connections in ${esc(target ? target.name : 'the target')} could not be listed.</b> ${esc(connErr.message)}</span></div>
      <div class="row" style="margin-bottom:16px">${connErr.authRequired ? '<button class="btn btn-sm btn-primary" id="connSignIn">Sign in to grant access</button>' : ''}<button class="btn btn-sm" id="connRetry">Try again</button></div>` : ''}
    ${refs.length ? `<div id="crSummary" class="cr-summary"></div>
    ${connectionToolbar(target)}
    <section class="card" style="margin-bottom:16px">
      <div class="cr-head">
        <div><h3>Connection references (${refs.length})</h3>
          <p class="card-sub" style="margin-bottom:0">Pick the connection each reference should use in the target. Flows that use them are turned on after the import.
          Only connections that the signed-in target account owns, or that are shared with it, are listed.</p></div>
        <div class="cr-tools">
          <input class="input" type="search" id="crSearch" placeholder="Search connections…" value="${esc(crUi().q)}" aria-label="Search connection references">
          <select class="input" id="crFilter" aria-label="Filter connection references">${crFilterOptions(refs)}</select>
        </div>
      </div>
      <div id="crGroups" class="cr-groups"></div>
    </section>` : ''}
    ${vars.length ? `<section class="card">
      <h3>Environment variables (${vars.length})</h3>
      <p class="card-sub">Enter the value for the target. Empty means the target's current value (or the default) is kept.</p>
      ${hasDataSource ? `<div class="notice warn" style="margin-bottom:10px"><span><b>Data source variables</b> (for example SharePoint lists) store IDs from the source. If you point a site URL variable to a different site, or move to another tenant, set the list / table variables to the IDs from the new site too. Otherwise flows fail with "Unauthorized" or "not found".${state.mode === 'cross' ? ' A selected SharePoint connection does not prove that the target site, list or data-source IDs are valid: check them separately in the target tenant.' : ''}</span></div>` : ''}
      <div class="table-wrap"><table class="table cfg-table var-table"><thead><tr><th>Variable</th><th>Source value</th><th>In target now</th><th>Value for target</th></tr></thead><tbody>${varRows}</tbody></table></div>
    </section>` : ''}`;

  if (refs.length) {
    renderCrSummary();
    renderCrGroups();
    const ui = crUi();
    $('#crSearch').addEventListener('input', (e) => { ui.q = e.target.value; renderCrGroups(); });
    $('#crFilter').addEventListener('change', (e) => { ui.filter = e.target.value; renderCrGroups(); });
  }
  const varByName = new Map(vars.map((v) => [v.schemaName, v]));
  body.querySelectorAll('[data-ev]').forEach((inp) => inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
    const v = varByName.get(inp.dataset.ev);
    if (inp.value === '') delete c.values[v.schemaName];
    else c.values[v.schemaName] = { value: inp.value, displayName: v.displayName };
  }));
  body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const v = varByName.get(b.dataset.copy);
    const value = String(v.sourceValue ?? v.defaultValue ?? '');
    c.values[v.schemaName] = { value: v.type === ENV_TYPE.BOOL ? (/^(true|yes|1)$/i.test(value) ? 'yes' : 'no') : value, displayName: v.displayName };
    renderConfigBody();
  }));
  const cs = document.getElementById('connSignIn');
  if (cs) cs.addEventListener('click', () => signIn(connErr.slot, connErr.tenantId, connErr.scope));
  const cr = document.getElementById('connRetry');
  if (cr) cr.addEventListener('click', () => [...new Set(refs.map((r) => r.connectorName))].forEach((n) => loadConnections(n)));
  const rf = document.getElementById('connRefresh');
  if (rf) rf.addEventListener('click', () => [...new Set(refs.map((r) => r.connectorName))].forEach((n) => loadConnections(n)));
}

function refRow(r) {
  const c = state.cfg;
    const conn = c.conns[r.connectorName] || { loading: true, list: [] };
    const m = c.mappings[r.logicalName] || {};
    const listed = conn.list.some((x) => x.id === m.connectionId);
    const isCurrent = m.auto === 'current' && m.connectionId && !listed;
    const manual = m.manual || (m.connectionId && !listed && !isCurrent && !conn.loading);
    const usable = conn.list.filter((x) => x.connected).length;
    const current = !r.existsInTarget ? '<span class="badge">New in target</span>'
      : r.targetConnectionId ? '<span class="badge badge-ok">Connected</span>' : '<span class="badge badge-warn">No connection</span>';
    let picker;
    if (conn.loading) picker = '<select class="input" disabled><option>Loading connections…</option></select>';
    else {
      picker = `<select class="input" data-cr="${esc(r.logicalName)}">
        <option value="">— Leave as is (set later) —</option>
        ${isCurrent ? `<option value="${esc(m.connectionId)}" selected>Current connection in the target</option>` : ''}
        ${conn.list.map((x) => `<option value="${esc(x.id)}" ${x.id === m.connectionId ? 'selected' : ''} ${x.connected ? '' : 'class="bad"'}>${esc(x.displayName)}${x.connected ? '' : ` (${esc(x.status)})`}</option>`).join('')}
        <option value="__manual" ${manual ? 'selected' : ''}>Enter a connection ID…</option>
      </select>
      ${manual ? `<input class="input mono" style="margin-top:6px" data-crid="${esc(r.logicalName)}" placeholder="Connection ID (from the connection's URL)" value="${esc(m.connectionId || '')}">` : ''}
      ${!m.connectionId && usable > 1 ? `<div class="hint">${usable} connections are available: choose one.</div>` : ''}
      ${conn.error ? '<div class="hint error">Connections could not be listed (see the message above). You can still paste a connection ID.</div>' : ''}
      ${!conn.error && !conn.list.length ? '<div class="hint">No connections for this connector in the target yet.</div>' : ''}
      ${m.connectionId && conn.list.some((x) => x.id === m.connectionId && !x.connected) ? '<div class="hint error">This connection is not in a connected state; flows using it may fail.</div>' : ''}`;
    }
    return `<tr data-ref="${esc(r.logicalName)}">
      <td><div class="cr-name">${connectorIcon(r.connectorName, 'sm')}<div><b>${esc(r.displayName)}</b><div class="muted small mono">${esc(r.logicalName)}</div>
        ${r.notInSolution ? '<span class="badge badge-warn" style="margin-top:4px" title="Required by the solution but not in it; added automatically during migration">Added automatically</span>' : ''}</div></div></td>
      <td>${current}</td>
      <td class="cr-pick">${picker}</td></tr>`;
}


// --- Step 4: grouped connection references -------------------------------------------------------
// Grouping is presentation only: every connection reference keeps its own mapping (c.mappings by logical name).
const CONNECTOR_NAMES = {
  shared_sharepointonline: 'SharePoint', shared_office365: 'Office 365 Outlook', shared_office365users: 'Office 365 Users',
  shared_onedriveforbusiness: 'OneDrive for Business', shared_teams: 'Microsoft Teams', shared_commondataserviceforapps: 'Microsoft Dataverse',
  shared_webcontents: 'HTTP with Microsoft Entra ID', shared_excelonlinebusiness: 'Excel Online (Business)', shared_powerbi: 'Power BI',
  shared_approvals: 'Approvals', shared_sql: 'SQL Server', shared_planner: 'Planner', shared_flowpush: 'Notifications',
};
const CONNECTOR_COLORS = { shared_sharepointonline: '#038387', shared_office365: '#0f6cbd', shared_onedriveforbusiness: '#2b88d8', shared_teams: '#5b5fc7', shared_commondataserviceforapps: '#107c41', shared_excelonlinebusiness: '#107c41', shared_powerbi: '#c19c00', shared_webcontents: '#6b6b7b' };

function connectorLabel(name) {
  if (CONNECTOR_NAMES[name]) return CONNECTOR_NAMES[name];
  const base = String(name || 'Other').replace(/^shared_/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function connectorIcon(name, size = '') {
  const label = connectorLabel(name);
  const letters = label.split(/[\s()]+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let color = CONNECTOR_COLORS[name];
  if (!color) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; color = `hsl(${h} 45% 42%)`; }
  return `<span class="cx-icon ${size}" style="--cx:${color}" aria-hidden="true">${esc(letters)}</span>`;
}

function crUi() {
  const c = state.cfg;
  if (!c.ui) c.ui = { q: '', filter: 'all', open: null, showAll: new Set(), bulk: {} };
  return c.ui;
}

// Assigned = a usable target connection is selected for this reference (not just "a connection of this type exists").
function crAssigned(r) {
  const c = state.cfg;
  const m = c.mappings[r.logicalName];
  if (!m || !m.connectionId) return false;
  const listed = ((c.conns[r.connectorName] || {}).list || []).find((x) => x.id === m.connectionId);
  return !listed || listed.connected;
}

function crFilterOptions(refs) {
  const ui = crUi();
  const connectors = [...new Set(refs.map((r) => r.connectorName))].sort((a, b) => connectorLabel(a).localeCompare(connectorLabel(b)));
  const opt = (v, l) => `<option value="${esc(v)}" ${ui.filter === v ? 'selected' : ''}>${esc(l)}</option>`;
  return `${opt('all', 'All connectors')}${opt('missing', 'Missing')}${opt('assigned', 'Assigned')}${refs.some((r) => r.notInSolution) ? opt('auto', 'Added automatically') : ''}
    <optgroup label="Connector">${connectors.map((n) => opt(`conn:${n}`, connectorLabel(n))).join('')}</optgroup>`;
}

function crMatches(r) {
  const ui = crUi();
  const f = ui.filter;
  if (f === 'missing' && crAssigned(r)) return false;
  if (f === 'assigned' && !crAssigned(r)) return false;
  if (f === 'auto' && !r.notInSolution) return false;
  if (f.startsWith('conn:') && r.connectorName !== f.slice(5)) return false;
  const q = ui.q.trim().toLowerCase();
  if (!q) return true;
  const m = state.cfg.mappings[r.logicalName] || {};
  return [r.displayName, r.logicalName, r.connectorName, connectorLabel(r.connectorName), m.connectionName].filter(Boolean).join(' ').toLowerCase().includes(q);
}

function renderCrSummary() {
  const el = document.getElementById('crSummary');
  const c = state.cfg;
  if (!el || !c.data) return;
  const refs = c.data.connectionReferences;
  const assigned = refs.filter(crAssigned).length;
  const missing = refs.length - assigned;
  const icon = { ok: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    total: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>' };
  const card = (tone, svg, v, l, title) => `<div class="cr-stat ${tone}" title="${esc(title)}"><span class="cr-stat-icon">${svg}</span><div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
  el.innerHTML = card('ok', icon.ok, assigned, 'Assigned', 'A usable target connection is selected')
    + card(missing ? 'warn' : '', icon.warn, missing, 'Missing', 'No usable connection selected yet: set it here, or in the target after the import')
    + card('total', icon.total, refs.length, 'Total connection references', 'Every reference is kept and migrated');
}

const CR_ROWS_COLLAPSED = 5;

function renderCrGroups() {
  const box = document.getElementById('crGroups');
  const c = state.cfg;
  if (!box || !c.data) return;
  const ui = crUi();
  const refs = c.data.connectionReferences;
  const groups = new Map();
  for (const r of refs) { if (!groups.has(r.connectorName)) groups.set(r.connectorName, []); groups.get(r.connectorName).push(r); }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || connectorLabel(a[0]).localeCompare(connectorLabel(b[0])));
  const loadingConns = ordered.some(([n]) => !c.conns[n] || c.conns[n].loading);
  if (!ui.open && !loadingConns) { // first view, once connections are known: open groups that still need a connection, else the largest group
    ui.open = new Set(ordered.filter(([, list]) => list.some((r) => !crAssigned(r))).map(([n]) => n));
    if (!ui.open.size && ordered.length) ui.open.add(ordered[0][0]);
  }
  const openSet = ui.open || new Set();
  const filtering = Boolean(ui.q.trim()) || ui.filter !== 'all';
  const html = ordered.map(([name, list]) => {
    const shown = list.filter(crMatches);
    if (!shown.length) return '';
    const assigned = list.filter(crAssigned).length;
    const missing = list.length - assigned;
    const open = filtering || openSet.has(name);
    const groupLoading = !c.conns[name] || c.conns[name].loading;
    const status = groupLoading ? '<span class="cr-pill"><span class="spinner"></span> Loading connections…</span>' : missing
      ? `<span class="cr-pill warn">${missing} missing</span>${assigned ? `<span class="cr-pill ok">${assigned} connected</span>` : ''}`
      : `<span class="cr-pill ok"><span class="dot" aria-hidden="true">✓</span>${assigned} connected</span>`;
    let bodyHtml = '';
    if (open) {
      const conn = c.conns[name] || { loading: true, list: [] };
      const limit = filtering || ui.showAll.has(name) ? shown.length : CR_ROWS_COLLAPSED;
      const bulkVal = ui.bulk[name] || '';
      const bulk = list.length > 1 ? `<div class="cr-bulk">
          <label class="small" for="bulk-${esc(name)}">Use one target connection for all ${list.length} ${esc(connectorLabel(name))} references</label>
          <div class="cr-bulk-row">
            <select class="input" id="bulk-${esc(name)}" data-bulk="${esc(name)}" ${conn.loading ? 'disabled' : ''}>
              <option value="">${conn.loading ? 'Loading connections…' : conn.list.length ? '— Choose a connection —' : 'No connections for this connector in the target yet'}</option>
              ${conn.list.map((x) => `<option value="${esc(x.id)}" ${x.id === bulkVal ? 'selected' : ''} ${x.connected ? '' : 'disabled'}>${esc(x.displayName)}${x.connected ? '' : ` (${esc(x.status)})`}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-sm btn-primary" data-apply="${esc(name)}" ${bulkVal ? '' : 'disabled'}>Apply to all</button>
          </div>
          <div class="hint">You confirm before it's applied, and you can still change any single reference afterwards.</div>
        </div>` : '';
      bodyHtml = `<div class="cr-body">${bulk}
        <div class="table-wrap"><table class="table cfg-table cr-table"><thead><tr><th>Connection reference</th><th>In target now</th><th>Use connection</th></tr></thead>
          <tbody>${shown.slice(0, limit).map(refRow).join('')}</tbody></table></div>
        ${shown.length > limit ? `<button type="button" class="link-btn cr-more" data-more="${esc(name)}">Show all ${shown.length} references ▾</button>`
          : !filtering && ui.showAll.has(name) && shown.length > CR_ROWS_COLLAPSED ? `<button type="button" class="link-btn cr-more" data-less="${esc(name)}">Show fewer ▴</button>` : ''}
      </div>`;
    }
    return `<div class="cr-group ${open ? 'open' : ''} ${missing ? 'has-missing' : ''}">
      <button type="button" class="cr-group-head" data-group="${esc(name)}" aria-expanded="${open}">
        <span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${connectorIcon(name)}
        <span class="cr-group-name">${esc(connectorLabel(name))}</span>
        <span class="badge">${filtering && shown.length !== list.length ? `${shown.length} of ` : ''}${list.length} reference${list.length === 1 ? '' : 's'}</span>
        <span class="spacer"></span>${status}
      </button>${bodyHtml}</div>`;
  }).join('');
  box.innerHTML = html || '<div class="empty small">No connection references match your search or filter.</div>';
  wireCrGroups(box);
}

function wireCrGroups(box) {
  const c = state.cfg;
  const ui = crUi();
  const refByName = new Map(c.data.connectionReferences.map((r) => [r.logicalName, r]));
  const changed = () => { renderCrGroups(); renderCrSummary(); };
  box.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    const n = b.dataset.group;
    ui.open = ui.open || new Set();
    if (ui.open.has(n)) ui.open.delete(n); else ui.open.add(n);
    renderCrGroups();
  }));
  box.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => { ui.showAll.add(b.dataset.more); renderCrGroups(); }));
  box.querySelectorAll('[data-less]').forEach((b) => b.addEventListener('click', () => { ui.showAll.delete(b.dataset.less); renderCrGroups(); }));
  box.querySelectorAll('[data-bulk]').forEach((sel) => sel.addEventListener('change', () => { ui.bulk[sel.dataset.bulk] = sel.value; renderCrGroups(); }));
  box.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.apply;
    const conn = ((c.conns[name] || {}).list || []).find((x) => x.id === ui.bulk[name]);
    if (!conn) return;
    const list = c.data.connectionReferences.filter((r) => r.connectorName === name);
    const differs = list.filter((r) => (c.mappings[r.logicalName] || {}).connectionId && c.mappings[r.logicalName].connectionId !== conn.id).length;
    if (!await confirmModal(`Use this connection for all ${list.length} ${connectorLabel(name)} references?`,
      `${conn.displayName} will be selected for all ${list.length} references.${differs ? ` ${differs} reference(s) currently use a different connection; they are changed too.` : ''} Each reference is still migrated separately, and you can change any of them afterwards.`, 'Apply to all')) return;
    c.touched = c.touched || {};
    for (const r of list) {
      c.touched[r.logicalName] = true;
      c.mappings[r.logicalName] = { connectionId: conn.id, connectionName: conn.displayName, displayName: r.displayName, connectorId: r.connectorId };
    }
    toast(`${conn.displayName} applied to ${list.length} references.`);
    changed();
  }));
  box.querySelectorAll('[data-cr]').forEach((sel) => sel.addEventListener('change', () => {
    const r = refByName.get(sel.dataset.cr);
    c.touched = c.touched || {};
    c.touched[r.logicalName] = true;
    const conn = (c.conns[r.connectorName] || { list: [] }).list.find((x) => x.id === sel.value);
    if (!sel.value) delete c.mappings[r.logicalName];
    else if (sel.value === '__manual') c.mappings[r.logicalName] = { manual: true, connectionId: '', displayName: r.displayName, connectorId: r.connectorId };
    else c.mappings[r.logicalName] = { connectionId: sel.value, connectionName: conn ? conn.displayName : 'Current connection in the target', displayName: r.displayName, connectorId: r.connectorId };
    changed();
  }));
  box.querySelectorAll('[data-crid]').forEach((inp) => inp.addEventListener('input', () => {
    const r = refByName.get(inp.dataset.crid);
    c.mappings[r.logicalName] = { manual: true, connectionId: inp.value.trim(), connectionName: inp.value.trim(), displayName: r.displayName, connectorId: r.connectorId };
    renderCrSummary();
  }));
}

function renderPackageCanvasApps(apps) {
  if (!apps || !apps.length) return '';
  return `<section class="card" style="margin-bottom:16px"><h3>Canvas apps in the migrated package</h3>
    <p class="card-sub">What was actually exported. Compare the screens and the saved time with the app in the source: if screens are missing here, the source app wasn't published with them.</p>
    <table class="table small"><thead><tr><th>App</th><th>Version saved (UTC)</th><th>Screens</th></tr></thead><tbody>
    ${apps.map((a) => `<tr><td><b>${esc(a.name)}</b>${a.error ? `<div class="muted">${esc(a.error)}</div>` : ''}</td><td>${esc(a.savedUtc || '—')}</td>
      <td>${a.screens.length ? `<details><summary>${a.screens.length} screen(s)</summary><div class="muted">${a.screens.map(esc).join(', ')}</div></details>` : '<span class="muted">none found</span>'}</td></tr>`).join('')}
    </tbody></table></section>`;
}

function issueBadge(level) {
  if (level === 'failure') return '<span class="badge badge-err">Failed</span>';
  if (level === 'action') return '<span class="badge badge-warn">Action required</span>';
  return '<span class="badge badge-warn">Warning</span>';
}

function renderActionRequired(s, m) {
  const ar = s.actionRequired;
  if (!ar || !ar.total) return '';
  const target = esc(s.target.environment);
  const rows = [
    ...ar.connectionReferences.map((x) => `<tr><td><span class="badge badge-warn">Connection</span></td><td><b>${esc(x.name)}</b> <span class="muted mono small">${esc(x.logicalName)}</span>
      <div class="muted">${s.configurationSkipped ? 'Skipped during migration. ' : 'No connection selected. '}Create or pick a ${esc((x.connector || '').replace(/^shared_/, '') || 'matching')} connection in ${target} and bind it to this connection reference.</div></td></tr>`),
    ...ar.environmentVariables.map((x) => `<tr><td><span class="badge badge-warn">Variable</span></td><td><b>${esc(x.name)}</b> <span class="muted mono small">${esc(x.schemaName)}</span>
      <div class="muted">Has no value and no default in ${target}. Set its current value.</div></td></tr>`),
    ...ar.flows.map((x) => `<tr><td><span class="badge badge-warn">Cloud flow</span></td><td><b>${esc(x.name)}</b>
      <div class="muted">${esc(x.message || 'Turn the flow on once its connections are configured.')}</div></td></tr>`),
  ];
  return `<section class="card action-card">
    <div class="row"><h3 style="flex:1">Action required in ${target} (${ar.total})</h3>
      ${s.targetSolutionsUrl ? (m ? accountLink(m.crossTenant ? 'target' : 'source', m.request.target.tenant.tenantId, s.targetSolutionsUrl, `Open solutions in ${target}`, 'btn btn-sm')
        : `<a class="btn btn-sm" href="${esc(s.targetSolutionsUrl)}" target="_blank" rel="noopener">Open solutions in ${target} ↗</a>`) : ''}</div>
    <p class="card-sub">The solution was imported and verified in the target. ${s.configurationSkipped ? 'You skipped the Connections & variables step, so these' : 'These'} still need to be configured in the target before the solution works fully. Open the solution in the target, then:
      bind each connection reference to a connection, set the variable values, and turn the flows on.</p>
    <table class="table small"><tbody>${rows.join('')}</tbody></table></section>`;
}

function renderConfigResults(cr) {
  if (!cr) return '';
  const badge = (r) => (r === 'failed' ? '<span class="badge badge-err">Failed</span>'
    : r === 'unchanged' ? '<span class="badge badge-ok" title="The target already had this value; it was set during the import">Already set</span>'
      : r === 'action' || r === 'waiting' ? '<span class="badge badge-warn">Action required</span>'
        : r === 'activated' ? '<span class="badge badge-ok">Turned on</span>' : '<span class="badge badge-ok">Applied</span>');
  const tech = (x) => (x.details ? `<details class="small"><summary class="muted">Technical details</summary><div class="mono wrap muted">${esc(x.details)}</div></details>` : '');
  const rows = [
    ...cr.connectionReferences.map((x) => `<tr><td>${badge(x.result)}</td><td><b>${esc(x.name)}</b> → ${esc(x.connection)}${x.message ? `<div class="muted">${esc(x.message)}</div>` : ''}</td><td class="muted">Connection reference</td></tr>`),
    ...cr.environmentVariables.map((x) => `<tr><td>${badge(x.result)}</td><td><b>${esc(x.name)}</b>${x.message ? `<div class="muted">${esc(x.message)}</div>` : ''}</td><td class="muted">Environment variable</td></tr>`),
    ...(cr.flows || []).filter((x) => x.result === 'activated').map((x) => `<tr><td>${badge(x.result)}</td><td><b>${esc(x.name)}</b>${x.message ? `<div class="muted">${esc(x.message)}</div>` : ''}${tech(x)}</td><td class="muted">Cloud flow</td></tr>`),
  ];
  if (!rows.length) return '';
  return `<section class="card" style="margin-bottom:16px"><h3>Connections & variables applied</h3>
    <table class="table small" style="margin-top:8px"><tbody>${rows.join('')}</tbody></table></section>`;
}

// --- mandatory canvas-app publish check (Options & review) -------------------------------------
const canvasKey = () => `${state.source.envId}|${state.solutionId}|${[...state.excluded].sort().join(',')}`;

const CANVAS_AUTO_MS = 15000;   // re-check interval while apps are blocked
const CANVAS_AUTO_MAX = 40;     // stop after ~10 minutes

async function runCanvasCheck(force, { silent = false } = {}) {
  const cv = state.canvas;
  const key = canvasKey();
  if (!force && cv.key === key && (cv.result || cv.loading)) return;
  if (cv.loading && cv.key === key) return;
  clearTimeout(cv.timer);
  const sameKey = cv.key === key;
  const previous = sameKey ? cv.result : null;
  // A silent re-check keeps the current results on screen until the new ones arrive.
  Object.assign(cv, { key, loading: true, error: null, ack: sameKey ? cv.ack : false, override: sameKey ? cv.override : false, result: silent && sameKey ? cv.result : null });
  if (!sameKey) cv.autoCount = 0;
  updateCanvasPanel();
  try {
    cv.result = await api(`/api/source/tenants/${state.source.tenantId}/environments/${state.source.envId}/solutions/${state.solutionId}/canvas-check`, {
      method: 'POST', body: { excludedComponentIds: [...state.excluded] },
    });
    cv.checkedAt = Date.now();
    if (previous && previous.status === 'unpublished' && cv.result.status === 'ok') toast('All canvas apps are published now. You can start the migration.');
  } catch (err) {
    if (!(silent && cv.result)) cv.error = err;
  }
  cv.loading = false;
  if (cv.key !== canvasKey()) return; // the selection changed meanwhile
  updateCanvasPanel();
  // Publishing in Studio can take a moment to show up in the Power Apps service:
  // keep checking by ourselves while something is still unpublished.
  if (cv.result && cv.result.status === 'unpublished' && (cv.autoCount || 0) < CANVAS_AUTO_MAX) {
    cv.timer = setTimeout(() => {
      if (state.view !== 'wizard' || state.step !== STEP.OPTIONS || cv.key !== canvasKey()) return;
      cv.autoCount = (cv.autoCount || 0) + 1;
      runCanvasCheck(true, { silent: true });
    }, CANVAS_AUTO_MS);
  }
}

// Re-draws only the check panel, so typing elsewhere on the page isn't disturbed.
function updateCanvasPanel() {
  if (state.view !== 'wizard' || state.step !== STEP.OPTIONS) return;
  const el = document.querySelector('.canvas-check');
  if (!el) return;
  el.outerHTML = canvasCheckCard();
  wireCanvasCheck();
  const start = document.getElementById('start');
  if (start) start.disabled = startBlocked();
}

// Coming back from Power Apps Studio (another tab or window): check again right away.
window.addEventListener('focus', () => {
  const cv = state.canvas;
  if (state.view === 'wizard' && state.step === STEP.OPTIONS && cv.result && cv.result.status === 'unpublished' && !cv.loading) {
    runCanvasCheck(true, { silent: true });
  }
});

function canvasCheckPassed() {
  const cv = state.canvas;
  if (cv.loading || (!cv.result && !cv.error)) return false;
  if (cv.error) return cv.ack;
  if (cv.result.status === 'unpublished') return Boolean(cv.override);
  if (cv.result.status === 'unverified') return cv.ack;
  return true;
}

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '—');

function canvasCheckCard() {
  const cv = state.canvas;
  let inner;
  if (!cv.result && (cv.loading || !cv.error)) inner = '<div class="muted small"><span class="spinner"></span> Checking that canvas apps are published…</div>';
  else if (cv.error) {
    inner = `<div class="notice err"><span>The check could not run: ${esc(cv.error.message)}</span></div>
      ${ackBox('I confirm the latest version of every canvas app in this solution is published.')}
      <div class="row" style="margin-top:6px"><button class="btn btn-sm" id="canvasRecheck" ${state.canvas.loading ? 'disabled' : ''}>${state.canvas.loading ? 'Checking…' : 'Check again'}</button></div>`;
  } else {
    const r = cv.result;
    const appRows = r.apps.length ? `<table class="table small" style="margin-top:8px"><tbody>${r.apps.map((a) => `<tr>
        <td>${a.state === 'published' ? '<span class="badge badge-ok">Published</span>' : a.state === 'unpublished' ? '<span class="badge badge-err">Unpublished changes</span>' : '<span class="badge badge-warn">Not verified</span>'}</td>
        <td><b>${esc(a.displayName)}</b><div class="muted">${a.state === 'unknown' ? esc(a.reason || 'Publish state unknown') : `Last saved ${esc(fmtTime(a.lastSaved))} · last published ${esc(fmtTime(a.lastPublished))}${a.evidence ? ` · checked with ${esc(a.evidence)}` : ''}`}</div>
          ${a.state !== 'published' && a.editUrl ? accountLink('source', state.source.tenantId, a.editUrl, 'Open in Power Apps Studio to publish', 'small') : ''}
          ${a.raw ? `<details class="small" data-raw="${esc(a.objectId)}" ${cv.openRaw && cv.openRaw.has(a.objectId) ? 'open' : ''}><summary class="muted">Technical details</summary><pre class="raw">${esc(JSON.stringify(a.raw, null, 2))}</pre></details>` : ''}</td></tr>`).join('')}</tbody></table>` : '';
    if (r.status === 'none') inner = '<div class="notice ok"><span>No canvas apps in this solution.</span></div>';
    else if (r.status === 'ok') inner = `<div class="notice ok"><span>${esc(r.message)}</span></div>${appRows}`;
    else if (r.status === 'unpublished') {
      inner = `<div class="notice err"><span><b>${cv.override ? 'Continuing on your confirmation.' : 'Migration blocked.'}</b> ${esc(r.message)}</span></div>${appRows}
        <label class="check"><input type="checkbox" id="canvasOverride" ${cv.override ? 'checked' : ''}><span><strong>I have published these apps in Power Apps Studio. The check is showing old information; continue anyway.</strong><span class="muted small">Use this only after publishing. Your confirmation is recorded in the migration log and history.</span></span></label>
        <div class="row" style="margin-top:8px"><button class="btn btn-sm" id="canvasRecheck" ${state.canvas.loading ? 'disabled' : ''}>${state.canvas.loading ? 'Checking…' : 'Check again'}</button></div>`;
    } else {
      inner = `<div class="notice warn"><span>${esc(r.message)}</span></div>${appRows}
        ${ackBox('I confirm the latest version of every canvas app listed above is published.')}
        <div class="row" style="margin-top:6px"><button class="btn btn-sm" id="canvasRecheck" ${state.canvas.loading ? 'disabled' : ''}>${state.canvas.loading ? 'Checking…' : 'Check again'}</button>
          ${r.stepUp ? '<button class="btn btn-sm btn-primary" id="canvasGrant">Sign in to grant access</button>' : ''}</div>`;
    }
  }
  const auto = cv.result && cv.result.status === 'unpublished' && (cv.autoCount || 0) < CANVAS_AUTO_MAX;
  const footer = cv.result || cv.error
    ? `<div class="hint" style="margin-top:8px">${cv.loading ? '<span class="spinner"></span> Checking again…' : `Last checked ${esc(new Date(cv.checkedAt || Date.now()).toLocaleTimeString())}`}${auto ? ' · checks again automatically every 15 seconds and when you return to this tab' : ''}</div>`
    : '';
  return `<div class="checks canvas-check"><div class="lbl">Pre-migration check · canvas apps</div>${inner}${footer}</div>`;
}

function ackBox(text) {
  return `<label class="check"><input type="checkbox" id="canvasAck" ${state.canvas.ack ? 'checked' : ''}><span><strong>${esc(text)}</strong><span class="muted small">Required because the publish state couldn't be verified automatically.</span></span></label>`;
}

function wireCanvasCheck() {
  const re = document.getElementById('canvasRecheck');
  if (re) re.addEventListener('click', () => runCanvasCheck(true));
  const ov = document.getElementById('canvasOverride');
  if (ov) ov.addEventListener('change', () => { state.canvas.override = ov.checked; updateCanvasPanel(); });
  document.querySelectorAll('.canvas-check details[data-raw]').forEach((d) => d.addEventListener('toggle', () => {
    state.canvas.openRaw = state.canvas.openRaw || new Set();
    if (d.open) state.canvas.openRaw.add(d.dataset.raw); else state.canvas.openRaw.delete(d.dataset.raw);
  }));
  const ack = document.getElementById('canvasAck');
  if (ack) ack.addEventListener('change', () => { state.canvas.ack = ack.checked; $('#start').disabled = startBlocked(); });
  const g = document.getElementById('canvasGrant');
  if (g) g.addEventListener('click', () => { const s = state.canvas.result.stepUp; signIn(s.slot, s.tenantId, s.scope); });
}

function renderCanvasAppsTable(apps) {
  if (!apps || !apps.length) return '';
  return `<h3 style="font-size:14px;margin:16px 0 6px">Canvas apps</h3>
    <table class="table small"><tbody>${apps.map((a) => `<tr><td><b>${esc(a.displayName)}</b>
      <div class="muted">${a.state === 'unpublished' ? `Unpublished changes · last saved ${esc(fmtTime(a.lastSaved))}, last published ${esc(fmtTime(a.lastPublished))}` : a.state === 'unknown' ? esc(a.reason || 'Publish state could not be verified') : 'Published'}</div>
      ${a.editUrl && a.state !== 'published' ? accountLink('source', state.source.tenantId, a.editUrl, 'Open in Power Apps Studio') : ''}</td></tr>`).join('')}</tbody></table>`;
}

// --- small dialogs -------------------------------------------------------------------------------
function dialog({ title, bodyHtml, okLabel, focusSel, onOk }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.classList.add('plain');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    const actions = $('#modalActions');
    actions.innerHTML = '';
    const done = (v) => { modal.hidden = true; modal.classList.remove('plain'); resolve(v); };
    const ok = button(okLabel, 'btn btn-primary', () => { const v = onOk ? onOk() : true; if (v !== undefined) done(v); });
    actions.append(button('Cancel', 'btn', () => done(null)), ok);
    modal.hidden = false;
    const f = focusSel ? $(focusSel) : ok;
    if (f) f.focus();
    const input = focusSel ? $(focusSel) : null;
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
  });
}

function promptModal(title, label, value) {
  return dialog({
    title,
    bodyHtml: `<label class="field"><span>${esc(label)}</span><input class="input" id="promptInput" maxlength="120" value="${esc(value || '')}"></label><div class="hint error" id="promptErr"></div>`,
    okLabel: 'Save',
    focusSel: '#promptInput',
    onOk: () => {
      const v = $('#promptInput').value.trim();
      if (!v) { $('#promptErr').textContent = 'Enter a name.'; return undefined; }
      return v;
    },
  });
}

function confirmModal(title, text, okLabel) {
  return dialog({ title, bodyHtml: `<p style="margin:0">${esc(text)}</p>`, okLabel }).then(Boolean);
}

// --- profiles ------------------------------------------------------------------------------------
function captureProfile(name) {
  const srcEnv = findEnv(state.source);
  const tEnv = pkgMode() ? null : targetEnv();
  const sol = selectedSolution();
  const tTenant = state.mode === 'same' ? findTenant(state.source) : findTenant(state.target);
  return {
    name,
    mode: state.mode,
    source: { tenantId: state.source.tenantId, tenantName: (findTenant(state.source) || {}).displayName || state.source.tenantId, envId: srcEnv.id, envName: srcEnv.name, envUrl: srcEnv.url },
    target: tEnv ? { tenantId: targetTenantId(), tenantName: (tTenant || {}).displayName || targetTenantId(), envId: tEnv.id, envName: tEnv.name, envUrl: tEnv.url } : null,
    solution: { uniqueName: sol.uniqueName, displayName: sol.displayName },
    excludedObjectIds: state.components.filter((c) => state.excluded.has(c.id)).map((c) => c.objectId),
    rename: { enabled: state.rename.enabled, uniqueName: state.rename.uniqueName, displayName: state.rename.displayName },
    options: { ...state.options },
    configuration: pkgMode() ? { skipped: true, mappings: {}, values: {} } : { skipped: state.cfg.skipped, mappings: state.cfg.mappings, values: state.cfg.values },
  };
}

async function saveProfile(asNew) {
  const sol = selectedSolution();
  if (!sol || (!pkgMode() && !targetEnv())) return;
  const updating = state.profile && !asNew;
  const name = await promptModal(updating ? 'Update profile' : 'Save as profile', 'Profile name',
    updating ? state.profile.name : `${sol.displayName}: ${findEnv(state.source).name} → ${pkgMode() ? 'package' : targetEnv().name}`);
  if (!name) return;
  try {
    const body = captureProfile(name);
    const saved = updating
      ? await api(`/api/profiles/${state.profile.id}`, { method: 'PUT', body })
      : await api('/api/profiles', { method: 'POST', body });
    state.profile = { id: saved.id, name: saved.name };
    state.profiles = null;
    toast(`Profile "${saved.name}" saved`);
    render();
  } catch (err) { showError(err, 'Could not save the profile'); }
}

async function loadProfiles() {
  try { state.profiles = await api('/api/profiles'); } catch (err) { state.profiles = []; showError(err, 'Could not load profiles'); }
  if (state.view === 'profiles') render();
}

function statusBadge(status, outcome) {
  if (status === 'succeeded' && outcome === 'package') return '<span class="badge badge-ok">Package ready</span>';
  if (status === 'attention') {
    return outcome === 'errors'
      ? '<span class="badge badge-err">Completed with errors</span>'
      : '<span class="badge badge-ok">Succeeded</span> <span class="badge badge-warn">Configuration required</span>';
  }
  const map = { attention: ['Action required', 'badge-warn'], succeeded: ['Succeeded', 'badge-ok'], failed: ['Failed', 'badge-err'], running: ['Running', 'badge-accent'], interrupted: ['Interrupted', 'badge-warn'], cancelled: ['Stopped', 'badge-warn'] };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function renderProfiles(main) {
  const list = state.profiles;
  main.innerHTML = `
    <div class="page-head"><div><h2>Saved profiles</h2><p>Reuse a migration setup: source and target, solution, excluded components, name, options, connections and variable values.</p></div>
      <button class="btn btn-primary" id="newFromProfiles">New migration</button></div>
    ${!list ? '<div class="card empty"><span class="spinner"></span> Loading profiles…</div>'
      : !list.length ? '<div class="card empty">No profiles yet. Set up a migration, then choose <b>Save as profile</b> on the Options & review step or on the summary.</div>'
        : `<div class="profile-grid">${list.map((p) => `
      <section class="card profile">
        <div class="row"><h3 style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(p.name)}</h3>${p.lastRun ? statusBadge(p.lastRun.status, p.lastRun.outcome) : '<span class="badge">Never run</span>'}</div>
        <div class="flow" style="margin:12px 0">
          <div class="end"><div class="lbl">From</div><div class="env">${esc(p.source.envName)}</div><div class="muted small">${esc(p.source.tenantName)}</div></div>
          <div class="arrow" aria-hidden="true">→</div>
          ${p.mode === 'package' || !p.target ? '<div class="end"><div class="lbl">To</div><div class="env">Solution package</div><div class="muted small">Download only</div></div>'
    : `<div class="end"><div class="lbl">To</div><div class="env">${esc(p.target.envName)}</div><div class="muted small">${esc(p.target.tenantName)}</div></div>`}
        </div>
        <dl class="kv small">
          <dt>Solution</dt><dd>${esc(p.solution.displayName)} <span class="muted mono">${esc(p.solution.uniqueName)}</span></dd>
          ${p.rename && p.rename.enabled ? `<dt>Created as</dt><dd class="mono">${esc(p.rename.uniqueName)}</dd>` : ''}
          <dt>Settings</dt><dd>${p.mode === 'package' ? 'Package only' : p.mode === 'cross' ? 'Cross tenant' : 'Same tenant'} · ${p.options && p.options.managed ? 'Managed' : 'Unmanaged'}${(p.excludedObjectIds || []).length ? ` · ${p.excludedObjectIds.length} excluded` : ''}${p.configuration && !p.configuration.skipped ? ` · ${Object.values(p.configuration.mappings || {}).filter((m) => m && m.connectionId).length} connection(s), ${Object.keys(p.configuration.values || {}).length} value(s)` : ''}</dd>
          <dt>Last run</dt><dd>${p.lastRun ? `<button class="link-btn" data-run="${esc(p.lastRun.id)}">${esc(new Date(p.lastRun.startedAt).toLocaleString())}</button>` : '—'}</dd>
        </dl>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-primary btn-sm" data-load="${esc(p.id)}">Load & review</button>
          <button class="btn btn-sm" data-rename="${esc(p.id)}">Rename</button>
          <button class="btn btn-sm btn-ghost" data-del="${esc(p.id)}">Delete</button>
        </div>
      </section>`).join('')}</div>`}`;
  $('#newFromProfiles').addEventListener('click', () => { showView('wizard'); newMigration(); });
  const byId = (id) => list.find((p) => p.id === id);
  main.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => applyProfile(byId(b.dataset.load))));
  main.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => openRun(b.dataset.run)));
  main.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', async () => {
    const p = byId(b.dataset.rename);
    const name = await promptModal('Rename profile', 'Profile name', p.name);
    if (!name || name === p.name) return;
    try {
      const { lastRun, id, createdAt, updatedAt, ...rest } = p;
      await api(`/api/profiles/${p.id}`, { method: 'PUT', body: { ...rest, name } });
      if (state.profile && state.profile.id === p.id) state.profile.name = name;
      loadProfiles();
    } catch (err) { showError(err, 'Could not rename the profile'); }
  }));
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const p = byId(b.dataset.del);
    if (!await confirmModal(`Delete "${p.name}"?`, 'The profile is removed. Its migration history is kept.', 'Delete')) return;
    try {
      await api(`/api/profiles/${p.id}`, { method: 'DELETE' });
      if (state.profile && state.profile.id === p.id) state.profile = null;
      loadProfiles();
    } catch (err) { showError(err, 'Could not delete the profile'); }
  }));
}

function pickEnvFor(sideState, envs, saved) {
  const env = envs.find((e) => e.id === saved.envId) || envs.find((e) => e.url && saved.envUrl && e.url.toLowerCase() === saved.envUrl.toLowerCase());
  if (!env) throw new Error(`The environment "${saved.envName}" is not available to the signed-in account in ${saved.tenantName}.`);
  sideState.envId = env.id;
}

async function applyProfile(p) {
  const need = [];
  if (!state.auth.source.signedIn) need.push('source');
  if (p.mode === 'cross' && !state.auth.target.signedIn) need.push('target');
  if (need.length) {
    state.mode = p.mode;
    showView('wizard');
    go(STEP.CONNECT);
    showError({ message: `Sign in to the ${need.join(' and ')} connection${need.length > 1 ? 's' : ''} first (Source & target step), then load the profile "${p.name}" again.` }, 'Sign-in required');
    return;
  }
  toast(`Loading profile "${p.name}"…`);
  try {
    state.view = 'wizard';
    state.migration = null;
    state.mode = p.mode;
    resetSolution();
    Object.assign(state.target, side());
    state.step = STEP.CONNECT;
    render();

    await loadTenants('source', p.source.tenantId);
    if (state.source.tenantId !== p.source.tenantId) throw new Error(`The source account has no access to the tenant "${p.source.tenantName}".`);
    pickEnvFor(state.source, state.source.envs, p.source);
    if (p.mode === 'package') {
      // no target
    } else if (p.mode === 'cross') {
      await loadTenants('target', p.target.tenantId);
      if (state.target.tenantId !== p.target.tenantId) throw new Error(`The target account has no access to the tenant "${p.target.tenantName}".`);
      pickEnvFor(state.target, state.target.envs, p.target);
    } else {
      pickEnvFor(state.target, state.source.envs.filter((e) => e.id !== state.source.envId), p.target);
    }

    await loadSolutions();
    const sol = state.solutions.find((s) => s.uniqueName.toLowerCase() === p.solution.uniqueName.toLowerCase());
    if (!sol) throw new Error(`The solution "${p.solution.displayName}" (${p.solution.uniqueName}) was not found in ${p.source.envName}.`);
    if (sol.isManaged) throw new Error(`"${sol.displayName}" is managed in ${p.source.envName} and cannot be exported.`);
    state.solutionId = sol.id;
    await loadComponents();
    const excludedObj = new Set((p.excludedObjectIds || []).map((x) => x.toLowerCase()));
    state.excluded = new Set(state.components.filter((c) => excludedObj.has(String(c.objectId).toLowerCase())).map((c) => c.id));
    const missingExcl = excludedObj.size - state.excluded.size;

    state.rename = { enabled: Boolean(p.rename && p.rename.enabled), uniqueName: (p.rename && p.rename.uniqueName) || '', displayName: (p.rename && p.rename.displayName) || '', uniqueTouched: true };
    state.options = { ...DEFAULT_OPTIONS, ...(p.options || {}) };
    delete state.options.acknowledgeUnverifiedCanvasApps;
    delete state.options.overrideCanvasCheck;
    state.cfg = newCfg();
    state.cfg.skipped = Boolean(p.configuration && p.configuration.skipped);
    state.cfg.mappings = JSON.parse(JSON.stringify((p.configuration && p.configuration.mappings) || {}));
    state.cfg.values = JSON.parse(JSON.stringify((p.configuration && p.configuration.values) || {}));
    state.profile = { id: p.id, name: p.name };
    go(STEP.OPTIONS);
    toast(missingExcl > 0 ? `Profile loaded. ${missingExcl} excluded component(s) no longer exist in the solution.` : `Profile "${p.name}" loaded. Review and ${p.mode === 'package' ? 'create the package' : 'start the migration'}.`);
  } catch (err) {
    showError(err, 'Could not load the profile');
    render();
  }
}

// --- settings (app registration) -----------------------------------------------------------------
async function loadSettings() {
  try { state.settings = await api('/api/settings'); } catch (err) { showError(err, 'Could not load settings'); }
  if (state.view === 'settings') render();
}

function renderSettings(main) {
  const s = state.settings;
  if (!s) { main.innerHTML = '<div class="card empty"><span class="spinner"></span> Loading settings…</div>'; return; }
  if (s.hosted) {
    main.innerHTML = `
      <div class="page-head"><div><h2>Settings</h2><p>This migrator is hosted. Its settings are managed on the server by the people who run it.</p></div></div>
      <section class="card">
        <h3>Microsoft sign-in</h3>
        <dl class="kv" style="margin-top:12px">
          <dt>Application (client) ID</dt><dd class="mono">${esc(s.clientId || 'Not set')}</dd>
          <dt>Redirect URI</dt><dd class="mono">${esc(s.redirectUri)}</dd>
          <dt>User registration</dt><dd>${esc({ supabase: 'On (Supabase)', demo: 'On (demo backend)', misconfigured: 'On, but not configured' }[s.registrationMode] || s.registrationMode)}</dd>
          <dt>Migrator version</dt><dd>${esc(s.system.appVersion)}</dd>
        </dl>
        <p class="hint" style="margin-top:12px">For a cross-tenant migration, an administrator of the target tenant approves the app once, the first time someone signs in there.</p>
      </section>`;
    return;
  }
  main.innerHTML = `
    <div class="page-head"><div><h2>Settings</h2><p>The Microsoft Entra ID app registration the migrator signs in with. Saved to <span class="mono">${esc(s.envFile)}</span>.</p></div></div>
    ${state.settingsIntro && !s.clientId ? '<div class="notice warn" style="margin-bottom:16px"><span><b>Set up the app registration to start.</b> Enter the Application (client) ID below. To try the tool without one, run it in demo mode (<span class="mono">MOCK_MODE=true</span>).</span></div>' : ''}
    ${s.mockMode ? '<div class="notice" style="margin-bottom:16px"><span>Demo mode is on, so sign-in is simulated and these settings are not used until you run without <span class="mono">MOCK_MODE=true</span>.</span></div>' : ''}
    <div class="grid-2">
      <section class="card">
        <h3>App registration</h3>
        <p class="card-sub">Changing it signs out the source and target accounts; sign in again afterwards.</p>
        <div class="stack">
          <label class="field"><span>Application (client) ID</span>
            <input class="input mono" id="setClientId" value="${esc(s.clientId || '')}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off">
            <div class="hint" id="setClientIdHint">From the app registration's <b>Overview</b> page in the Entra admin center.</div></label>
          <label class="field"><span>Client secret <span class="muted" style="font-weight:400">(optional)</span></span>
            <input class="input mono" id="setSecret" type="password" placeholder="${s.hasClientSecret ? 'A secret is saved. Leave empty to keep it' : 'Only if the app uses the Web platform'}" autocomplete="new-password">
            <div class="hint">Leave empty for the recommended setup (Mobile and desktop platform, public client). Stored in .env on this computer.</div></label>
          ${s.hasClientSecret ? '<label class="check"><input type="checkbox" id="setRemoveSecret"><span><strong>Remove the saved client secret</strong><span class="muted small">Switch back to a public client.</span></span></label>' : ''}
          ${s.overriddenByEnvironment.length ? `<div class="notice warn"><span>${esc(s.overriddenByEnvironment.join(' and '))} ${s.overriddenByEnvironment.length > 1 ? 'are' : 'is'} also set as a system environment variable, which wins over .env after a restart. Remove it there to keep using the value saved here.</span></div>` : ''}
          <div class="row"><button class="btn btn-primary" id="setSave">Save</button><span class="muted small" id="setStatus"></span></div>
        </div>
      </section>
      <section class="card">
        <h3>Register these in the app registration</h3>
        <dl class="kv" style="margin-top:12px">
          <dt>Redirect URI</dt><dd><span class="mono">${esc(s.redirectUri)}</span> <button class="link-btn small" id="copyRedirect">Copy</button>
            <div class="muted small">Platform <b>Mobile and desktop applications</b>, with <b>Allow public client flows</b> set to Yes.</div></dd>
          <dt>Account types</dt><dd>Accounts in any organizational directory (multitenant), needed for cross-tenant migrations.</dd>
          <dt>API permissions</dt><dd>Delegated: <b>Dynamics CRM</b> › user_impersonation; <b>PowerApps Service</b> › User; <b>Azure Service Management</b> › user_impersonation (optional, lists tenants).</dd>
        </dl>
        <a class="btn btn-sm" style="margin-top:14px" href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Open App registrations ↗</a>
      </section>
    </div>
    ${registrationSettingsCard(s)}
    ${s.system ? `<section class="card" style="margin-top:16px">
      <div class="row"><h3 style="flex:1">System</h3>${s.system.dependenciesReady ? '<span class="badge badge-ok">All components installed</span>' : '<span class="badge badge-warn">Components need updating</span>'}</div>
      <dl class="kv" style="margin-top:12px">
        <dt>Migrator version</dt><dd>${esc(s.system.appVersion)}</dd>
        <dt>Node.js</dt><dd>${esc(s.system.node)} <span class="muted">(${esc(s.system.platform)})</span></dd>
        <dt>Components</dt><dd class="small">${Object.entries(s.system.dependencies).map(([k, v]) => `<span class="type-chip">${esc(k)} <b>${esc(v || 'missing')}</b></span>`).join(' ')}</dd>
        <dt>Saved data</dt><dd class="mono small">${esc(s.system.dataDir)}</dd>
      </dl>
      <p class="hint" style="margin-top:10px">${s.system.dependenciesReady ? 'Start the migrator by double-clicking <b>Start-Migrator.cmd</b>. It installs or updates components by itself when needed.' : 'Close the migrator window and double-click <b>Start-Migrator.cmd</b>: it updates the components and restarts.'}</p>
    </section>` : ''}`;
  const idInput = $('#setClientId');
  const validate = () => {
    const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idInput.value.trim());
    idInput.classList.toggle('invalid', Boolean(idInput.value.trim()) && !ok);
    $('#setClientIdHint').classList.toggle('error', Boolean(idInput.value.trim()) && !ok);
    $('#setClientIdHint').innerHTML = idInput.value.trim() && !ok
      ? 'That is not a valid ID. It looks like <span class="mono">3d7c1ae2-f89d-4d8f-ad33-662f352bceb5</span>.'
      : 'From the app registration\'s <b>Overview</b> page in the Entra admin center.';
    return ok;
  };
  idInput.addEventListener('input', validate);
  wireRegistrationSettings();
  $('#copyRedirect').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(s.redirectUri); toast('Redirect URI copied'); } catch { toast(s.redirectUri); }
  });
  $('#setSave').addEventListener('click', async () => {
    if (!validate()) { idInput.focus(); return; }
    const btn = $('#setSave');
    btn.disabled = true;
    try {
      const rm = document.getElementById('setRemoveSecret');
      const res = await api('/api/settings', {
        method: 'PUT',
        body: { clientId: idInput.value.trim(), clientSecret: $('#setSecret').value, removeClientSecret: Boolean(rm && rm.checked) },
      });
      state.settings = res;
      state.settingsIntro = false;
      if (!res.changed) { toast('No changes to save'); render(); return; }
      state.config = await api('/api/config');
      state.auth = await api('/api/auth/status');
      Object.assign(state.source, side());
      Object.assign(state.target, side());
      resetSolution();
      state.migration = null;
      toast('Saved. Sign in again on the Source & target step.');
      render();
    } catch (err) {
      showError(err, 'Could not save the settings');
    } finally {
      const b = document.getElementById('setSave');
      if (b) b.disabled = false;
    }
  });
}

// --- history -------------------------------------------------------------------------------------
async function loadHistory() {
  try { state.history = await api('/api/history'); } catch (err) { state.history = []; showError(err, 'Could not load history'); }
  if (state.view === 'history') render();
}

async function openRun(id) {
  try {
    state.historyRun = await api(`/api/migrations/${id}`);
    state.view = 'run';
    render();
    window.scrollTo({ top: 0 });
  } catch (err) { showError(err, 'Could not open the migration'); }
}

function renderHistory(main) {
  const all = state.history;
  const f = state.historyFilter;
  main.innerHTML = `
    <div class="page-head"><div><h2>Migration history</h2><p>Every migration run on this computer, newest first. Select a row to see its summary, logs and downloads.</p></div>
      <button class="btn btn-sm" id="histRefresh">Refresh</button></div>
    <div class="toolbar">
      <input class="input" id="histSearch" type="search" placeholder="Search solution, environment, profile, user" value="${esc(f.q)}" aria-label="Search history">
      <select class="input" id="histStatus" aria-label="Filter by status"><option value="">All results</option>
        ${[['succeeded', 'Succeeded'], ['attention', 'Configuration required / errors'], ['failed', 'Failed'], ['cancelled', 'Stopped'], ['interrupted', 'Interrupted'], ['running', 'Running']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="list" id="histList"></div>`;
  const draw = () => {
    const el = $('#histList');
    if (!all) { el.innerHTML = '<div class="empty"><span class="spinner"></span> Loading history…</div>'; return; }
    const q = f.q.toLowerCase();
    const rows = all.filter((r) => (!f.status || r.status === f.status) && (!q || [
      r.solution && r.solution.displayName, r.solution && r.solution.uniqueName, r.finalUniqueName,
      r.source && r.source.environment && r.source.environment.name, r.target && r.target.environment && r.target.environment.name,
      r.profile && r.profile.name, r.startedBy, r.packageOnly ? 'package only' : '',
    ].filter(Boolean).join(' ').toLowerCase().includes(q)));
    if (!rows.length) { el.innerHTML = `<div class="empty">${all.length ? 'No migrations match your filter.' : 'No migrations yet.'}</div>`; return; }
    el.innerHTML = rows.map((r) => {
      const dur = r.finishedAt ? fmtDuration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : '';
      return `<div class="list-row hist-row" data-id="${esc(r.id)}" role="button" tabindex="0">
        <div class="main"><div class="title">${esc(r.solution ? r.solution.displayName : '(solution not read)')}
          ${r.finalUniqueName && r.solution && r.finalUniqueName !== r.solution.uniqueName ? `<span class="muted small"> → ${esc(r.finalUniqueName)}</span>` : ''}</div>
          <div class="muted small">${esc(r.source && r.source.environment ? r.source.environment.name : '?')} → ${r.packageOnly ? 'solution package' : esc(r.target && r.target.environment ? r.target.environment.name : '?')}${r.crossTenant ? ' · cross tenant' : ''}${r.packageOnly ? ' · package only' : ''}
            · ${esc(new Date(r.startedAt).toLocaleString())}${dur ? ` · ${dur}` : ''}${r.startedBy ? ` · ${esc(r.startedBy)}` : ''}</div>
          ${r.error && r.status !== 'succeeded' && r.status !== 'attention' ? `<div class="small" style="color:var(--err);overflow-wrap:anywhere">${esc(r.error.step)}: ${esc(r.error.message.slice(0, 160))}</div>` : ''}</div>
        <div class="meta">${r.profile ? `<span class="badge badge-accent">${esc(r.profile.name)}</span>` : ''}${statusBadge(r.status, r.outcome)}</div>
      </div>`;
    }).join('');
    el.querySelectorAll('.hist-row').forEach((row) => {
      row.addEventListener('click', () => openRun(row.dataset.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRun(row.dataset.id); });
    });
  };
  draw();
  $('#histSearch').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $('#histStatus').addEventListener('change', (e) => { f.status = e.target.value; draw(); });
  $('#histRefresh').addEventListener('click', () => { state.history = null; draw(); loadHistory(); });
}

// Create a connection / Copy link / Refresh connections, with the account and instructions below.
function connectionToolbar(target) {
  const slot = targetSlot();
  const acct = state.auth[slot] && state.auth[slot].account;
  const url = target && target.connectionsUrl;
  const href = url ? `/auth/open?slot=${encodeURIComponent(slot)}&tenant=${encodeURIComponent(targetTenantId() || '')}&next=${encodeURIComponent(url)}` : '';
  return `<section class="card conn-manage" style="margin-bottom:16px">
    <div class="conn-manage-top">
      <div class="conn-manage-title"><h3>Create and manage target connections</h3>
        ${acct ? `<div class="conn-account muted small">Target account: <b>${esc(acct.username)}</b></div>` : ''}</div>
      <div class="conn-actions">
        ${url ? `<a class="btn btn-sm btn-primary" href="${esc(href)}" target="_blank" rel="noopener">Create a connection in ${esc(target.name)} ↗</a>
        <button type="button" class="btn btn-sm" data-copy-url="${esc(url)}" title="Copy the link to open it in a private window or another browser profile">Copy link</button>` : ''}
        <button type="button" class="btn btn-sm" id="connRefresh">↻ Refresh connections</button>
      </div>
    </div>
    ${url ? `<details class="conn-howto"><summary>How to create a connection?</summary>
      <ol class="conn-help small">
        <li><b>Create a connection</b> signs in to Power Apps with the target account first, then opens the Connections page.</li>
        <li>If Power Apps still opens with another account, use <b>Copy link</b> and open it in a private window.</li>
        <li>When you're done, click <b>Refresh connections</b> to list the new connection here.</li>
      </ol></details>` : ''}
  </section>`;
}

// --- Power Apps links opened as the right account --------------------------------------------
function accountLink(slot, tenantId, url, label, cls = '') {
  const acct = state.auth[slot] && state.auth[slot].account;
  const href = `/auth/open?slot=${encodeURIComponent(slot)}&tenant=${encodeURIComponent(tenantId || '')}&next=${encodeURIComponent(url)}`;
  return `<span class="acct-link"><a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>
    <button type="button" class="link-btn small" data-copy-url="${esc(url)}" title="Copy the link to open it in a private window or another browser profile">Copy link</button>
    ${acct ? `<span class="muted small">opens as ${esc(acct.username)}</span>` : ''}</span>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-copy-url]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copyUrl); toast('Link copied. Paste it into a private window signed in with the right account.'); } catch { toast(b.dataset.copyUrl); }
});

// --- connections step: pick existing connections automatically ---------------------------------
function autoSelectConnections(connector) {
  const c = state.cfg;
  if (!c.data || c.skipped) return;
  c.touched = c.touched || {};
  const list = ((c.conns[connector] || {}).list) || [];
  for (const r of c.data.connectionReferences.filter((x) => x.connectorName === connector)) {
    if (c.mappings[r.logicalName] || c.touched[r.logicalName]) continue; // the user's or a profile's choice wins
    const base = { displayName: r.displayName, connectorId: r.connectorId };
    if (r.targetConnectionId) {
      const cur = list.find((x) => x.id === r.targetConnectionId);
      c.mappings[r.logicalName] = { ...base, connectionId: r.targetConnectionId, connectionName: cur ? cur.displayName : 'Current connection in the target', auto: 'current' };
      continue;
    }
    const usable = list.filter((x) => x.connected);
    if (usable.length === 1) c.mappings[r.logicalName] = { ...base, connectionId: usable[0].id, connectionName: usable[0].displayName, auto: 'single' };
  }
}

// --- Options & review: does the solution already exist in the target? --------------------------
function finalUniqueName() {
  const sol = selectedSolution();
  if (!sol) return null;
  if (state.rename.enabled) return renameError() ? null : state.rename.uniqueName;
  return sol.uniqueName;
}

let targetCheckTimer = null;
function scheduleTargetCheck() {
  clearTimeout(targetCheckTimer);
  const name = finalUniqueName();
  const key = `${state.target.envId}|${name}`;
  const prev = state.targetCheck;
  if (!name) { state.targetCheck = null; updateTargetCheckPanel(); return; }
  if (!prev || prev.key !== key) {
    state.targetCheck = { key, name, loading: true, result: null, error: null, confirm: false };
    updateTargetCheckPanel();
  } else if (!prev.loading) return; // same name, result already known
  // (Re)start the debounce whenever this name is still waiting, so a cancelled timer is always replaced.
  targetCheckTimer = setTimeout(() => runTargetCheck(true), 450);
}

// force: ask the target again even for the same name (e.g. the target changed after a migration).
async function runTargetCheck(force) {
  const name = finalUniqueName();
  const key = `${state.target.envId}|${name}`;
  if (!name) { state.targetCheck = null; updateTargetCheckPanel(); return; }
  const prev = state.targetCheck;
  if (!force && prev && prev.key === key && (prev.result || prev.loading)) { updateTargetCheckPanel(); return; }
  state.targetCheck = { key, name, loading: true, result: null, error: null, confirm: Boolean(prev && prev.key === key && prev.confirm) };
  updateTargetCheckPanel();
  try {
    state.targetCheck.result = await api(`/api/${targetSlot()}/tenants/${targetTenantId()}/environments/${state.target.envId}/solution-by-name/${encodeURIComponent(name)}`);
  } catch (err) { state.targetCheck.error = err; }
  if (state.targetCheck.key !== key) return;
  state.targetCheck.loading = false;
  updateTargetCheckPanel();
}

function versionCompare(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// 'none' | 'new' | 'update' | 'blocked'
function targetCheckState() {
  const t = state.targetCheck;
  if (t && t.key !== `${state.target.envId}|${finalUniqueName()}`) return 'pending'; // name changed, result is stale
  if (!t || t.loading || t.error || !t.result) return t && t.error && !t.loading ? 'error' : 'pending';
  if (!t.result.exists) return 'new';
  const ex = t.result.solution;
  if (ex.isManaged !== Boolean(state.options.managed)) return 'blocked';
  if (state.options.managed && versionCompare(selectedSolution().version, ex.version) < 0) return 'blocked';
  return 'update';
}

function targetCheckPassed() {
  const st = targetCheckState();
  if (st === 'new') return true;
  if (st === 'update') return Boolean(state.targetCheck.confirm);
  return false;
}

function startBlocked() {
  if (pkgMode()) return Boolean(renameError()) || !canvasCheckPassed();
  return Boolean(renameError()) || !canvasCheckPassed() || !targetCheckPassed();
}

// Name availability shown right under the name: ✓ Name available / ✗ Solution already exists.
function targetCheckCard() {
  const t = state.targetCheck;
  const env = targetEnv();
  const envName = esc(env ? env.name : 'the target');
  const sol = selectedSolution();
  const renameBtn = state.rename.enabled ? '' : '<button class="btn btn-sm" id="tcRename">Use a different name</button>';
  let inner = '';
  const st = targetCheckState();
  if (!t) inner = '';
  else if (st === 'pending') inner = `<div class="ns-line muted"><span class="spinner"></span> Checking whether <span class="mono">${esc(t.name)}</span> is available in ${envName}…</div>`;
  else if (st === 'error') inner = `<div class="ns-box warn"><div class="ns-line warn">Availability couldn't be checked</div><div class="hint">${esc(t.error.message)} <button type="button" class="link-btn" id="tcRetry">Try again</button></div></div>`;
  else if (st === 'new') inner = `<div class="ns-box ok"><div class="ns-line ok"><span class="ns-icon" aria-hidden="true">✓</span> Solution name available</div>
      <div class="hint"><span class="mono">${esc(t.name)}</span> doesn't exist in ${envName}; a new solution will be created.</div></div>`;
  else {
    const ex = t.result.solution;
    const kind = (x) => (x ? 'managed' : 'unmanaged');
    const cmp = versionCompare(sol.version, ex.version);
    const head = '<div class="ns-line err" role="alert"><span class="ns-icon" aria-hidden="true">✗</span> Solution already exists</div>';
    if (st === 'blocked') {
      const reason = ex.isManaged !== Boolean(state.options.managed)
        ? `It's installed as ${kind(ex.isManaged)}, so a ${kind(state.options.managed)} solution with the same name can't be imported over it. Enter a different name or change the package type.`
        : `The target has v${esc(ex.version)}, newer than v${esc(sol.version)}; a managed solution can't be downgraded. Enter a different name.`;
      inner = `<div class="ns-box err">${head}<div class="hint"><span class="mono">${esc(t.name)}</span> v${esc(ex.version)} is in ${envName}. ${reason}</div></div>
        ${renameBtn ? `<div class="row" style="margin-top:6px">${renameBtn}</div>` : ''}`;
    } else {
      inner = `<div class="ns-box err">${head}<div class="hint"><span class="mono">${esc(t.name)}</span> v${esc(ex.version)} (${kind(ex.isManaged)}) is in ${envName}. Importing ${cmp > 0 ? `updates it to v${esc(sol.version)}` : cmp === 0 ? `replaces it with the same version (v${esc(sol.version)})` : `replaces it with an older version (v${esc(sol.version)})`}.</div></div>
        <label class="check"><input type="checkbox" id="tcConfirm" ${t.confirm ? 'checked' : ''}><span><strong>Update the existing solution</strong><span class="muted small">Required to continue${state.rename.enabled ? ', or enter a different unique name above' : ', or use a different name'}.</span></span></label>
        ${renameBtn ? `<div class="row">${renameBtn}</div>` : ''}`;
    }
  }
  if (!t) inner = `<div class="ns-line muted">${state.rename.enabled && renameError() ? 'Enter a valid unique name to check it.' : 'Not checked yet.'}</div>`;
  const busy = t && (t.loading || st === 'pending');
  return `<div class="name-status target-check" aria-live="polite">
    <div class="ns-head"><span class="ns-title">Name check in ${envName}</span>
      <button type="button" class="btn btn-sm" id="tcRefresh" title="Reset the display name and unique name to the source solution's names, then check again">↺ Reset names</button></div>
    ${inner}</div>`;
}

function updateTargetCheckPanel() {
  if (state.view !== 'wizard' || state.step !== STEP.OPTIONS) return;
  const el = document.querySelector('.target-check');
  if (!el) return;
  el.outerHTML = targetCheckCard();
  wireTargetCheck();
  const start = document.getElementById('start');
  if (start) start.disabled = startBlocked();
}

// Reset names: both names go back to the source solution's names, then the name is checked again.
// The unique name follows the display name again until it is edited.
function resetSolutionNames() {
  const sol = selectedSolution();
  if (!sol) return;
  const r = state.rename;
  r.displayName = sol.displayName;
  r.uniqueName = sol.uniqueName;
  r.uniqueTouched = false;
  render(); // renderOptions checks the (reset) name in the target
  runTargetCheck(true);
  toast('Names reset to the source solution names.');
}

function wireTargetCheck() {
  const rf = document.getElementById('tcRefresh');
  if (rf) rf.addEventListener('click', resetSolutionNames);
  const tr = document.getElementById('tcRetry');
  if (tr) tr.addEventListener('click', () => runTargetCheck(true));
  const c = document.getElementById('tcConfirm');
  if (c) c.addEventListener('change', () => { state.targetCheck.confirm = c.checked; const s = document.getElementById('start'); if (s) s.disabled = startBlocked(); });
  const r = document.getElementById('tcRename');
  if (r) r.addEventListener('click', () => {
    switchToRename('rnUnique');
    const d = document.getElementById('rnUnique');
    if (d) d.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

// --- tab lifecycle: closing the tab stops the migrator (when started by Start-Migrator.cmd) ------
let leavingForSignIn = false;
const pageId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(16).slice(2)}`;

function startHeartbeat() {
  const beat = () => api('/api/session/heartbeat', { method: 'POST', body: { id: pageId } }).catch(() => {});
  beat();
  setInterval(beat, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
  window.addEventListener('pagehide', () => {
    if (leavingForSignIn) return; // coming back after Microsoft sign-in
    try { navigator.sendBeacon('/api/session/closed', JSON.stringify({ id: pageId })); } catch { /* ignore */ }
  });
  // Closing the tab during a migration doesn't stop it (the migrator finishes it first), but warn.
  window.addEventListener('beforeunload', (e) => {
    if (state.migration && state.migration.status === 'running' && !leavingForSignIn) { e.preventDefault(); e.returnValue = ''; }
  });
  const f = document.querySelector('.app-footer');
  if (f) f.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:4px">Closing this tab stops the migrator.</div>');
}

// --- boot ------------------------------------------------------------------------------------
(async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (err) { showError(err, 'Could not reach the migrator service'); return; }
  $('#modeBadge').hidden = !state.config.mockMode;
  if (state.config.serverless) {
    // Serverless hosting (Vercel functions) stops the server after each request: say so up front.
    document.querySelector('.app-header').insertAdjacentHTML('afterend', `<div class="host-banner" role="alert"><b>This deployment can't run migrations.</b>
      It runs on serverless functions (for example Vercel), which stop after each request: Microsoft sign-ins are lost between
      requests and a long export or import is cut off. Run the migrator as a continuously running Node.js server (Azure App Service,
      a container or a VM): see <b>DEPLOYMENT.md</b>.</div>`);
  }
  if (state.config.autoExit) startHeartbeat();
  // User registration: show sign-in / registration until an active member is signed in.
  try {
    if (!await accountBoot()) return;
  } catch (err) { showError(err, 'Could not reach the account service'); return; }
  try {
    state.auth = await api('/api/auth/status');
  } catch (err) { showError(err, 'Could not reach the migrator service'); }
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  render();
  if (!state.config.configured) {
    state.settingsIntro = true;
    showView('settings');
  }
  const pending = sessionStorage.getItem('psm-auth');
  if (pending) { sessionStorage.removeItem('psm-auth'); receiveAuth(JSON.parse(pending)); }
  else {
    if (state.auth.source.signedIn) loadTenants('source');
  }
})();
