"""SQLite persistence for signals, analysis logs, and agent memory.

Three user-facing tables:

* ``signals`` — one row per detected opportunity
  (ticker, type, confidence, source, entry, stop, target, price, timestamp).
* ``analysis_log`` — the full AI analysis JSON plus the market-data snapshot
  that produced it, for later inspection/backtesting.
* ``ticker_memory`` — one row per ticker; updated after every agent run.
  Provides the MemoryLayer with per-ticker scan history so the AI prompt
  can reference prior signals and RSI streaks.

A fresh connection is opened per call so the module is safe to use from both
the FastAPI request threads and the async scheduler. Run standalone to create
the database file and print a summary::

    python -m backend.database
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import get_settings


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> str:
    return get_settings().database_path


def _connect(db_path: str | None = None) -> sqlite3.Connection:
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
    llm_provider TEXT,
    llm_model   TEXT,
    timestamp   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);

CREATE TABLE IF NOT EXISTS analysis_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker             TEXT NOT NULL,
    analysis_json      TEXT NOT NULL,
    market_snapshot    TEXT NOT NULL,
    opportunities_json TEXT,   -- JSON array of ALL detected opportunities (null on old rows)
    actionable_json    TEXT,   -- JSON array of opportunities that cleared the confidence floor
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_ticker ON analysis_log(ticker);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticker_memory (
    ticker                TEXT PRIMARY KEY,
    last_scan             TEXT,
    last_signal           TEXT,
    last_confidence       REAL,
    consecutive_oversold  INTEGER DEFAULT 0,
    consecutive_overbought INTEGER DEFAULT 0,
    last_price            REAL,
    price_trend_pct       REAL,
    updated_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
"""


def init_db(db_path: str | None = None) -> None:  # noqa: C901
    """Create tables and indexes if they do not already exist."""

    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA)
        # Migrate analysis_log tables created before opportunities/LLM columns were added.
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(analysis_log)").fetchall()
        }
        if "opportunities_json" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN opportunities_json TEXT")
        if "actionable_json" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN actionable_json TEXT")
        if "llm_provider" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN llm_provider TEXT")
        if "llm_model" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN llm_model TEXT")
        if "prompt_tokens" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN prompt_tokens INTEGER")
        if "completion_tokens" not in existing_cols:
            conn.execute("ALTER TABLE analysis_log ADD COLUMN completion_tokens INTEGER")
        # Migrate signals tables created before the llm_* columns were added.
        existing_signal_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(signals)").fetchall()
        }
        if "llm_provider" not in existing_signal_cols:
            conn.execute("ALTER TABLE signals ADD COLUMN llm_provider TEXT")
        if "llm_model" not in existing_signal_cols:
            conn.execute("ALTER TABLE signals ADD COLUMN llm_model TEXT")
        # Ensure a stable admin token exists for the key-reveal endpoint.
        # Priority: ADMIN_TOKEN env var → DB-stored → auto-generate + store.
        from .config import get_settings as _cfg  # local to avoid circular import at module level

        env_token = _cfg().admin_token  # empty string if ADMIN_TOKEN not set
        existing_row = conn.execute(
            "SELECT value FROM app_settings WHERE key = 'admin_token'"
        ).fetchone()

        if env_token:
            # User has ADMIN_TOKEN in .env — upsert so /settings returns it correctly.
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_token', ?)",
                (env_token,),
            )
        elif not existing_row:
            # No env var and no DB entry — auto-generate and log once.
            import logging as _logging

            generated = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES ('admin_token', ?)",
                (generated,),
            )
            _logging.getLogger(__name__).warning(
                "ADMIN_TOKEN not set in .env — auto-generated: %s  "
                "(add ADMIN_TOKEN=%s to .env to make it permanent)",
                generated,
                generated,
            )
        conn.commit()


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #
def save_signal(
    opportunity: dict[str, Any],
    llm_provider: str | None = None,
    llm_model: str | None = None,
    db_path: str | None = None,
) -> int:
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
        llm_provider,
        llm_model,
        opportunity.get("timestamp") or _now_iso(),
        _now_iso(),
    )
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO signals
                (ticker, type, confidence, source, entry, stop, target, price,
                 reasons, llm_provider, llm_model, timestamp, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            row,
        )
        conn.commit()
        if cur.lastrowid is None:
            raise RuntimeError("insert into signals returned no lastrowid")
        return cur.lastrowid


