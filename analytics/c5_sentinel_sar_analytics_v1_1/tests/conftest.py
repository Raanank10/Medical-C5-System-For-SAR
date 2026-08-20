"""Shared fixtures for the analytics package test suite.

Adds the package directory to sys.path so tests can import db/kpis/charts/
report the same way seed_demo_db.py and the README's own usage example do
(flat imports, not the relative `.db` form used only when this package is
imported as `c5_sentinel_sar_analytics`), and forces the non-interactive
Agg backend before matplotlib is used anywhere, so chart/report tests don't
need a display.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import matplotlib

matplotlib.use("Agg")

import pytest

from db import DB
from kpis import KPIEngine
from seed_demo_db import main as seed_db


@pytest.fixture()
def seeded_db_path(tmp_path: Path) -> Path:
    """A fresh copy of the demo database, seeded immediately before the test
    runs. KPIs that compare event timestamps to `now()` (e.g. vitals
    reassessment compliance) rely on the seed data being authored ~35 minutes
    in the past *relative to seed time*, not to some fixed clock - reseeding
    per-test keeps that gap correct regardless of when the suite runs.
    """
    return seed_db(tmp_path / "test_demo.db")


@pytest.fixture()
def db(seeded_db_path: Path) -> DB:
    return DB(seeded_db_path)


@pytest.fixture()
def kpi(db: DB) -> KPIEngine:
    return KPIEngine(db)


@pytest.fixture()
def empty_db_path(tmp_path: Path) -> Path:
    """A database with the schema but no rows - covers the "nothing has
    happened yet" / brand-new-incident case every KPI needs to degrade
    gracefully on.
    """
    import sqlite3

    from seed_demo_db import SCHEMA

    path = tmp_path / "empty_demo.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    return path


@pytest.fixture()
def empty_db(empty_db_path: Path) -> DB:
    return DB(empty_db_path)


@pytest.fixture()
def empty_kpi(empty_db: DB) -> KPIEngine:
    return KPIEngine(empty_db)


@pytest.fixture()
def bare_db_path(tmp_path: Path) -> Path:
    """A database missing entirely optional tables (device_sync_state,
    sync_ingestion_errors, incident_command_state, aar_context_notes,
    tourniquets) - covers DB/KPIEngine methods that check table_exists()
    before querying, for a schema version that predates those tables.
    """
    import sqlite3

    path = tmp_path / "bare.db"
    conn = sqlite3.connect(path)
    conn.execute("create table dummy(id integer)")
    conn.commit()
    conn.close()
    return path


@pytest.fixture()
def bare_db(bare_db_path: Path) -> DB:
    return DB(bare_db_path)


@pytest.fixture()
def no_vitals_red_patient_db(tmp_path: Path) -> DB:
    """A single active red patient with no vitals event at all - the
    `no_vitals` branch of vitals_reassessment_compliance(), which no seeded
    patient in the main demo DB actually hits (both p001 and p002 have at
    least one vitals event).
    """
    import sqlite3
    from datetime import datetime, timezone

    from seed_demo_db import SCHEMA

    path = tmp_path / "no_vitals.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute(
        "insert into incidents values (?,?,?,?,?,?,?,?,?,?,?)",
        ("inc_x", "INC-X", now, now, "Test", "active", "pc_demo", now, None, None, None),
    )
    conn.execute(
        "insert into patients values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("p_novit", "inc_x", None, "P-NOVIT", "red", "free", "treating", 0, 0, now, now, None, None, "{}"),
    )
    conn.commit()
    conn.close()
    return DB(path)
