"""Smoke tests for charts.py: every ChartBuilder method must return a
matplotlib Figure without raising, for both real KPI output and the "no
data yet" empty-DataFrame case each method is expected to handle via
ChartBuilder._empty().
"""

from __future__ import annotations

import matplotlib.pyplot as plt
import pandas as pd
import pytest

from charts import ChartBuilder


@pytest.fixture()
def chart():
    return ChartBuilder()


@pytest.fixture(autouse=True)
def _close_figures():
    yield
    plt.close("all")


class TestEmptyInputs:
    """Every chart method takes a DataFrame and must degrade to the
    placeholder figure instead of raising when that frame is empty."""

    @pytest.mark.parametrize(
        "method_name",
        [
            "command_summary_cards",
            "patient_progression_funnel",
            "time_to_first_vitals",
            "data_freshness",
            "stockout_risk",
            "watchdog_alerts",
        ],
    )
    def test_empty_dataframe_returns_a_figure(self, chart, method_name):
        method = getattr(chart, method_name)
        fig = method(pd.DataFrame())
        assert isinstance(fig, plt.Figure)


class TestRealData:
    def test_command_summary_cards(self, chart, kpi):
        fig = chart.command_summary_cards(kpi.command_summary())
        assert isinstance(fig, plt.Figure)

    def test_patient_progression_funnel(self, chart, kpi):
        fig = chart.patient_progression_funnel(kpi.patient_progression_funnel())
        assert isinstance(fig, plt.Figure)

    def test_time_to_first_vitals(self, chart, kpi):
        fig = chart.time_to_first_vitals(kpi.time_to_first_vitals())
        assert isinstance(fig, plt.Figure)

    def test_data_freshness(self, chart, kpi):
        fig = chart.data_freshness(kpi.data_freshness())
        assert isinstance(fig, plt.Figure)

    def test_stockout_risk(self, chart, kpi):
        fig = chart.stockout_risk(kpi.stockout_risk())
        assert isinstance(fig, plt.Figure)

    def test_watchdog_alerts(self, chart, kpi, db):
        fig = chart.watchdog_alerts(db.watchdog_alerts())
        assert isinstance(fig, plt.Figure)
