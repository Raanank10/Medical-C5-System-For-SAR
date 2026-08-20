"""Tests for export_live_incident.py's live-schema -> SQLite mapping.

Mocks fetch_table() with rows shaped exactly like the live Supabase tables
(see database/001_postgresql_schema_v1.2.sql) rather than hitting the
network, then verifies the resulting SQLite file actually loads and computes
through the real DB/KPIEngine classes - the same check that matters for a
real export, without needing live credentials in CI or local dev.
"""

from __future__ import annotations

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
            "incidents": [{"id": incident_id, "visual_id": "INC-1", "t_zero": now, "t_injury_default": now, "location_name": "Test Site", "address": None, "incident_type": None, "status": "active", "draft_created_by": None, "confirmed_by": None, "opened_by": actor_id, "closed_by": None, "opened_at": now, "confirmed_at": None, "draft_acknowledged_by": None, "draft_acknowledged_at": None, "draft_resolved_at": None, "closed_at": None, "metadata": {}, "created_at": now, "updated_at": now, "version": 1}],
            "patients": [{"id": patient_id, "incident_id": incident_id, "sector_id": None, "visual_id": "P-001", "optional_name": None, "t_injury": now, "current_triage": "red", "algorithm_triage": None, "triage_recorded_at": now, "access_status": "free", "access_recorded_at": now, "current_status": "stabilizing", "status_recorded_at": now, "is_pediatric": False, "pediatric_age_years": None, "needs_full_assessment": True, "pending_incident_approval": False, "pulse_present": True, "breathing_present": True, "tourniquet_used": True, "injury_zones": ["leg"], "is_trapped": False, "trap_status": "not_trapped", "location_json": {"zone": "A"}, "location_recorded_at": now, "last_vitals_at": now, "last_seen_at": now, "handed_over_at": None, "handed_over_to": None, "handover_token": _uid(), "handover_token_used_at": None, "handover_token_expires_at": None, "created_by": actor_id, "created_at": now, "updated_at": now, "version": 1}],
            "events": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "actor_id": actor_id, "actor_role": "medic", "type": "VITALS_RECORDED", "payload_json": {"heart_rate": {"raw_count": 25, "window_seconds": 15, "calculated_bpm": 100, "entry_method": "stepper"}, "respiratory_rate": {"raw_count": 8, "window_seconds": 30, "calculated_rate": 16, "entry_method": "stepper"}, "spo2": 97, "avpu": "A", "bp_estimate": "radial_strong"}, "device_id": "dev-1", "local_event_id": "evt-1", "local_timestamp": now, "server_timestamp": now, "synced_at": now, "sync_cursor": 1, "event_version": 1}],
            "tourniquets": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "limb": "left_leg", "applied_event_id": _uid(), "released_event_id": None, "last_reassessed_event_id": None, "applied_at": now, "released_at": None, "last_reassessed_at": now, "reassessment_due_at": now, "tourniquet_status": "active", "is_active": True, "created_at": now, "updated_at": now, "clinical_context": "gunshot", "reassessment_interval_minutes": 60, "next_reassessment_due_at": now, "last_reassessment_event_id": None, "released_by_event_id": None}],
            "inventory_ledger_v12": [{"id": _uid(), "incident_id": incident_id, "actor_id": actor_id, "item_type": "tourniquet", "movement_type": "consumed", "quantity_delta": -1, "device_id": "dev-1", "local_event_id": "evt-2", "patient_id": patient_id, "created_at": now, "payload_json": {}}],
            "watchdog_alerts": [{"id": _uid(), "incident_id": incident_id, "patient_id": patient_id, "actor_id": actor_id, "alert_type": "vitals_overdue", "severity": "warning", "message": "test", "triggered_at": now, "acknowledged_by": None, "acknowledged_at": None, "resolved_at": None, "payload_json": {}, "updated_at": now, "version": 1, "dedupe_key": "dk1", "source_event_id": None, "resolved_by_event_id": None, "suppressed_before_dashboard": False}],
            "device_presence": [{"id": _uid(), "incident_id": incident_id, "actor_id": actor_id, "device_id": "dev-1", "current_location_json": {}, "current_patient_id": patient_id, "last_heartbeat_at": now, "sync_status": "online", "updated_at": now, "version": 1}],
            "device_sync_state": [{"id": _uid(), "incident_id": incident_id, "actor_id": actor_id, "device_id": "dev-1", "last_successful_push_at": now, "last_successful_pull_at": now, "last_pull_cursor": 5, "unsynced_event_count": 0, "battery_percent": 80, "power_mode": "normal", "gps_enabled": True, "logistics_location_tracking_enabled": False, "updated_at": now}],
            "sync_ingestion_errors": [],
            "conflict_log": [],
            "aar_context_notes": [{"id": _uid(), "incident_id": incident_id, "source_event_id": None, "patient_id": patient_id, "sector_id": None, "actor_id": actor_id, "note_type": "context_note", "note_text": "test note", "voice_memo_uri": None, "voice_memo_duration_seconds": None, "created_at": now}],
        },
    }


@pytest.fixture()
def exported_db_path(tmp_path, monkeypatch, live_rows):
    def fake_fetch_table(table, service_key, incident_id, incident_column="incident_id"):
        assert service_key == "fake-key"
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
