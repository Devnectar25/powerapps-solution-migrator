/* PowerApps Solution Migrator — user registration & organization profiles (front end).
 * Sign-in, registration, email verification, approval status, password reset, and the Account page
 * (profile, organization, members). Uses the helpers in app.js (state, api, esc, toast, …). */
'use strict';

const acct = { status: null, screen: 'login', notice: null, pending: null, members: null, tab: 'profile', domainCheck: null };

// --- boot ----------------------------------------------------------------------------------------
// Returns true when the tool may be shown (registration off, or an active member is signed in).
async function accountBoot() {
  if (!state.config.registration) return true;
  // Back from an email link (verification or password reset): tokens are in the URL fragment.
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (frag.get('access_token') && frag.get('refresh_token')) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      acct.status = await api('/api/account/session', { method: 'POST', body: { accessToken: frag.get('access_token'), refreshToken: frag.get('refresh_token'), type: frag.get('type') } });
      if (acct.status.recovery) acct.screen = 'newPassword';
      else acct.notice = frag.get('type') === 'signup' ? { tone: 'ok', text: 'Your email address is verified.' } : null;
    } catch (err) {
      acct.status = await api('/api/account/status').catch(() => ({ enabled: true, signedIn: false }));
      acct.notice = { tone: 'err', text: `The link could not be used: ${err.message} Sign in, or request a new link.` };
    }
  } else if (frag.get('error_description')) {
    history.replaceState(null, '', location.pathname + location.search);
    acct.notice = { tone: 'err', text: `${frag.get('error_description').replace(/\+/g, ' ')}. Sign in, or request a new link.` };
    acct.status = await api('/api/account/status');
  } else {
    acct.status = await api('/api/account/status');
  }
  if (acct.status.signedIn && acct.status.state === 'active' && !acct.status.recovery) {
    showAccountChip();
    return true;
  }
  renderAccountGate();
  return false;
}

// Called by api() when the server says the account session is gone.
function accountExpired() {
  if (!state.config.registration || document.body.classList.contains('locked')) return;
  acct.status = { ...(acct.status || {}), signedIn: false };
  acct.screen = 'login';
  acct.notice = { tone: 'warn', text: 'Your session has ended. Sign in again.' };
  renderAccountGate();
}

// --- gate screens ----------------------------------------------------------------------------------
function renderAccountGate() {
  document.body.classList.add('locked');
  const chip = document.getElementById('acctChip');
  if (chip) chip.remove();
  $('#stepper').hidden = true;
  const main = $('#main');
  const st = acct.status || {};
  let inner;
  if (st.misconfigured) inner = gateMisconfigured();
  else if (st.signedIn && st.recovery) inner = gateNewPassword();
  else if (st.signedIn && st.accountError) inner = gateMessage('err', 'Registration could not be completed', st.accountError, true);
  else if (st.signedIn && st.state === 'pending') inner = gatePending();
  else if (st.signedIn && st.state === 'rejected') inner = gateMessage('err', 'Request not approved', `Your request to join <b>${esc(st.account.organization.name)}</b> was not approved. Contact an administrator of your organization if you think this is a mistake.`, true, true);
  else if (st.signedIn && st.state === 'suspended') inner = gateMessage('warn', 'Access suspended', `Your access to <b>${esc(st.account.organization.name)}</b> has been suspended by an administrator of your organization.`, true, true);
  else if (acct.screen === 'register') inner = gateRegister();
  else if (acct.screen === 'checkEmail') inner = gateCheckEmail();
  else if (acct.screen === 'forgot') inner = gateForgot();
  else inner = gateLogin();
  main.innerHTML = `<div class="auth-wrap ${acct.screen === 'register' && !st.signedIn ? 'wide' : ''}">${inner}</div>`;
  wireGate(main);
}

const notice = () => (acct.notice ? `<div class="notice ${acct.notice.tone || ''}" style="margin-bottom:14px"><span>${acct.notice.html || esc(acct.notice.text)}</span></div>` : '');
const authSide = (title, text) => `<aside class="auth-side">
    <img src="brand/powercraft-logo-white.svg" alt="Powercraft" class="auth-logo">
    <h2>${title}</h2><p>${text}</p>
    <ul>
      <li>Package only, same-tenant and cross-tenant migrations</li>
      <li>One registered organization per company domain</li>
      <li>Organization administrators approve their colleagues</li>
    </ul>
    <p class="small auth-side-note">Your Microsoft sign-in for Power Platform stays separate: you connect your tenants inside the tool.</p>
  </aside>`;

