-- WP-18 follow-up: 077 revoked project_evac_point_arrival() from public only. Supabase also
-- grants execute to anon and authenticated by default, so get_advisors flagged it as a
-- SECURITY DEFINER function callable over /rest/v1/rpc (lints 0028/0029). A trigger function
-- cannot run outside a trigger, so nothing could be done with it, but the other trigger
-- functions are revoked from all three roles (071-073) and this one now matches.

revoke all on function public.project_evac_point_arrival() from public, anon, authenticated;
