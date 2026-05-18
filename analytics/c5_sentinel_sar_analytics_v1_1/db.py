"""
db.py — SQLite connection wrapper for C5 Sentinel-SAR analytics v1.1.

The wrapper is intentionally thin. It returns pandas DataFrames and parses
JSON event payloads when useful, while preserving the immutable event log.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional, Union

import pandas as pd


class DB:
    """SQLite reader for the local/offline analytics database."""

    def __init__(self, path: Union[str, Path]):
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f"Database not found: {self.path}")

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def query(self, sql: str, params: tuple = ()) -> pd.DataFrame:
        with self._connect() as conn:
            return pd.read_sql_query(sql, conn, params=params)

    def table_exists(self, table_name: str) -> bool:
        df = self.query(
            "select name from sqlite_master where type='table' and name=?",
            (table_name,),
        )
        return not df.empty

    @staticmethod
    def _dt(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
        for col in cols:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)
        return df

    @staticmethod
    def _json_load(value: Any) -> Any:
        if value is None or value == "":
            return {}
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except Exception:
            return {}

    def incidents(self, status: Optional[str] = None) -> pd.DataFrame:
        sql = "select * from incidents where 1=1"
        params: list[Any] = []
        if status:
            sql += " and status = ?"
            params.append(status)
        sql += " order by opened_at asc"
        df = self.query(sql, tuple(params))
        return self._dt(df, ["t_zero", "t_injury_default", "opened_at", "closed_at", "draft_created_at", "draft_resolved_at"])

    def profiles(self, role: Optional[str] = None) -> pd.DataFrame:
        sql = "select * from profiles where 1=1"
        params: list[Any] = []
        if role:
            sql += " and role = ?"
            params.append(role)
        return self.query(sql, tuple(params))

    def patients(self, incident_id: Optional[str] = None, include_closed: bool = True) -> pd.DataFrame:
        sql = "select * from patients where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        if not include_closed:
            sql += " and current_status not in ('handed_over','closed','deceased')"
        sql += " order by visual_id asc"
        df = self.query(sql, tuple(params))
        df = self._dt(df, ["created_at", "t_injury", "last_vitals_at", "handed_over_at"])
        if "location_json" in df.columns:
            df["location"] = df["location_json"].map(self._json_load)
        return df

    def events(
        self,
        event_type: Optional[str] = None,
        patient_id: Optional[str] = None,
        incident_id: Optional[str] = None,
        expand_payload: bool = False,
    ) -> pd.DataFrame:
        sql = "select * from events where 1=1"
        params: list[Any] = []
        if event_type:
            sql += " and type = ?"
            params.append(event_type)
        if patient_id:
            sql += " and patient_id = ?"
            params.append(patient_id)
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        sql += " order by clinical_timestamp asc, server_timestamp asc"
        df = self.query(sql, tuple(params))
        df = self._dt(df, ["clinical_timestamp", "local_timestamp", "server_timestamp", "synced_at"])
        if df.empty:
            return df
        if "payload_json" in df.columns:
            df["payload"] = df["payload_json"].map(self._json_load)
            if expand_payload:
                payload_df = pd.json_normalize(df["payload"])
                payload_df.columns = [f"payload.{c}" for c in payload_df.columns]
                df = pd.concat([df, payload_df], axis=1)
        return df

    def vitals_events(self, patient_id: Optional[str] = None) -> pd.DataFrame:
        df = self.events(event_type="VITALS_RECORDED", patient_id=patient_id)
        if df.empty:
            return df
        rows = []
        for _, row in df.iterrows():
            p = row.get("payload", {}) or {}
            hr = p.get("heart_rate", {}) or {}
            rr = p.get("respiratory_rate", {}) or {}
            rows.append({
                "event_id": row["id"],
                "incident_id": row["incident_id"],
                "patient_id": row["patient_id"],
                "actor_id": row["actor_id"],
                "recorded_at": row["clinical_timestamp"],
                "pulse": hr.get("calculated_bpm") or p.get("pulse") or p.get("hr"),
                "pulse_raw_count": hr.get("raw_count"),
                "pulse_entry_method": hr.get("entry_method"),
                "rr": rr.get("calculated_per_min") or p.get("rr") or p.get("breathing"),
                "rr_raw_count": rr.get("raw_count"),
                "rr_entry_method": rr.get("entry_method"),
                "spo2": p.get("spo2"),
                "bp": p.get("bp"),
                "avpu": p.get("avpu"),
            })
        out = pd.DataFrame(rows)
        return self._dt(out, ["recorded_at"])

    def treatment_events(self, patient_id: Optional[str] = None) -> pd.DataFrame:
        frames = []
        for t in ["INTERVENTION_RECORDED", "MEDICATION_ADMINISTERED", "TOURNIQUET_APPLIED", "TOURNIQUET_REASSESSMENT", "TOURNIQUET_RELEASED"]:
            df = self.events(event_type=t, patient_id=patient_id)
            if not df.empty:
                frames.append(df)
        if not frames:
            return pd.DataFrame()
        df = pd.concat(frames, ignore_index=True).sort_values("clinical_timestamp")
        rows = []
        for _, row in df.iterrows():
            p = row.get("payload", {}) or {}
            rows.append({
                "event_id": row["id"],
                "incident_id": row["incident_id"],
                "patient_id": row["patient_id"],
                "actor_id": row["actor_id"],
                "type": row["type"],
                "recorded_at": row["clinical_timestamp"],
                "treatment_type": p.get("treatment_type") or p.get("medication") or p.get("tourniquet_context"),
                "quantity": p.get("quantity", 1),
                "high_risk": bool(p.get("high_risk") or p.get("emergency_override")),
                "notes": p.get("notes") or p.get("reason") or "",
            })
        out = pd.DataFrame(rows)
        return self._dt(out, ["recorded_at"])

    def inventory_ledger(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        sql = "select * from inventory_ledger where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        sql += " order by server_timestamp asc"
        df = self.query(sql, tuple(params))
        df = self._dt(df, ["clinical_timestamp", "server_timestamp"])
        if "location_at_time" in df.columns:
            df["location"] = df["location_at_time"].map(self._json_load)
        return df

    def watchdog_alerts(self, incident_id: Optional[str] = None, unresolved_only: bool = False) -> pd.DataFrame:
        sql = "select * from watchdog_alerts where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        if unresolved_only:
            sql += " and resolved_at is null and suppressed_before_dashboard = 0"
        sql += " order by triggered_at asc"
        df = self.query(sql, tuple(params))
        return self._dt(df, ["triggered_at", "resolved_at", "acknowledged_at"])

    def device_presence(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        sql = "select * from device_presence where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        df = self.query(sql, tuple(params))
        return self._dt(df, ["last_heartbeat_at", "updated_at"])

    def device_sync_state(self) -> pd.DataFrame:
        if not self.table_exists("device_sync_state"):
            return pd.DataFrame()
        df = self.query("select * from device_sync_state order by updated_at desc")
        return self._dt(df, ["last_successful_pull_at", "last_successful_push_at", "updated_at"])

    def sync_ingestion_errors(self) -> pd.DataFrame:
        if not self.table_exists("sync_ingestion_errors"):
            return pd.DataFrame()
        df = self.query("select * from sync_ingestion_errors order by created_at asc")
        return self._dt(df, ["created_at", "resolved_at"])

    def conflict_log(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        sql = "select * from conflict_log where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        sql += " order by created_at asc"
        df = self.query(sql, tuple(params))
        return self._dt(df, ["created_at", "resolved_at"])

    def command_state(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        if not self.table_exists("incident_command_state"):
            return pd.DataFrame()
        sql = "select * from incident_command_state where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        df = self.query(sql, tuple(params))
        return self._dt(df, ["snapshot_at"])

    def aar_context_notes(self, incident_id: Optional[str] = None) -> pd.DataFrame:
        if not self.table_exists("aar_context_notes"):
            return pd.DataFrame()
        sql = "select * from aar_context_notes where 1=1"
        params: list[Any] = []
        if incident_id:
            sql += " and incident_id = ?"
            params.append(incident_id)
        sql += " order by created_at asc"
        df = self.query(sql, tuple(params))
        return self._dt(df, ["created_at"])