function gateLogin() {
  const st = acct.status || {};
  return `<div class="auth-card">
    ${authSide('Sign in to the PowerApps Solution Migrator', 'Use the account you registered with your organization.')}
    <form class="auth-form" id="loginForm" novalidate>
      <h2>Sign in</h2>
      ${notice()}
      ${st.backend === 'demo' && st.demo ? `<div class="notice" style="margin-bottom:14px"><span><b>Demo mode:</b> sign in as <span class="mono">${esc(st.demo.email)}</span> / <span class="mono">${esc(st.demo.password)}</span>, or register a new organization. <button type="button" class="link-btn" id="useDemo">Use the demo account</button></span></div>` : ''}
      <label class="field"><span>Work email</span><input class="input" id="liEmail" type="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input class="input" id="liPassword" type="password" autocomplete="current-password" required></label>
      <div class="auth-row"><label class="check inline"><input type="checkbox" id="liRemember"><span>Keep me signed in on this computer</span></label>
        <button type="button" class="link-btn small" data-screen="forgot">Forgot password?</button></div>
      <button class="btn btn-primary auth-submit" type="submit" id="liSubmit">Sign in</button>
      <p class="auth-switch">New to the migrator? <button type="button" class="link-btn" data-screen="register">Register your organization</button></p>
    </form></div>`;
}