def save_analysis(
    ticker: str,
    analysis: dict[str, Any],
    market_snapshot: dict[str, Any],
    opportunities: list[dict[str, Any]] | None = None,
    actionable: list[dict[str, Any]] | None = None,
    llm_provider: str | None = None,
    llm_model: str | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    db_path: str | None = None,
) -> int:
    """Persist the full analysis + market snapshot; return the new row id.

    ``opportunities`` is the full list of rule-detected scores (all confidence
    levels).  ``actionable`` is the subset that cleared the confidence floor.
    Both default to ``None`` which stores SQL NULL so that old rows can be
    distinguished from rows that ran with zero detected opportunities.

    ``llm_provider`` and ``llm_model`` record which AI provider/model produced
    the analysis (e.g. ``"groq"`` / ``"llama-3.3-70b-versatile"``).

    ``prompt_tokens`` and ``completion_tokens`` are the token counts reported
    by the provider — stored for usage aggregation via :func:`get_usage_stats`.
    """

    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO analysis_log
                (ticker, analysis_json, market_snapshot,
                 opportunities_json, actionable_json,
                 llm_provider, llm_model,
                 prompt_tokens, completion_tokens,
                 created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ticker,
                json.dumps(analysis, default=str),
                json.dumps(market_snapshot, default=str),
                (json.dumps(opportunities, default=str) if opportunities is not None else None),
                json.dumps(actionable, default=str) if actionable is not None else None,
                llm_provider or None,
                llm_model or None,
                prompt_tokens if prompt_tokens else None,
                completion_tokens if completion_tokens else None,
                _now_iso(),
            ),
        )
        conn.commit()
        if cur.lastrowid is None:
            raise RuntimeError("insert into analysis_log returned no lastrowid")
        return cur.lastrowid


