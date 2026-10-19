-- Admin wins the concurrent-edit tie-break (repo owner decision, 2026-10-19; docs/GAP_CLOSURE_PLAN.md D7).
--
-- database/047 gave admin every action ("admin may do everything") but kept
-- app.role_authority_rank('admin') = 0, the deliberate safe default from database/021, so a
-- test/admin push could never outrank a real clinical edit. The owner decided admin is above every
-- role, including in this tie-break: when admin and another role edit the same patient field
-- (triage or status) within the 5-minute window, admin's edit wins, and the losing side is still
-- logged to conflict_log as before (never silent).
--
-- Only the rank changes. Outside the window plain last-write-wins still applies; chamal,
-- logistics_officer, rpc and rcc stay at 0. Event log and audit tables stay append-only for every
-- role, admin included (CLAUDE.md: never remove audit history).

create or replace function app.role_authority_rank(r user_role)
returns integer
language sql
immutable
set search_path = public
as $$
  select case r
    when 'admin'     then 6  -- database/048: admin above every clinical role
    when 'physician' then 5
    when 'paramedic' then 4
    when 'cc'        then 3
    when 'pc'        then 2
    when 'medic'     then 1
    else 0  -- chamal, logistics_officer, rpc, rcc, and any future role: not part of the
            -- clinical tie-break (docs/CONFLICT_RESOLUTION_DECISION.md).
  end
$$;

-- create or replace keeps existing grants, but re-assert database/021's rule.
revoke execute on function app.role_authority_rank(user_role) from public, anon, authenticated;