function gateRegister() {
  const st = acct.status || {};
  const d = acct.draft || {};
  const v = (k) => esc(d[k] || '');
  const dc = acct.domainCheck;
  return `<div class="auth-card wide">
    <form class="auth-form" id="regForm" novalidate>
      <div class="auth-form-head"><img src="brand/powercraft-icon.svg" alt="" class="auth-icon"><div><h2>Register</h2>
        <p class="muted">An authorized representative registers the organization. Colleagues who register later with the same email domain join it after approval.</p></div></div>
      ${notice()}
      <div class="reg-grid">
        <fieldset class="reg-section"><legend>Organization details</legend>
          <label class="field"><span>Organization name</span><input class="input" name="orgName" value="${v('orgName')}" maxlength="200" autocomplete="organization" required></label>
          <label class="field"><span>Organization domain</span><input class="input mono" name="orgDomain" value="${v('orgDomain')}" placeholder="e.g. powercraft.co" maxlength="120" spellcheck="false" required>
            <div class="hint" id="domainHint">${dc && dc.domain === (d.orgDomain || '').toLowerCase() && dc.exists ? '<span class="dom-exists">This organization is already registered. You\'ll join it as a member once one of its administrators approves your request.</span>' : 'Your company\'s email domain.'}</div></label>
          <label class="field"><span>Organization type</span><select class="input" name="orgType" required>
            <option value="">— Select —</option>${(st.orgTypes || []).map((t) => `<option ${d.orgType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label class="field"><span>Organization location</span><input class="input" name="orgLocation" value="${v('orgLocation')}" placeholder="City, country" maxlength="120" required></label>
        </fieldset>
        <fieldset class="reg-section"><legend>Representative details</legend>
          <label class="field"><span>Full name</span><input class="input" name="fullName" value="${v('fullName')}" maxlength="120" autocomplete="name" required></label>
          <label class="field"><span>Official work email</span><input class="input" name="email" type="email" value="${v('email')}" autocomplete="email" required>
            <div class="hint">Must use the organization domain. Personal addresses (Gmail, Outlook.com…) are not accepted.</div></label>
          <label class="field"><span>Designation / role</span><input class="input" name="designation" value="${v('designation')}" maxlength="120" autocomplete="organization-title" required></label>
          <label class="field"><span>Contact number <span class="muted" style="font-weight:400">(optional)</span></span><input class="input" name="phone" type="tel" value="${v('phone')}" maxlength="30" autocomplete="tel"></label>
        </fieldset>
      </div>
      <fieldset class="reg-section"><legend>Password</legend>
        <div class="grid-2 tight">
          <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="new-password" required>
            <div class="hint">At least 10 characters, with upper-case and lower-case letters and a number.</div></label>
          <label class="field"><span>Confirm password</span><input class="input" name="password2" type="password" autocomplete="new-password" required></label>
        </div>
      </fieldset>
      <label class="check"><input type="checkbox" name="authorized" ${d.authorized ? 'checked' : ''}><span><strong>I'm authorized to register on behalf of this organization</strong><span class="muted small">Your details are stored to manage access to the migrator.</span></span></label>
      <div class="auth-actions"><button type="button" class="btn" data-screen="login">Back to sign in</button><button class="btn btn-primary" type="submit" id="regSubmit">Create account</button></div>
    </form></div>`;
}

function gateCheckEmail() {
  const p = acct.pending || {};
  return `<div class="auth-card narrow"><div class="auth-form">
    <div class="auth-state-icon ok" aria-hidden="true">✉</div>
    <h2>Check your email</h2>
    <p>We sent a verification link to <b>${esc(p.email)}</b>. Open it to verify your address; you'll come back here signed in.</p>
    ${p.existingOrganization ? '<div class="notice" style="margin:12px 0"><span>Your organization is already registered. After you verify your email, an administrator of your organization approves your request.</span></div>' : '<div class="notice ok" style="margin:12px 0"><span>You\'re the first person from your organization: after you verify your email, you become its owner and can approve colleagues.</span></div>'}
    ${p.demoVerifyUrl ? `<div class="notice warn" style="margin-bottom:12px"><span><b>Demo mode:</b> no email is sent. <a class="link-btn" href="${esc(p.demoVerifyUrl)}">Open the verification link</a></span></div>` : ''}
    ${notice()}
    <div class="auth-actions"><button type="button" class="btn" data-screen="login">Back to sign in</button><button type="button" class="btn" id="resend">Send the link again</button></div>
  </div></div>`;
}

function gateForgot() {
  return `<div class="auth-card narrow"><form class="auth-form" id="forgotForm" novalidate>
    <h2>Reset your password</h2>
    <p class="muted">Enter your work email. If it's registered, we send a link to set a new password.</p>
    ${notice()}
    <label class="field"><span>Work email</span><input class="input" id="fgEmail" type="email" autocomplete="username" required></label>
    <div class="auth-actions"><button type="button" class="btn" data-screen="login">Back to sign in</button><button class="btn btn-primary" type="submit">Send link</button></div>
  </form></div>`;
}

function gateNewPassword() {
  return `<div class="auth-card narrow"><form class="auth-form" id="newPwForm" novalidate>
    <h2>Set a new password</h2>
    <p class="muted">For <b>${esc(acct.status.user && acct.status.user.email)}</b>.</p>
    ${notice()}
    <label class="field"><span>New password</span><input class="input" id="npPw" type="password" autocomplete="new-password" required>
      <div class="hint">At least 10 characters, with upper-case and lower-case letters and a number.</div></label>
    <label class="field"><span>Confirm new password</span><input class="input" id="npPw2" type="password" autocomplete="new-password" required></label>
    <div class="auth-actions"><button type="button" class="btn" id="gateSignOut">Cancel</button><button class="btn btn-primary" type="submit">Save password</button></div>
  </form></div>`;
}

function gatePending() {
  const a = acct.status.account;
  return `<div class="auth-card narrow"><div class="auth-form">
    <div class="auth-state-icon warn" aria-hidden="true">⏳</div>
    <h2>Waiting for approval</h2>
    ${notice()}
    <p>Your request to join <b>${esc(a.organization.name)}</b> <span class="muted">(${esc(a.organization.domain)})</span> was sent to its administrators. You can use the migrator as soon as one of them approves it.</p>
    <dl class="kv" style="margin:14px 0"><dt>Name</dt><dd>${esc(a.profile.full_name)}</dd><dt>Email</dt><dd>${esc(a.profile.email)}</dd><dt>Requested</dt><dd>${esc(new Date(a.membership.created_at).toLocaleString())}</dd></dl>
    <div class="auth-actions"><button type="button" class="btn" id="gateSignOut">Sign out</button><button type="button" class="btn btn-primary" id="gateRecheck">Check again</button></div>
  </div></div>`;
}

function gateMessage(tone, title, html, signOut) {
  return `<div class="auth-card narrow"><div class="auth-form">
    <div class="auth-state-icon ${tone}" aria-hidden="true">${tone === 'err' ? '!' : '⏸'}</div>
    <h2>${esc(title)}</h2>
    <p>${tone === 'err' && !/<b>/.test(html) ? esc(html) : html}</p>
    <div class="auth-actions">${signOut ? '<button type="button" class="btn" id="gateSignOut">Sign out</button>' : ''}<button type="button" class="btn btn-primary" id="gateRecheck">Check again</button></div>
  </div></div>`;
}

function gateMisconfigured() {
  return `<div class="auth-card narrow"><div class="auth-form">
    <div class="auth-state-icon err" aria-hidden="true">!</div>
    <h2>Registration is not configured</h2>
    <p>User registration is switched on (<span class="mono">REGISTRATION=on</span>), but the Supabase project isn't set. Enter the Supabase URL and anon key on the Settings page, or set <span class="mono">SUPABASE_URL</span> and <span class="mono">SUPABASE_ANON_KEY</span> in <span class="mono">.env</span>. See <b>SUPABASE_SETUP.md</b>.</p>
    <div class="auth-actions"><button type="button" class="btn btn-primary" id="gateSettings">Open Settings</button></div>
  </div></div>`;
}

// --- gate wiring ------------------------------------------------------------------------------------
function fieldError(form, name, message) {
  form.querySelectorAll('.field .hint.error.dynamic').forEach((h) => h.remove());
  form.querySelectorAll('.input.invalid').forEach((i) => i.classList.remove('invalid'));
  const input = name && form.querySelector(`[name="${name}"], #${name}`);
  if (!input) return false;
  input.classList.add('invalid');
  input.insertAdjacentHTML('afterend', `<div class="hint error dynamic">${esc(message)}</div>`);
  input.focus();
  return true;
}

async function busy(btn, fn) {
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); } finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = label; } }
}

