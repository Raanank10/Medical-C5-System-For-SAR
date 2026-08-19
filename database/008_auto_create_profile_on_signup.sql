-- profiles.id has no FK to auth.users and there was no trigger creating a
-- profiles row on signup. app.current_user_role() is
-- `select role from profiles where id = auth.uid()`, so any real signup
-- with no matching profiles row gets NULL back from every RLS role check -
-- fail-closed (locked out), not a security hole, but a real onboarding gap:
-- Auth wiring in 006/007 only worked because profiles rows were inserted
-- manually via SQL for each test account. Default role is 'medic' (lowest
-- privilege) - promoting to a higher role is a deliberate separate action,
-- not something signup should grant itself.
--
-- Verified with a real signup after applying this: a fresh auth.users row
-- got a matching profiles row (role='medic') with zero manual SQL.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email, 'Unnamed'), 'medic')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
