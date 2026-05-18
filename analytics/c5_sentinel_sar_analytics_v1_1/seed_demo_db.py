"""
seed_demo_db.py — C5 Sentinel-SAR analytics demo DB v1.1.

Creates rescue_demo_v1_1.db with an event-sourced SQLite schema that mirrors
key v1.1 concepts: dependency-aware sync errors, high-risk clinical flags,
watchdog alerts, adaptive sync state, command snapshot, platoon stock, and
rolling AAR notes.

Run:
    python seed_demo_db.py
"""

from __future__ import annotations

import json
import random
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

random.seed(42)
DB_PATH = Path("rescue_demo_v1_1.db")


def uid(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def main(path: Path = DB_PATH) -> Path:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.executescript(SCHEMA)

    t0 = datetime.now(timezone.utc) - timedelta(minutes=35)
    def t(minutes: float) -> str:
        return iso(t0 + timedelta(minutes=minutes))

    incident = "inc_001"
    users = [
        ("medic_cohen", "Medic Cohen", "medic"),
        ("medic_levi", "Medic Levi", "medic"),
        ("pc_demo", "PC Demo", "pc"),
        ("logo_demo", "Log-O Demo", "logistics"),
        ("cc_demo", "CC Demo", "cc"),
        ("chamal_demo", "Chamal Demo", "chamal"),
    ]
    cur.executemany("insert into profiles values (?,?,?,1,?)", [(u, n, r, t(0)) for u, n, r in users])
    cur.execute("insert into incidents values (?,?,?,?,?,?,?,?,?,?,?)", (incident, "INC-001", t(0), t(0), "Tel Aviv / Building 15A", "active", "pc_demo", t(0), None, None, None))

    sectors = [
        ("sec_15a_3", incident, "15A", "3", "7", "Building 15A / Floor 3 / Apt 7", "unstable", 0),
        ("sec_15a_2", incident, "15A", "2", None, "Building 15A / Floor 2", "unstable", 0),
        ("sec_15b_1", incident, "15B", "1", None, "Building 15B / Floor 1", "stable", 0),
    ]
    cur.executemany("insert into sectors values (?,?,?,?,?,?,?,?)", sectors)

    patients = [
        ("p001", incident, "sec_15a_3", "P-001", "red", "trapped", "treating", 0, 0, t(0), t(2), t(3), None, '{"building":"15A","floor":"3","apartment":"7"}'),
        ("p002", incident, "sec_15a_2", "P-002", "yellow", "partial", "treating", 0, 0, t(0), t(4), t(5), None, '{"building":"15A","floor":"2"}'),
        ("p003", incident, "sec_15b_1", "P-003", "green", "free", "observing", 1, 0, t(0), t(6), t(7), None, '{"building":"15B","floor":"1"}'),
        ("p004", incident, "sec_15a_3", "P-004", "red", "partial", "handed_over", 0, 0, t(0), t(8), t(10), t(31), '{"building":"15A","floor":"3"}'),
        ("p005", incident, "sec_15b_1", "P-005", "unknown", "free", "identified", 0, 1, t(0), t(12), None, None, '{"building":"15B","floor":"1"}'),
    ]
    cur.executemany("insert into patients values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", patients)

    def event(eid, patient, actor, typ, minute, payload, device="dev_cohen", local=None, critical=1, depends=None):
        local_id = local or eid
        cur.execute("""insert into events values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            eid, incident, patient, actor, typ, json.dumps(payload, ensure_ascii=False), device, local_id,
            t(minute), t(minute), t(minute + 0.05), t(minute + 0.1), critical, depends
        ))

    # Patient creation
    for idx, p in enumerate(patients, start=1):
        event(f"evt_create_{p[0]}", p[0], "medic_cohen", "PATIENT_CREATED", 1+idx, {"visual_id": p[3], "location": json.loads(p[13])}, local=f"local_create_{p[0]}")

    # Vitals: stepper format
    event("evt_vitals_p001_1", "p001", "medic_cohen", "VITALS_RECORDED", 3, {"heart_rate":{"raw_count":31,"window_seconds":15,"calculated_bpm":124,"entry_method":"stepper"},"respiratory_rate":{"raw_count":16,"window_seconds":30,"calculated_per_min":32,"entry_method":"stepper"},"bp":"Carotid","avpu":"Pain","spo2":91})
    event("evt_vitals_p001_2", "p001", "medic_cohen", "VITALS_RECORDED", 13, {"heart_rate":{"raw_count":33,"window_seconds":15,"calculated_bpm":132,"entry_method":"stepper"},"respiratory_rate":{"raw_count":17,"window_seconds":30,"calculated_per_min":34,"entry_method":"stepper"},"bp":"Carotid","avpu":"Pain","spo2":88})
    event("evt_vitals_p002_1", "p002", "medic_cohen", "VITALS_RECORDED", 5, {"heart_rate":{"raw_count":24,"window_seconds":15,"calculated_bpm":96,"entry_method":"stepper"},"respiratory_rate":{"raw_count":11,"window_seconds":30,"calculated_per_min":22,"entry_method":"stepper"},"bp":"Radial","avpu":"Alert","spo2":97})
    event("evt_vitals_p003_1", "p003", "medic_cohen", "VITALS_RECORDED", 7, {"heart_rate":{"raw_count":28,"window_seconds":15,"calculated_bpm":112,"entry_method":"stepper"},"respiratory_rate":{"raw_count":14,"window_seconds":30,"calculated_per_min":28,"entry_method":"stepper"},"bp":"Radial","avpu":"Alert","spo2":99})
    event("evt_vitals_p004_1", "p004", "medic_cohen", "VITALS_RECORDED", 10, {"heart_rate":{"raw_count":29,"window_seconds":15,"calculated_bpm":116,"entry_method":"stepper"},"respiratory_rate":{"raw_count":14,"window_seconds":30,"calculated_per_min":28,"entry_method":"stepper"},"bp":"Carotid","avpu":"Voice","spo2":92})

    # TQ lifecycle and dynamic reassessment
    event("evt_tq_p001_apply", "p001", "medic_cohen", "TOURNIQUET_APPLIED", 8, {"treatment_type":"TOURNIQUET","limb":"R-Leg","tourniquet_context":"crush_entrapment","location_at_time":{"building":"15A","floor":"3","apartment":"7"}})
    event("evt_tq_p001_reassess", "p001", "medic_cohen", "TOURNIQUET_REASSESSMENT", 28, {"tourniquet_context":"crush_entrapment","limb":"R-Leg","distal_status":"unknown","next_reassessment_due_minutes":30})
    event("evt_tq_p004_apply", "p004", "medic_cohen", "TOURNIQUET_APPLIED", 12, {"treatment_type":"TOURNIQUET","limb":"L-Arm","tourniquet_context":"arterial_bleed"})
    event("evt_tq_p004_release", "p004", "medic_cohen", "TOURNIQUET_RELEASED", 29, {"limb":"L-Arm","reason":"handed over / receiving team"})

    cur.executemany("insert into tourniquets values (?,?,?,?,?,?,?,?,?,?,?)", [
        ("tq_p001", incident, "p001", "R-Leg", "crush_entrapment", t(8), t(28), t(58), None, 1, "evt_tq_p001_reassess"),
        ("tq_p004", incident, "p004", "L-Arm", "arterial_bleed", t(12), None, t(42), t(29), 0, "evt_tq_p004_release"),
    ])

    # Treatments and high-risk accepted-with-alert example
    event("evt_tx_p003_actiq", "p003", "medic_cohen", "MEDICATION_ADMINISTERED", 16, {"treatment_type":"ACTIQ","medication":"ACTIQ","quantity":1,"weight_estimate_kg":None,"emergency_override":True,"double_confirmed":True,"high_risk":True})
    event("evt_handover_p004", "p004", "medic_cohen", "PATIENT_HANDED_OVER", 31, {"handover_to":"MDA"})

    # Inventory ledger — location auto-derived from patient location, with negative stock example
    inv_rows = [
        ("inv_1", incident, "platoon_stock", "pc_demo", "Platoon Stock", "TQ", "Tourniquet", 4, "INITIAL_STOCK", None, None, None, t(0), t(0), '{}'),
        ("inv_2", incident, "medic_bag", "medic_cohen", "Medic Cohen Bag", "TQ", "Tourniquet", 1, "TRANSFER_IN", None, None, None, t(1), t(1), '{}'),
        ("inv_3", incident, "medic_bag", "medic_cohen", "Medic Cohen Bag", "TQ", "Tourniquet", -1, "INTERVENTION_USED", "p001", "evt_tq_p001_apply", None, t(8), t(8), '{"building":"15A","floor":"3","apartment":"7"}'),
        ("inv_4", incident, "medic_bag", "medic_cohen", "Medic Cohen Bag", "ACTIQ", "Actiq / Fentanyl", -1, "MEDICATION_USED", "p003", "evt_tx_p003_actiq", None, t(16), t(16), '{"building":"15B","floor":"1"}'),
    ]
    cur.executemany("insert into inventory_ledger values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", inv_rows)

    # Watchdog and conflict high risk
    alerts = [
        ("wa_dms_levi", incident, None, "medic_levi", "DEAD_MAN_SWITCH", "critical", "Medic Levi silent for more than 5 minutes", t(34), None, None, "deadman:medic_levi", None, None, 0),
        ("wa_ped_weight", incident, "p003", "medic_cohen", "PEDIATRIC_MEDICATION_MISSING_WEIGHT", "critical", "Medication recorded for pediatric patient without weight estimate; accepted and flagged", t(16.1), None, None, "pediatric:p003:evt_tx_p003_actiq", "evt_tx_p003_actiq", None, 0),
        ("wa_negative_stock", incident, "p003", "medic_cohen", "INVENTORY_NEGATIVE_STOCK_USED", "warning", "Treatment saved even though inventory model shows negative stock", t(16.1), None, None, "stock:medic_cohen:ACTIQ", "evt_tx_p003_actiq", None, 0),
    ]
    cur.executemany("insert into watchdog_alerts values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", alerts)
    cur.execute("insert into conflict_log values (?,?,?,?,?,?,?,?,?,?,?)", ("conf_ped_weight", incident, "p003", "medic_cohen", "PEDIATRIC_MEDICATION_MISSING_WEIGHT", "critical", "Actiq recorded for pediatric patient without weight estimate; double-confirmed emergency override", json.dumps({"double_confirmed": True}), t(16.1), None, None))

    # Device heartbeat and data freshness / battery-aware sync
    presence = [
        ("dp_cohen", incident, "medic_cohen", "dev_cohen", t(34.5), "online", 74, t(34.5)),
        ("dp_levi", incident, "medic_levi", "dev_levi", t(28.5), "offline", 46, t(28.5)),
        ("dp_pc", incident, "pc_demo", "dev_pc", t(34.8), "online", 92, t(34.8)),
    ]
    cur.executemany("insert into device_presence values (?,?,?,?,?,?,?,?)", presence)
    sync_state = [
        ("dev_cohen", "medic_cohen", incident, t(34.7), t(34.9), "normal", 74, t(34.9)),
        ("dev_levi", "medic_levi", incident, t(25.0), t(25.1), "critical_only", 18, t(25.1)),
        ("dev_pc", "pc_demo", incident, t(34.8), t(34.8), "normal", 92, t(34.8)),
    ]
    cur.executemany("insert into device_sync_state values (?,?,?,?,?,?,?,?)", sync_state)

    # Dependency-aware sync errors: child blocked due rejected parent
    errors = [
        ("err_parent", incident, "dev_levi", "medic_levi", "local_create_bad", None, "MALFORMED_PATIENT_CREATED", "Missing visual/location payload", '{"type":"PATIENT_CREATED"}', t(26), None, "rejected", None),
        ("err_child", incident, "dev_levi", "medic_levi", "local_vitals_orphan", "local_create_bad", "BLOCKED_DEPENDENCY", "Vitals event depends on rejected patient-created event", '{"type":"VITALS_RECORDED"}', t(26.1), None, "blocked_dependency", "err_parent"),
    ]
    cur.executemany("insert into sync_ingestion_errors values (?,?,?,?,?,?,?,?,?,?,?,?,?)", errors)

    # Command snapshot flat table
    cur.execute("insert into incident_command_state values (?,?,?,?,?,?,?,?,?,?,?)", (incident, t(35), 5, 2, 3, 2, 1, 1.0, 1, 1, 1))

    # Rolling AAR context notes
    cur.executemany("insert into aar_context_notes values (?,?,?,?,?,?,?)", [
        ("note_1", incident, "cc_demo", t(14), "voice_memo", "Building 15A stairwell blocked; rerouting medics through south entrance", "evt_vitals_p001_2"),
        ("note_2", incident, "pc_demo", t(20), "context_note", "Platoon stock low on TQ; requested Log-O refill", None),
    ])

    conn.commit()
    conn.close()
    print(f"Created {path.resolve()}")
    return path


SCHEMA = """
PRAGMA foreign_keys=ON;
create table profiles(id text primary key, display_name text not null, role text not null, is_active integer not null default 1, created_at text not null);
create table incidents(id text primary key, visual_id text unique, t_zero text not null, t_injury_default text not null, location_name text, status text not null, opened_by text, opened_at text, closed_at text, draft_created_at text, draft_resolved_at text, check(t_injury_default >= t_zero));
create table sectors(id text primary key, incident_id text not null, building_no text not null, floor text, apartment text, sector_label text not null, building_status text not null, is_site_clear integer not null default 0);
create table patients(id text primary key, incident_id text not null, sector_id text, visual_id text not null, current_triage text not null, access_status text not null, current_status text not null, is_pediatric integer not null default 0, needs_full_assessment integer not null default 0, t_injury text not null, created_at text not null, last_vitals_at text, handed_over_at text, location_json text not null);
create table events(id text primary key, incident_id text not null, patient_id text, actor_id text, type text not null, payload_json text not null default '{}', device_id text not null, local_event_id text not null, clinical_timestamp text not null, local_timestamp text not null, server_timestamp text not null, synced_at text, is_critical integer not null default 1, depends_on_local_event_id text, unique(device_id, local_event_id));
create table tourniquets(id text primary key, incident_id text not null, patient_id text not null, limb text not null, clinical_context text not null, applied_at text not null, last_reassessed_at text, next_reassessment_due_at text, released_at text, is_active integer not null default 1, source_event_id text);
create table inventory_ledger(id text primary key, incident_id text, owner_type text not null, owner_id text, owner_label text, item_sku text not null, item_name text not null, quantity_change integer not null, reason text not null, related_patient_id text, related_event_id text, transfer_group_id text, clinical_timestamp text not null, server_timestamp text not null, location_at_time text not null default '{}');
create table watchdog_alerts(id text primary key, incident_id text not null, patient_id text, actor_id text, alert_type text not null, severity text not null, message text not null, triggered_at text not null, acknowledged_at text, resolved_at text, dedupe_key text unique, source_event_id text, resolved_by_event_id text, suppressed_before_dashboard integer not null default 0);
create table device_presence(id text primary key, incident_id text, actor_id text not null, device_id text not null, last_heartbeat_at text not null, sync_status text not null, battery_pct integer, updated_at text not null);
create table device_sync_state(device_id text primary key, actor_id text, incident_id text, last_successful_pull_at text, last_successful_push_at text, sync_mode text not null, battery_pct integer, updated_at text not null);
create table sync_ingestion_errors(id text primary key, incident_id text, device_id text, actor_id text, local_event_id text, depends_on_local_event_id text, error_code text not null, error_message text not null, raw_payload text, created_at text not null, resolved_at text, dependency_status text, parent_error_id text);
create table conflict_log(id text primary key, incident_id text not null, patient_id text, actor_id text, conflict_type text not null, severity text not null, description text not null, payload_json text not null default '{}', created_at text not null, resolved_by text, resolved_at text);
create table incident_command_state(incident_id text primary key, snapshot_at text not null, total_patients integer not null, active_red_patients integer not null, unresolved_alerts integer not null, critical_alerts integer not null, active_medics integer not null, red_patients_per_active_medic real, missing_full_vitals integer not null, negative_stock_items integer not null, stale_devices integer not null);
create table aar_context_notes(id text primary key, incident_id text not null, actor_id text not null, created_at text not null, note_type text not null, content text not null, related_event_id text);
create table local_event_queue(id text primary key, device_id text not null, event_type text not null, payload_json text not null, created_at text not null, synced_at text);
"""

if __name__ == "__main__":
    main()
