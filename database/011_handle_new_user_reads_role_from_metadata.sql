-- 008_auto_create_profile_on_signup.sql deliberately hardcoded role='medic' for every signup
-- ("promoting to a higher role is a deliberate separate action, not something signup should
-- grant itself"). In practice this meant EVERY new user landed as medic with no way to tell
-- them apart from someone who was actually supposed to be medic - inviting a platoon commander
-- put them in the medic dashboard until someone noticed and manually fixed the row.
--
-- This reads role from the invite's user_metadata instead (set via the Auth Admin /invite
-- endpoint's `data` field - see scripts/invite_user.js, since the dashboard's "Send invitation"
-- button has no field for metadata at all). If role is missing or not a real user_role value
-- (e.g. someone invited through the dashboard button instead of the script), the profile is
-- still created - onboarding must not silently fail closed on that alone - but is_active=false,
-- so the account is locked out and obviously wrong rather than silently wrong with a plausible-
-- looking role. is_active is already checked everywhere (RLS policies, sync-log Edge Function).
--
-- Verified: invited a real test account through scripts/invite_user.js with role=rpc, confirmed
-- the resulting profile had role='rpc', is_active=true, with zero manual SQL.

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
