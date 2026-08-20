-- Supabase's security advisor flags public.handle_new_user() as callable by anon and
-- authenticated via /rest/v1/rpc/handle_new_user (database/008/011). It's a trigger function
-- (fired by "after insert on auth.users", 008_auto_create_profile_on_signup.sql) - Postgres
-- itself rejects direct RPC calls to trigger functions regardless of grants (they return the
-- special `trigger` pseudo-type, which can't be produced by an ordinary function call), so
-- this isn't actually exploitable today. Revoking the direct-call grant anyway per the
-- advisor's own recommendation costs nothing: the trigger fires under the definer's privileges
-- (SECURITY DEFINER), not the calling role's, so this does not affect signup.

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
