"""Tests for export_live_incident.py's live-schema -> SQLite mapping.

Mocks fetch_table() with rows shaped exactly like the live Supabase tables
(see database/001_postgresql_schema_v1.2.sql) rather than hitting the
network, then verifies the resulting SQLite file actually loads and computes
through the real DB/KPIEngine classes - the same check that matters for a
real export, without needing live credentials in CI or local dev.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

import export_live_incident as export_mod
from db import DB
from kpis import KPIEngine


def _uid() -> str:
    return str(uuid.uuid4())


@pytest.fixture()
def live_rows():
    """Synthetic rows shaped like the live Postgres tables' actual columns."""
    now = datetime.now(timezone.utc).isoformat()
    incident_id = "00000000-0000-0000-0000-0000000000a1"
    patient_id = _uid()
    actor_id = _uid()
    return {
        "incident_id": incident_id,
        "patient_id": patient_id,
        "actor_id": actor_id,
        "rows": {
            "profiles": [{"id": actor_id, "display_name": "Test Medic", "role": "medic", "unit_name": None, "phone": None, "device_id": "dev-1", "last_seen_at": now, "is_active": True, "created_at": now, "updated_at": now, "version": 1}],
            "incidents": [{"id": incident_id, "visual_id": "INC-1", "t_zero": now, "t_injury_default": now, "location_name": "Test Site", "address": None, "incident_type": None, "status": "active", "draft_created_by": None, "confirmed_by": None, "opened_by": actor_id, "closed_by": None, "opened_at": now, "confirmed_at": None, "draft_acknowledged_by": None, "draft_acknowledged_at": None, "draft_resolved_at": None, "closed_at": None, "metadata": {"merged_from": ["INC-0"]}, "created_at": now, "updated_at": now, "version": 1, "aar_finalized_at": None, "company_id": "co-1", "platoon_id": "pl-1"}],
            "patients": [{"id": patient_id, "incident_id": incident_id, "sector_id": None, "visual_id": "P-001", "optional_name": None, "t_injury": now, "current_triage": "red", "algorithm_triage": None, "triage_recorded_at": now, "access_status": "free", "access_recorded_at": now, "current_status": "stabilizing", "status_recorded_at": now, "is_pediatric": False, "pediatric_age_years": None, "needs_full_assessment": True, "pending_incident_approval": False, "pulse_present": True, "breathing_present": True, "tourniquet_used": True, "injury_zones": ["leg"], "is_trapped": False, "trap_status": "not_trapped", "location_json": {"zone": "A"}, "location_recorded_at": now, "last_vitals_at": now, "last_seen_at": now, "handed_over_at": None, "handed_over_to": None, "handover_token": _uid(), "handover_token_used_at": None, "handover_token_expires_at": None, "created_by": actor_id, "created_at": now, "updated_at": now, "version": 1, "evacuation_destination": "Hospital A", "mda_classification": "urgent", "evacuation_updated_at": now}],
            "events": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "actor_id": actor_id, "actor_role": "medic", "type": "VITALS_RECORDED", "payload_json": {"heart_rate": {"raw_count": 25, "window_seconds": 15, "calculated_bpm": 100, "entry_method": "stepper"}, "respiratory_rate": {"raw_count": 8, "window_seconds": 30, "calculated_rate": 16, "entry_method": "stepper"}, "spo2": 97, "avpu": "A", "bp_estimate": "radial_strong"}, "device_id": "dev-1", "local_event_id": "evt-1", "local_timestamp": now, "server_timestamp": now, "synced_at": now, "sync_cursor": 1, "event_version": 1, "origin_incident_id": "00000000-0000-0000-0000-0000000000a0"}],
            "tourniquets": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "limb": "left_leg", "applied_event_id": _uid(), "released_event_id": None, "last_reassessed_event_id": None, "applied_at": now, "released_at": None, "last_reassessed_at": now, "reassessment_due_at": now, "tourniquet_status": "active", "is_active": True, "created_at": now, "updated_at": now, "clinical_context": "gunshot", "reassessment_interval_minutes": 60, "next_reassessment_due_at": now, "last_reassessment_event_id": None, "released_by_event_id": None}],
            "inventory_ledger_v12": [{"id": _uid(), "incident_id": incident_id, "actor_id": actor_id, "item_type": "tourniquet", "movement_type": "consumed", "quantity_delta": -1, "device_id": "dev-1", "local_event_id": "evt-2", "patient_id": patient_id, "created_at": now, "payload_json": {}}],
            "watchdog_alerts": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "actor_id": actor_id, "alert_type": "vitals_overdue", "severity": "warning", "message": "test", "triggered_at": now, "acknowledged_by": None, "acknowledged_at": None, "resolved_at": None, "payload_json": {}, "updated_at": now, "version": 1, "dedupe_key": "dk1", "source_event_id": None, "resolved_by_event_id": None, "suppressed_before_dashboard": False}],
            "device_presence": [{"id": _uid(), "incident_id": incident_id, "actor_id": actor_id, "device_id": "dev-1", "current_location_json": {}, "current_patient_id": patient_id, "last_heartbeat_at": now, "sync_status": "online", "updated_at": now, "version": 1}],
            "sync_ingestion_errors": [],
            "conflict_log": [],
            "aar_context_notes": [{"id": _uid(), "incident_id": incident_id, "source_event_id": None, "patient_id": patient_id, "sector_id": None, "actor_id": actor_id, "note_type": "context_note", "note_text": "test note", "voice_memo_uri": None, "voice_memo_duration_seconds": None, "created_at": now}],
            # Newer tables (gap N10), shaped like their live columns.
            "medical_resource_requests": [{"id": _uid(), "incident_id": incident_id, "request_kind": "medical_reinforcement", "resource_type": "paramedic", "quantity": 1, "urgency": "immediate", "reason_codes": ["airway"], "linked_patient_ids": [patient_id], "site_id": "SITE_A", "target_location": "Building 2", "free_text": None, "auto_generated": False, "status": "assigned", "status_history": [{"status": "requested"}, {"status": "assigned"}], "requested_by": actor_id, "requested_by_name": "Test Medic", "requested_by_role": "medic", "requested_at": now, "status_updated_by": actor_id, "status_updated_by_name": "Test Medic", "status_updated_by_role": "pc", "status_updated_at": now, "origin_device_id": "dev-1", "origin_client_request_id": "req-1", "created_event_id": _uid(), "last_event_id": _uid(), "version": 2}],
            "supply_requests": [{"id": _uid(), "incident_id": incident_id, "requester_id": actor_id, "supervisor_id": None, "logistics_officer_id": None, "kit_template_id": None, "status": "delivered", "request_level": "medic", "parent_supply_request_id": None, "approved_by_pc": actor_id, "direct_resupply_override_reason": None, "delivery_location_json": {}, "eta_minutes": 5, "notes": None, "requested_at": now, "dispatched_at": now, "in_transit_at": now, "delivered_at": now, "updated_at": now, "version": 3, "origin_device_id": "dev-1", "origin_client_request_id": "sr-1", "items_json": [{"item": "tourniquet", "qty": 2}], "assigned_runner_name": "Runner"}],
            "incident_pre_evacuations": [{"incident_id": incident_id, "groups": [{"severity": "moderate", "count": 2}], "note": None, "light_count": 1, "moderate_count": 2, "severe_count": 0, "total_count": 3, "reported_by": actor_id, "reported_by_name": "Test Medic", "reported_by_role": "medic", "reported_at": now, "reported_event_id": _uid(), "updated_by": actor_id, "updated_by_name": "Test Medic", "updated_by_role": "medic", "updated_at": now, "last_event_id": _uid(), "version": 1}],
            "incident_site_authority": [{"incident_id": incident_id, "official_t0": now, "official_by_role": "rpc", "official_by_name": "Test RPC", "official_at": now, "building_status": "unstable", "building_status_by_role": "rpc", "building_status_by_name": "Test RPC", "building_status_at": now, "site_cleared_at": None, "site_cleared_by_role": None, "site_cleared_by_name": None, "updated_at": now}],
            "external_reports": [{"id": "rep-1", "incident_id": incident_id, "source": "mda", "external_reference": "MDA-77", "reported_red": 1, "reported_yellow": 0, "reported_green": 2, "reported_black": 0, "evacuation_destination": "Hospital A", "notes": None, "created_by": actor_id, "created_at": now, "updated_at": now, "version": 1, "source_event_id": None}],
            "external_patient_links": [{"id": _uid(), "external_report_id": "rep-1", "patient_id": patient_id, "match_score": "1.00", "match_reason": {}, "linked_by": actor_id, "linked_at": now}],
            "aar_reports": [{"id": _uid(), "incident_id": incident_id, "generated_by": actor_id, "generated_at": now, "report_json": {"version": 1, "patients": {"total": 1}}, "locked": True}],
        },
    }


