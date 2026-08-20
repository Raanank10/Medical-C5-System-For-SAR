"""Smoke tests for report.py: the generated HTML must be well-formed and
contain the expected sections, for both a seeded incident and an empty
database, without raising.
"""

from __future__ import annotations

import matplotlib.pyplot as plt
import pytest

from report import ReportGenerator


@pytest.fixture(autouse=True)
def _close_figures():
    yield
    plt.close("all")


def test_generate_produces_a_complete_html_document(kpi):
    html = ReportGenerator(kpi).generate()
    assert html.strip().startswith("<!doctype html>")
    assert html.strip().endswith("</html>")
    assert "C5 Sentinel-SAR" in html


def test_generate_embeds_every_chart_as_inline_png(kpi):
    html = ReportGenerator(kpi).generate()
    # six charts embedded via _fig_to_b64 -> six data:image/png;base64 blocks
    assert html.count("data:image/png;base64,") == 6


def test_custom_title_is_used(kpi):
    html = ReportGenerator(kpi).generate(title="Custom AAR Title")
    assert "Custom AAR Title" in html


def test_generate_on_empty_database_does_not_raise(empty_kpi):
    html = ReportGenerator(empty_kpi).generate()
    assert html.strip().startswith("<!doctype html>")
    assert "אין נתונים" in html  # "no data" placeholder from at least one empty chart


def test_save_writes_the_file(kpi, tmp_path):
    out = tmp_path / "aar_report.html"
    result_path = ReportGenerator(kpi).save(out)
    assert result_path == out
    assert out.exists()
    assert out.read_text(encoding="utf-8").strip().startswith("<!doctype html>")
