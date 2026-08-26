"""
seed_mci_rehearsal_scenario_v1.py — C5 Sentinel-SAR synthetic MCI rehearsal scenario.

Builds `rescue_mci_rehearsal_v1.db`, a larger synthetic mass-casualty scenario for
`docs/FIELD_USABILITY_TEST_PLAN.md`'s "Session 4: Synthetic Mass-Casualty Scenario
Rehearsal" (26 synthetic casualties across 3 sites, staffed by 3 medics, 1 pc, 1 cc,
1 logistics — the session's minimum-staffing bar). It reuses `seed_demo_db.py`'s
schema unmodified, so `DB`/`KPIEngine`/`ReportGenerator` load it exactly like
`rescue_demo_v1_1.db` (see README.md's "Run" section) — this file is a bigger sibling
scenario, not a replacement for the small one used by the pytest suite and notebook.

All patients, names, and locations are synthetic per `docs/OPERATIONS_SAFETY.md` —
no real patient-identifiable data.

Run:
    python seed_mci_rehearsal_scenario_v1.py
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from .seed_demo_db import SCHEMA
except ImportError:
    from seed_demo_db import SCHEMA

DB_PATH = Path("rescue_mci_rehearsal_v1.db")

INCIDENT = "inc_mci_rehearsal_001"

# device_id per actor, reused by every event/ledger/presence row that actor generates.
DEVICES = {
    "medic_cohen": "dev_cohen",
    "medic_levi": "dev_levi",
    "medic_amit": "dev_amit",
    "pc_demo": "dev_pc",
    "cc_demo": "dev_cc",
    "logo_demo": "dev_logo",
}

# (hr, rr, bp, avpu, spo2) starting points by triage color, used as the base for
# each patient's vitals series before per-patient adjustment (deterioration, etc).
ARCHETYPE_VITALS = {
    "red": (128, 30, "Carotid", "Pain", 90),
    "yellow": (104, 24, "Radial", "Voice", 94),
    "green": (86, 16, "Radial", "Alert", 98),
}

# Patient roster: one row per synthetic casualty.
# fields: pid, site, sector_id, visual_id, triage, access_status, medic,
#         created_min, pediatric_age (None if adult), vitals (list of
#         (minute, hr, rr, bp, avpu, spo2)) or None, tq (limb, context, applied_min,
#         reassess_min, release_min) or None, handover_min (None if not evacuated),
#         status_track ("treating"/"observing"), expectant (bool)
PATIENTS = [
    # -- Site 1: Building 15A (primary structural collapse) — medic_cohen --
    dict(pid="p001", site=1, sector="sec_15a_3", visual="P-001", triage="red", access="trapped",
         medic="medic_cohen", created=1, vitals=[(3, 128, 30, "Carotid", "Pain", 90),
                                                  (13, 134, 33, "Carotid", "Pain", 87),
                                                  (23, 141, 36, "Carotid", "Unresponsive", 84)],
         tq=("R-Leg", "crush_entrapment", 4, 24, None), handover=None, status="treating"),
    dict(pid="p002", site=1, sector="sec_15a_3", visual="P-002", triage="red", access="trapped",
         medic="medic_cohen", created=1.5, vitals=[(4, 122, 28, "Carotid", "Pain", 91)],
         tq=("L-Arm", "arterial_bleed", 5, None, 45), handover=45, status="treating"),
    dict(pid="p003", site=1, sector="sec_15a_2", visual="P-003", triage="red", access="partial",
         medic="medic_cohen", created=2, vitals=[(5, 118, 27, "Carotid", "Pain", 92),
                                                  (18, 112, 25, "Radial", "Voice", 94)],
         tq=None, handover=42, status="treating"),
    dict(pid="p004", site=1, sector="sec_15a_2", visual="P-004", triage="yellow", access="partial",
         medic="medic_cohen", created=2.5, vitals=[(6, 104, 24, "Radial", "Voice", 94)],
         tq=None, handover=None, status="treating", mstart_override=("red", "yellow", "Ambulatory, minor lacerations")),
    dict(pid="p005", site=1, sector="sec_15a_2", visual="P-005", triage="yellow", access="free",
         medic="medic_cohen", created=3, pediatric=7, vitals=[(7, 108, 26, "Radial", "Alert", 95)],
         tq=None, handover=None, status="treating",
         high_risk_med=("ACTIQ", 1, False, "no weight estimate on hand at time of dosing")),
    dict(pid="p006", site=1, sector="sec_15a_4", visual="P-006", triage="yellow", access="partial",
         medic="medic_cohen", created=3.5, vitals=[(8, 100, 22, "Radial", "Alert", 95)],
         tq=None, handover=None, status="treating"),
    dict(pid="p007", site=1, sector="sec_15a_4", visual="P-007", triage="yellow", access="free",
         medic="medic_cohen", created=4, vitals=[(9, 98, 22, "Radial", "Alert", 96)],
         tq=None, handover=None, status="observing"),
    dict(pid="p008", site=1, sector="sec_15a_4", visual="P-008", triage="green", access="free",
         medic="medic_cohen", created=4.5, vitals=None, tq=None, handover=None, status="observing"),
    dict(pid="p009", site=1, sector="sec_15a_3", visual="P-009", triage="red", access="trapped",
         medic="medic_cohen", created=5, vitals=[(6, 130, 31, "Carotid", "Pain", 89)],
         tq=None, handover=38, status="treating"),
    dict(pid="p010", site=1, sector="sec_15a_2", visual="P-010", triage="red", access="partial",
         medic="medic_cohen", created=5.5, vitals=[(7, 124, 29, "Carotid", "Voice", 91)],
         tq=None, handover=50, status="treating"),
    dict(pid="p011", site=1, sector="sec_15a_3", visual="P-011", triage="black", access="free",
         medic="medic_cohen", created=6, vitals=None, tq=None, handover=None, status="expectant", expectant=True),

    # -- Site 2: Building 15B (partial collapse) — medic_levi --
    dict(pid="p012", site=2, sector="sec_15b_1", visual="P-012", triage="red", access="trapped",
         medic="medic_levi", created=2, vitals=[(5, 126, 30, "Carotid", "Voice", 90)],
         tq=("R-Arm", "arterial_bleed", 6, None, None), handover=None, status="treating"),
    dict(pid="p013", site=2, sector="sec_15b_1", visual="P-013", triage="yellow", access="partial",
         medic="medic_levi", created=2.5, vitals=[(6, 106, 24, "Radial", "Alert", 94)],
         tq=None, handover=None, status="treating", gauze=1),
    dict(pid="p014", site=2, sector="sec_15b_1", visual="P-014", triage="yellow", access="free",
         medic="medic_levi", created=3, vitals=[(7, 102, 23, "Radial", "Alert", 95)],
         tq=None, handover=None, status="observing"),
    dict(pid="p015", site=2, sector="sec_15b_2", visual="P-015", triage="yellow", access="partial",
         medic="medic_levi", created=3.5, vitals=[(8, 108, 25, "Radial", "Voice", 93)],
         tq=None, handover=None, status="treating", gauze=1),
    dict(pid="p016", site=2, sector="sec_15b_2", visual="P-016", triage="yellow", access="free",
         medic="medic_levi", created=4, vitals=[(9, 100, 22, "Radial", "Alert", 95)],
         tq=None, handover=None, status="observing", gauze=1),
    dict(pid="p017", site=2, sector="sec_15b_2", visual="P-017", triage="yellow", access="free",
         medic="medic_levi", created=4.5, vitals=[(10, 104, 23, "Radial", "Alert", 94)],
         tq=None, handover=None, status="treating", gauze=1),
    dict(pid="p018", site=2, sector="sec_15b_1", visual="P-018", triage="green", access="free",
         medic="medic_levi", created=5, vitals=[(12, 88, 17, "Radial", "Alert", 98)],
         tq=None, handover=None, status="observing"),
    dict(pid="p019", site=2, sector="sec_15b_2", visual="P-019", triage="green", access="free",
         medic="medic_levi", created=5.5, vitals=[(13, 84, 16, "Radial", "Alert", 98)],
         tq=None, handover=None, status="observing"),
    dict(pid="p020", site=2, sector="sec_15b_2", visual="P-020", triage="green", access="free",
         medic="medic_levi", created=6, vitals=[(14, 82, 15, "Radial", "Alert", 99)],
         tq=None, handover=48, status="observing"),

    # -- Site 3: Assembly point, Building 22C (ambulatory / walking wounded) — medic_amit --
    dict(pid="p021", site=3, sector="sec_22c_amb", visual="P-021", triage="yellow", access="free",
         medic="medic_amit", created=3, vitals=[(8, 100, 22, "Radial", "Alert", 95)],
         tq=None, handover=None, status="treating"),
    dict(pid="p022", site=3, sector="sec_22c_amb", visual="P-022", triage="green", access="free",
         medic="medic_amit", created=4, vitals=[(9, 90, 18, "Radial", "Alert", 97)],
         tq=None, handover=None, status="observing"),
    dict(pid="p023", site=3, sector="sec_22c_amb", visual="P-023", triage="green", access="free",
         medic="medic_amit", created=5, pediatric=5, vitals=[(10, 96, 20, "Radial", "Alert", 98)],
         tq=None, handover=None, status="observing"),
    dict(pid="p024", site=3, sector="sec_22c_amb", visual="P-024", triage="green", access="free",
         medic="medic_amit", created=6, vitals=[(11, 88, 17, "Radial", "Alert", 98)],
         tq=None, handover=30, status="observing"),
    dict(pid="p025", site=3, sector="sec_22c_amb", visual="P-025", triage="green", access="free",
         medic="medic_amit", created=7, vitals=None, tq=None, handover=None, status="observing"),
    dict(pid="p026", site=3, sector="sec_22c_amb", visual="P-026", triage="black", access="free",
         medic="medic_amit", created=9, vitals=None, tq=None, handover=None, status="expectant", expectant=True),
]

STATUS_MAP = {
    ("treating", None): "treating",
    ("observing", None): "observing",
    ("expectant", None): "deceased",
}


def uid(prefix: str) -> str:
    return prefix


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def vitals_payload(hr: int, rr: int, bp: str, avpu: str, spo2: int) -> dict:
    return {
        "heart_rate": {"raw_count": round(hr / 4), "window_seconds": 15, "calculated_bpm": hr, "entry_method": "stepper"},
        "respiratory_rate": {"raw_count": round(rr / 2), "window_seconds": 30, "calculated_per_min": rr, "entry_method": "stepper"},
        "bp": bp,
        "avpu": avpu,
        "spo2": spo2,
    }


def main(path: Path = DB_PATH) -> Path:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.executescript(SCHEMA)

    t0 = datetime.now(timezone.utc) - timedelta(minutes=58)

    def t(minutes: float) -> str:
        return iso(t0 + timedelta(minutes=minutes))

    now_min = 58  # scenario "current time" used for patients/tourniquets still open

    users = [
        ("medic_cohen", "Medic Cohen", "medic"),
        ("medic_levi", "Medic Levi", "medic"),
        ("medic_amit", "Medic Amit", "medic"),
        ("pc_demo", "PC Demo", "pc"),
        ("logo_demo", "Log-O Demo", "logistics"),
        ("cc_demo", "CC Demo", "cc"),
    ]
    cur.executemany("insert into profiles values (?,?,?,1,?)", [(u, n, r, t(0)) for u, n, r in users])
    cur.execute(
        "insert into incidents values (?,?,?,?,?,?,?,?,?,?,?)",
        (INCIDENT, "INC-MCI-REHEARSAL-001", t(0), t(0), "Tel Aviv / Buildings 15A, 15B, 22C — 3-site MCI rehearsal",
         "active", "cc_demo", t(0), None, None, None),
    )

    sectors = [
        ("sec_15a_2", INCIDENT, "15A", "2", None, "Building 15A / Floor 2 (Site 1)", "unstable", 0),
        ("sec_15a_3", INCIDENT, "15A", "3", "7", "Building 15A / Floor 3 / Apt 7 (Site 1)", "unstable", 0),
        ("sec_15a_4", INCIDENT, "15A", "4", None, "Building 15A / Floor 4 (Site 1)", "unstable", 0),
        ("sec_15b_1", INCIDENT, "15B", "1", None, "Building 15B / Floor 1 (Site 2)", "unstable", 0),
        ("sec_15b_2", INCIDENT, "15B", "2", None, "Building 15B / Floor 2 (Site 2)", "stable", 0),
        ("sec_22c_amb", INCIDENT, "22C", "ground", None, "Building 22C / Assembly Point (Site 3)", "stable", 0),
    ]
    cur.executemany("insert into sectors values (?,?,?,?,?,?,?,?)", sectors)

    patient_rows = []
    events = []  # (id, patient, actor, type, minute, payload, device, local, critical, depends)
    tourniquet_rows = []
    inv_rows = []
    alert_rows = []
    conflict_rows = []

    def add_event(eid, patient, actor, typ, minute, payload, critical=1, depends=None, local=None):
        device = DEVICES[actor]
        local_id = local or eid
        events.append((eid, INCIDENT, patient, actor, typ, json.dumps(payload, ensure_ascii=False),
                        device, local_id, t(minute), t(minute), t(minute + 0.05), t(minute + 0.1), critical, depends))

    for p in PATIENTS:
        pid = p["pid"]
        is_pediatric = 1 if p.get("pediatric") else 0
        has_full_vitals = bool(p.get("vitals"))
        needs_full_assessment = 0 if (p.get("expectant") or has_full_vitals) else 1
        last_vitals_at = t(p["vitals"][-1][0]) if has_full_vitals else None
        handed_over_at = t(p["handover"]) if p.get("handover") else None
        current_triage = p["triage"]
        current_status = "handed_over" if p.get("handover") else STATUS_MAP.get((p["status"], None), p["status"])
        if p.get("expectant"):
            current_status = "deceased"

        patient_rows.append((
            pid, INCIDENT, p["sector"], p["visual"], current_triage, p["access"], current_status,
            is_pediatric, needs_full_assessment, t(0), t(p["created"]), last_vitals_at, handed_over_at,
            json.dumps({"building": p["sector"].split("_")[1].upper() if "_" in p["sector"] else "", "site": p["site"]}, ensure_ascii=False),
        ))

        add_event(f"evt_create_{pid}", pid, p["medic"], "PATIENT_CREATED", p["created"],
                   {"visual_id": p["visual"], "site": p["site"], "pediatric_age_years": p.get("pediatric")},
                   local=f"local_create_{pid}")

        if p.get("expectant"):
            add_event(f"evt_expectant_{pid}", pid, p["medic"], "PATIENT_TRIAGED_EXPECTANT", p["created"] + 0.5,
                       {"reason": "no signs of life on assessment", "site": p["site"]})
            continue

        if p.get("mstart_override"):
            algo, human, reason = p["mstart_override"]
            add_event(f"evt_override_{pid}", pid, p["medic"], "MSTART_OVERRIDE", p["created"] + 1,
                       {"algorithm_value": algo, "human_value": human, "reason": reason,
                        "description": f"{p['visual']} manual override from algorithmic {algo.upper()} to {human.upper()}"})

        if has_full_vitals:
            for i, (minute, hr, rr, bp, avpu, spo2) in enumerate(p["vitals"], start=1):
                add_event(f"evt_vitals_{pid}_{i}", pid, p["medic"], "VITALS_RECORDED", minute,
                           vitals_payload(hr, rr, bp, avpu, spo2))

        if p.get("tq"):
            limb, context, applied_min, reassess_min, release_min = p["tq"]
            tq_id = f"tq_{pid}"
            add_event(f"evt_tq_{pid}_apply", pid, p["medic"], "TOURNIQUET_APPLIED", applied_min,
                       {"treatment_type": "TOURNIQUET", "limb": limb, "tourniquet_context": context})
            inv_rows.append((
                f"inv_tq_{pid}", INCIDENT, "medic_bag", p["medic"], f"{p['medic'].replace('_', ' ').title()} Bag",
                "TQ", "Tourniquet", -1, "INTERVENTION_USED", pid, f"evt_tq_{pid}_apply", None,
                t(applied_min), t(applied_min), json.dumps({"site": p["site"]}),
            ))
            last_reassessed = t(reassess_min) if reassess_min else None
            if reassess_min:
                add_event(f"evt_tq_{pid}_reassess", pid, p["medic"], "TOURNIQUET_REASSESSMENT", reassess_min,
                           {"limb": limb, "tourniquet_context": context, "distal_status": "monitored",
                            "next_reassessment_due_minutes": 30})
            released_at = t(release_min) if release_min else None
            if release_min:
                add_event(f"evt_tq_{pid}_release", pid, p["medic"], "TOURNIQUET_RELEASED", release_min,
                           {"limb": limb, "reason": "handed over / receiving team"})
            due_base = reassess_min if reassess_min else applied_min
            tourniquet_rows.append((
                tq_id, INCIDENT, pid, limb, context, t(applied_min), last_reassessed, t(due_base + 30),
                released_at, 0 if release_min else 1, f"evt_tq_{pid}_reassess" if reassess_min else f"evt_tq_{pid}_apply",
            ))

        if p.get("gauze"):
            add_event(f"evt_tx_{pid}_gauze", pid, p["medic"], "INTERVENTION_RECORDED", p["vitals"][0][0] + 1,
                       {"treatment_type": "COMBAT_GAUZE", "site": p["site"]})
            inv_rows.append((
                f"inv_gauze_{pid}", INCIDENT, "medic_bag", p["medic"], f"{p['medic'].replace('_', ' ').title()} Bag",
                "COMBAT_GAUZE", "Combat Gauze", -1, "INTERVENTION_USED", pid, f"evt_tx_{pid}_gauze", None,
                t(p["vitals"][0][0] + 1), t(p["vitals"][0][0] + 1), json.dumps({"site": p["site"]}),
            ))

        if p.get("high_risk_med"):
            med, qty, has_weight, note = p["high_risk_med"]
            med_min = p["vitals"][0][0] + 2
            add_event(f"evt_tx_{pid}_med", pid, p["medic"], "MEDICATION_ADMINISTERED", med_min,
                       {"treatment_type": med, "medication": med, "quantity": qty,
                        "weight_estimate_kg": None, "emergency_override": True, "double_confirmed": True,
                        "high_risk": True})
            inv_rows.append((
                f"inv_med_{pid}", INCIDENT, "medic_bag", p["medic"], f"{p['medic'].replace('_', ' ').title()} Bag",
                med, "Actiq / Fentanyl" if med == "ACTIQ" else med, -qty, "MEDICATION_USED", pid,
                f"evt_tx_{pid}_med", None, t(med_min), t(med_min), json.dumps({"site": p["site"]}),
            ))
            alert_rows.append((
                f"wa_ped_{pid}", INCIDENT, pid, p["medic"], "PEDIATRIC_MEDICATION_MISSING_WEIGHT", "critical",
                f"Medication recorded for pediatric patient {p['visual']} without weight estimate ({note}); accepted and flagged",
                t(med_min + 0.1), None, None, f"pediatric:{pid}:evt_tx_{pid}_med", f"evt_tx_{pid}_med", None, 0,
            ))
            conflict_rows.append((
                f"conf_ped_{pid}", INCIDENT, pid, p["medic"], "PEDIATRIC_MEDICATION_MISSING_WEIGHT", "critical",
                f"{med.title()} recorded for pediatric patient {p['visual']} without weight estimate; double-confirmed emergency override",
                json.dumps({"double_confirmed": True}), t(med_min + 0.1), None, None,
            ))

        if p.get("handover"):
            add_event(f"evt_handover_{pid}", pid, p["medic"], "PATIENT_HANDED_OVER", p["handover"],
                       {"handover_to": "MDA", "site": p["site"]})

    cur.executemany("insert into patients values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", patient_rows)
    cur.executemany("insert into events values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", events)
    cur.executemany("insert into tourniquets values (?,?,?,?,?,?,?,?,?,?,?)", tourniquet_rows)

    # -- Inventory: initial fills (platoon stock + 3 medic bags), consumption already added above --
    init_stock = [
        ("inv_init_platoon_tq", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "TQ", "Tourniquet", 10, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_platoon_gauze", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "COMBAT_GAUZE", "Combat Gauze", 12, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_platoon_bandage", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "BANDAGE", "First-aid Bandage", 14, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_platoon_fluid", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "FLUID_500", "IV Fluids 500ml", 8, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_platoon_morphine", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "MORPHINE", "Morphine", 50, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_platoon_actiq", INCIDENT, "platoon_stock", "pc_demo", "Platoon Stock", "ACTIQ", "Actiq / Fentanyl", 6, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_cohen_tq", INCIDENT, "medic_bag", "medic_cohen", "Medic Cohen Bag", "TQ", "Tourniquet", 3, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_cohen_actiq", INCIDENT, "medic_bag", "medic_cohen", "Medic Cohen Bag", "ACTIQ", "Actiq / Fentanyl", 1, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        # Levi's bag deliberately under-stocked on Combat Gauze relative to Site 2's yellow-heavy
        # casualty load (4 dressings drawn against 2 on hand) — the negative-stock rehearsal case.
        ("inv_init_levi_gauze", INCIDENT, "medic_bag", "medic_levi", "Medic Levi Bag", "COMBAT_GAUZE", "Combat Gauze", 2, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_levi_tq", INCIDENT, "medic_bag", "medic_levi", "Medic Levi Bag", "TQ", "Tourniquet", 2, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
        ("inv_init_amit_bandage", INCIDENT, "medic_bag", "medic_amit", "Medic Amit Bag", "BANDAGE", "First-aid Bandage", 4, "INITIAL_STOCK", None, None, None, t(0), t(0), "{}"),
    ]
    cur.executemany("insert into inventory_ledger values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", init_stock)
    if inv_rows:
        cur.executemany("insert into inventory_ledger values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", inv_rows)

    # -- Dead Man's Switch: medic_amit (sole medic at Site 3) goes silent from minute ~20 --
    presence = [
        ("dp_cohen", INCIDENT, "medic_cohen", "dev_cohen", t(now_min - 0.5), "online", 71, t(now_min - 0.5)),
        ("dp_levi", INCIDENT, "medic_levi", "dev_levi", t(now_min - 0.3), "online", 63, t(now_min - 0.3)),
        ("dp_amit", INCIDENT, "medic_amit", "dev_amit", t(20), "offline", 34, t(20)),
        ("dp_pc", INCIDENT, "pc_demo", "dev_pc", t(now_min - 0.2), "online", 88, t(now_min - 0.2)),
    ]
    cur.executemany("insert into device_presence values (?,?,?,?,?,?,?,?)", presence)
    sync_state = [
        ("dev_cohen", "medic_cohen", INCIDENT, t(now_min - 0.6), t(now_min - 0.4), "normal", 71, t(now_min - 0.4)),
        ("dev_levi", "medic_levi", INCIDENT, t(now_min - 0.5), t(now_min - 0.3), "normal", 63, t(now_min - 0.3)),
        ("dev_amit", "medic_amit", INCIDENT, t(20.2), t(20.1), "critical_only", 34, t(20.2)),
        ("dev_pc", "pc_demo", INCIDENT, t(now_min - 0.3), t(now_min - 0.2), "normal", 88, t(now_min - 0.2)),
    ]
    cur.executemany("insert into device_sync_state values (?,?,?,?,?,?,?,?)", sync_state)
    alert_rows.append((
        "wa_dms_amit", INCIDENT, None, "medic_amit", "DEAD_MAN_SWITCH", "critical",
        "Medic Amit (Site 3 / Assembly Point) silent for more than 6 minutes",
        t(26), None, None, "deadman:medic_amit", None, None, 0,
    ))

    # -- Site 2 dependency-blocked sync error pair (medic_levi's device) --
    sync_errors = [
        ("err_parent", INCIDENT, "dev_levi", "medic_levi", "local_create_p099_bad", None, "MALFORMED_PATIENT_CREATED",
         "Missing visual/location payload", json.dumps({"type": "PATIENT_CREATED"}), t(7), None, "rejected", None),
        ("err_child", INCIDENT, "dev_levi", "medic_levi", "local_vitals_p099_orphan", "local_create_p099_bad",
         "BLOCKED_DEPENDENCY", "Vitals event depends on rejected patient-created event",
         json.dumps({"type": "VITALS_RECORDED"}), t(7.1), None, "blocked_dependency", "err_parent"),
    ]
    cur.executemany("insert into sync_ingestion_errors values (?,?,?,?,?,?,?,?,?,?,?,?,?)", sync_errors)

    # -- Negative-stock watchdog alert for Site 2's Combat Gauze (4 draws against 2 on hand) --
    alert_rows.append((
        "wa_negative_stock_levi_gauze", INCIDENT, None, "medic_levi", "INVENTORY_NEGATIVE_STOCK_USED", "warning",
        "Medic Levi Bag Combat Gauze went negative after 4 dressings drawn against 2 on hand at Site 2",
        t(10.5), None, None, "stock:medic_levi:COMBAT_GAUZE", "evt_tx_p017_gauze", None, 0,
    ))

    cur.executemany("insert into watchdog_alerts values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", alert_rows)
    if conflict_rows:
        cur.executemany("insert into conflict_log values (?,?,?,?,?,?,?,?,?,?,?)", conflict_rows)

    # -- Command snapshot (see module docstring: matches the hand-computed values in
    # docs/FIELD_USABILITY_TEST_PLAN.md's Session 4 write-up for this scenario) --
    cur.execute(
        "insert into incident_command_state values (?,?,?,?,?,?,?,?,?,?,?)",
        (INCIDENT, t(now_min), 26, 3, 3, 2, 2, 1.5, 2, 1, 1),
    )

    # -- Rolling AAR context notes, cc/pc coordinating across 3 sites --
    cur.executemany("insert into aar_context_notes values (?,?,?,?,?,?,?)", [
        ("note_1", INCIDENT, "cc_demo", t(10), "voice_memo",
         "3 sites active: 15A structural collapse (primary, Medic Cohen), 15B partial collapse "
         "(Medic Levi), 22C assembly point for ambulatory casualties (Medic Amit).", "evt_create_p001"),
        ("note_2", INCIDENT, "pc_demo", t(27), "context_note",
         "Site 2 (15B) Combat Gauze depleted below on-hand stock; Log-O resupply requested. "
         "Medic Levi shifting to pressure bandages in the interim.", "evt_tx_p017_gauze"),
        ("note_3", INCIDENT, "cc_demo", t(34), "voice_memo",
         "Medic Amit (Site 3 / Assembly Point) not responding to radio for over 6 minutes; "
         "command escalating per Dead Man's Switch protocol.", None),
    ])

    conn.commit()
    conn.close()
    print(f"Created {path.resolve()}")
    return path


if __name__ == "__main__":
    main()
