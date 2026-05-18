"""
C5 Sentinel-SAR — Analytics Package v1.1
=======================================

KPI computation, dashboard snapshots, and after-action reporting on top of
an event-sourced SQLite demo database that mirrors the C5 Sentinel-SAR v1.1
product specification.

This package is intentionally local/offline-first: analytics read from the
local event log and current-state projections, not from live REST APIs.
"""

from .db import DB
from .kpis import KPIEngine
from .charts import ChartBuilder
from .report import ReportGenerator

__version__ = "1.1.0"
__all__ = ["DB", "KPIEngine", "ChartBuilder", "ReportGenerator"]
