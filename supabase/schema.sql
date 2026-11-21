-- PowerApps Solution Migrator: user registration & organization profiles (Supabase)
-- Run once in the Supabase SQL editor (Project > SQL Editor > New query > paste > Run).
-- Safe to run again: objects are created if missing and functions are replaced.
--
-- Tables
--   organizations             one row per registered organization (unique domain)
--   profiles                  one row per registered user (linked to auth.users)
--   organization_memberships  user <-> organization, with role and status
--
-- Rules
--   * Rows are only created through the functions below (no direct inserts).
--   * The first user of a domain creates the organization and becomes its owner (active).
--   * Later users of the same domain join as members with status 'pending' until an
--     owner/admin approves them.
--   * The work email's domain must match the organization domain; free-mail domains are refused.
--   * Row Level Security: users see their own profile, their organization and (owners/admins)
--     the members of their organization. Nothing is visible to anonymous users.

create extension if not exists citext;
create extension if not exists pgcrypto;

do $$ begin
  create type public.membership_role as enum ('owner', 'admin', 'member');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.membership_status as enum ('pending', 'active', 'rejected', 'suspended');
exception when duplicate_object then null; end $$;

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 200),
  domain      citext not null unique check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  org_type    text not null check (char_length(org_type) between 2 and 60),
  location    text not null check (char_length(btrim(location)) between 2 and 120),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (char_length(btrim(full_name)) between 2 and 120),
  email       citext not null unique,
  designation text not null check (char_length(btrim(designation)) between 2 and 120),
  phone       text check (phone is null or phone ~ '^[+0-9 ()./-]{6,30}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null unique references auth.users(id) on delete cascade, -- one organization per user
  role            public.membership_role not null default 'member',
  status          public.membership_status not null default 'pending',
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists organization_memberships_org_idx on public.organization_memberships(organization_id, status);

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch before update on public.organizations for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists memberships_touch on public.organization_memberships;
create trigger memberships_touch before update on public.organization_memberships for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Helpers (security definer so RLS policies can use them without recursion)
-- ---------------------------------------------------------------------------------------------
create or replace function public.psm_my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from public.organization_memberships where user_id = auth.uid() and status = 'active'
$$;

create or replace function public.psm_is_org_admin(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_memberships
                 where user_id = auth.uid() and organization_id = org and status = 'active' and role in ('owner', 'admin'))
$$;

create or replace function public.psm_is_free_mail(d text) returns boolean
language sql immutable as $$
  select lower(d) = any (array['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com',
    'ymail.com','icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','gmx.com','gmx.de','gmx.net',
    'mail.com','zoho.com','yandex.com','yandex.ru','rediffmail.com','qq.com','163.com','web.de'])
$$;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_memberships enable row level security;

drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select to authenticated
  using (exists (select 1 from public.organization_memberships m where m.organization_id = organizations.id and m.user_id = auth.uid()));

drop policy if exists profile_select on public.profiles;
create policy profile_select on public.profiles for select to authenticated
  using (id = auth.uid() or exists (select 1 from public.organization_memberships m
         where m.user_id = profiles.id and public.psm_is_org_admin(m.organization_id)));

drop policy if exists membership_select on public.organization_memberships;
create policy membership_select on public.organization_memberships for select to authenticated
  using (user_id = auth.uid() or public.psm_is_org_admin(organization_id));

-- No insert/update/delete policies: all changes go through the functions below.
revoke insert, update, delete on public.organizations, public.profiles, public.organization_memberships from anon, authenticated;
grant select on public.organizations, public.profiles, public.organization_memberships to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Functions called by the migrator (PostgREST RPC: POST /rest/v1/rpc/<name>)
-- ---------------------------------------------------------------------------------------------

-- Before sign-up: is an organization with this domain already registered? (no other details)
create or replace function public.psm_organization_exists(p_domain text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organizations where domain = lower(btrim(p_domain)))
$$;

-- The signed-in user's account: profile, organization and membership (null parts when missing).
create or replace function public.psm_get_my_account() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) - 'created_at' from public.profiles p where p.id = auth.uid()),
    'membership', (select jsonb_build_object('role', m.role, 'status', m.status, 'created_at', m.created_at, 'decided_at', m.decided_at)
                   from public.organization_memberships m where m.user_id = auth.uid()),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'domain', o.domain, 'org_type', o.org_type, 'location', o.location, 'created_at', o.created_at)
                     from public.organizations o join public.organization_memberships m on m.organization_id = o.id
                     where m.user_id = auth.uid()))
$$;

