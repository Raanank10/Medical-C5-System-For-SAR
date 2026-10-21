-- Rescue site-authority state crosses devices (WP-8, docs/GAP_CLOSURE_PLAN.md, V2.99.44).
--
-- RPC/RCC declare the incident official with a T0, set the building status and confirm the site
-- clear (docs/ROLE_COMMAND_MODEL_v2.8.md, "Site authority: final, without medical sign-off"). The
-- client has pushed OFFICIAL_INCIDENT_OPENED_BY_RESCUE, BUILDING_STATUS_UPDATED and
-- SITE_CLEAR_CONFIRMED since 009, but nothing projected them, so the PC/CC "site status" line and
-- the medic's Movement screen only ever showed what this same phone had pressed. (Incident type
-- already crosses devices through incidents.incident_type; close/reopen through
-- close_incident()/reopen_incident().)
--
-- Where the state lives: its own table, not incidents.metadata. The client rewrites the whole
-- metadata object (read-modify-write for medic assignments and the incident type), so a trigger
-- writing a key there could be silently overwritten by a stale copy. And incidents_update RLS lets
-- pc/cc/chamal/physician update the incident row, which would let them set rescue's fields
-- directly. Here only the trigger writes; authenticated users can only read.
--
-- Rules (the role is read from profiles by actor_id, never from events.actor_role):
-- - Only rpc, rcc and admin change this state. sync-log also lets pc/cc/chamal/physician send these
--   types (SITE_AUTHORITY_EVENTS); their events are kept in events as the audit record and change
--   nothing here. This is the server-side enforcement the role model doc asked for.
-- - T0: the first declaration wins (payload t0, else the event's local_timestamp; a T0 more than 5
--   minutes in the future is ignored). incidents.t_zero is not touched: it is the incident's own
--   opening time from open_incident(), which other parts (t_injury_default, AAR) already use.
-- - Building status: the newest local_timestamp wins; unknown values are ignored.
-- - Site clear: the first confirmation wins (there is no "un-clear" action).
-- - Never raises: a trigger that raises rolls back the event insert.

create table if not exists incident_site_authority (
  incident_id uuid primary key references incidents(id) on delete cascade,
  official_t0 timestamptz,
  official_by_role text,
  official_by_name text,
  official_at timestamptz,
  building_status text check (building_status in ('stable','unstable','progressive_collapse','safe_to_enter')),
  building_status_by_role text,
  building_status_by_name text,
  building_status_at timestamptz,
  site_cleared_at timestamptz,
  site_cleared_by_role text,
  site_cleared_by_name text,
  updated_at timestamptz not null default now()
);

alter table incident_site_authority enable row level security;

drop policy if exists incident_site_authority_read on incident_site_authority;
create policy incident_site_authority_read on incident_site_authority for select to authenticated
using (app.can_access_incident(incident_id));
-- No insert/update/delete policy: only project_incident_site_authority() (security definer) writes.

create or replace function project_incident_site_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  actor_name text;
  v_t0 timestamptz;
  v_status text;
begin
  if new.type not in ('OFFICIAL_INCIDENT_OPENED_BY_RESCUE', 'BUILDING_STATUS_UPDATED', 'SITE_CLEAR_CONFIRMED') then
    return new;
  end if;
  if new.incident_id is null then
    return new;
  end if;

  begin
    select p.role::text, p.display_name into actor_role, actor_name from profiles p where p.id = new.actor_id;
    if actor_role is null or actor_role not in ('rpc', 'rcc', 'admin') then
      return new; -- kept in events as the audit record, state unchanged
    end if;

    insert into incident_site_authority (incident_id) values (new.incident_id)
    on conflict (incident_id) do nothing;

    if new.type = 'OFFICIAL_INCIDENT_OPENED_BY_RESCUE' then
      begin
        v_t0 := nullif(new.payload_json->>'t0', '')::timestamptz;
      exception when others then
        v_t0 := null;
      end;
      v_t0 := coalesce(v_t0, new.local_timestamp);
      if v_t0 > now() + interval '5 minutes' then
        return new;
      end if;
      update incident_site_authority
      set official_t0 = v_t0, official_by_role = actor_role, official_by_name = actor_name,
          official_at = new.local_timestamp, updated_at = now()
      where incident_id = new.incident_id and official_t0 is null;

    elsif new.type = 'BUILDING_STATUS_UPDATED' then
      v_status := new.payload_json->>'status';
      if v_status is null or v_status not in ('stable','unstable','progressive_collapse','safe_to_enter') then
        return new;
      end if;
      update incident_site_authority
      set building_status = v_status, building_status_by_role = actor_role, building_status_by_name = actor_name,
          building_status_at = new.local_timestamp, updated_at = now()
      where incident_id = new.incident_id
        and (building_status_at is null or new.local_timestamp >= building_status_at);

    elsif new.type = 'SITE_CLEAR_CONFIRMED' then
      update incident_site_authority
      set site_cleared_at = new.local_timestamp, site_cleared_by_role = actor_role, site_cleared_by_name = actor_name,
          updated_at = now()
      where incident_id = new.incident_id and site_cleared_at is null;
    end if;
  exception when others then
    null; -- never fail the event insert over the projection
  end;

  return new;
end;
$$;

revoke execute on function project_incident_site_authority() from public, anon, authenticated;

drop trigger if exists trg_project_incident_site_authority on events;
create trigger trg_project_incident_site_authority
after insert on events
for each row execute function project_incident_site_authority();
