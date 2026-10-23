"""
export_live_incident.py — pull a real incident from the live Supabase Postgres
database into a local SQLite file shaped like seed_demo_db.py's SCHEMA, so
db.py/kpis.py/report.py can run against real event data, not just the
synthetic demo.

Deliberately stdlib-only (urllib.request, json, sqlite3) - no new production
dependency for the analytics package, per CLAUDE.md. Talks to Supabase's
PostgREST REST API directly rather than a Postgres wire-protocol driver.

Requires a service-role key (bypasses RLS - this is an offline reporting
tool run by a trusted operator against their own incident data, not a
client-facing code path). NEVER commit a key: read only from the
SUPABASE_SERVICE_ROLE_KEY environment variable, found in the Supabase
dashboard under Project Settings -> API -> service_role secret.

Run:
    export SUPABASE_SERVICE_ROLE_KEY=...   # from the Supabase dashboard, never committed
    python export_live_incident.py --incident-id 00000000-0000-0000-0000-0000000000a1 --out live_incident.db

Then use it exactly like the demo DB:
    from db import DB
    from kpis import KPIEngine
    db = DB("live_incident.db")
    kpi = KPIEngine(db)
    print(kpi.command_summary())

Known, deliberate scope limits (see docs/ROADMAP.md Phase 3 and the
per-table mapping notes below):
  - incident_command_state is NOT exported: its live schema (aggregate
    counts refreshed by a Postgres trigger) and this SQLite schema's columns
    genuinely don't match. Not needed - kpis.py's command_summary() already
    falls back to computing the same aggregates locally when this table is
    empty, from the real exported patients/watchdog_alerts data.
  - device_sync_state is not exported: it was always empty live and is in the
    archive schema since database/070 (WP-15); its SQLite table is left empty.
  - sectors and local_event_queue are not exported: db.py never queries
    sectors, and local_event_queue represents a device's own *unsynced*
    local queue, which by definition the server never sees.
  - Tables and columns added live later (gap N10) go to their own SQLite
    tables, so the original ones keep their shape: incident_details,
    patient_evacuation (destination, MDA class, trap status), event_origins
    (merged events), medical_resource_requests, supply_requests,
    incident_pre_evacuations, incident_site_authority, external_reports,
    external_patient_links and aar_reports (the report stored on each close).
    Display names are not copied; actor ids join to profiles.
  - Several tables have columns with no live equivalent (documented inline
    per table below) - those are left as their SQLite column's own default
    or None rather than invented.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from seed_demo_db import SCHEMA

SUPABASE_URL = "https://btvvjmuwdzirjyauyijx.supabase.co"
PAGE_SIZE = 1000


def fetch_table(table: str, service_key: str, incident_id: str | None, incident_column: str = "incident_id", op: str = "eq") -> list[dict[str, Any]]:
    """Fetch all rows of `table` via PostgREST, paginating with the Range header.

    `op` is the PostgREST operator for the filter: "eq" by default, "in" with a value like
    "(id1,id2)" for a table with no incident_id of its own (external_patient_links)."""
    rows: list[dict[str, Any]] = []
    offset = 0
    query = f"select=*" + (f"&{incident_column}={op}.{incident_id}" if incident_id else "")
    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table}?{query}"
        req = urllib.request.Request(url, headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Range-Unit": "items",
            "Range": f"{offset}-{offset + PAGE_SIZE - 1}",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                page = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"fetching {table} failed: HTTP {e.code} {e.read().decode('utf-8', 'ignore')}") from e
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def b(value: Any) -> int | None:
    """Postgres boolean -> SQLite integer (0/1), preserving None."""
    if value is None:
        return None
    return 1 if value else 0


def j(value: Any) -> str:
    """Postgres jsonb (already decoded by json.loads) -> SQLite text."""
    return json.dumps(value if value is not None else {})


def insert_rows(conn: sqlite3.Connection, table: str, columns: list[str], rows: list[tuple]) -> None:
    if not rows:
        return
    placeholders = ",".join("?" for _ in columns)
    conn.executemany(
        f"insert or ignore into {table} ({','.join(columns)}) values ({placeholders})",
        rows,
    )


def export_incident(incident_id: str, out_path: Path, service_key: str) -> None:
    if out_path.exists():
        out_path.unlink()
    conn = sqlite3.connect(out_path)
    conn.executescript(SCHEMA)

    # profiles: not incident-scoped live (no incident_id column) - export every profile this
    # service key can see. Small table, safe to pull in full for a single-incident export.
    profiles = fetch_table("profiles", service_key, None)
    insert_rows(conn, "profiles", ["id", "display_name", "role", "is_active", "created_at"], [
        (r["id"], r["display_name"], r["role"], b(r["is_active"]), r["created_at"]) for r in profiles
    ])

    incidents = fetch_table("incidents", service_key, incident_id, "id")
    insert_rows(conn, "incidents", ["id", "visual_id", "t_zero", "t_injury_default", "location_name", "status", "opened_by", "opened_at", "closed_at", "draft_created_at", "draft_resolved_at"], [
        # draft_created_at has no live equivalent (live tracks draft_created_by, not -_at) -> None.
        (r["id"], r["visual_id"], r["t_zero"], r["t_injury_default"], r["location_name"], r["status"], r["opened_by"], r["opened_at"], r["closed_at"], None, r["draft_resolved_at"]) for r in incidents
    ])

    patients = fetch_table("patients", service_key, incident_id)
    insert_rows(conn, "patients", ["id", "incident_id", "sector_id", "visual_id", "current_triage", "access_status", "current_status", "is_pediatric", "needs_full_assessment", "t_injury", "created_at", "last_vitals_at", "handed_over_at", "location_json"], [
        (r["id"], r["incident_id"], r["sector_id"], r["visual_id"], r["current_triage"], r["access_status"], r["current_status"], b(r["is_pediatric"]), b(r["needs_full_assessment"]), r["t_injury"], r["created_at"], r["last_vitals_at"], r["handed_over_at"], j(r["location_json"])) for r in patients
    ])

    events = fetch_table("events", service_key, incident_id)
    insert_rows(conn, "events", ["id", "incident_id", "patient_id", "actor_id", "type", "payload_json", "device_id", "local_event_id", "clinical_timestamp", "local_timestamp", "server_timestamp", "synced_at"], [
        # clinical_timestamp has no live equivalent - local_timestamp is the closest proxy
        # (when the device says the clinical moment happened, vs. server_timestamp being when
        # the row landed). is_critical/depends_on_local_event_id are left at their SQLite
        # column defaults (1 / NULL) since the live schema doesn't track either.
        (r["id"], r["incident_id"], r["patient_id"], r["actor_id"], r["type"], j(r["payload_json"]), r["device_id"], r["local_event_id"], r["local_timestamp"], r["local_timestamp"], r["server_timestamp"], r["synced_at"]) for r in events
    ])

    tourniquets = fetch_table("tourniquets", service_key, incident_id)
    insert_rows(conn, "tourniquets", ["id", "incident_id", "patient_id", "limb", "clinical_context", "applied_at", "last_reassessed_at", "next_reassessment_due_at", "released_at", "is_active", "source_event_id"], [
        # source_event_id <- applied_event_id: "the event that created this tourniquet record",
        # the closest live analog to this column's meaning.
        (r["id"], r["incident_id"], r["patient_id"], r["limb"], r["clinical_context"], r["applied_at"], r["last_reassessed_at"], r["next_reassessment_due_at"], r["released_at"], b(r["is_active"]), r["applied_event_id"]) for r in tourniquets
    ])

    # inventory_ledger: exported from inventory_ledger_v12, the table the real client actually
    # writes to - see docs/ARCHITECTURE.md's "Backend Deployment Status" on why the plain
    # inventory_ledger table is schema debt, not live data. v12's item_type/movement_type shape
    # has no owner-tier or human-readable-name concept, so those columns are best-effort:
    # owner_type is a constant placeholder (not real ownership-tier data), item_name duplicates
    # item_type (no separate label available), reason <- movement_type.
    ledger = fetch_table("inventory_ledger_v12", service_key, incident_id)
    insert_rows(conn, "inventory_ledger", ["id", "incident_id", "owner_type", "owner_id", "owner_label", "item_sku", "item_name", "quantity_change", "reason", "related_patient_id", "related_event_id", "transfer_group_id", "clinical_timestamp", "server_timestamp", "location_at_time"], [
        (r["id"], r["incident_id"], "field", r["actor_id"], None, r["item_type"], r["item_type"], r["quantity_delta"], r["movement_type"], r["patient_id"], None, None, r["created_at"], r["created_at"], "{}") for r in ledger
    ])

    alerts = fetch_table("watchdog_alerts", service_key, incident_id)
    insert_rows(conn, "watchdog_alerts", ["id", "incident_id", "patient_id", "actor_id", "alert_type", "severity", "message", "triggered_at", "acknowledged_at", "resolved_at", "dedupe_key", "source_event_id", "resolved_by_event_id", "suppressed_before_dashboard"], [
        (r["id"], r["incident_id"], r["patient_id"], r["actor_id"], r["alert_type"], r["severity"], r["message"], r["triggered_at"], r["acknowledged_at"], r["resolved_at"], r["dedupe_key"], r["source_event_id"], r["resolved_by_event_id"], b(r["suppressed_before_dashboard"])) for r in alerts
    ])

    presence = fetch_table("device_presence", service_key, incident_id)
    insert_rows(conn, "device_presence", ["id", "incident_id", "actor_id", "device_id", "last_heartbeat_at", "sync_status", "battery_pct", "updated_at"], [
        # battery_pct has no live equivalent on this table (that's on device_sync_state) -> None.
        (r["id"], r["incident_id"], r["actor_id"], r["device_id"], r["last_heartbeat_at"], r["sync_status"], None, r["updated_at"]) for r in presence
    ])

    # device_sync_state is not fetched: live it was always empty and database/070 (WP-15) moved it
    # to the archive schema, which the API cannot reach. The SQLite table stays (KPIEngine reads
    # it) and is left empty.

    errors = fetch_table("sync_ingestion_errors", service_key, incident_id)
    insert_rows(conn, "sync_ingestion_errors", ["id", "incident_id", "device_id", "actor_id", "local_event_id", "depends_on_local_event_id", "error_code", "error_message", "raw_payload", "created_at", "resolved_at", "dependency_status", "parent_error_id"], [
        # depends_on_local_event_id <- parent_local_event_id. parent_error_id has no live
        # equivalent (live links parents by device_id+local_event_id, not a parent row id) -> None.
        (r["id"], r["incident_id"], r["device_id"], r["actor_id"], r["local_event_id"], r["parent_local_event_id"], r["error_code"], r["error_message"], j(r["raw_payload"]) if r["raw_payload"] is not None else None, r["created_at"], r["resolved_at"], r["dependency_status"], None) for r in errors
    ])

    conflicts = fetch_table("conflict_log", service_key, incident_id)
    insert_rows(conn, "conflict_log", ["id", "incident_id", "patient_id", "actor_id", "conflict_type", "severity", "description", "payload_json", "created_at", "resolved_by", "resolved_at"], [
        (r["id"], r["incident_id"], r["patient_id"], r["actor_id"], r["conflict_type"], r["severity"], r["description"], j(r["payload_json"]), r["created_at"], r["resolved_by"], r["resolved_at"]) for r in conflicts
    ])

    notes = fetch_table("aar_context_notes", service_key, incident_id)
    insert_rows(conn, "aar_context_notes", ["id", "incident_id", "actor_id", "created_at", "note_type", "content", "related_event_id"], [
        (r["id"], r["incident_id"], r["actor_id"], r["created_at"], r["note_type"], r["note_text"] or "", r["source_event_id"]) for r in notes
    ])

    export_newer_tables(conn, incident_id, service_key, incidents, patients, events)

    conn.commit()
    counts = {
        t: conn.execute(f"select count(*) from {t}").fetchone()[0]
        for t in ["profiles", "incidents", "patients", "events", "tourniquets", "inventory_ledger", "watchdog_alerts", "device_presence", "device_sync_state", "sync_ingestion_errors", "conflict_log", "aar_context_notes", *NEWER_TABLES]
    }
    conn.close()
    print(f"Exported incident {incident_id} to {out_path.resolve()}")
    for table, count in counts.items():
        print(f"  {table}: {count}")


NEWER_TABLES = ["incident_details", "patient_evacuation", "event_origins", "medical_resource_requests", "supply_requests", "incident_pre_evacuations", "incident_site_authority", "external_reports", "external_patient_links", "aar_reports"]


def export_newer_tables(conn: sqlite3.Connection, incident_id: str, service_key: str, incidents: list[dict[str, Any]], patients: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    """Tables and columns added live after the original SQLite schema (gap N10): evacuation and
    MDA class, merge origin, requests, pre-evacuation, site authority, external reports and their
    links, and the reports stored on each close (database/068). Each goes to its own SQLite table
    (seed_demo_db.SCHEMA) so the existing ones keep their shape. Display names are not copied:
    the actor ids join to profiles."""
    # incidents: type, unit, finalize time and metadata (a merged duplicate keeps merged_into there).
    insert_rows(conn, "incident_details", ["incident_id", "incident_type", "company_id", "platoon_id", "aar_finalized_at", "metadata_json"], [
        (r["id"], r.get("incident_type"), r.get("company_id"), r.get("platoon_id"), r.get("aar_finalized_at"), j(r.get("metadata"))) for r in incidents
    ])
    # patients: where they were evacuated to and MDA's own classification beside field triage
    # (database/043, 044), and the trapped / not trapped status.
    insert_rows(conn, "patient_evacuation", ["patient_id", "incident_id", "evacuation_destination", "mda_classification", "evacuation_updated_at", "trap_status"], [
        (r["id"], r["incident_id"], r.get("evacuation_destination"), r.get("mda_classification"), r.get("evacuation_updated_at"), r.get("trap_status")) for r in patients
    ])
    # events moved here by merge_incident() (D8) keep the incident they were recorded in.
    insert_rows(conn, "event_origins", ["event_id", "incident_id", "origin_incident_id"], [
        (r["id"], r["incident_id"], r["origin_incident_id"]) for r in events if r.get("origin_incident_id") and r["origin_incident_id"] != r["incident_id"]
    ])

    requests = fetch_table("medical_resource_requests", service_key, incident_id)
    insert_rows(conn, "medical_resource_requests", ["id", "incident_id", "request_kind", "resource_type", "quantity", "urgency", "reason_codes_json", "linked_patient_ids_json", "target_location", "free_text", "auto_generated", "status", "status_history_json", "requested_by", "requested_by_role", "requested_at", "status_updated_by", "status_updated_by_role", "status_updated_at"], [
        (r["id"], r["incident_id"], r["request_kind"], r["resource_type"], r["quantity"], r["urgency"], json.dumps(r.get("reason_codes") or []), json.dumps(r.get("linked_patient_ids") or []), r["target_location"], r["free_text"], b(r["auto_generated"]), r["status"], json.dumps(r.get("status_history") or []), r["requested_by"], r["requested_by_role"], r["requested_at"], r["status_updated_by"], r["status_updated_by_role"], r["status_updated_at"]) for r in requests
    ])

    supply = fetch_table("supply_requests", service_key, incident_id)
    insert_rows(conn, "supply_requests", ["id", "incident_id", "requester_id", "status", "request_level", "approved_by_pc", "items_json", "eta_minutes", "requested_at", "dispatched_at", "in_transit_at", "delivered_at", "updated_at", "notes"], [
        (r["id"], r["incident_id"], r["requester_id"], r["status"], r["request_level"], r["approved_by_pc"], json.dumps(r.get("items_json") or []), r["eta_minutes"], r["requested_at"], r["dispatched_at"], r["in_transit_at"], r["delivered_at"], r["updated_at"], r["notes"]) for r in supply
    ])

    pre = fetch_table("incident_pre_evacuations", service_key, incident_id)
    insert_rows(conn, "incident_pre_evacuations", ["incident_id", "groups_json", "note", "light_count", "moderate_count", "severe_count", "total_count", "reported_by", "reported_by_role", "reported_at", "updated_by", "updated_by_role", "updated_at"], [
        (r["incident_id"], json.dumps(r.get("groups") or []), r["note"], r["light_count"], r["moderate_count"], r["severe_count"], r["total_count"], r["reported_by"], r["reported_by_role"], r["reported_at"], r["updated_by"], r["updated_by_role"], r["updated_at"]) for r in pre
    ])

    site = fetch_table("incident_site_authority", service_key, incident_id)
    insert_rows(conn, "incident_site_authority", ["incident_id", "official_t0", "official_by_role", "official_at", "building_status", "building_status_by_role", "building_status_at", "site_cleared_at", "site_cleared_by_role", "updated_at"], [
        (r["incident_id"], r["official_t0"], r["official_by_role"], r["official_at"], r["building_status"], r["building_status_by_role"], r["building_status_at"], r["site_cleared_at"], r["site_cleared_by_role"], r["updated_at"]) for r in site
    ])

    reports = fetch_table("external_reports", service_key, incident_id)
    insert_rows(conn, "external_reports", ["id", "incident_id", "source", "external_reference", "reported_red", "reported_yellow", "reported_green", "reported_black", "evacuation_destination", "notes", "created_by", "created_at", "updated_at"], [
        (r["id"], r["incident_id"], r["source"], r["external_reference"], r["reported_red"], r["reported_yellow"], r["reported_green"], r["reported_black"], r["evacuation_destination"], r["notes"], r["created_by"], r["created_at"], r["updated_at"]) for r in reports
    ])
    # external_patient_links has no incident_id: fetched by this incident's report ids.
    if reports:
        links = fetch_table("external_patient_links", service_key, "(" + ",".join(r["id"] for r in reports) + ")", "external_report_id", op="in")
        insert_rows(conn, "external_patient_links", ["id", "external_report_id", "patient_id", "match_score", "linked_by", "linked_at"], [
            (r["id"], r["external_report_id"], r["patient_id"], float(r["match_score"]) if r.get("match_score") is not None else None, r["linked_by"], r["linked_at"]) for r in links
        ])

    # aar_reports: one locked, statistics-only version per close (database/068).
    stored = fetch_table("aar_reports", service_key, incident_id)
    insert_rows(conn, "aar_reports", ["id", "incident_id", "generated_by", "generated_at", "locked", "report_json"], [
        (r["id"], r["incident_id"], r["generated_by"], r["generated_at"], b(r["locked"]), j(r["report_json"])) for r in stored
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--incident-id", required=True, help="incidents.id (uuid) to export")
    parser.add_argument("--out", default="live_incident.db", help="output SQLite path (default: live_incident.db)")
    args = parser.parse_args()

    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        print("SUPABASE_SERVICE_ROLE_KEY is not set. Get it from the Supabase dashboard "
              "(Project Settings -> API -> service_role secret) and export it - never commit it.", file=sys.stderr)
        return 1

    export_incident(args.incident_id, Path(args.out), service_key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
