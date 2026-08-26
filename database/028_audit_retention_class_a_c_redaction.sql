-- Implements the two concrete, near-term-actionable mechanisms named in
-- docs/AUDIT_AND_RETENTION_POLICY.md that don't require picking a retention
-- duration (that part still needs real legal/organizational input, per that
-- doc's own scoping) - both are schema-driven off columns that already exist:
--
-- 1. Class A refinement on patient_handover_tokens: once a token has expired,
--    its credential material (token_hash/token_signature/encrypted_link) is a
--    dead secret with no further operational or audit use - null it out, keep
--    the row itself (patient_id, handover_method, destination_facility,
--    created_at, expires_at, consumed_at) as the permanent Class A audit
--    record of "a handover token was issued at time X for patient Y, and
--    whether/when it was consumed."
-- 2. Class C: sync_ingestion_errors.raw_payload can contain partial clinical
--    free text that never became part of the actual patient record (that's
--    why it was rejected) - once a row is resolved_at, null out raw_payload
--    specifically while keeping error_code/error_message/dependency_status/
--    timestamps as the permanent Class B diagnostic trail. Directly closes
--    docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md finding #7.
--
-- "Deletion must be audited, not silent" (same doc): both functions write a
-- retention_actions row before redacting, so the fact that something was
-- redacted - what, when, under what policy - is itself a permanent record.
--
-- Explicitly NOT covered here: Class B's incident-close-triggered archival
-- and Class C's window-based fallback (e.g. "30-90 days") both need a real
-- policy decision on the actual duration, which this migration doesn't
-- invent - see docs/AUDIT_AND_RETENTION_POLICY.md's own scoping.

create table if not exists retention_actions (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  action text not null,
  reason text not null,
  performed_by text not null default 'system:retention_policy',
  performed_at timestamptz not null default now()
);

alter table retention_actions enable row level security;

-- Reviewable by command roles (same audience as the sync_ingestion_errors
-- quarantine review panel this pairs with), never writable by authenticated -
-- only the SECURITY DEFINER functions below (and service_role) write to it.
create policy retention_actions_read_command on retention_actions
  for select to authenticated
  using (app.is_command_role());

-- token_hash/token_signature were NOT NULL - redaction sets them to null, so
-- that constraint has to relax. The UNIQUE constraint on token_hash is
-- unaffected: Postgres never treats NULL as equal to NULL under UNIQUE, so
-- multiple redacted rows holding NULL don't conflict with each other or with
-- a live token's real hash.
alter table patient_handover_tokens alter column token_hash drop not null;
alter table patient_handover_tokens alter column token_signature drop not null;

create or replace function redact_expired_handover_token_credentials()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select id from patient_handover_tokens
    where expires_at < now() and token_hash is not null
  loop
    insert into retention_actions (table_name, row_id, action, reason)
    values (
      'patient_handover_tokens', v_row.id,
      'redact_credential_columns',
      'token_hash/token_signature/encrypted_link nulled after expiry - docs/AUDIT_AND_RETENTION_POLICY.md Class A refinement'
    );

    update patient_handover_tokens
    set token_hash = null, token_signature = null, encrypted_link = null
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function redact_resolved_sync_ingestion_error_payloads()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select id from sync_ingestion_errors
    where resolved_at is not null and raw_payload is not null
  loop
    insert into retention_actions (table_name, row_id, action, reason)
    values (
      'sync_ingestion_errors', v_row.id,
      'redact_raw_payload',
      'raw_payload nulled after resolution - docs/AUDIT_AND_RETENTION_POLICY.md Class C, closes docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md finding #7'
    );

    update sync_ingestion_errors
    set raw_payload = null
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Neither function is meant to be PostgREST/RPC-callable by end users (this is
-- a system maintenance process, not an app feature) - revoke from anon/
-- authenticated, matching the same "not exposed via API" convention already
-- used for the app.*() helper functions.
revoke all on function redact_expired_handover_token_credentials() from anon, authenticated;
revoke all on function redact_resolved_sync_ingestion_error_payloads() from anon, authenticated;

create extension if not exists pg_cron;

select cron.schedule(
  'redact-expired-handover-tokens',
  '0 3 * * *',
  $$select redact_expired_handover_token_credentials()$$
);

select cron.schedule(
  'redact-resolved-sync-error-payloads',
  '15 3 * * *',
  $$select redact_resolved_sync_ingestion_error_payloads()$$
);