def get_usage_stats(days: int = 30, db_path: str | None = None) -> dict[str, Any]:
    """Aggregate token usage from ``analysis_log`` for the last *days* days.

    Returns a dict with:
    - ``period_days`` — the window requested
    - ``total_rows``  — number of analysed rows in the window
    - ``total_prompt_tokens``
    - ``total_completion_tokens``
    - ``total_tokens``
    - ``by_provider``  — list of ``{provider, model, rows, prompt_tokens,
                          completion_tokens, total_tokens}`` sorted by total desc
    - ``by_day``       — list of ``{date, prompt_tokens, completion_tokens,
                          total_tokens}`` newest first
    """
    cutoff_interval = f"-{int(days)} days"  # e.g. "-30 days"
    with _connect(db_path) as conn:
        # Overall totals
        row = conn.execute(
            """
            SELECT
                COUNT(*)                        AS rows,
                COALESCE(SUM(prompt_tokens), 0) AS pt,
                COALESCE(SUM(completion_tokens), 0) AS ct
            FROM analysis_log
            WHERE created_at >= datetime('now', ?)
            """,
            (cutoff_interval,),
        ).fetchone()
        total_rows = row["rows"]
        total_pt = row["pt"]
        total_ct = row["ct"]

        # Per-provider/model breakdown
        provider_rows = conn.execute(
            """
            SELECT
                COALESCE(llm_provider, 'unknown')  AS provider,
                COALESCE(llm_model, 'unknown')     AS model,
                COUNT(*)                           AS rows,
                COALESCE(SUM(prompt_tokens), 0)    AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
            FROM analysis_log
            WHERE created_at >= datetime('now', ?)
            GROUP BY llm_provider, llm_model
            ORDER BY prompt_tokens + completion_tokens DESC
            """,
            (cutoff_interval,),
        ).fetchall()

        # Per-day breakdown
        day_rows = conn.execute(
            """
            SELECT
                DATE(created_at)                   AS day,
                COALESCE(SUM(prompt_tokens), 0)    AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
            FROM analysis_log
            WHERE created_at >= datetime('now', ?)
            GROUP BY DATE(created_at)
            ORDER BY day DESC
            """,
            (cutoff_interval,),
        ).fetchall()

    return {
        "period_days": days,
        "total_rows": total_rows,
        "total_prompt_tokens": total_pt,
        "total_completion_tokens": total_ct,
        "total_tokens": total_pt + total_ct,
        "by_provider": [
            {
                "provider": r["provider"],
                "model": r["model"],
                "rows": r["rows"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "total_tokens": r["prompt_tokens"] + r["completion_tokens"],
            }
            for r in provider_rows
        ],
        "by_day": [
            {
                "date": r["day"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "total_tokens": r["prompt_tokens"] + r["completion_tokens"],
            }
            for r in day_rows
        ],
    }


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
def get_recent_signals(
    limit: int = 50,
    ticker: str | None = None,
    db_path: str | None = None,
) -> list[dict[str, Any]]:
    """Return the most recent signals, optionally filtered by ticker."""

    query = "SELECT * FROM signals"
    params: list[Any] = []
    if ticker:
        query += " WHERE ticker = ?"
        params.append(ticker.upper())
    query += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))

    with _connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()

    results: list[dict[str, Any]] = []
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
    db_path: str | None = None,
) -> list[dict[str, Any]]:
    """Return recent analysis-log entries across all tickers, newest first."""

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM analysis_log ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for json_key in ("analysis_json", "market_snapshot"):
            if record.get(json_key):
                try:
                    record[json_key] = json.loads(record[json_key])
                except (json.JSONDecodeError, TypeError):
                    pass  # leave raw string in place; caller gets what the DB stored
        # Expand opportunities columns: keep None (SQL NULL) as None so the
        # frontend can distinguish "not stored" (old rows) from "empty list".
        for opp_key, out_key in (
            ("opportunities_json", "opportunities"),
            ("actionable_json", "actionable"),
        ):
            raw = record.pop(opp_key, None)
            if raw is not None:
                try:
                    record[out_key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    record[out_key] = None
            else:
                record[out_key] = None
        results.append(record)
    return results


def delete_signal(signal_id: int, db_path: str | None = None) -> bool:
    """Delete a signal by id. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM signals WHERE id = ?", (int(signal_id),))
        conn.commit()
        return cur.rowcount > 0


def delete_analysis(entry_id: int, db_path: str | None = None) -> bool:
    """Delete an analysis_log entry by id. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM analysis_log WHERE id = ?", (int(entry_id),))
        conn.commit()
        return cur.rowcount > 0


def get_analysis_history(
    ticker: str,
    limit: int = 20,
    db_path: str | None = None,
) -> list[dict[str, Any]]:
    """Return recent analysis-log entries for *ticker*, newest first."""

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM analysis_log WHERE ticker = ? ORDER BY id DESC LIMIT ?",
            (ticker.upper(), int(limit)),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for json_key in ("analysis_json", "market_snapshot"):
            if record.get(json_key):
                try:
                    record[json_key] = json.loads(record[json_key])
                except (json.JSONDecodeError, TypeError):
                    pass  # leave raw string in place; caller gets what the DB stored
        for opp_key, out_key in (
            ("opportunities_json", "opportunities"),
            ("actionable_json", "actionable"),
        ):
            raw = record.pop(opp_key, None)
            if raw is not None:
                try:
                    record[out_key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    record[out_key] = None
            else:
                record[out_key] = None
        results.append(record)
    return results


# --------------------------------------------------------------------------- #
# Key-value app settings (runtime toggles persisted across restarts)
# --------------------------------------------------------------------------- #
def get_setting(key: str, default: str = "", db_path: str | None = None) -> str:
    with _connect(db_path) as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str, db_path: str | None = None) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()


def clear_all_data(db_path: str | None = None) -> dict[str, int]:
    """Delete all rows from signals and analysis_log. app_settings is preserved."""
    with _connect(db_path) as conn:
        sig_rows = conn.execute("DELETE FROM signals").rowcount
        log_rows = conn.execute("DELETE FROM analysis_log").rowcount
        conn.commit()
    return {"signals_deleted": sig_rows, "analyses_deleted": log_rows}


def get_effective_watchlist(db_path: str | None = None) -> list[str]:
    """Return the watchlist as modified by add/remove overrides stored in DB."""
    from .config import get_settings as _cfg

    base = _cfg().watchlist
    added: list[str] = json.loads(get_setting("watchlist_added", "[]", db_path))
    removed: set = set(json.loads(get_setting("watchlist_removed", "[]", db_path)))
    seen: set = set()
    result: list[str] = []
    for t in [*base, *added]:
        if t not in seen and t not in removed:
            seen.add(t)
            result.append(t)
    return result


# --------------------------------------------------------------------------- #
# Ticker memory — per-ticker agent context (one row per ticker, UPSERT)
# --------------------------------------------------------------------------- #


def get_ticker_memory(ticker: str, db_path: str | None = None) -> dict[str, Any]:
    """Return the memory row for *ticker* as a plain dict, or {} if absent."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM ticker_memory WHERE ticker = ?", (ticker.upper(),)
        ).fetchone()
    if row is None:
        return {}
    return dict(row)


def upsert_ticker_memory(
    ticker: str,
    *,
    last_scan: str | None = None,
    last_signal: str | None = None,
    last_confidence: float | None = None,
    consecutive_oversold: int = 0,
    consecutive_overbought: int = 0,
    last_price: float | None = None,
    price_trend_pct: float | None = None,
    db_path: str | None = None,
) -> None:
    """Insert or replace the memory row for *ticker*."""
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO ticker_memory
                (ticker, last_scan, last_signal, last_confidence,
                 consecutive_oversold, consecutive_overbought,
                 last_price, price_trend_pct,
                 updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                    strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            """,
            (
                ticker.upper(),
                last_scan,
                last_signal,
                last_confidence,
                consecutive_oversold,
                consecutive_overbought,
                last_price,
                price_trend_pct,
            ),
        )
        conn.commit()


def delete_ticker_memory(ticker: str, db_path: str | None = None) -> bool:
    """Remove the memory row for *ticker*. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM ticker_memory WHERE ticker = ?", (ticker.upper(),))
        conn.commit()
    return cur.rowcount > 0


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
