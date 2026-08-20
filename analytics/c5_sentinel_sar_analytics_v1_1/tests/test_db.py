"""Tests for db.py's SQLite -> DataFrame wrapper, independent of KPI logic."""

from __future__ import annotations

import pandas as pd
import pytest

from db import DB


def test_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        DB(tmp_path / "does_not_exist.db")


def test_table_exists(db):
    assert db.table_exists("patients") is True
    assert db.table_exists("no_such_table") is False


class TestIncidents:
    def test_returns_seeded_incident(self, db):
        df = db.incidents()
        assert len(df) == 1
        assert df.iloc[0]["id"] == "inc_001"
        assert df.iloc[0]["status"] == "active"

    def test_filter_by_status_no_match(self, db):
        assert db.incidents(status="closed").empty

    def test_filter_by_status_match(self, db):
        df = db.incidents(status="active")
        assert len(df) == 1


class TestPatients:
    def test_returns_all_five(self, db):
        df = db.patients()
        assert len(df) == 5
        assert set(df["visual_id"]) == {"P-001", "P-002", "P-003", "P-004", "P-005"}

    def test_include_closed_false_drops_handed_over_patient(self, db):
        df = db.patients(include_closed=False)
        assert len(df) == 4
        assert "p004" not in set(df["id"])

    def test_filter_by_incident_id(self, db):
        df = db.patients(incident_id="inc_001")
        assert len(df) == 5
        assert db.patients(incident_id="no_such_incident").empty

    def test_location_json_parsed_into_dict(self, db):
        df = db.patients()
        p001 = df[df["id"] == "p001"].iloc[0]
        assert p001["location"] == {"building": "15A", "floor": "3", "apartment": "7"}

    def test_datetime_columns_are_parsed(self, db):
        df = db.patients()
        for col in ["created_at", "t_injury", "last_vitals_at"]:
            assert pd.api.types.is_datetime64_any_dtype(df[col]), col


class TestEvents:
    def test_filters_by_type(self, db):
        df = db.events(event_type="TOURNIQUET_APPLIED")
        assert len(df) == 2
        assert set(df["patient_id"]) == {"p001", "p004"}

    def test_filters_by_patient(self, db):
        df = db.events(patient_id="p001")
        assert len(df) > 0
        assert set(df["patient_id"]) == {"p001"}

    def test_filters_by_incident(self, db):
        assert len(db.events(incident_id="inc_001")) > 0
        assert db.events(incident_id="no_such_incident").empty

    def test_payload_json_parsed_to_dict(self, db):
        df = db.events(event_type="PATIENT_HANDED_OVER")
        assert df.iloc[0]["payload"] == {"handover_to": "MDA"}

    def test_expand_payload_adds_flattened_columns(self, db):
        df = db.events(event_type="PATIENT_HANDED_OVER", expand_payload=True)
        assert "payload.handover_to" in df.columns
        assert df.iloc[0]["payload.handover_to"] == "MDA"

    def test_no_matching_events_returns_empty_frame(self, db):
        df = db.events(event_type="NO_SUCH_EVENT_TYPE")
        assert df.empty


class TestVitalsEvents:
    def test_extracts_stepper_pulse_and_rr(self, db):
        df = db.vitals_events(patient_id="p001")
        assert len(df) == 2
        row = df.sort_values("recorded_at").iloc[0]
        assert row["pulse"] == 124
        assert row["rr"] == 32
        assert row["pulse_entry_method"] == "stepper"
        assert row["spo2"] == 91
        assert row["avpu"] == "Pain"

    def test_no_events_returns_empty_frame(self, db):
        assert db.vitals_events(patient_id="p005").empty


class TestTreatmentEvents:
    def test_combines_multiple_event_types(self, db):
        df = db.treatment_events()
        types = set(df["type"])
        assert {"TOURNIQUET_APPLIED", "TOURNIQUET_REASSESSMENT", "TOURNIQUET_RELEASED", "MEDICATION_ADMINISTERED"} <= types

    def test_flags_high_risk_medication(self, db):
        df = db.treatment_events(patient_id="p003")
        actiq = df[df["type"] == "MEDICATION_ADMINISTERED"].iloc[0]
        assert actiq["high_risk"] == True

    def test_no_matching_events_returns_empty_frame(self, db):
        assert db.treatment_events(patient_id="p005").empty


class TestInventoryLedger:
    def test_location_at_time_parsed(self, db):
        df = db.inventory_ledger()
        used = df[df["related_patient_id"] == "p001"].iloc[0]
        assert used["location"]["building"] == "15A"

    def test_filters_by_incident(self, db):
        assert not db.inventory_ledger(incident_id="inc_001").empty
        assert db.inventory_ledger(incident_id="no_such_incident").empty


class TestWatchdogAlerts:
    def test_returns_all_seeded_alerts(self, db):
        assert len(db.watchdog_alerts()) == 3

    def test_unresolved_only_matches_all_when_none_resolved(self, db):
        # every seeded alert has resolved_at=None and suppressed_before_dashboard=0
        assert len(db.watchdog_alerts(unresolved_only=True)) == 3


class TestOptionalTables:
    """Methods that check table_exists() first, for schemas older than v1.1."""

    def test_device_sync_state_missing_table(self, bare_db):
        assert bare_db.device_sync_state().empty

    def test_sync_ingestion_errors_missing_table(self, bare_db):
        assert bare_db.sync_ingestion_errors().empty

    def test_command_state_missing_table(self, bare_db):
        assert bare_db.command_state().empty

    def test_aar_context_notes_missing_table(self, bare_db):
        assert bare_db.aar_context_notes().empty

    def test_present_when_table_exists(self, db):
        assert not db.device_sync_state().empty
        assert not db.sync_ingestion_errors().empty
        assert not db.command_state().empty
        assert not db.aar_context_notes().empty