async function afterSignIn(status) {
  acct.status = status;
  acct.notice = null;
  if (status.state === 'active' && !status.recovery && !status.accountError) { location.replace('/'); return; }
  renderAccountGate();
}

function wireGate(main) {
  main.querySelectorAll('[data-screen]').forEach((b) => b.addEventListener('click', () => { acct.screen = b.dataset.screen; acct.notice = null; renderAccountGate(); }));
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

  on('useDemo', 'click', () => { $('#liEmail').value = acct.status.demo.email; $('#liPassword').value = acct.status.demo.password; $('#liSubmit').click(); });
  on('loginForm', 'submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const email = $('#liEmail').value.trim();
    const password = $('#liPassword').value;
    if (!email) return fieldError(form, 'liEmail', 'Enter your work email.');
    if (!password) return fieldError(form, 'liPassword', 'Enter your password.');
    await busy($('#liSubmit'), async () => {
      try {
        await afterSignIn(await api('/api/account/login', { method: 'POST', body: { email, password, remember: $('#liRemember').checked } }));
      } catch (err) {
        acct.notice = { tone: 'err', text: err.message };
        if (/Verify your email/.test(err.message)) { acct.pending = { email }; acct.notice.html = `${esc(err.message)} <button type="button" class="link-btn" id="resendFromLogin">Send the link again</button>`; }
        renderAccountGate();
        $('#liEmail').value = email;
        on('resendFromLogin', 'click', () => resend(email));
      }
    });
  });

  const regForm = document.getElementById('regForm');
  if (regForm) {
    const read = () => Object.fromEntries([...new FormData(regForm).entries()].map(([k, val]) => [k, typeof val === 'string' ? val : '']).concat([['authorized', regForm.authorized.checked]]));
    regForm.addEventListener('input', () => { acct.draft = { ...read(), password: '', password2: '' }; });
    // Suggest the domain from the work email, and say whether the organization already exists.
    let t = null;
    const checkDomain = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const domain = regForm.orgDomain.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        const hint = document.getElementById('domainHint');
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) { acct.domainCheck = null; hint.innerHTML = 'Your company\'s email domain.'; return; }
        try {
          const r = await api(`/api/account/org-exists?domain=${encodeURIComponent(domain)}`);
          acct.domainCheck = { domain, exists: r.exists };
          hint.innerHTML = r.freeMail ? '<span class="dom-bad">Personal email domains can\'t be registered as an organization.</span>'
            : r.exists ? '<span class="dom-exists">This organization is already registered. You\'ll join it as a member once one of its administrators approves your request.</span>'
              : '<span class="dom-new">New organization: you\'ll be its owner.</span>';
        } catch { /* the server checks again on submit */ }
      }, 400);
    };
    regForm.orgDomain.addEventListener('input', checkDomain);
    regForm.email.addEventListener('change', () => {
      const dom = (regForm.email.value.split('@')[1] || '').trim().toLowerCase();
      if (dom && !regForm.orgDomain.value.trim()) { regForm.orgDomain.value = dom; checkDomain(); }
    });
    if (regForm.orgDomain.value) checkDomain();
    regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = read();
      if (data.password !== data.password2) return fieldError(regForm, 'password2', 'The passwords don\'t match.');
      if (!data.authorized) return fieldError(regForm, 'authorized', 'Confirm that you are authorized to register this organization.');
      await busy($('#regSubmit'), async () => {
        try {
          const r = await api('/api/account/register', { method: 'POST', body: data });
          acct.pending = r;
          acct.draft = null;
          acct.notice = null;
          acct.screen = 'checkEmail';
          renderAccountGate();
        } catch (err) {
          if (!fieldError(regForm, err.field, err.message)) { acct.notice = { tone: 'err', text: err.message }; renderAccountGate(); }
        }
      });
    });
  }

  on('resend', 'click', () => resend(acct.pending && acct.pending.email));
  on('forgotForm', 'submit', async (e) => {
    e.preventDefault();
    const email = $('#fgEmail').value.trim();
    if (!email) return fieldError(e.target, 'fgEmail', 'Enter your work email.');
    try {
      const r = await api('/api/account/recover', { method: 'POST', body: { email } });
      acct.notice = { tone: 'ok', html: `If <b>${esc(email)}</b> is registered, a link to set a new password is on its way.${r.demoResetUrl ? ` <span class="muted">Demo mode:</span> <a class="link-btn" href="${esc(r.demoResetUrl)}" id="demoReset">Open the reset link</a>` : ''}` };
      renderAccountGate();
      on('demoReset', 'click', () => setTimeout(() => location.reload(), 0));
    } catch (err) { acct.notice = { tone: 'err', text: err.message }; renderAccountGate(); }
  });
  on('newPwForm', 'submit', async (e) => {
    e.preventDefault();
    if ($('#npPw').value !== $('#npPw2').value) return fieldError(e.target, 'npPw2', 'The passwords don\'t match.');
    try {
      const st = await api('/api/account/password', { method: 'POST', body: { password: $('#npPw').value } });
      toast('Password changed');
      await afterSignIn(st);
    } catch (err) { fieldError(e.target, 'npPw', err.message); }
  });
  on('gateSignOut', 'click', accountSignOut);
  on('gateRecheck', 'click', async () => { acct.notice = null; await afterSignIn(await api('/api/account/status?refresh=1')); if (acct.status.state === 'pending') toast('Still waiting for approval'); });
  on('gateSettings', 'click', () => { document.body.classList.remove('locked'); showView('settings'); });
}

