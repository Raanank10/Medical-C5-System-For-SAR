"""Tests for kpis.py against the seeded demo database (5 patients, one active
incident inc_001 - see seed_demo_db.py for the exact scenario).

A few KPIs (vitals_reassessment_compliance, medic_to_critical_ratio,
data_freshness) compare event timestamps to `pd.Timestamp.utcnow()` at call
time. The seed script anchors its data ~35 minutes before the moment it
runs, so as long as a test calls the KPI shortly after the `kpi` fixture
seeds the database (a fraction of a second, never minutes), the computed
gaps only ever grow slightly past their seed-time value - never shrink. The
assertions below rely on that one-directional drift instead of exact
equality wherever a real "now" is involved, so they don't flake.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest


class TestTimeToFirstVitals:
    def test_flags_patient_with_no_vitals(self, kpi):
        df = kpi.time_to_first_vitals().set_index("patient_id")
        assert df.loc["p005", "missing_first_vitals"] == True
        assert math.isnan(df.loc["p005", "minutes"])
        assert df.loc["p005", "within_target"] == False

    def test_other_patients_are_within_target(self, kpi):
        df = kpi.time_to_first_vitals()
        others = df[df["patient_id"] != "p005"]
        assert not others.empty
        assert (others["within_target"] == True).all()

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.time_to_first_vitals().empty


class TestVitalsReassessmentCompliance:
    def test_only_covers_active_red_and_yellow_patients(self, kpi):
        df = kpi.vitals_reassessment_compliance()
        # p003 is green, p004 is red but already handed_over (excluded via
        # include_closed=False), p005 has no triage assigned yet
        assert set(df["patient_id"]) == {"p001", "p002"}

    def test_red_and_yellow_targets(self, kpi):
        df = kpi.vitals_reassessment_compliance().set_index("patient_id")
        assert df.loc["p001", "target_min"] == 10
        assert df.loc["p002", "target_min"] == 30

    def test_both_seeded_patients_are_overdue(self, kpi):
        # p001's last vitals are ~22 real minutes old against a 10-minute
        # target, p002's are ~30 against a 30-minute target - both already
        # at or past target the instant the seed data is written.
        df = kpi.vitals_reassessment_compliance().set_index("patient_id")
        assert df.loc["p001", "compliant"] == False
        assert df.loc["p001", "reason"] == "overdue"
        assert df.loc["p002", "compliant"] == False

    def test_no_vitals_at_all_is_reported_as_noncompliant(self, no_vitals_red_patient_db):
        from kpis import KPIEngine

        df = KPIEngine(no_vitals_red_patient_db).vitals_reassessment_compliance()
        row = df.iloc[0]
        assert row["reason"] == "no_vitals"
        assert row["compliant"] == False
        assert math.isnan(row["latest_gap_min"])

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.vitals_reassessment_compliance().empty


class TestGoldenHourCompliance:
    def test_met_only_for_the_handed_over_patient(self, kpi):
        df = kpi.golden_hour_compliance().set_index("patient_id")
        assert df.loc["p004", "golden_hour_met"] == True
        assert df.loc["p004", "handover_minutes_from_injury"] == pytest.approx(31.0)

    def test_not_met_for_patients_without_a_handover(self, kpi):
        df = kpi.golden_hour_compliance().set_index("patient_id")
        for pid in ["p001", "p002", "p003", "p005"]:
            assert df.loc[pid, "golden_hour_met"] == False
            assert math.isnan(df.loc[pid, "handover_minutes_from_injury"])

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.golden_hour_compliance().empty


class TestHighRiskViolations:
    def test_combines_watchdog_and_conflict_sources(self, kpi):
        df = kpi.high_risk_violations()
        assert len(df) == 3
        assert (df["source"] == "watchdog").sum() == 2
        assert (df["source"] == "conflict").sum() == 1

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.high_risk_violations().empty


class TestTourniquetReassessmentDue:
    def test_excludes_released_tourniquet(self, kpi):
        df = kpi.tourniquet_reassessment_due()
        assert len(df) == 1
        assert df.iloc[0]["patient_id"] == "p001"

    def test_not_yet_due(self, kpi):
        # tq_p001's next_reassessment_due_at is set well in the future
        # relative to seed time (t(58) against a t0 ~35 minutes in the past).
        df = kpi.tourniquet_reassessment_due()
        assert df.iloc[0]["is_due"] == False

    def test_missing_table_returns_empty_frame(self, bare_db):
        from kpis import KPIEngine

        assert KPIEngine(bare_db).tourniquet_reassessment_due().empty


class TestPatientProgressionFunnel:
    def test_counts_by_stage(self, kpi):
        counts = kpi.patient_progression_funnel().set_index("stage")["count"]
        assert counts["Identified"] == 1
        assert counts["In Treatment"] == 3
        assert counts["Handed Over"] == 1

    def test_empty_incident_returns_empty_frame_with_columns(self, empty_kpi):
        df = empty_kpi.patient_progression_funnel()
        assert df.empty
        assert list(df.columns) == ["stage", "count"]


class TestTimeRegistrationToHandover:
    def test_only_includes_handed_over_patients(self, kpi):
        df = kpi.time_registration_to_handover()
        assert len(df) == 1
        assert df.iloc[0]["patient_id"] == "p004"
        assert df.iloc[0]["minutes_to_handover"] == pytest.approx(23.0)

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.time_registration_to_handover().empty


class TestMedicToCriticalRatio:
    def test_counts_active_red_patients_and_medics(self, kpi):
        row = kpi.medic_to_critical_ratio().iloc[0]
        # p004 is red but already handed_over, so it's excluded here even
        # though patient_progression_funnel and command_summary count it
        # differently (see README/CLAUDE.md note on this discrepancy).
        assert row["active_red_patients"] == 1
        assert row["active_medics"] == 2
        assert row["red_patients_per_active_medic"] == pytest.approx(0.5)

    def test_no_active_medics_gives_infinite_ratio(self, empty_kpi):
        row = empty_kpi.medic_to_critical_ratio().iloc[0]
        assert row["active_medics"] == 0
        assert row["red_patients_per_active_medic"] == float("inf")


class TestDeadManSwitchEvents:
    def test_filters_to_dead_man_switch_alerts(self, kpi):
        df = kpi.dead_man_switch_events()
        assert len(df) == 1
        assert df.iloc[0]["actor_id"] == "medic_levi"

    def test_empty_incident_returns_empty_frame(self, empty_kpi):
        assert empty_kpi.dead_man_switch_events().empty


class TestDataFreshness:
    def test_classifies_devices_by_staleness(self, kpi):
        state = kpi.data_freshness().set_index("device_id")["freshness_state"]
        assert state["dev_cohen"] == "fresh"
        assert state["dev_pc"] == "fresh"
        assert state["dev_levi"] == "critical_stale"

    def test_missing_table_returns_empty_frame(self, bare_db):
        from kpis import KPIEngine

        assert KPIEngine(bare_db).data_freshness().empty


class TestInventoryAndStockout:
    def test_current_inventory_nets_ledger_entries(self, kpi):
        qty = kpi.current_inventory().set_index(["owner_id", "item_sku"])["current_quantity"]
        assert qty[("medic_cohen", "TQ")] == 0
        assert qty[("medic_cohen", "ACTIQ")] == -1
        assert qty[("pc_demo", "TQ")] == 4

    def test_stockout_risk_flags_negative_and_low_stock(self, kpi):
        risk = kpi.stockout_risk().set_index(["owner_id", "item_sku"])["risk_level"]
        assert risk[("medic_cohen", "ACTIQ")] == "negative_stock"
        assert risk[("medic_cohen", "TQ")] == "low_stock"
        assert risk[("pc_demo", "TQ")] == "ok"

    def test_stockout_risk_is_anchored_to_ledger_time_not_wall_clock(self, kpi):
        # the 30-minute consumption window in stockout_risk() is measured
        # from the ledger's own max server_timestamp, not from utcnow(), so
        # this must be stable no matter how long the test run takes.
        first = kpi.stockout_risk().set_index(["owner_id", "item_sku"])["risk_level"]
        second = kpi.stockout_risk().set_index(["owner_id", "item_sku"])["risk_level"]
        assert first.equals(second)

    def test_empty_incident_returns_empty_frames(self, empty_kpi):
        assert empty_kpi.current_inventory().empty
        assert empty_kpi.stockout_risk().empty


class TestSyncKPIs:
    def test_sync_latency_computed_per_event(self, kpi):
        df = kpi.sync_latency()
        assert not df.empty
        assert (df["sync_latency_sec"] >= 0).all()

    def test_sync_error_summary_counts_by_code(self, kpi):
        counts = kpi.sync_error_summary().set_index(["error_code", "dependency_status"])["count"]
        assert counts[("MALFORMED_PATIENT_CREATED", "rejected")] == 1
        assert counts[("BLOCKED_DEPENDENCY", "blocked_dependency")] == 1

    def test_sync_error_summary_missing_table_returns_empty(self, bare_db):
        from kpis import KPIEngine

        assert KPIEngine(bare_db).sync_error_summary().empty


class TestCommandSummary:
    def test_uses_precomputed_snapshot_when_present(self, kpi):
        # seed_demo_db.py inserts a row into incident_command_state directly;
        # command_summary() should return that snapshot rather than recompute.
        row = kpi.command_summary().iloc[0]
        assert row["total_patients"] == 5
        assert row["unresolved_alerts"] == 3
        assert row["critical_alerts"] == 2
        assert row["negative_stock_items"] == 1

    def test_falls_back_to_computed_summary_without_a_snapshot(self, empty_kpi):
        row = empty_kpi.command_summary().iloc[0]
        assert row["total_patients"] == 0
        assert row["unresolved_alerts"] == 0


class TestFullSummary:
    def test_returns_every_expected_kpi(self, kpi):
        summary = kpi.full_summary()
        expected_keys = {
            "command_summary", "time_to_first_vitals", "patients_missing_full_vitals",
            "vitals_reassessment_compliance", "golden_hour_compliance", "high_risk_violations",
            "tourniquet_reassessment_due", "patient_progression_funnel",
            "time_registration_to_handover", "medic_to_critical_ratio",
            "dead_man_switch_events", "data_freshness", "current_inventory",
            "stockout_risk", "sync_latency", "sync_error_summary",
        }
        assert set(summary.keys()) == expected_keys
        for key, df in summary.items():
            assert isinstance(df, pd.DataFrame), f"{key} did not return a DataFrame"

    def test_degrades_gracefully_on_an_empty_database(self, empty_kpi):
        summary = empty_kpi.full_summary()
        for key, df in summary.items():
            assert isinstance(df, pd.DataFrame), f"{key} did not return a DataFrame"
