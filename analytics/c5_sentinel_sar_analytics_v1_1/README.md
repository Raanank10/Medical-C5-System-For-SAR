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
- `analytics_demo.ipynb` — quick demo notebook
- `tests/` — pytest suite for `db.py`/`kpis.py`/`charts.py`/`report.py`

## Safety note

This is a prototype analytics layer. It is not a certified medical device, does not replace medical doctrine, and must not be used with real patient data without authorization and privacy controls.