async function resend(email) {
  if (!email) return;
  try { await api('/api/account/resend', { method: 'POST', body: { email } }); toast('Verification email sent again'); } catch (err) { showError(err, 'Could not send the email'); }
}

async function accountSignOut() {
  try { await api('/api/account/logout', { method: 'POST', body: {} }); } catch { /* signed out anyway */ }
  location.replace('/');
}

// --- header chip -----------------------------------------------------------------------------------
function showAccountChip() {
  const s = acct.status;
  if (!s || !s.account || document.getElementById('acctChip')) return;
  const p = s.account.profile || {};
  const nav = document.querySelector('.top-nav');
  if (nav && !nav.querySelector('[data-view="account"]')) nav.insertAdjacentHTML('beforeend', '<button type="button" data-view="account">Account</button>');
  document.querySelector('.header-right').insertAdjacentHTML('beforeend', `<button type="button" class="acct-chip" id="acctChip" title="Account: ${esc(p.email || '')}">
    <span class="avatar" aria-hidden="true">${esc(initials(p.full_name))}</span>
    <span class="acct-chip-text"><b>${esc(p.full_name || '')}</b><span>${esc(s.account.organization.name)}</span></span></button>`);
  document.getElementById('acctChip').addEventListener('click', () => showView('account'));
}

// --- Account page (profile, organization, members) -------------------------------------------------
async function loadAccountPage() {
  try { acct.status = await api('/api/account/status?refresh=1'); } catch (err) { showError(err); }
  if (acct.status.isAdmin) loadMembers();
  if (state.view === 'account') render();
}
async function loadMembers() {
  try { acct.members = await api('/api/account/members'); } catch (err) { acct.members = { error: err.message }; }
  if (state.view === 'account') render();
}

