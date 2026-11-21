'use strict';

/**
 * Authentication with Microsoft Entra ID (MSAL Node, auth-code + PKCE).
 *
 * Two independent "slots" are kept: `source` and `target`. Each slot has its own MSAL
 * client and token cache, so a cross-tenant migration can use two different accounts
 * (e.g. admin@contoso.com for the source and admin@fabrikam.com for the target).
 * In a same-tenant migration the target simply re-uses the `source` slot.
 */

const crypto = require('crypto');
const msal = require('@azure/msal-node');
const config = require('./config');
const workspace = require('./workspace');

const SLOTS = ['source', 'target'];

class AuthRequiredError extends Error {
  constructor(slot, tenantId, message, scope) {
    super(message || `Sign-in required for the ${slot} connection${tenantId ? ` (tenant ${tenantId})` : ''}.`);
    this.scope = scope || null;
    this.mfa = /AADSTS50076|AADSTS50079|multi-factor/i.test(message || '');
    this.name = 'AuthRequiredError';
    this.status = 401;
    this.slot = slot;
    this.tenantId = tenantId;
  }
}

// Sign-ins are kept per workspace (one per user when hosted; a single 'local' one otherwise).
const workspaces = new Map(); // workspace key -> { source: {client, account}, target: {...} }
const slotsFor = (ws = workspace.key()) => {
  if (!workspaces.has(ws)) workspaces.set(ws, {});
  return workspaces.get(ws);
};
const pendingLogins = new Map(); // state -> { ws, slot, verifier, tenant, scopes, createdAt }
// Claims challenges (e.g. MFA required by Conditional Access) per `${ws}|${slot}|${tenantId}`.
const claimsChallenges = new Map();
const challengeKey = (slot, tenant, ws = workspace.key()) => `${ws}|${slot}|${String(tenant).toLowerCase()}`;
const BASE_SCOPES = ['openid', 'profile', 'offline_access'];

function getClient(slot, ws = workspace.key()) {
  const slots = slotsFor(ws);
  if (!slots[slot]) {
    const auth = {
      clientId: config.clientId,
      authority: `${config.authorityHost}/organizations`,
    };
    const client = config.clientSecret
      ? new msal.ConfidentialClientApplication({ auth: { ...auth, clientSecret: config.clientSecret } })
      : new msal.PublicClientApplication({ auth });
    slots[slot] = { client, account: null };
  }
  return slots[slot];
}

function assertSlot(slot) {
  if (!SLOTS.includes(slot)) {
    const err = new Error(`Unknown connection slot "${slot}"`);
    err.status = 400;
    throw err;
  }
}

/**
 * @param {string} slot
 * @param {string} [tenant]  tenant ID/domain to sign in to (default: organizations)
 * @param {object} [opts]
 * @param {string} [opts.scope]  resource scope to consent/step-up for (e.g. after an MFA challenge)
 */
async function getLoginUrl(slot, tenant, opts = {}) {
  assertSlot(slot);
  const slotState = getClient(slot);
  const { client } = slotState;
  const scopes = opts.scope ? [...BASE_SCOPES, opts.scope] : BASE_SCOPES;
  const claims = tenant ? claimsChallenges.get(challengeKey(slot, tenant)) : undefined;
  const stepUp = Boolean(opts.scope || claims);
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(state, { ws: workspace.key(), slot, verifier, tenant, scopes, popup: Boolean(opts.popup), next: opts.next || null, createdAt: Date.now() });
  // Clean up abandoned logins.
  for (const [k, v] of pendingLogins) if (Date.now() - v.createdAt > 15 * 60 * 1000) pendingLogins.delete(k);

  return client.getAuthCodeUrl({
    scopes,
    redirectUri: config.redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    // Step-up (MFA) keeps the current user; a fresh sign-in lets the user pick an account.
    // Opening a Power Apps link "as" the source/target account: hint that account so Microsoft makes
    // it the active one (no account picker when it's already signed in).
    ...(opts.next && slotState.account ? { loginHint: slotState.account.username }
      : stepUp && slotState.account ? { loginHint: slotState.account.username } : { prompt: 'select_account' }),
    ...(claims ? { claims } : {}),
    authority: `${config.authorityHost}/${tenant || 'organizations'}`,
  });
}