-- After the user has verified their email and signed in for the first time: creates the profile
-- and either a new organization (owner) or a pending membership of the existing one.
-- Registration details come from the user's sign-up metadata (stored by Supabase Auth).
create or replace function public.psm_complete_registration() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid := auth.uid();
  u record;
  meta jsonb;
  email_domain text;
  org_domain text;
  org_id uuid;
  created boolean := false;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if exists (select 1 from public.organization_memberships where user_id = uid) then
    return public.psm_get_my_account();
  end if;
  select id, email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = uid;
  if u.email_confirmed_at is null then raise exception 'Verify your email address first.' using errcode = '28000'; end if;
  meta := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  email_domain := lower(split_part(u.email, '@', 2));
  org_domain := lower(btrim(coalesce(meta->>'org_domain', '')));
  if org_domain = '' or meta->>'org_name' is null or meta->>'full_name' is null or meta->>'designation' is null then
    raise exception 'Registration details are missing. Register again.' using errcode = '22023';
  end if;
  if public.psm_is_free_mail(email_domain) then
    raise exception 'Use your official work email, not a personal email address.' using errcode = '22023';
  end if;
  if not (email_domain = org_domain or email_domain like '%.' || org_domain) then
    raise exception 'Your email domain (%) does not match the organization domain (%).', email_domain, org_domain using errcode = '22023';
  end if;

  insert into public.profiles (id, full_name, email, designation, phone)
  values (uid, btrim(meta->>'full_name'), u.email, btrim(meta->>'designation'), nullif(btrim(coalesce(meta->>'phone', '')), ''))
  on conflict (id) do update set full_name = excluded.full_name, designation = excluded.designation, phone = excluded.phone;

  insert into public.organizations (name, domain, org_type, location, created_by)
  values (btrim(meta->>'org_name'), org_domain, coalesce(nullif(btrim(meta->>'org_type'), ''), 'Other'), btrim(coalesce(meta->>'org_location', '')), uid)
  on conflict (domain) do nothing
  returning id into org_id;
  if org_id is not null then
    created := true;
  else
    select id into org_id from public.organizations where domain = org_domain;
  end if;

  insert into public.organization_memberships (organization_id, user_id, role, status, decided_at)
  values (org_id, uid, case when created then 'owner' else 'member' end::public.membership_role,
          case when created then 'active' else 'pending' end::public.membership_status,
          case when created then now() end);
  return public.psm_get_my_account() || jsonb_build_object('created_organization', created);
end $$;

-- Owners/admins: list the members (and pending requests) of their organization.
create or replace function public.psm_list_members() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'full_name', p.full_name, 'email', p.email, 'designation', p.designation, 'phone', p.phone,
      'role', m.role, 'status', m.status, 'requested_at', m.created_at, 'decided_at', m.decided_at)
      order by (m.status = 'pending') desc, p.full_name), '[]'::jsonb)
  from public.organization_memberships m join public.profiles p on p.id = m.user_id
  where public.psm_is_org_admin(m.organization_id)
$$;

-- Owners/admins: approve, reject, suspend or reactivate a member, or change their role.
-- Only an owner can make someone owner or change an owner; the last active owner can't be removed.
create or replace function public.psm_set_member(p_user uuid, p_status text, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_m record;
  target record;
  new_status public.membership_status := coalesce(nullif(p_status, ''), null)::public.membership_status;
  new_role public.membership_role := coalesce(nullif(p_role, ''), null)::public.membership_role;
begin
  select * into my_m from public.organization_memberships where user_id = me and status = 'active' and role in ('owner', 'admin');
  if not found then raise exception 'Only owners and admins of the organization can manage members.' using errcode = '42501'; end if;
  select * into target from public.organization_memberships where user_id = p_user and organization_id = my_m.organization_id;
  if not found then raise exception 'This user is not in your organization.' using errcode = '42501'; end if;
  if p_user = me and (new_status is not null and new_status <> 'active' or new_role is not null and new_role <> my_m.role) then
    raise exception 'You can''t change your own role or status.' using errcode = '42501';
  end if;
  if my_m.role <> 'owner' and (target.role = 'owner' or new_role = 'owner') then
    raise exception 'Only an owner can change owners.' using errcode = '42501';
  end if;
  if target.role = 'owner' and target.status = 'active' and (coalesce(new_role, 'owner') <> 'owner' or coalesce(new_status, 'active') <> 'active')
     and (select count(*) from public.organization_memberships where organization_id = target.organization_id and role = 'owner' and status = 'active') <= 1 then
    raise exception 'The organization must keep at least one active owner.' using errcode = '42501';
  end if;
  update public.organization_memberships
     set status = coalesce(new_status, status),
         role = coalesce(new_role, role),
         decided_by = case when new_status is not null and new_status <> target.status then me else decided_by end,
         decided_at = case when new_status is not null and new_status <> target.status then now() else decided_at end
   where id = target.id;
  return public.psm_list_members();
end $$;

-- Owners/admins: update the organization details (the domain can't be changed).
create or replace function public.psm_update_organization(p_name text, p_org_type text, p_location text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare org uuid := public.psm_my_org();
begin
  if org is null or not public.psm_is_org_admin(org) then raise exception 'Only owners and admins can edit the organization.' using errcode = '42501'; end if;
  update public.organizations set name = btrim(p_name), org_type = btrim(p_org_type), location = btrim(p_location) where id = org;
  return public.psm_get_my_account();
end $$;

-- Any registered user: update their own profile (the email is managed by Supabase Auth).
create or replace function public.psm_update_my_profile(p_full_name text, p_designation text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  update public.profiles set full_name = btrim(p_full_name), designation = btrim(p_designation), phone = nullif(btrim(coalesce(p_phone, '')), '')
   where id = auth.uid();
  if not found then raise exception 'Complete your registration first.' using errcode = '22023'; end if;
  return public.psm_get_my_account();
end $$;

revoke all on function public.psm_organization_exists(text), public.psm_get_my_account(), public.psm_complete_registration(),
  public.psm_list_members(), public.psm_set_member(uuid, text, text), public.psm_update_organization(text, text, text),
  public.psm_update_my_profile(text, text, text), public.psm_my_org(), public.psm_is_org_admin(uuid) from public;
grant execute on function public.psm_organization_exists(text) to anon, authenticated;
grant execute on function public.psm_get_my_account(), public.psm_complete_registration(), public.psm_list_members(),
  public.psm_set_member(uuid, text, text), public.psm_update_organization(text, text, text), public.psm_update_my_profile(text, text, text),
  public.psm_my_org(), public.psm_is_org_admin(uuid) to authenticated;
