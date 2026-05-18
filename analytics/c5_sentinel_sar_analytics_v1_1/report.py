"""report.py — Self-contained HTML report generator v1.1."""

from __future__ import annotations

import base64
import io
from datetime import datetime
from pathlib import Path
from typing import Optional

import matplotlib.pyplot as plt
import pandas as pd

try:
    from .charts import ChartBuilder, COLORS
    from .kpis import KPIEngine
except ImportError:
    from charts import ChartBuilder, COLORS
    from kpis import KPIEngine


def _fig_to_b64(fig: plt.Figure) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class ReportGenerator:
    CSS = f"""
    :root {{ --bg:{COLORS['bg']}; --surface:{COLORS['surface']}; --border:{COLORS['border']}; --text:{COLORS['text']}; --muted:{COLORS['muted']}; --red:{COLORS['red']}; --amber:{COLORS['amber']}; --green:{COLORS['green']}; --blue:{COLORS['blue']}; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font-family:Arial, sans-serif; direction:rtl; }}
    .wrap {{ max-width:1120px; margin:0 auto; padding:28px; }}
    .header, .section, .card {{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:20px; margin-bottom:18px; }}
    h1 {{ margin:0 0 6px; font-size:28px; }} h2 {{ margin:0 0 14px; color:var(--blue); font-size:20px; }}
    .meta {{ color:var(--muted); font-size:13px; }}
    .grid {{ display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }}
    .num {{ font-size:30px; font-weight:800; font-family:monospace; }}
    .label {{ color:var(--muted); font-size:12px; margin-top:4px; }}
    img {{ width:100%; border-radius:12px; }}
    table {{ width:100%; border-collapse:collapse; font-size:13px; }} th,td {{ border-bottom:1px solid var(--border); padding:8px; text-align:right; }} th {{ color:var(--muted); }}
    .red {{ color:var(--red); }} .amber {{ color:var(--amber); }} .green {{ color:var(--green); }} .blue {{ color:var(--blue); }}
    footer {{ color:var(--muted); text-align:center; font-size:11px; margin-top:28px; }}
    """

    def __init__(self, kpi: KPIEngine, chart: Optional[ChartBuilder] = None):
        self.kpi = kpi
        self.chart = chart or ChartBuilder()

    @staticmethod
    def _df_table(df: pd.DataFrame, max_rows: int = 12) -> str:
        if df is None or df.empty:
            return "<p class='meta'>אין נתונים</p>"
        view = df.head(max_rows).copy()
        for c in view.columns:
            if pd.api.types.is_datetime64_any_dtype(view[c]):
                view[c] = view[c].dt.strftime("%H:%M:%S")
        return view.to_html(index=False, border=0, escape=False)

    def generate(self, incident_id: Optional[str] = None, title: str = "C5 Sentinel-SAR — AAR / Command Analytics") -> str:
        summary = self.kpi.full_summary(incident_id)
        cmd = summary["command_summary"]
        row = cmd.iloc[0] if not cmd.empty else {}

        charts = {
            "command": self.chart.command_summary_cards(cmd),
            "funnel": self.chart.patient_progression_funnel(summary["patient_progression_funnel"]),
            "ttfv": self.chart.time_to_first_vitals(summary["time_to_first_vitals"]),
            "freshness": self.chart.data_freshness(summary["data_freshness"]),
            "stock": self.chart.stockout_risk(summary["stockout_risk"]),
            "alerts": self.chart.watchdog_alerts(self.kpi.db.watchdog_alerts(incident_id=incident_id)),
        }
        img = {k: _fig_to_b64(v) for k, v in charts.items()}
        generated = datetime.now().strftime("%Y-%m-%d %H:%M")

        html = f"""<!doctype html><html lang='he' dir='rtl'><head><meta charset='utf-8'><title>{title}</title><style>{self.CSS}</style></head><body><div class='wrap'>
        <div class='header'><h1>{title}</h1><div class='meta'>נוצר: {generated} · גרסה אנליטית v1.1 · מקור: SQLite event log</div></div>
        <div class='grid'>
          <div class='card'><div class='num blue'>{row.get('total_patients','—')}</div><div class='label'>סה״כ פצועים</div></div>
          <div class='card'><div class='num red'>{row.get('active_red_patients','—')}</div><div class='label'>אדומים פעילים</div></div>
          <div class='card'><div class='num amber'>{row.get('unresolved_alerts','—')}</div><div class='label'>התראות פתוחות</div></div>
          <div class='card'><div class='num red'>{row.get('negative_stock_items','—')}</div><div class='label'>פריטי מלאי שליליים</div></div>
        </div>
        <div class='section'><h2>תמונת מצב</h2><img src='data:image/png;base64,{img['command']}'></div>
        <div class='section'><h2>משפך פצועים</h2><img src='data:image/png;base64,{img['funnel']}'></div>
        <div class='section'><h2>זמן למדדים ראשונים</h2><img src='data:image/png;base64,{img['ttfv']}'></div>
        <div class='section'><h2>רעננות נתונים</h2><img src='data:image/png;base64,{img['freshness']}'></div>
        <div class='section'><h2>סיכון מלאי</h2><img src='data:image/png;base64,{img['stock']}'></div>
        <div class='section'><h2>התראות Watchdog</h2><img src='data:image/png;base64,{img['alerts']}'></div>
        <div class='section'><h2>הפרות / חריגות בסיכון גבוה</h2>{self._df_table(summary['high_risk_violations'])}</div>
        <div class='section'><h2>שגיאות Sync / אירועים מורעלים</h2>{self._df_table(summary['sync_error_summary'])}</div>
        <footer>C5 Sentinel-SAR analytics package v1.1 — prototype / no real patient data</footer>
        </div></body></html>"""
        return html

    def save(self, path: str | Path, incident_id: Optional[str] = None, title: str = "C5 Sentinel-SAR — AAR / Command Analytics") -> Path:
        path = Path(path)
        path.write_text(self.generate(incident_id=incident_id, title=title), encoding="utf-8")
        return path