function renderAccount(main) {
  const s = acct.status;
  if (!s || !s.account) { main.innerHTML = '<div class="card empty"><span class="spinner"></span> Loading your account…</div>'; return; }
  const a = s.account;
  const pending = Array.isArray(acct.members) ? acct.members.filter((m) => m.status === 'pending').length : 0;
  const tabs = [['profile', 'My profile'], ['organization', 'Organization'], ...(s.isAdmin ? [['members', `Members${pending ? ` <span class="badge badge-warn">${pending} pending</span>` : ''}`]] : [])];
  if (!tabs.some(([k]) => k === acct.tab)) acct.tab = 'profile';
  const roleBadge = (r) => `<span class="badge ${r === 'owner' ? 'badge-accent' : r === 'admin' ? 'badge-ok' : ''}">${esc(r[0].toUpperCase() + r.slice(1))}</span>`;
  let body;
  if (acct.tab === 'organization') {
    const o = a.organization;
    body = `<section class="card">
      <div class="row"><h3 style="flex:1">${esc(o.name)}</h3>${roleBadge(a.membership.role)}</div>
      <p class="card-sub">Registered ${esc(new Date(o.created_at).toLocaleDateString())} · domain <span class="mono">${esc(o.domain)}</span></p>
      ${s.isAdmin ? `<form id="orgForm" class="stack" novalidate>
        <div class="grid-2 tight">
          <label class="field"><span>Organization name</span><input class="input" name="name" value="${esc(o.name)}" maxlength="200"></label>
          <label class="field"><span>Organization domain</span><input class="input mono" value="${esc(o.domain)}" disabled><div class="hint">The domain can't be changed: it links colleagues to this organization.</div></label>
          <label class="field"><span>Organization type</span><select class="input" name="orgType">${(s.orgTypes || []).map((t) => `<option ${t === o.org_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label class="field"><span>Organization location</span><input class="input" name="location" value="${esc(o.location)}" maxlength="120"></label>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Save organization</button></div></form>`
    : `<dl class="kv"><dt>Type</dt><dd>${esc(o.org_type)}</dd><dt>Location</dt><dd>${esc(o.location)}</dd></dl>
        <p class="hint" style="margin-top:12px">Only owners and admins can change the organization details.</p>`}
    </section>`;
  } else if (acct.tab === 'members') {
    const list = acct.members;
    const isOwner = a.membership.role === 'owner';
    const rows = !list ? '<tr><td colspan="5" class="muted"><span class="spinner"></span> Loading members…</td></tr>'
      : list.error ? `<tr><td colspan="5"><div class="notice err"><span>${esc(list.error)}</span></div></td></tr>`
        : list.map((m) => {
          const self = m.email === (a.profile && a.profile.email);
          const canTouch = !self && (isOwner || m.role !== 'owner');
          const statusBadge = { pending: 'badge-warn', active: 'badge-ok', rejected: 'badge-err', suspended: 'badge-err' }[m.status] || '';
          let actions = '<span class="muted small">—</span>';
          if (canTouch) {
            if (m.status === 'pending') actions = `<button class="btn btn-sm btn-primary" data-member="${esc(m.user_id)}" data-status="active">Approve</button><button class="btn btn-sm" data-member="${esc(m.user_id)}" data-status="rejected">Reject</button>`;
            else if (m.status === 'active') {
              actions = `<select class="input input-sm" data-role-for="${esc(m.user_id)}" aria-label="Role of ${esc(m.full_name)}">
                ${['member', 'admin', ...(isOwner ? ['owner'] : [])].map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>
                <button class="btn btn-sm" data-member="${esc(m.user_id)}" data-status="suspended">Suspend</button>`;
            } else actions = `<button class="btn btn-sm" data-member="${esc(m.user_id)}" data-status="active">${m.status === 'rejected' ? 'Approve' : 'Reactivate'}</button>`;
          }
          return `<tr class="${m.status === 'pending' ? 'row-pending' : ''}">
            <td><div class="cr-name"><span class="avatar sm" aria-hidden="true">${esc(initials(m.full_name))}</span><div><b>${esc(m.full_name)}</b>${self ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(m.email)}</div></div></div></td>
            <td>${esc(m.designation)}${m.phone ? `<div class="muted small">${esc(m.phone)}</div>` : ''}</td>
            <td>${roleBadge(m.role)}</td>
            <td><span class="badge ${statusBadge}">${esc(m.status[0].toUpperCase() + m.status.slice(1))}</span><div class="muted small">${esc(new Date(m.status === 'pending' ? m.requested_at : (m.decided_at || m.requested_at)).toLocaleDateString())}</div></td>
            <td class="member-actions">${actions}</td></tr>`;
        }).join('');
    body = `<section class="card">
      <div class="row"><h3 style="flex:1">Members of ${esc(a.organization.name)}</h3><button class="btn btn-sm" id="membersRefresh">Refresh</button></div>
      <p class="card-sub">People who registered with <span class="mono">@${esc(a.organization.domain)}</span>. Approve requests to give access to the migrator. Admins manage members; only owners manage owners.</p>
      <div class="table-wrap"><table class="table members-table"><thead><tr><th>Name</th><th>Designation</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  } else {
    const p = a.profile;
    body = `<div class="grid-2">
      <section class="card"><h3>My profile</h3><p class="card-sub">Shown to the administrators of your organization.</p>
        <form id="profileForm" class="stack" novalidate>
          <label class="field"><span>Full name</span><input class="input" name="fullName" value="${esc(p.full_name)}" maxlength="120"></label>
          <label class="field"><span>Work email</span><input class="input" value="${esc(p.email)}" disabled><div class="hint">Your sign-in. It can't be changed here.</div></label>
          <label class="field"><span>Designation / role</span><input class="input" name="designation" value="${esc(p.designation)}" maxlength="120"></label>
          <label class="field"><span>Contact number <span class="muted" style="font-weight:400">(optional)</span></span><input class="input" name="phone" value="${esc(p.phone || '')}" maxlength="30"></label>
          <div class="row"><button class="btn btn-primary" type="submit">Save profile</button></div>
        </form></section>
      <section class="card"><h3>Password</h3><p class="card-sub">Change the password you sign in to the migrator with.</p>
        <form id="pwForm" class="stack" novalidate>
          <label class="field"><span>New password</span><input class="input" name="pw" type="password" autocomplete="new-password"><div class="hint">At least 10 characters, with upper-case and lower-case letters and a number.</div></label>
          <label class="field"><span>Confirm new password</span><input class="input" name="pw2" type="password" autocomplete="new-password"></label>
          <div class="row"><button class="btn" type="submit">Change password</button></div>
        </form>
        <h3 style="margin-top:22px">Access</h3>
        <dl class="kv" style="margin-top:10px"><dt>Organization</dt><dd>${esc(a.organization.name)}</dd><dt>Role</dt><dd>${roleBadge(a.membership.role)}</dd><dt>Member since</dt><dd>${esc(new Date(a.membership.decided_at || a.membership.created_at).toLocaleDateString())}</dd></dl>
        <p class="hint" style="margin-top:10px">Microsoft accounts for Power Platform are connected separately, on the migration's first step.</p>
      </section></div>`;
  }
  main.innerHTML = `
    <div class="page-head"><div><h2>Account</h2><p>Signed in as <b>${esc(a.profile.email)}</b> · ${esc(a.organization.name)}</p></div>
      <button class="btn btn-sm" id="acctSignOut">Sign out</button></div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="tab ${acct.tab === k ? 'active' : ''}" aria-selected="${acct.tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
    ${body}`;
  main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { acct.tab = b.dataset.tab; if (acct.tab === 'members') loadMembers(); render(); }));
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('acctSignOut', 'click', accountSignOut);
  on('membersRefresh', 'click', () => { acct.members = null; render(); loadMembers(); });
  on('profileForm', 'submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      acct.status = await api('/api/account/profile', { method: 'PUT', body: { fullName: f.fullName.value, designation: f.designation.value, phone: f.phone.value } });
      toast('Profile saved');
      document.getElementById('acctChip').remove();
      showAccountChip();
      render();
    } catch (err) { if (!fieldError(f, err.field, err.message)) showError(err, 'Could not save the profile'); }
  });
  on('pwForm', 'submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.pw.value !== f.pw2.value) return fieldError(f, 'pw2', 'The passwords don\'t match.');
    try { await api('/api/account/password', { method: 'POST', body: { password: f.pw.value } }); f.reset(); toast('Password changed'); } catch (err) { fieldError(f, 'pw', err.message); }
  });
  on('orgForm', 'submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      acct.status = await api('/api/account/organization', { method: 'PUT', body: { name: f.name.value, orgType: f.orgType.value, location: f.location.value } });
      toast('Organization saved');
      document.getElementById('acctChip').remove();
      showAccountChip();
      render();
    } catch (err) { if (!fieldError(f, { orgName: 'name', orgLocation: 'location' }[err.field] || err.field, err.message)) showError(err, 'Could not save the organization'); }
  });
  const setMember = async (userId, body, confirmText) => {
    if (confirmText && !await confirmModal(confirmText[0], confirmText[1], confirmText[2])) { render(); return; }
    try { acct.members = await api(`/api/account/members/${encodeURIComponent(userId)}`, { method: 'POST', body }); toast('Saved'); render(); } catch (err) { showError(err, 'Could not update the member'); loadMembers(); }
  };
  main.querySelectorAll('[data-member]').forEach((b) => b.addEventListener('click', () => {
    const m = acct.members.find((x) => x.user_id === b.dataset.member);
    const st = b.dataset.status;
    const conf = st === 'rejected' ? ['Reject this request?', `${m.full_name} (${m.email}) won't get access to the migrator.`, 'Reject']
      : st === 'suspended' ? ['Suspend this member?', `${m.full_name} loses access to the migrator until reactivated.`, 'Suspend'] : null;
    setMember(m.user_id, { status: st }, conf);
  }));
  main.querySelectorAll('[data-role-for]').forEach((sel) => sel.addEventListener('change', () => {
    const m = acct.members.find((x) => x.user_id === sel.dataset.roleFor);
    setMember(m.user_id, { role: sel.value }, sel.value === 'owner' ? ['Make this member an owner?', `${m.full_name} will be able to manage all members, including owners.`, 'Make owner'] : null);
  }));
}