/** Whether the sign-in identified by `state` was started in a popup window. */
function pendingNext(state) {
  const p = pendingLogins.get(state);
  return p ? p.next : null;
}

function isPopupLogin(state) {
  const p = pendingLogins.get(state);
  return Boolean(p && p.popup);
}

async function handleCallback(query) {
  const pending = pendingLogins.get(query.state);
  if (!pending) throw new Error('Sign-in session expired or is invalid. Please try again.');
  pendingLogins.delete(query.state);
  if (query.error) throw new Error(`${query.error}: ${query.error_description || ''}`.trim());

  // The sign-in lands in the workspace that started it (the state value is random and secret).
  const slotState = getClient(pending.slot, pending.ws);
  const result = await slotState.client.acquireTokenByCode({
    code: query.code,
    scopes: pending.scopes || BASE_SCOPES,
    redirectUri: config.redirectUri,
    codeVerifier: pending.verifier,
    authority: `${config.authorityHost}/${pending.tenant || 'organizations'}`,
  });
  slotState.account = result.account;
  if (pending.tenant) claimsChallenges.delete(challengeKey(pending.slot, pending.tenant, pending.ws));
  return { slot: pending.slot, account: describeAccount(result.account), next: pending.next };
}

function describeAccount(account) {
  if (!account) return null;
  return {
    username: account.username,
    name: account.name || account.username,
    homeTenantId: account.tenantId,
  };
}

function getStatus() {
  const slots = slotsFor();
  const out = {};
  for (const slot of SLOTS) {
    const s = slots[slot];
    out[slot] = { signedIn: Boolean(s && s.account), account: describeAccount(s && s.account) };
  }
  return out;
}

function getAccount(slot) {
  const s = slotsFor()[slot];
  return s && s.account;
}

/**
 * Acquire an access token for `scope` in `tenantId` for the account in `slot`.
 * Uses the refresh token silently; throws AuthRequiredError if interaction is needed
 * (e.g. MFA / consent required for that tenant).
 */
async function getToken(slot, tenantId, scope) {
  assertSlot(slot);
  const s = slotsFor()[slot];
  if (!s || !s.account) throw new AuthRequiredError(slot, tenantId);
  try {
    const result = await s.client.acquireTokenSilent({
      account: s.account,
      scopes: [scope],
      authority: `${config.authorityHost}/${tenantId || s.account.tenantId}`,
    });
    if (!result || !result.accessToken) throw new AuthRequiredError(slot, tenantId, undefined, scope);
    return result.accessToken;
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    if (err instanceof msal.InteractionRequiredAuthError || /interaction_required|consent_required|login_required|AADSTS50076|AADSTS65001|AADSTS50079/i.test(err.message || '')) {
      const tid = (tenantId || s.account.tenantId).toLowerCase();
      if (err.claims) claimsChallenges.set(challengeKey(slot, tid), err.claims);
      const detail = err.errorMessage || err.message || '';
      const why = /AADSTS50076|AADSTS50079/.test(detail)
        ? 'Your organization requires multi-factor authentication (MFA) for this. Click "Sign in" and complete the MFA prompt.'
        : /AADSTS65001|consent/i.test(detail)
          ? 'Consent is required for this app in this tenant. Click "Sign in" to grant it (an administrator may need to approve).'
          : 'Click "Sign in" to continue.';
      throw new AuthRequiredError(slot, tid, `Additional sign-in is required for the ${slot} connection. ${why}\n\nDetails: ${detail.split('\n')[0]}`, scope);
    }
    throw err;
  }
}

async function signOut(slot) {
  assertSlot(slot);
  const s = slotsFor()[slot];
  if (!s) return;
  if (s.account) {
    try { await s.client.getTokenCache().removeAccount(s.account); } catch { /* ignore */ }
  }
  s.account = null;
}

/** True while a sign-in started in the last 10 minutes hasn't come back yet. */
function hasPendingLogin() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const p of pendingLogins.values()) if (p.createdAt > cutoff) return true;
  return false;
}

/** Forget all sign-ins and MSAL clients (used when the app registration changes). */
function reset() {
  workspaces.clear();
  pendingLogins.clear();
  claimsChallenges.clear();
}

module.exports = { pendingNext, hasPendingLogin, reset, SLOTS, AuthRequiredError, getLoginUrl, isPopupLogin, handleCallback, getStatus, getAccount, getToken, signOut, describeAccount };