@pytest.fixture()
def exported_db_path(tmp_path, monkeypatch, live_rows):
    def fake_fetch_table(table, service_key, incident_id, incident_column="incident_id", op="eq"):
        assert service_key == "fake-key"
        # Archived by database/070 (WP-15): not reachable through the API, so never fetched.
        assert table != "device_sync_state"
        live_rows.setdefault("fetches", []).append((table, incident_id, incident_column, op))
        return live_rows["rows"].get(table, [])

    monkeypatch.setattr(export_mod, "fetch_table", fake_fetch_table)
    out = tmp_path / "live_export.db"
    export_mod.export_incident(live_rows["incident_id"], out, "fake-key")
    return out


class TestExportIncident:
    def test_exports_expected_row_counts(self, exported_db_path):
        db = DB(exported_db_path)
        assert len(db.incidents()) == 1
        assert len(db.patients()) == 1
        assert len(db.events()) == 1
        assert len(db.watchdog_alerts()) == 1
        assert len(db.device_presence()) == 1

    def test_incident_command_state_deliberately_not_exported(self, exported_db_path):
        # incident_command_state's live and SQLite schemas genuinely don't match (see the
        # module docstring) - command_summary() must fall back to computing from real
        # patients/watchdog_alerts data instead, not fail or return an empty result.
        db = DB(exported_db_path)
        assert db.command_state(incident_id="00000000-0000-0000-0000-0000000000a1").empty

    def test_exported_data_loads_through_kpi_engine_without_raising(self, exported_db_path, live_rows):
        kpi = KPIEngine(DB(exported_db_path))
        summary = kpi.full_summary(live_rows["incident_id"])
        assert set(summary.keys()) >= {"command_summary", "time_to_first_vitals", "current_inventory"}

    def test_command_summary_falls_back_to_real_exported_data(self, exported_db_path, live_rows):
        kpi = KPIEngine(DB(exported_db_path))
        row = kpi.command_summary(live_rows["incident_id"]).iloc[0]
        assert row["total_patients"] == 1
        assert row["active_red_patients"] == 1
        assert row["unresolved_alerts"] == 1

    def test_inventory_ledger_mapped_from_v12_shape(self, exported_db_path):
        db = DB(exported_db_path)
        ledger = db.inventory_ledger()
        assert len(ledger) == 1
        assert ledger.iloc[0]["item_sku"] == "tourniquet"
        assert ledger.iloc[0]["quantity_change"] == -1

    def test_missing_service_key_reported_and_returns_nonzero(self, monkeypatch, capsys):
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
        monkeypatch.setattr("sys.argv", ["export_live_incident.py", "--incident-id", "x"])
        assert export_mod.main() == 1
        assert "SUPABASE_SERVICE_ROLE_KEY" in capsys.readouterr().err

    def test_newer_tables_exported(self, exported_db_path, live_rows):
        # Gap N10: requests, pre-evacuation, site authority, external reports and links, stored
        # reports, evacuation / MDA class and merge origin all reach the analytics file.
        db = DB(exported_db_path)
        count = lambda t: int(db.query(f"select count(*) as n from {t}").iloc[0]["n"])
        for table in ["incident_details", "patient_evacuation", "event_origins", "medical_resource_requests", "supply_requests", "incident_pre_evacuations", "incident_site_authority", "external_reports", "external_patient_links", "aar_reports"]:
            assert count(table) == 1, table
        evac = db.query("select * from patient_evacuation").iloc[0]
        assert evac["evacuation_destination"] == "Hospital A" and evac["mda_classification"] == "urgent" and evac["trap_status"] == "not_trapped"
        assert db.query("select origin_incident_id from event_origins").iloc[0]["origin_incident_id"] == "00000000-0000-0000-0000-0000000000a0"
        req = db.query("select * from medical_resource_requests").iloc[0]
        assert req["status"] == "assigned" and json.loads(req["linked_patient_ids_json"]) == [live_rows["patient_id"]]
        assert json.loads(db.query("select items_json from supply_requests").iloc[0]["items_json"]) == [{"item": "tourniquet", "qty": 2}]
        assert int(db.query("select total_count from incident_pre_evacuations").iloc[0]["total_count"]) == 3
        assert db.query("select building_status from incident_site_authority").iloc[0]["building_status"] == "unstable"
        link = db.query("select * from external_patient_links").iloc[0]
        assert link["external_report_id"] == "rep-1" and link["patient_id"] == live_rows["patient_id"] and link["match_score"] == 1.0
        stored = db.query("select * from aar_reports").iloc[0]
        assert stored["locked"] == 1 and json.loads(stored["report_json"])["patients"]["total"] == 1
        assert json.loads(db.query("select metadata_json from incident_details").iloc[0]["metadata_json"]) == {"merged_from": ["INC-0"]}

    def test_newer_tables_drop_display_names(self, exported_db_path):
        # Names stay on profiles; the copies the live tables keep (requested_by_name, ...) are not exported.
        db = DB(exported_db_path)
        for table in ["medical_resource_requests", "incident_pre_evacuations", "incident_site_authority"]:
            assert not [c for c in db.query(f"select * from {table}").columns if c.endswith("_name")], table

    def test_external_links_fetched_by_this_incidents_report_ids(self, exported_db_path, live_rows):
        # external_patient_links has no incident_id, so it is read with in.(report ids).
        assert ("external_patient_links", "(rep-1)", "external_report_id", "in") in live_rows["fetches"]

    def test_no_external_reports_means_no_link_fetch(self, tmp_path, monkeypatch, live_rows):
        live_rows["rows"]["external_reports"] = []
        calls = []
        monkeypatch.setattr(export_mod, "fetch_table", lambda table, *a, **k: calls.append(table) or live_rows["rows"].get(table, []))
        export_mod.export_incident(live_rows["incident_id"], tmp_path / "x.db", "fake-key")
        assert "external_patient_links" not in calls
