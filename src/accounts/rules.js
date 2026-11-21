'use strict';

/** Registration rules shared by the server, the demo backend and (mirrored) the Supabase SQL functions. */

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'rediffmail.com', 'qq.com', '163.com', 'web.de']);

const ORG_TYPES = ['Enterprise', 'Microsoft partner / consultancy', 'Independent software vendor', 'Public sector / government',
  'Education', 'Non-profit', 'Other'];

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PHONE_RE = /^[+0-9 ()./-]{6,30}$/;

class AccountError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.name = 'AccountError'; this.status = status; Object.assign(this, extra); }
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const emailDomain = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

const isFreeMail = (domain) => FREE_MAIL.has(String(domain || '').toLowerCase());
const domainMatches = (emailDom, orgDom) => emailDom === orgDom || emailDom.endsWith(`.${orgDom}`);

function checkPassword(password) {
  const p = String(password || '');
  if (p.length < 10) throw new AccountError('Use a password of at least 10 characters.');
  if (p.length > 72) throw new AccountError('Use a password of at most 72 characters.');
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) throw new AccountError('Use upper-case and lower-case letters and at least one number in the password.');
  return p;
}

/** Validates and normalizes the registration form. Throws AccountError with a field name. */
function validateRegistration(input) {
  const b = input || {};
  const field = (name, message) => new AccountError(message, 400, { field: name });
  const r = {
    org_name: clean(b.orgName, 200),
    org_domain: normalizeDomain(b.orgDomain),
    org_type: clean(b.orgType, 60),
    org_location: clean(b.orgLocation, 120),
    full_name: clean(b.fullName, 120),
    email: String(b.email || '').trim().toLowerCase(),
    designation: clean(b.designation, 120),
    phone: clean(b.phone, 30),
  };
  if (r.org_name.length < 2) throw field('orgName', 'Enter the organization name.');
  if (!DOMAIN_RE.test(r.org_domain)) throw field('orgDomain', 'Enter the organization domain, for example powercraft.co.');
  if (isFreeMail(r.org_domain)) throw field('orgDomain', 'Personal email domains (such as gmail.com) can\'t be registered as an organization.');
  if (!ORG_TYPES.includes(r.org_type)) throw field('orgType', 'Choose the organization type.');
  if (r.org_location.length < 2) throw field('orgLocation', 'Enter the organization location (city, country).');
  if (r.full_name.length < 2) throw field('fullName', 'Enter your full name.');
  if (!EMAIL_RE.test(r.email)) throw field('email', 'Enter your official work email.');
  const dom = emailDomain(r.email);
  if (isFreeMail(dom)) throw field('email', 'Use your official work email, not a personal email address.');
  if (!domainMatches(dom, r.org_domain)) throw field('email', `Your email domain (${dom}) must match the organization domain (${r.org_domain}).`);
  if (r.designation.length < 2) throw field('designation', 'Enter your designation or role.');
  if (r.phone && !PHONE_RE.test(r.phone)) throw field('phone', 'Enter a valid contact number, or leave it empty.');
  try { checkPassword(b.password); } catch (e) { e.field = 'password'; throw e; }
  return r;
}

module.exports = { FREE_MAIL, ORG_TYPES, AccountError, validateRegistration, checkPassword, normalizeDomain, isFreeMail, domainMatches, emailDomain, clean, EMAIL_RE, PHONE_RE, DOMAIN_RE };
