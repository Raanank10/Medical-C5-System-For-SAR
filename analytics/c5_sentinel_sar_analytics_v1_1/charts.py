"""charts.py — C5 Sentinel-SAR chart builder v1.1."""

from __future__ import annotations

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
import pandas as pd

COLORS = {
    "red": "#FF3B30",
    "yellow": "#FFD60A",
    "green": "#34C759",
    "black": "#3A3A3A",
    "blue": "#0A84FF",
    "amber": "#FF9F0A",
    "bg": "#090B0D",
    "surface": "#111518",
    "border": "#252D36",
    "text": "#E8EDF2",
    "muted": "#8C98A4",
}
TRIAGE_COLORS = {"red": COLORS["red"], "yellow": COLORS["yellow"], "green": COLORS["green"], "black": COLORS["black"], "unknown": COLORS["blue"]}
TRIAGE_LABELS = {"red": "קשה", "yellow": "בינוני", "green": "קל", "black": "ללא סימני חיים", "unknown": "לא ידוע"}


def _dark(fig, ax):
    fig.patch.set_facecolor(COLORS["bg"])
    ax.set_facecolor(COLORS["surface"])
    for sp in ax.spines.values():
        sp.set_edgecolor(COLORS["border"])
    ax.tick_params(colors=COLORS["muted"])
    ax.xaxis.label.set_color(COLORS["muted"])
    ax.yaxis.label.set_color(COLORS["muted"])
    ax.title.set_color(COLORS["text"])
    ax.grid(True, color=COLORS["border"], alpha=0.45)
    ax.set_axisbelow(True)


def _fig(w=10, h=5):
    fig, ax = plt.subplots(figsize=(w, h))
    _dark(fig, ax)
    return fig, ax


