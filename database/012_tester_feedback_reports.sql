-- In-app "Report a problem" button for friends/testers who won't have a GitHub account.
-- Separate from the events/patients event-sourcing model on purpose: feedback reports are not
-- clinical data and don't need the offline outbox/sync-log pipeline, so the client writes here
-- directly over the Supabase client (online-only, same pattern as auth calls).
--
-- Reviewing reports: command roles (pc/cc/chamal/admin) can read and triage everything via
-- app.is_command_role(); a tester can only see their own submissions. Promoting a real bug into
-- a tracked GitHub issue is a manual step for now (paste the summary in) - github_issue_url is
-- just a place to record the link once that's done, not an automated sync.

create table if not exists tester_feedback_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reporter_role user_role,
  reporter_display_name text,
  screen text,
  summary text not null,
  expected text,
  device_info text,
  app_version text,
  status text not null default 'new' check (status in ('new', 'triaged', 'resolved', 'wont_fix')),
  github_issue_url text
);

create index if not exists idx_tester_feedback_reports_status on tester_feedback_reports(status);
create index if not exists idx_tester_feedback_reports_reporter on tester_feedback_reports(reporter_id);

alter table tester_feedback_reports enable row level security;

create policy tester_feedback_reports_insert_own
  on tester_feedback_reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));

create policy tester_feedback_reports_select_own_or_command
  on tester_feedback_reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (select app.is_command_role()));

create policy tester_feedback_reports_update_command_only
  on tester_feedback_reports for update to authenticated
  using ((select app.is_command_role()))
  with check ((select app.is_command_role()));
