# C5 Sentinel-SAR Analytics Package v1.1

Local analytics and AAR reporting for the C5 Sentinel-SAR event-sourced demo database.

## What changed from the uploaded v0.2 analytics package

- Renamed the package from generic Rescue analytics to **C5 Sentinel-SAR**.
- Updated version to **1.1.0**.
- Added v1.1 concepts from the product spec:
  - dependency-aware sync ingestion errors
  - high-risk clinical violations preserved and flagged
  - data freshness / stale UI indicators
  - battery-aware sync state
  - dynamic tourniquet reassessment
  - command snapshot table
  - rolling AAR context notes
  - platoon stock / negative-stock visibility
- Removed the old morphine-centric stock KPI and replaced it with inventory-ledger analysis.
- Updated vitals parsing to support stepper payloads:
  - `heart_rate.raw_count × 4`
  - `respiratory_rate.raw_count × 2`

## Run

```bash
pip install -r requirements.txt
python seed_demo_db.py
```

### Run against a real incident instead of the synthetic demo

```bash
export SUPABASE_SERVICE_ROLE_KEY=...   # Supabase dashboard: Project Settings -> API -> service_role secret; never commit it
python export_live_incident.py --incident-id <incident-uuid> --out live_incident.db
```

Then use `live_incident.db` exactly like `rescue_demo_v1_1.db` below. Stdlib-only (`urllib.request`), no new dependency. See `export_live_incident.py`'s module docstring for exactly which tables/columns are exported and the handful of documented best-effort mappings where the live and analytics schemas don't line up 1:1 (e.g. `inventory_ledger` is exported from the live `inventory_ledger_v12` table). `incident_command_state` is deliberately not exported — its live and SQLite schemas don't match, and `KPIEngine.command_summary()` already falls back to computing the same aggregates from real exported `patients`/`watchdog_alerts` data when it's empty.

Then:

```python
from db import DB
from kpis import KPIEngine
from report import ReportGenerator

# if running as a package, use: from c5_sentinel_sar_analytics import DB, KPIEngine, ReportGenerator

db = DB("rescue_demo_v1_1.db")
kpi = KPIEngine(db)
print(kpi.command_summary())
ReportGenerator(kpi).save("aar_report_v1_1.html")
```

## Test

```bash
pip install -r requirements.txt
python -m pytest
```

Tests seed a fresh temporary database per test (via `seed_demo_db.main()`) rather than depending on `rescue_demo_v1_1.db`, so they're independent of whatever state that file happens to be in.

## Files

- `db.py` — SQLite DataFrame wrapper
- `kpis.py` — KPI computation engine
- `charts.py` — tactical/dark charts
- `report.py` — self-contained HTML report generator
- `seed_demo_db.py` — creates `rescue_demo_v1_1.db`
- `export_live_incident.py` — exports a real incident from the live Supabase Postgres database into a local SQLite file shaped like `seed_demo_db.py`'s schema
- `analytics_demo.ipynb` — quick demo notebook
- `tests/` — pytest suite for `db.py`/`kpis.py`/`charts.py`/`report.py`

## Safety note

This is a prototype analytics layer. It is not a certified medical device, does not replace medical doctrine, and must not be used with real patient data without authorization and privacy controls.
