-- 044/045 revoked EXECUTE on their new trigger functions from PUBLIC only. Supabase also grants
-- EXECUTE to anon and authenticated directly (default privileges), so the security advisor
-- reported public.project_evacuation_tracking() as callable via /rest/v1/rpc (found live
-- 2026-10-18, right after applying 044). A trigger function cannot actually run outside a trigger,
-- but it should not be exposed at all - same fix as database/016 for handle_new_user().
revoke execute on function public.project_evacuation_tracking() from anon, authenticated;
revoke execute on function app.guard_platoon_commander_change() from anon, authenticated;