class ChartBuilder:
    def __init__(self, dark: bool = True):
        self.dark = dark
        plt.rcParams.update({"font.family": "DejaVu Sans", "axes.unicode_minus": False})

    def _empty(self, msg="אין נתונים"):
        fig, ax = _fig()
        ax.text(0.5, 0.5, msg, ha="center", va="center", transform=ax.transAxes, color=COLORS["muted"], fontsize=14)
        ax.set_axis_off()
        return fig

    def command_summary_cards(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        row = df.iloc[0]
        labels = ["פצועים", "אדומים פעילים", "התראות", "יחס אדום/חובש", "מלאי שלילי"]
        values = [row.get("total_patients", 0), row.get("active_red_patients", 0), row.get("unresolved_alerts", 0), row.get("red_patients_per_active_medic", "—"), row.get("negative_stock_items", 0)]
        colors = [COLORS["blue"], COLORS["red"], COLORS["amber"], COLORS["yellow"], COLORS["red"]]
        fig, ax = _fig(w=12, h=3)
        ax.set_axis_off()
        for i, (lab, val, col) in enumerate(zip(labels, values, colors)):
            x = 0.1 + i * 0.2
            rect = mpatches.FancyBboxPatch((x-0.08, 0.22), 0.16, 0.58, boxstyle="round,pad=0.02", linewidth=1, edgecolor=COLORS["border"], facecolor=COLORS["surface"])
            ax.add_patch(rect)
            ax.text(x, 0.58, str(val), ha="center", va="center", color=col, fontsize=24, fontweight="bold")
            ax.text(x, 0.36, lab, ha="center", va="center", color=COLORS["muted"], fontsize=11)
        ax.set_title("תמונת מצב פיקודית", fontsize=16, fontweight="bold")
        return fig

    def patient_progression_funnel(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        fig, ax = _fig(w=10, h=4)
        bars = ax.bar(df["stage"].astype(str), df["count"], color=COLORS["blue"], edgecolor=COLORS["bg"])
        ax.set_title("משפך התקדמות פצועים", fontsize=15, fontweight="bold")
        ax.set_ylabel("מספר פצועים")
        for b in bars:
            ax.text(b.get_x()+b.get_width()/2, b.get_height()+0.1, f"{int(b.get_height())}", ha="center", color=COLORS["text"], fontweight="bold")
        fig.tight_layout()
        return fig

    def time_to_first_vitals(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        plot = df.copy()
        plot["minutes"] = plot["minutes"].fillna(0)
        fig, ax = _fig(w=max(8, len(plot)*0.8), h=5)
        colors = [TRIAGE_COLORS.get(x, COLORS["muted"]) for x in plot["current_triage"]]
        bars = ax.bar(plot["visual_id"], plot["minutes"], color=colors, edgecolor=COLORS["bg"])
        ax.axhline(5, color=COLORS["amber"], linestyle="--", linewidth=1.5, label="יעד 5 דקות")
        ax.set_title("זמן עד מדדים ראשונים", fontsize=15, fontweight="bold")
        ax.set_ylabel("דקות")
        for b in bars:
            ax.text(b.get_x()+b.get_width()/2, b.get_height()+0.1, f"{b.get_height():.1f}", ha="center", color=COLORS["text"], fontsize=9)
        ax.legend(facecolor=COLORS["surface"], edgecolor=COLORS["border"], labelcolor=COLORS["text"])
        fig.tight_layout()
        return fig

    def data_freshness(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        fig, ax = _fig(w=10, h=max(4, len(df)*0.55))
        color_map = {"fresh": COLORS["green"], "stale": COLORS["amber"], "critical_stale": COLORS["red"]}
        colors = [color_map.get(s, COLORS["muted"]) for s in df["freshness_state"]]
        bars = ax.barh(df["device_id"], df["seconds_since_pull"], color=colors)
        ax.axvline(60, color=COLORS["amber"], linestyle="--", label="stale >60s")
        ax.axvline(300, color=COLORS["red"], linestyle="--", label="critical >300s")
        ax.set_title("רעננות נתונים לפי מכשיר", fontsize=15, fontweight="bold")
        ax.set_xlabel("שניות מאז pull מוצלח")
        for b in bars:
            ax.text(b.get_width()+2, b.get_y()+b.get_height()/2, f"{b.get_width():.0f}s", va="center", color=COLORS["text"], fontsize=9)
        ax.legend(facecolor=COLORS["surface"], edgecolor=COLORS["border"], labelcolor=COLORS["text"])
        fig.tight_layout()
        return fig

    def stockout_risk(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        plot = df.head(12).copy()
        risk_color = {"negative_stock": COLORS["red"], "low_stock": COLORS["amber"], "depleting_soon": COLORS["yellow"], "ok": COLORS["green"], "unknown": COLORS["muted"]}
        labels = plot["owner_label"].astype(str) + " / " + plot["item_sku"].astype(str)
        fig, ax = _fig(w=11, h=max(4, len(plot)*0.55))
        bars = ax.barh(labels, plot["current_quantity"], color=[risk_color.get(x, COLORS["muted"]) for x in plot["risk_level"]])
        ax.axvline(0, color=COLORS["text"], linewidth=1)
        ax.set_title("סיכון מלאי / מלאי שלילי", fontsize=15, fontweight="bold")
        ax.set_xlabel("כמות נוכחית")
        for b in bars:
            ax.text(b.get_width()+0.1, b.get_y()+b.get_height()/2, f"{b.get_width():.0f}", va="center", color=COLORS["text"])
        fig.tight_layout()
        return fig

    def watchdog_alerts(self, df: pd.DataFrame) -> plt.Figure:
        if df.empty:
            return self._empty()
        counts = df.groupby(["alert_type", "severity"]).size().reset_index(name="count")
        fig, ax = _fig(w=11, h=max(4, len(counts)*0.55))
        colors = [COLORS["red"] if s == "critical" else COLORS["amber"] for s in counts["severity"]]
        labels = counts["alert_type"] + " / " + counts["severity"]
        ax.barh(labels, counts["count"], color=colors)
        ax.set_title("התראות Watchdog", fontsize=15, fontweight="bold")
        ax.set_xlabel("כמות")
        fig.tight_layout()
        return fig
