'use strict';

/**
 * In-memory stand-in for Supabase, used in demo mode and by the tests. It follows the same rules
 * as supabase/schema.sql (first user of a domain owns the organization, later users wait for
 * approval, only owners/admins manage members, an organization keeps at least one owner).
 */

const crypto = require('crypto');
const { AccountError, isFreeMail, domainMatches, emailDomain } = require('./rules');

const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
const verify = (password, stored) => {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(password, salt, 32));
};

const DEMO = { email: 'admin@contoso.com', password: 'DemoPass2026' };

function create({ seed = true } = {}) {
  const users = new Map(); // id -> { id, email, pw, confirmed, meta }
  const tokens = new Map(); // access token -> { userId, expiresAt }
  const refresh = new Map(); // refresh token -> userId
  const verifyTokens = new Map(); // demo email-verification token -> userId
  const orgs = new Map(); // id -> org
  const profiles = new Map(); // userId -> profile
  const members = new Map(); // userId -> membership

  const now = () => new Date().toISOString();
  const byEmail = (email) => [...users.values()].find((u) => u.email === String(email).toLowerCase());
  const issue = (userId) => {
    const accessToken = crypto.randomBytes(24).toString('base64url');
    const refreshToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 3600 * 1000;
    tokens.set(accessToken, { userId, expiresAt });
    refresh.set(refreshToken, userId);
    const u = users.get(userId);
    return { accessToken, refreshToken, expiresAt, user: { id: u.id, email: u.email, confirmed: u.confirmed } };
  };
  const uid = (token) => {
    const t = tokens.get(token);
    if (!t || t.expiresAt < Date.now()) throw new AccountError('Your session has expired. Sign in again.', 401);
    return t.userId;
  };

  function account(userId) {
    const m = members.get(userId);
    const o = m ? orgs.get(m.organization_id) : null;
    return {
      profile: profiles.get(userId) ? { ...profiles.get(userId) } : null,
      membership: m ? { role: m.role, status: m.status, created_at: m.created_at, decided_at: m.decided_at } : null,
      organization: o ? { id: o.id, name: o.name, domain: o.domain, org_type: o.org_type, location: o.location, created_at: o.created_at } : null,
    };
  }
  const adminOf = (userId) => {
    const m = members.get(userId);
    return m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin') ? m : null;
  };
  const listMembers = (userId) => {
    const me = adminOf(userId);
    if (!me) return [];
    return [...members.values()].filter((m) => m.organization_id === me.organization_id).map((m) => {
      const p = profiles.get(m.user_id);
      return { user_id: m.user_id, full_name: p.full_name, email: p.email, designation: p.designation, phone: p.phone, role: m.role, status: m.status, requested_at: m.created_at, decided_at: m.decided_at };
    }).sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || a.full_name.localeCompare(b.full_name));
  };

  function completeRegistration(userId) {
    if (members.has(userId)) return account(userId);
    const u = users.get(userId);
    if (!u.confirmed) throw new AccountError('Verify your email address first.', 400);
    const meta = u.meta || {};
    const dom = emailDomain(u.email);
    const orgDom = String(meta.org_domain || '').toLowerCase();
    if (!orgDom || !meta.org_name || !meta.full_name || !meta.designation) throw new AccountError('Registration details are missing. Register again.');
    if (isFreeMail(dom)) throw new AccountError('Use your official work email, not a personal email address.');
    if (!domainMatches(dom, orgDom)) throw new AccountError(`Your email domain (${dom}) does not match the organization domain (${orgDom}).`);
    profiles.set(userId, { id: userId, full_name: meta.full_name, email: u.email, designation: meta.designation, phone: meta.phone || null, updated_at: now() });
    let org = [...orgs.values()].find((o) => o.domain === orgDom);
    const created = !org;
    if (!org) {
      org = { id: crypto.randomUUID(), name: meta.org_name, domain: orgDom, org_type: meta.org_type || 'Other', location: meta.org_location || '', created_by: userId, created_at: now() };
      orgs.set(org.id, org);
    }
    members.set(userId, { organization_id: org.id, user_id: userId, role: created ? 'owner' : 'member', status: created ? 'active' : 'pending', created_at: now(), decided_at: created ? now() : null });
    return { ...account(userId), created_organization: created };
  }

  function setMember(userId, { p_user: target, p_status: status, p_role: role }) {
    const me = adminOf(userId);
    if (!me) throw new AccountError('Only owners and admins of the organization can manage members.', 403);
    const t = members.get(target);
    if (!t || t.organization_id !== me.organization_id) throw new AccountError('This user is not in your organization.', 403);
    if (status && !['pending', 'active', 'rejected', 'suspended'].includes(status)) throw new AccountError('Invalid status.');
    if (role && !['owner', 'admin', 'member'].includes(role)) throw new AccountError('Invalid role.');
    if (target === userId && ((status && status !== 'active') || (role && role !== me.role))) throw new AccountError('You can\'t change your own role or status.', 403);
    if (me.role !== 'owner' && (t.role === 'owner' || role === 'owner')) throw new AccountError('Only an owner can change owners.', 403);
    const owners = [...members.values()].filter((m) => m.organization_id === t.organization_id && m.role === 'owner' && m.status === 'active').length;
    if (t.role === 'owner' && t.status === 'active' && ((role || 'owner') !== 'owner' || (status || 'active') !== 'active') && owners <= 1) {
      throw new AccountError('The organization must keep at least one active owner.', 403);
    }
    if (status && status !== t.status) { t.status = status; t.decided_at = now(); t.decided_by = userId; }
    if (role) t.role = role;
    return listMembers(userId);
  }

  const backend = {
    kind: 'demo',
    demoAccount: DEMO,
    async signUp({ email, password, data }) {
      const e = String(email).toLowerCase();
      if (byEmail(e)) throw new AccountError('An account with this email already exists. Sign in instead.', 409);
      const id = crypto.randomUUID();
      users.set(id, { id, email: e, pw: hash(password), confirmed: false, meta: { ...data } });
      const token = crypto.randomBytes(18).toString('base64url');
      verifyTokens.set(token, id);
      return { needsConfirmation: true, demoVerifyToken: token };
    },
    async demoVerify(token) {
      const id = verifyTokens.get(token);
      if (!id) throw new AccountError('This verification link is not valid any more.', 400);
      verifyTokens.delete(token);
      users.get(id).confirmed = true;
      return issue(id);
    },
    async signIn(email, password) {
      const u = byEmail(email);
      if (!u || !verify(String(password || ''), u.pw)) throw new AccountError('Email or password is not correct.', 401);
      if (!u.confirmed) throw new AccountError('Verify your email address first: open the link in the email we sent you.', 403, { code: 'email_not_confirmed' });
      return issue(u.id);
    },
    async refresh(refreshToken) {
      const id = refresh.get(refreshToken);
      if (!id) throw new AccountError('Your session has expired. Sign in again.', 401);
      refresh.delete(refreshToken);
      return issue(id);
    },
    async getUser(accessToken) { const u = users.get(uid(accessToken)); return { id: u.id, email: u.email, confirmed: u.confirmed }; },
    async signOut(accessToken) { tokens.delete(accessToken); },
    async resendConfirmation() { /* demo: the verification link is shown on screen */ },
    async recover(email) {
      const u = byEmail(email);
      if (!u) return {};
      return { demoRecovery: issue(u.id) };
    },
    async updatePassword(accessToken, password) { users.get(uid(accessToken)).pw = hash(password); },
    async organizationExists(domain) { return [...orgs.values()].some((o) => o.domain === String(domain).toLowerCase()); },
    async rpc(accessToken, name, args = {}) {
      const id = uid(accessToken);
      switch (name) {
        case 'psm_get_my_account': return account(id);
        case 'psm_complete_registration': return completeRegistration(id);
        case 'psm_list_members': return listMembers(id);
        case 'psm_set_member': return setMember(id, args);
        case 'psm_update_organization': {
          const me = adminOf(id);
          if (!me) throw new AccountError('Only owners and admins can edit the organization.', 403);
          Object.assign(orgs.get(me.organization_id), { name: args.p_name, org_type: args.p_org_type, location: args.p_location });
          return account(id);
        }
        case 'psm_update_my_profile': {
          const p = profiles.get(id);
          if (!p) throw new AccountError('Complete your registration first.');
          Object.assign(p, { full_name: args.p_full_name, designation: args.p_designation, phone: args.p_phone || null, updated_at: now() });
          return account(id);
        }
        default: throw new AccountError(`Unknown function ${name}.`, 404);
      }
    },
  };

  if (seed) {
    // Demo organization with an owner and one pending request, so approvals can be tried right away.
    const add = (email, password, meta) => {
      const id = crypto.randomUUID();
      users.set(id, { id, email, pw: hash(password), confirmed: true, meta });
      completeRegistration(id);
      return id;
    };
    const org = { org_name: 'Contoso Ltd', org_domain: 'contoso.com', org_type: 'Enterprise', org_location: 'Seattle, USA' };
    add(DEMO.email, DEMO.password, { ...org, full_name: 'Contoso Admin', designation: 'Power Platform lead', phone: '+1 425 555 0100' });
    add('lee.chen@contoso.com', 'DemoPass2026', { ...org, full_name: 'Lee Chen', designation: 'Solution architect' });
  }
  return backend;
}

module.exports = { create, DEMO };