// --- Settings: Supabase connection ------------------------------------------------------------------
function registrationSettingsCard(s) {
  if (s.supabaseUrl === undefined) return '';
  const modeText = { supabase: 'On: users register and sign in with Supabase.', demo: 'On: demo mode uses a built-in demo backend (no Supabase needed).', off: 'Off: anyone who opens the migrator can use it.', misconfigured: 'On, but Supabase is not configured yet.' }[s.registrationMode] || s.registrationMode;
  return `<section class="card" style="margin-top:16px">
    <div class="row"><h3 style="flex:1">User registration (Supabase)</h3><span class="badge ${s.registrationMode === 'off' ? '' : s.registrationMode === 'misconfigured' ? 'badge-err' : 'badge-ok'}">${esc(modeText.split(':')[0])}</span></div>
    <p class="card-sub">${esc(modeText)} People must register their organization and be approved before they can use the migrator. Set up the database once with <span class="mono">supabase/schema.sql</span> (see SUPABASE_SETUP.md).</p>
    <div class="grid-2 tight">
      <label class="field"><span>Supabase project URL</span><input class="input mono" id="sbUrl" value="${esc(s.supabaseUrl)}" placeholder="https://your-project.supabase.co" spellcheck="false"></label>
      <label class="field"><span>Anon (public) key</span><input class="input mono" id="sbKey" value="${esc(s.supabaseAnonKey)}" placeholder="eyJ… or sb_publishable_…" spellcheck="false" autocomplete="off">
        <div class="hint">Project Settings › API. Never enter the <b>service_role</b> / secret key.</div></label>
      <label class="field"><span>Registration</span><select class="input" id="sbMode">
        ${[['auto', 'Automatic (on when Supabase is configured)'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${s.registration === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${emailLinkInfo(s)}
    </div>
    <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="sbSave">Save registration settings</button></div>
  </section>`;
}

