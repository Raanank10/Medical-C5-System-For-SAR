-- docs/RLS_AUDIT_v1.md's systematic RLS/authorization pass (docs/THREAT_MODEL.md T1) found that
-- `profiles.is_active` was not actually enforced everywhere the docs claimed. Two live gaps,
-- same root cause:
--
-- 1. app.current_user_role() was `select role from profiles where id = auth.uid()` with no
--    is_active filter. Every RLS policy and every app.*() helper (is_command_role,
--    can_access_incident, can_write_incident_event) is built on this function, so a deactivated
--    profile was NOT locked out of RLS-gated table access (patients, incidents,
--    incident_memberships, device_presence, etc.) - only the sync-log Edge Function's own
--    separate is_active check protected that one path (supabase/functions/sync-log/index.ts:145).
--
-- 2. The live handle_new_user() trigger omitted is_active from its insert into profiles
--    entirely, silently taking the column default (true) - unlike what
--    011_handle_new_user_reads_role_from_metadata.sql documents and claims verified
--    (is_active := role_is_valid, so an invite with a missing/invalid role fails closed rather
--    than landing as a fully active, plausible-looking medic). No evidence of what caused the
--    live function to diverge from that file; redeploying it here to match 011's logic exactly.
--
-- Neither is a cross-incident/cross-role escalation for an active account (the class of bug
-- 013-016 fixed) - both are real defects in the account-deactivation control path, which
-- docs/THREAT_MODEL.md's T4/T8 already treats as a load-bearing safety mechanism, not a
-- hypothetical one.
--
-- app.current_user_role() alone is not enough: app.can_access_incident() and
-- app.can_write_incident_event()'s incident_memberships EXISTS branch checks
-- `im.profile_id = auth.uid()` directly and never calls current_user_role() at all, so a
-- deactivated medic/pc who already has an incident_memberships row would still pass even after
-- the fix above - caught by re-querying these functions' live bodies while verifying the first
-- fix, before this migration was considered done. Both are redefined below to require
-- current_user_role() is not null (i.e. an active profile) up front.

create or replace function app.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid() and is_active = true
$$;

create or replace function app.can_access_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    app.current_user_role() is not null
    and (
      app.current_user_role() in ('cc','chamal','admin','rpc','rcc')
      or exists (
        select 1
        from incident_memberships im
        where im.incident_id = p_incident_id
          and im.profile_id = auth.uid()
      )
    ),
    false
  )
$$;

create or replace function app.can_write_incident_event(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    app.current_user_role() is not null
    and (
      app.current_user_role() in ('pc','cc','chamal','admin')
      or exists (
        select 1
        from incident_memberships im
        where im.incident_id = p_incident_id
          and im.profile_id = auth.uid()
          and im.role_at_incident in ('medic','pc')
      )
    ),
    false
  )
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  requested_role text := new.raw_user_meta_data->>'role';
  role_is_valid boolean := requested_role is not null
    and requested_role = any (enum_range(null::public.user_role)::text[]);
  resolved_role public.user_role := case
    when role_is_valid then requested_role::public.user_role
    else 'medic'::public.user_role
  end;
begin
  insert into public.profiles (id, display_name, role, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email, 'Unnamed'),
    resolved_role,
    role_is_valid
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- handle_new_user's direct-RPC-call grant was already revoked from anon/authenticated in 016;
-- redefining the function body here does not reset grants, but re-assert it anyway for safety
-- since `create or replace function` can be run by a superuser role that owns default grants.
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
