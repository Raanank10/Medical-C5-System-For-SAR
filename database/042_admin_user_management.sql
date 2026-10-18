-- In-app user management for the admin role: list users, change a user's role, deactivate /
-- reactivate, and an append-only audit trail of every access change. Inviting (which needs the
-- service-role key) lives in the admin-users Edge Function, which writes to the same audit table.
--
-- Why (gaps verified live 2026-10-16, not assumed):
-- 1. profiles has only a SELECT policy, so no signed-in user can change anyone's role or
--    is_active. The only paths were scripts/invite_user.js (service-role key on a laptop) and
--    hand edits in the Supabase dashboard.
-- 2. profiles.role / is_active changes left no record beyond updated_at
--    (docs/AUTH_AND_ROLE_MODEL.md "No role-change audit trail").
--
-- Design decisions (made with the repo owner 2026-10-16):
-- - Only an active admin can invite, change roles, or (de)activate. The admin picks the role
--   per invitation; the invitee never chooses a role.
-- - An admin cannot change their own role or deactivate themselves. Since the caller must be
--   an active admin, this also guarantees at least one active admin always remains.
-- - The audit trigger fires on EVERY role / is_active change, whatever the path (these RPCs,
--   the SQL editor, the service role). actor_id is auth.uid(), so it is null for changes made
--   outside a signed-in session - recorded as "unknown actor", never silently skipped.
-- - The audit table is append-only: UPDATE/DELETE are rejected by trigger, for every role
--   including the service role.

-- ---------------------------------------------------------------------------------------------
-- Audit table
-- ---------------------------------------------------------------------------------------------
create table if not exists admin_user_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid,
  actor_role user_role,
  target_user_id uuid,
  target_email text,
  action text not null check (action in ('invited','reinvited','role_changed','deactivated','reactivated')),
  old_role user_role,
  new_role user_role,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_admin_user_audit_target on admin_user_audit(target_user_id, created_at desc);
create index if not exists idx_admin_user_audit_created on admin_user_audit(created_at desc);

alter table admin_user_audit enable row level security;

drop policy if exists admin_user_audit_read_admin on admin_user_audit;
create policy admin_user_audit_read_admin on admin_user_audit
  for select to authenticated
  using (app.current_user_role() = 'admin');

revoke all on admin_user_audit from public, anon, authenticated;
grant select on admin_user_audit to authenticated;

create or replace function app.reject_admin_user_audit_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'admin_user_audit is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists trg_admin_user_audit_append_only on admin_user_audit;
create trigger trg_admin_user_audit_append_only
  before update or delete on admin_user_audit
  for each row execute function app.reject_admin_user_audit_mutation();

revoke execute on function app.reject_admin_user_audit_mutation() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Audit every role / is_active change on profiles, whatever the path
-- ---------------------------------------------------------------------------------------------
create or replace function app.log_profile_access_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := (select u.email::text from auth.users u where u.id = new.id);
  v_actor_role user_role := app.current_user_role();
begin
  if new.role is distinct from old.role then
    insert into admin_user_audit (actor_id, actor_role, target_user_id, target_email, action, old_role, new_role)
    values (auth.uid(), v_actor_role, new.id, v_email, 'role_changed', old.role, new.role);
  end if;
  if new.is_active is distinct from old.is_active then
    insert into admin_user_audit (actor_id, actor_role, target_user_id, target_email, action, old_role, new_role)
    values (auth.uid(), v_actor_role, new.id, v_email,
            case when new.is_active then 'reactivated' else 'deactivated' end, old.role, new.role);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_access_audit on profiles;
create trigger trg_profiles_access_audit
  after update of role, is_active on profiles
  for each row execute function app.log_profile_access_change();

revoke execute on function app.log_profile_access_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------------------------

-- Every account with its role and onboarding state. Reads auth.users (invited / confirmed /
-- last sign-in / whether a password was ever set), which no client can read directly.
create or replace function admin_list_users()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role user_role,
  is_active boolean,
  has_profile boolean,
  has_password boolean,
  invited_at timestamptz,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if app.current_user_role() is distinct from 'admin' then
    raise exception 'only an active admin can list users' using errcode = '42501';
  end if;
  return query
    select u.id,
           u.email::text,
           p.display_name,
           p.role,
           coalesce(p.is_active, false),
           p.id is not null,
           coalesce(u.encrypted_password, '') <> '',
           u.invited_at,
           u.email_confirmed_at,
           u.last_sign_in_at,
           u.created_at
    from auth.users u
    left join profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;

create or replace function admin_set_user_role(p_user_id uuid, p_role user_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if app.current_user_role() is distinct from 'admin' then
    raise exception 'only an active admin can change roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'an admin cannot change their own role' using errcode = '42501';
  end if;
  if p_role is null then
    raise exception 'role is required' using errcode = '22023';
  end if;
  update profiles
     set role = p_role, updated_at = now(), version = version + 1
   where id = p_user_id and role is distinct from p_role;
  if not found and not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'no profile for this user' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function admin_set_user_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if app.current_user_role() is distinct from 'admin' then
    raise exception 'only an active admin can activate or deactivate users' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'an admin cannot deactivate or reactivate themselves' using errcode = '42501';
  end if;
  if p_active is null then
    raise exception 'active flag is required' using errcode = '22023';
  end if;
  update profiles
     set is_active = p_active, updated_at = now(), version = version + 1
   where id = p_user_id and is_active is distinct from p_active;
  if not found and not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'no profile for this user' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function admin_list_users() from public, anon;
grant execute on function admin_list_users() to authenticated;
revoke execute on function admin_set_user_role(uuid, user_role) from public, anon;
grant execute on function admin_set_user_role(uuid, user_role) to authenticated;
revoke execute on function admin_set_user_active(uuid, boolean) from public, anon;
grant execute on function admin_set_user_active(uuid, boolean) to authenticated;