// Where verification and password-reset emails send people: APP_URL if set, else this page's address.
function emailLinkInfo(s) {
  const here = `${location.origin}/`;
  const configured = s.appUrl ? `${s.appUrl.replace(/\/$/, '')}/` : '';
  const target = configured || here;
  const mismatch = configured && configured !== here;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(target);
  return `<div class="field"><span>Email links return to</span>
    <div class="mono small" style="padding-top:8px">${esc(target)}</div>
    <div class="hint">${configured ? 'Set by <span class="mono">APP_URL</span> on the server.' : 'The address this page was opened with (<span class="mono">APP_URL</span> is not set).'}
      In Supabase › Authentication › URL Configuration, add every address people use, for example this computer's
      <span class="mono">http://localhost:3000/</span> and the deployed <span class="mono">https://powerapps-solution-migrator.vercel.app/</span>.</div>
    ${mismatch ? `<div class="notice warn" style="margin-top:8px"><span>You opened the migrator at <b>${esc(here)}</b>, but <span class="mono">APP_URL</span> is <b>${esc(configured)}</b>, so email links (and Microsoft sign-in) go there.
      ${local ? 'On a deployed copy, set <span class="mono">APP_URL</span> to its public address (for example in Vercel › Settings › Environment Variables), or remove it, then redeploy.' : 'If that is not this copy\'s public address, change or remove <span class="mono">APP_URL</span> on the server.'}</span></div>` : ''}
  </div>`;
}

function wireRegistrationSettings() {
  const btn = document.getElementById('sbSave');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await busy(btn, async () => {
      try {
        const res = await api('/api/settings', { method: 'PUT', body: { supabaseUrl: $('#sbUrl').value.trim(), supabaseAnonKey: $('#sbKey').value.trim(), registration: $('#sbMode').value } });
        state.settings = res;
        if (!res.changed) { toast('No changes to save'); return; }
        toast('Registration settings saved. Reloading…');
        setTimeout(() => location.replace('/'), 700);
      } catch (err) { showError(err, 'Could not save the registration settings'); }
    });
  });
}
