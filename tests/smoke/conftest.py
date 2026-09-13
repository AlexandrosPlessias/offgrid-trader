"""Shared fixtures and setup for offgrid-trader smoke tests.

This conftest.py is auto-discovered by pytest for all subdirectories, so
fixtures defined here are available to every submodule without explicit import.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

# Ensure the repo root is on sys.path so ``from backend import …`` works
# whether tests are run from the repo root, from tests/smoke/, or inside
# the Docker container (where WORKDIR=/app).
# __file__ = tests/smoke/conftest.py → three dirname() calls reach the root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Use an isolated temp DB so we never touch a real one.
_TMP_DB = os.path.join(tempfile.gettempdir(), "offgrid_smoke.db")
os.environ["DATABASE_PATH"] = _TMP_DB
os.environ["EMAIL_ENABLED"] = "false"
os.environ["SLACK_ENABLED"] = "false"

# --------------------------------------------------------------------------- #
# Section 1 — Import all backend modules; fail fast if any is missing.
# --------------------------------------------------------------------------- #
try:
    from backend import (  # noqa: E402
        alerts,
        analysis,
        config,
        data,
        database,
        opportunities,
        scheduler,
    )
    from backend.main import app  # noqa: E402
except Exception as exc:  # pragma: no cover
    raise ImportError(f"Fatal import error — aborting smoke test suite: {exc}") from exc


# --------------------------------------------------------------------------- #
# Shared check helper — exposed as a pytest fixture so each test function
# gets its own failure list; assert is raised at teardown if any check failed.
# --------------------------------------------------------------------------- #
@pytest.fixture
def check():
    """Named check collector.  Usage: def test_foo(check): check("label", cond)."""
    _failures: list[str] = []

    def _check(name: str, cond: bool, detail: str = "") -> None:
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
        if not cond:
            _failures.append(name)

    yield _check
    assert not _failures, f"Failed checks: {_failures}"


# --------------------------------------------------------------------------- #
# Session-scoped DB initialisation — runs once before any test in the suite.
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="session", autouse=True)
def _init_db_session():
    """Ensure the temp DB is initialised exactly once per pytest session."""
    database.init_db()
    yield


# --------------------------------------------------------------------------- #
# Shared data fixtures — used verbatim by sections 5, 7, 8, 11.
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="session")
def synthetic():
    """Synthetic market-data dict shared across multiple test sections."""
    return {
        "ticker": "TEST",
        "price": {"current": 100.0, "change_pct": 3.5, "volume_ratio": 3.0},
        "technicals": {
            "1H": {"RSI": 25.0, "MACD": {"histogram": 0.5}},
            "4H": {"RSI": 28.0, "MACD": {"histogram": 0.4}},
            "1D": {"RSI": 45.0, "MACD": {"histogram": 0.3}},
        },
        "errors": [],
    }


@pytest.fixture(scope="session")
def ai_result():
    """Fake AI analysis result shared across multiple test sections."""
    return {
        "opportunity": {
            "type": "long",
            "confidence": 82.0,
            "entry": 100.0,
            "stop": 95.0,
            "target": 110.0,
        },
        "signals": ["bullish structure"],
        "error": None,
    }


@pytest.fixture(scope="session")
def opps(synthetic, ai_result):
    """Pre-computed opportunity list from synthetic data (sections 5 & 8)."""
    return opportunities.detect_opportunities(synthetic, ai_result)
