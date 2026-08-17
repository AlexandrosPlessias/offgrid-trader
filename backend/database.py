"""SQLite persistence for signals and full analysis logs.

Two tables:

* ``signals`` — one row per detected opportunity
  (ticker, type, confidence, source, entry, stop, target, price, timestamp).
* ``analysis_log`` — the full AI analysis JSON plus the market-data snapshot
  that produced it, for later inspection/backtesting.

A fresh connection is opened per call so the module is safe to use from both
the FastAPI request threads and the async scheduler. Run standalone to create
the database file and print a summary::

    python -m backend.database
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import get_settings


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> str:
    return get_settings().database_path


def _connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or _db_path())
    conn.row_factory = sqlite3.Row
    return conn


_SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    confidence  REAL    NOT NULL,
    source      TEXT,
    entry       REAL,
    stop        REAL,
    target      REAL,
    price       REAL,
    reasons     TEXT,
    timestamp   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);

CREATE TABLE IF NOT EXISTS analysis_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    analysis_json   TEXT NOT NULL,
    market_snapshot TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_ticker ON analysis_log(ticker);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_db(db_path: Optional[str] = None) -> None:
    """Create tables and indexes if they do not already exist."""

    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA)
        conn.commit()


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #
def save_signal(opportunity: Dict[str, Any], db_path: Optional[str] = None) -> int:
    """Persist a single opportunity dict to ``signals``; return the new row id."""

    reasons = opportunity.get("reasons")
    reasons_json = json.dumps(reasons) if reasons is not None else None
    row = (
        opportunity.get("ticker"),
        opportunity.get("type"),
        float(opportunity.get("confidence") or 0.0),
        opportunity.get("source") or "+".join(opportunity.get("sources", []) or []),
        opportunity.get("entry"),
        opportunity.get("stop"),
        opportunity.get("target"),
        opportunity.get("price"),
        reasons_json,
        opportunity.get("timestamp") or _now_iso(),
        _now_iso(),
    )
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO signals
                (ticker, type, confidence, source, entry, stop, target, price,
                 reasons, timestamp, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            row,
        )
        conn.commit()
        return int(cur.lastrowid)


def save_analysis(
    ticker: str,
    analysis: Dict[str, Any],
    market_snapshot: Dict[str, Any],
    db_path: Optional[str] = None,
) -> int:
    """Persist the full analysis + market snapshot; return the new row id."""

    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO analysis_log (ticker, analysis_json, market_snapshot, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                ticker,
                json.dumps(analysis, default=str),
                json.dumps(market_snapshot, default=str),
                _now_iso(),
            ),
        )
        conn.commit()
        return int(cur.lastrowid)


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
def get_recent_signals(
    limit: int = 50,
    ticker: Optional[str] = None,
    db_path: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return the most recent signals, optionally filtered by ticker."""

    query = "SELECT * FROM signals"
    params: List[Any] = []
    if ticker:
        query += " WHERE ticker = ?"
        params.append(ticker.upper())
    query += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))

    with _connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        if record.get("reasons"):
            try:
                record["reasons"] = json.loads(record["reasons"])
            except (json.JSONDecodeError, TypeError):
                pass
        results.append(record)
    return results


def get_recent_analyses(
    limit: int = 25,
    db_path: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return recent analysis-log entries across all tickers, newest first."""

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM analysis_log ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for json_key in ("analysis_json", "market_snapshot"):
            if record.get(json_key):
                try:
                    record[json_key] = json.loads(record[json_key])
                except (json.JSONDecodeError, TypeError):
                    pass
        results.append(record)
    return results


def delete_signal(signal_id: int, db_path: Optional[str] = None) -> bool:
    """Delete a signal by id. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM signals WHERE id = ?", (int(signal_id),))
        conn.commit()
        return cur.rowcount > 0


def delete_analysis(entry_id: int, db_path: Optional[str] = None) -> bool:
    """Delete an analysis_log entry by id. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM analysis_log WHERE id = ?", (int(entry_id),))
        conn.commit()
        return cur.rowcount > 0


def get_analysis_history(
    ticker: str,
    limit: int = 20,
    db_path: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return recent analysis-log entries for *ticker*, newest first."""

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM analysis_log WHERE ticker = ? ORDER BY id DESC LIMIT ?",
            (ticker.upper(), int(limit)),
        ).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for json_key in ("analysis_json", "market_snapshot"):
            if record.get(json_key):
                try:
                    record[json_key] = json.loads(record[json_key])
                except (json.JSONDecodeError, TypeError):
                    pass
        results.append(record)
    return results


# --------------------------------------------------------------------------- #
# Key-value app settings (runtime toggles persisted across restarts)
# --------------------------------------------------------------------------- #
def get_setting(
    key: str, default: str = "", db_path: Optional[str] = None
) -> str:
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (key,)
        ).fetchone()
    return row["value"] if row else default


def set_setting(
    key: str, value: str, db_path: Optional[str] = None
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()


def clear_all_data(db_path: Optional[str] = None) -> Dict[str, int]:
    """Delete all rows from signals and analysis_log. app_settings is preserved."""
    with _connect(db_path) as conn:
        sig_rows  = conn.execute("DELETE FROM signals").rowcount
        log_rows  = conn.execute("DELETE FROM analysis_log").rowcount
        conn.commit()
    return {"signals_deleted": sig_rows, "analyses_deleted": log_rows}


def get_effective_watchlist(db_path: Optional[str] = None) -> List[str]:
    """Return the watchlist as modified by add/remove overrides stored in DB."""
    from .config import get_settings as _cfg

    base = _cfg().watchlist
    added: List[str] = json.loads(get_setting("watchlist_added", "[]", db_path))
    removed: set = set(
        json.loads(get_setting("watchlist_removed", "[]", db_path))
    )
    seen: set = set()
    result: List[str] = []
    for t in [*base, *added]:
        if t not in seen and t not in removed:
            seen.add(t)
            result.append(t)
    return result


if __name__ == "__main__":
    init_db()
    with _connect() as _conn:
        n_signals = _conn.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
        n_analysis = _conn.execute("SELECT COUNT(*) FROM analysis_log").fetchone()[0]
    print(
        json.dumps(
            {
                "database_path": _db_path(),
                "signals_rows": n_signals,
                "analysis_log_rows": n_analysis,
            },
            indent=2,
        )
    )
