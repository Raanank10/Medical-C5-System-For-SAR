"""
kpis.py — C5 Sentinel-SAR KPI Engine v1.1.

The KPI engine reflects the v1.1 product architecture:
- local/offline event log as the analytical source
- dependency-aware sync errors
- freshness and battery-aware operational state
- high-risk clinical violations are preserved and flagged, not deleted
- command dashboard should use snapshots instead of heavy live joins
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

try:
    from .db import DB
except ImportError:
    from db import DB

TRIAGE_ORDER = ["red", "yellow", "green", "black", "unknown"]
TRIAGE_LABELS = {
    "red": "קשה",
    "yellow": "בינוני",
    "green": "קל",
    "black": "ללא סימני חיים",
    "unknown": "לא ידוע",
}
AVPU_RANK = {"A": 4, "V": 3, "P": 2, "U": 1, "Alert": 4, "Voice": 3, "Pain": 2, "Unresponsive": 1}


@dataclass(frozen=True)
class Targets:
    first_vitals_min: int = 5
    red_reassessment_min: int = 10
    yellow_reassessment_min: int = 30
    stale_pull_warning_sec: int = 60
    critical_stale_pull_sec: int = 300
    dead_man_switch_min: int = 5
    low_battery_pct: int = 20


class KPIEngine:
    def __init__(self, db: DB, targets: Targets | None = None):
        self.db = db
        self.targets = targets or Targets()

    def _incident_id(self, incident_id: Optional[str]) -> Optional[str]:
        if incident_id:
            return incident_id
        inc = self.db.incidents(status="active")
        if not inc.empty:
            return inc.iloc[0]["id"]
        inc = self.db.incidents()
        return None if inc.empty else inc.iloc[0]["id"]

    # ── Clinical KPIs ──────────────────────────────────────────
    def time_to_first_vitals(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        patients = self.db.patients(incident_id=incident_id)
        vitals = self.db.vitals_events()
        if patients.empty:
            return pd.DataFrame()
        first = pd.DataFrame(columns=["patient_id", "first_vitals_at"])
        if not vitals.empty:
            first = vitals.groupby("patient_id")["recorded_at"].min().reset_index().rename(columns={"recorded_at": "first_vitals_at"})
        df = patients.merge(first, left_on="id", right_on="patient_id", how="left")
        df["seconds_to_first_vitals"] = (df["first_vitals_at"] - df["created_at"]).dt.total_seconds()
        df["minutes"] = (df["seconds_to_first_vitals"] / 60).round(1)
        df["within_target"] = df["seconds_to_first_vitals"].le(self.targets.first_vitals_min * 60)
        df["missing_first_vitals"] = df["first_vitals_at"].isna()
        return df[["id", "visual_id", "current_triage", "access_status", "minutes", "within_target", "missing_first_vitals"]].rename(columns={"id": "patient_id"})

    def patients_missing_full_vitals(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        patients = self.db.patients(incident_id=incident_id, include_closed=False)
        if patients.empty:
            return pd.DataFrame()
        mask = (patients.get("needs_full_assessment", 0).fillna(0).astype(int) == 1) | patients["last_vitals_at"].isna()
        return patients.loc[mask, ["id", "visual_id", "current_triage", "access_status", "current_status", "last_vitals_at"]].rename(columns={"id": "patient_id"})

    def vitals_reassessment_compliance(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        patients = self.db.patients(incident_id=incident_id, include_closed=False)
        vitals = self.db.vitals_events()
        if patients.empty:
            return pd.DataFrame()
        rows = []
        for _, p in patients.iterrows():
            triage = p["current_triage"]
            if triage not in {"red", "yellow"}:
                continue
            target = self.targets.red_reassessment_min if triage == "red" else self.targets.yellow_reassessment_min
            pv = vitals[vitals["patient_id"] == p["id"]].sort_values("recorded_at") if not vitals.empty else pd.DataFrame()
            if pv.empty:
                rows.append({"patient_id": p["id"], "visual_id": p["visual_id"], "triage": triage, "latest_gap_min": np.nan, "target_min": target, "compliant": False, "reason": "no_vitals"})
                continue
            last = pv["recorded_at"].max()
            now = max(pd.Timestamp.utcnow(), last)
            gap = (now - last).total_seconds() / 60
            rows.append({"patient_id": p["id"], "visual_id": p["visual_id"], "triage": triage, "latest_gap_min": round(gap, 1), "target_min": target, "compliant": gap <= target, "reason": "ok" if gap <= target else "overdue"})
        return pd.DataFrame(rows)

    def golden_hour_compliance(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        patients = self.db.patients(incident_id=incident_id)
        if patients.empty:
            return pd.DataFrame()
        df = patients.copy()
        df["handover_minutes_from_injury"] = (df["handed_over_at"] - df["t_injury"]).dt.total_seconds() / 60
        df["golden_hour_met"] = df["handover_minutes_from_injury"].le(60)
        return df[["id", "visual_id", "current_triage", "t_injury", "handed_over_at", "handover_minutes_from_injury", "golden_hour_met"]].rename(columns={"id": "patient_id"})

    def high_risk_violations(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        alerts = self.db.watchdog_alerts(incident_id=incident_id)
        conflicts = self.db.conflict_log(incident_id=incident_id)
        frames = []
        if not alerts.empty:
            frames.append(alerts[alerts["alert_type"].str.contains("HIGH_RISK|PEDIATRIC|MEDICATION|NEGATIVE_STOCK", na=False)].assign(source="watchdog"))
        if not conflicts.empty:
            frames.append(conflicts[conflicts["conflict_type"].str.contains("HIGH_RISK|PEDIATRIC|MEDICATION|NEGATIVE_STOCK", na=False)].assign(source="conflict"))
        return pd.concat(frames, ignore_index=True, sort=False) if frames else pd.DataFrame()

    def tourniquet_reassessment_due(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        if not self.db.table_exists("tourniquets"):
            return pd.DataFrame()
        sql = """
        select tq.*, p.visual_id, p.current_triage, p.location_json
        from tourniquets tq
        join patients p on p.id = tq.patient_id
        where tq.is_active = 1
        """
        params = []
        if incident_id:
            sql += " and tq.incident_id = ?"
            params.append(incident_id)
        df = self.db.query(sql, tuple(params))
        if df.empty:
            return df
        for col in ["applied_at", "last_reassessed_at", "next_reassessment_due_at", "released_at"]:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)
        df["is_due"] = df["next_reassessment_due_at"].le(pd.Timestamp.utcnow())
        return df.sort_values("next_reassessment_due_at")

    # ── Operational KPIs ───────────────────────────────────────
    def patient_progression_funnel(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        patients = self.db.patients(incident_id=self._incident_id(incident_id))
        if patients.empty:
            return pd.DataFrame(columns=["stage", "count"])
        stage_map = {
            "identified": "Identified",
            "treating": "In Treatment",
            "observing": "In Treatment",
            "extricated": "Extricated",
            "stabilized": "Extricated",
            "handed_over": "Handed Over",
            "closed": "Handed Over",
            "deceased": "Closed / Deceased",
        }
        out = patients["current_status"].map(stage_map).fillna("Other").value_counts().reset_index()
        out.columns = ["stage", "count"]
        order = ["Identified", "In Treatment", "Extricated", "Handed Over", "Closed / Deceased", "Other"]
        out["stage"] = pd.Categorical(out["stage"], categories=order, ordered=True)
        return out.sort_values("stage")

    def time_registration_to_handover(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        patients = self.db.patients(incident_id=self._incident_id(incident_id))
        if patients.empty:
            return pd.DataFrame()
        df = patients.dropna(subset=["handed_over_at"]).copy()
        if df.empty:
            return df
        df["minutes_to_handover"] = (df["handed_over_at"] - df["created_at"]).dt.total_seconds() / 60
        return df[["id", "visual_id", "current_triage", "minutes_to_handover"]].rename(columns={"id": "patient_id"}).sort_values("minutes_to_handover")

    def medic_to_critical_ratio(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        patients = self.db.patients(incident_id=incident_id, include_closed=False)
        presence = self.db.device_presence(incident_id=incident_id)
        if patients.empty:
            active_red = 0
        else:
            active_red = int((patients["current_triage"] == "red").sum())
        active_medics = 0
        if not presence.empty:
            active_medics = int(((pd.Timestamp.utcnow() - presence["last_heartbeat_at"]).dt.total_seconds() <= self.targets.dead_man_switch_min * 60).sum())
        return pd.DataFrame([{
            "incident_id": incident_id,
            "active_red_patients": active_red,
            "active_medics": active_medics,
            "red_patients_per_active_medic": round(active_red / active_medics, 2) if active_medics else np.inf,
        }])

    def dead_man_switch_events(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        alerts = self.db.watchdog_alerts(incident_id=incident_id)
        if alerts.empty:
            return pd.DataFrame()
        return alerts[alerts["alert_type"].eq("DEAD_MAN_SWITCH")].copy()

    def data_freshness(self) -> pd.DataFrame:
        state = self.db.device_sync_state()
        if state.empty:
            return pd.DataFrame()
        now = pd.Timestamp.utcnow()
        state = state.copy()
        state["seconds_since_pull"] = (now - state["last_successful_pull_at"]).dt.total_seconds()
        state["freshness_state"] = np.select(
            [state["seconds_since_pull"] > self.targets.critical_stale_pull_sec, state["seconds_since_pull"] > self.targets.stale_pull_warning_sec],
            ["critical_stale", "stale"],
            default="fresh",
        )
        return state

    # ── Logistics KPIs ─────────────────────────────────────────
    def current_inventory(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        ledger = self.db.inventory_ledger(incident_id=self._incident_id(incident_id))
        if ledger.empty:
            return pd.DataFrame()
        keys = ["incident_id", "owner_type", "owner_id", "owner_label", "item_sku", "item_name"]
        return ledger.groupby(keys, dropna=False)["quantity_change"].sum().reset_index(name="current_quantity").sort_values(["owner_type", "item_sku"])

    def stockout_risk(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        inv = self.current_inventory(incident_id)
        ledger = self.db.inventory_ledger(incident_id=self._incident_id(incident_id))
        if inv.empty or ledger.empty:
            return pd.DataFrame()
        consumption = ledger[ledger["quantity_change"] < 0].copy()
        if consumption.empty:
            inv["risk_level"] = "unknown"
            inv["estimated_minutes_to_zero"] = np.nan
            return inv
        max_t = ledger["server_timestamp"].max()
        recent = consumption[consumption["server_timestamp"] >= max_t - pd.Timedelta(minutes=30)]
        burn = recent.groupby(["owner_type", "owner_id", "item_sku"], dropna=False)["quantity_change"].sum().abs().reset_index(name="units_used_30m")
        df = inv.merge(burn, on=["owner_type", "owner_id", "item_sku"], how="left")
        df["units_used_30m"] = df["units_used_30m"].fillna(0)
        df["burn_per_min"] = df["units_used_30m"] / 30
        df["estimated_minutes_to_zero"] = np.where(df["burn_per_min"] > 0, df["current_quantity"] / df["burn_per_min"], np.inf)
        df["risk_level"] = np.select(
            [df["current_quantity"] < 0, df["current_quantity"] <= 2, df["estimated_minutes_to_zero"] <= 30],
            ["negative_stock", "low_stock", "depleting_soon"],
            default="ok",
        )
        return df.sort_values(["risk_level", "estimated_minutes_to_zero"])

    # ── Sync / data quality KPIs ───────────────────────────────
    def sync_latency(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        events = self.db.events(incident_id=self._incident_id(incident_id))
        if events.empty:
            return pd.DataFrame()
        df = events.copy()
        df["sync_latency_sec"] = (df["server_timestamp"] - df["local_timestamp"]).dt.total_seconds()
        return df[["id", "type", "device_id", "local_event_id", "sync_latency_sec", "is_critical"]].sort_values("sync_latency_sec", ascending=False)

    def unsynced_backlog(self) -> pd.DataFrame:
        if not self.db.table_exists("local_event_queue"):
            return pd.DataFrame()
        return self.db.query("select device_id, event_type, count(*) as unsynced_events from local_event_queue where synced_at is null group by device_id, event_type")

    def sync_error_summary(self) -> pd.DataFrame:
        errors = self.db.sync_ingestion_errors()
        if errors.empty:
            return pd.DataFrame()
        return errors.groupby(["error_code", "dependency_status"], dropna=False).size().reset_index(name="count").sort_values("count", ascending=False)

    def command_summary(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        incident_id = self._incident_id(incident_id)
        snap = self.db.command_state(incident_id=incident_id)
        if not snap.empty:
            return snap
        # fallback computed locally, without Cartesian joins
        patients = self.db.patients(incident_id=incident_id)
        alerts = self.db.watchdog_alerts(incident_id=incident_id, unresolved_only=True)
        ratio = self.medic_to_critical_ratio(incident_id)
        inv_risk = self.stockout_risk(incident_id)
        row = {
            "incident_id": incident_id,
            "snapshot_at": pd.Timestamp.utcnow(),
            "total_patients": len(patients),
            "active_red_patients": int((patients["current_triage"] == "red").sum()) if not patients.empty else 0,
            "unresolved_alerts": len(alerts),
            "critical_alerts": int((alerts.get("severity", pd.Series(dtype=str)) == "critical").sum()) if not alerts.empty else 0,
            "red_patients_per_active_medic": ratio.iloc[0]["red_patients_per_active_medic"] if not ratio.empty else np.nan,
            "negative_stock_items": int((inv_risk.get("risk_level", pd.Series(dtype=str)) == "negative_stock").sum()) if not inv_risk.empty else 0,
        }
        return pd.DataFrame([row])

    def full_summary(self, incident_id: Optional[str] = None) -> dict[str, pd.DataFrame]:
        return {
            "command_summary": self.command_summary(incident_id),
            "time_to_first_vitals": self.time_to_first_vitals(incident_id),
            "patients_missing_full_vitals": self.patients_missing_full_vitals(incident_id),
            "vitals_reassessment_compliance": self.vitals_reassessment_compliance(incident_id),
            "golden_hour_compliance": self.golden_hour_compliance(incident_id),
            "high_risk_violations": self.high_risk_violations(incident_id),
            "tourniquet_reassessment_due": self.tourniquet_reassessment_due(incident_id),
            "patient_progression_funnel": self.patient_progression_funnel(incident_id),
            "time_registration_to_handover": self.time_registration_to_handover(incident_id),
            "medic_to_critical_ratio": self.medic_to_critical_ratio(incident_id),
            "dead_man_switch_events": self.dead_man_switch_events(incident_id),
            "data_freshness": self.data_freshness(),
            "current_inventory": self.current_inventory(incident_id),
            "stockout_risk": self.stockout_risk(incident_id),
            "sync_latency": self.sync_latency(incident_id),
            "sync_error_summary": self.sync_error_summary(),
        }
