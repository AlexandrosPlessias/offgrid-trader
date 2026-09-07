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
from datetime import datetime, timedelta, timezone
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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker       TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    confidence   REAL    NOT NULL,
    source       TEXT,
    entry        REAL,
    stop         REAL,
    target       REAL,
    price        REAL,
    week52_high  REAL,
    week52_low   REAL,
    reasons      TEXT,
    llm_provider TEXT,
    llm_model    TEXT,
    timestamp    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
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

-- Backtesting tables — fully separate from live signals; never touched by clear_all_data.
CREATE TABLE IF NOT EXISTS backtest_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at          TEXT    NOT NULL,
    tickers             TEXT    NOT NULL,   -- JSON array
    start_date          TEXT    NOT NULL,
    end_date            TEXT    NOT NULL,
    initial_balance     REAL    NOT NULL DEFAULT 10000.0,
    confidence_floor    REAL,
    max_hold_days       INTEGER NOT NULL DEFAULT 10,
    signal_mode         TEXT    NOT NULL DEFAULT 'rules', -- 'rules' | 'llm'
    atr_multiple        REAL    NOT NULL DEFAULT 1.5,
    reward_risk         REAL    NOT NULL DEFAULT 2.0,
    requests_per_minute INTEGER,
    scan_interval_minutes INTEGER NOT NULL DEFAULT 1440, -- 1440=end-of-day; <1440=intraday
    status              TEXT    NOT NULL DEFAULT 'running', -- running|done|error|stopped_quota
    metrics_json        TEXT,   -- JSON object with all computed metrics
    error               TEXT,
    llm_calls           INTEGER NOT NULL DEFAULT 0,
    llm_prompt_tokens   INTEGER NOT NULL DEFAULT 0,
    llm_completion_tokens INTEGER NOT NULL DEFAULT 0,
    llm_provider        TEXT,   -- active provider when run was created (null for rule mode)
    llm_model           TEXT,   -- active model name (null for rule mode)
    is_out_of_sample    INTEGER NOT NULL DEFAULT 0,  -- 1 if user marked as OOS test
    deployment_stage    TEXT    -- AI-review stage (reject|research_only|paper_trade|live_candidate)
);

CREATE TABLE IF NOT EXISTS backtest_trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    ticker       TEXT    NOT NULL,
    signal_date  TEXT    NOT NULL,
    type         TEXT    NOT NULL,   -- 'long' | 'short'
    confidence   REAL    NOT NULL,
    source       TEXT,
    entry        REAL,
    stop         REAL,
    target       REAL,
    exit_date    TEXT,
    exit_price   REAL,
    outcome      TEXT,   -- 'win' | 'loss' | 'timeout'
    r_multiple   REAL,
    reasons      TEXT,   -- JSON array
    created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run ON backtest_trades(run_id);
CREATE INDEX IF NOT EXISTS idx_bt_runs_created ON backtest_runs(created_at);

-- Per-run AI floor-suggestion history (one row per button press).
CREATE TABLE IF NOT EXISTS backtest_floor_suggests (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id             INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    recommended_floor  INTEGER NOT NULL,
    reasoning          TEXT,
    trade_off          TEXT,
    result_json        TEXT,               -- full advisor response (expanded schema)
    llm_provider       TEXT,
    llm_model          TEXT,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_floor_suggests_run ON backtest_floor_suggests(run_id);

-- Multi-run AI comparison history (one row per compare call).
CREATE TABLE IF NOT EXISTS backtest_compares (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    run_ids_json       TEXT    NOT NULL,   -- JSON array of int
    result_json        TEXT,               -- full LLM response
    llm_provider       TEXT,
    llm_model          TEXT,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL
);

-- Saved backtesting parameter configurations (user-defined profiles).
-- Name is UNIQUE so saving with the same name overwrites the previous entry.
CREATE TABLE IF NOT EXISTS backtest_profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    params_json TEXT    NOT NULL,   -- JSON object: tickers, confFloor, maxHold, …
    created_at  TEXT    NOT NULL
);

-- Market-data cache: JSON blobs keyed by source + ticker + params.
-- Separate from app_settings so it can be indexed and bulk-evicted independently.
CREATE TABLE IF NOT EXISTS data_cache (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,           -- JSON envelope: {_cached_at, _data}
    cached_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_data_cache_at ON data_cache(cached_at);

-- Paper trading orders: one row per order placed on Alpaca paper account.
-- signal_id references the signals table row that triggered the order.
CREATE TABLE IF NOT EXISTS paper_orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id          INTEGER REFERENCES signals(id) ON DELETE SET NULL,
    ticker             TEXT    NOT NULL,
    side               TEXT    NOT NULL,   -- 'buy' | 'sell'
    alpaca_order_id    TEXT    UNIQUE,
    status             TEXT    NOT NULL DEFAULT 'pending',
    notional           REAL,              -- $ amount placed
    qty                REAL,              -- filled quantity (from Alpaca)
    entry_price        REAL,              -- signal entry at order time
    stop_price         REAL,
    take_profit_price  REAL,
    filled_avg_price   REAL,
    filled_at          TEXT,
    closed_at          TEXT,
    realized_pnl       REAL,
    -- Denormalised signal fields stored at placement time so they survive
    -- even if the parent signal row is deleted or signal_id is null.
    signal_confidence  REAL,
    signal_source      TEXT,
    signal_timestamp   TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_orders_ticker    ON paper_orders(ticker);
CREATE INDEX IF NOT EXISTS idx_paper_orders_status    ON paper_orders(status);
CREATE INDEX IF NOT EXISTS idx_paper_orders_signal_id ON paper_orders(signal_id);

-- Discovery tables — populated by backend.discovery; never cleared by clear_all_data.
CREATE TABLE IF NOT EXISTS discovery_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT    NOT NULL,
    sources         TEXT    NOT NULL,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'running',   -- running|done|error
    error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_created ON discovery_runs(created_at);

CREATE TABLE IF NOT EXISTS discovery_candidates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
    ticker         TEXT    NOT NULL,
    score          REAL    NOT NULL DEFAULT 0,
    price          REAL,
    percent_change REAL,
    volume         INTEGER,
    source         TEXT,
    reasons        TEXT,   -- JSON array
    components     TEXT,   -- JSON object
    created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_candidates_run   ON discovery_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_score ON discovery_candidates(score DESC);

-- Watchlist groups: user-defined sector/theme buckets.
CREATE TABLE IF NOT EXISTS watchlist_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    tickers    TEXT    NOT NULL DEFAULT '[]',   -- JSON array
    created_at TEXT    NOT NULL
);
"""


def init_db(db_path: str | None = None) -> None:
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
        # Migrate backtest_runs tables created before LLM usage columns were added.
        existing_bt_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(backtest_runs)").fetchall()
        }
        for _col, _def in [
            ("llm_calls", "INTEGER NOT NULL DEFAULT 0"),
            ("llm_prompt_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("llm_completion_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("llm_provider", "TEXT"),
            ("llm_model", "TEXT"),
            ("review_prompt_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("review_completion_tokens", "INTEGER NOT NULL DEFAULT 0"),
        ]:
            if _col not in existing_bt_cols:
                conn.execute(f"ALTER TABLE backtest_runs ADD COLUMN {_col} {_def}")
        # Migrate signals tables created before the llm_* columns were added.
        existing_signal_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(signals)").fetchall()
        }
        if "llm_provider" not in existing_signal_cols:
            conn.execute("ALTER TABLE signals ADD COLUMN llm_provider TEXT")
        if "llm_model" not in existing_signal_cols:
            conn.execute("ALTER TABLE signals ADD COLUMN llm_model TEXT")
        # backtest_runs: add is_out_of_sample and deployment_stage if missing.
        existing_br_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(backtest_runs)").fetchall()
        }
        if "is_out_of_sample" not in existing_br_cols:
            conn.execute(
                "ALTER TABLE backtest_runs ADD COLUMN is_out_of_sample INTEGER NOT NULL DEFAULT 0"
            )
        if "deployment_stage" not in existing_br_cols:
            conn.execute("ALTER TABLE backtest_runs ADD COLUMN deployment_stage TEXT")
        if "scan_interval_minutes" not in existing_br_cols:
            conn.execute(
                "ALTER TABLE backtest_runs"
                " ADD COLUMN scan_interval_minutes INTEGER NOT NULL DEFAULT 1440"
            )
        # signals: add week52_high / week52_low columns if missing.
        existing_sig_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(signals)").fetchall()
        }
        for _col in ("week52_high", "week52_low"):
            if _col not in existing_sig_cols:
                conn.execute(f"ALTER TABLE signals ADD COLUMN {_col} REAL")
        # paper_orders: add denormalised signal fields if missing, then backfill.
        existing_po_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(paper_orders)").fetchall()
        }
        for _col, _def in [
            ("signal_confidence", "REAL"),
            ("signal_source", "TEXT"),
            ("signal_timestamp", "TEXT"),
        ]:
            if _col not in existing_po_cols:
                conn.execute(f"ALTER TABLE paper_orders ADD COLUMN {_col} {_def}")
        # Backfill rows where signal_id is set but the denormalised columns are null.
        conn.execute("""
            UPDATE paper_orders
            SET signal_confidence = s.confidence,
                signal_source     = s.source,
                signal_timestamp  = s.timestamp
            FROM signals s
            WHERE paper_orders.signal_id = s.id
              AND paper_orders.signal_confidence IS NULL
            """)
        # backtest_floor_suggests: add result_json column if missing (expanded advisor schema).
        existing_bfs_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(backtest_floor_suggests)").fetchall()
        }
        if "result_json" not in existing_bfs_cols:
            conn.execute("ALTER TABLE backtest_floor_suggests ADD COLUMN result_json TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_bt_floor_suggests_run"
            " ON backtest_floor_suggests(run_id)"
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
        opportunity.get("week52_high"),
        opportunity.get("week52_low"),
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
                 week52_high, week52_low,
                 reasons, llm_provider, llm_model, timestamp, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    # Both analysis_log (live scans) and backtest_runs (LLM-mode runs) contribute
    # tokens.  We union them into a single virtual table so the usage stats reflect
    # the true total regardless of which surface consumed the tokens.
    #
    # analysis_log columns: created_at, prompt_tokens, completion_tokens, llm_provider, llm_model
    # backtest_runs columns: created_at, llm_prompt_tokens, llm_completion_tokens,
    #                        llm_provider, llm_model
    # We expose a `source` column so callers can distinguish if needed (unused for now).
    _UNION_SQL = """
        SELECT created_at,
               prompt_tokens,
               completion_tokens,
               COALESCE(llm_provider, 'unknown') AS llm_provider,
               COALESCE(llm_model,    'unknown') AS llm_model,
               'signal' AS source
        FROM analysis_log
        WHERE prompt_tokens > 0 OR completion_tokens > 0

        UNION ALL

        SELECT created_at,
               llm_prompt_tokens     AS prompt_tokens,
               llm_completion_tokens AS completion_tokens,
               COALESCE(llm_provider, 'unknown') AS llm_provider,
               COALESCE(llm_model,    'unknown') AS llm_model,
               'backtest' AS source
        FROM backtest_runs
        WHERE (llm_prompt_tokens > 0 OR llm_completion_tokens > 0)
          AND llm_provider IS NOT NULL

        UNION ALL

        SELECT created_at,
               review_prompt_tokens     AS prompt_tokens,
               review_completion_tokens AS completion_tokens,
               COALESCE(llm_provider, 'unknown') AS llm_provider,
               COALESCE(llm_model,    'unknown') AS llm_model,
               'backtest_review' AS source
        FROM backtest_runs
        WHERE (review_prompt_tokens > 0 OR review_completion_tokens > 0)

        UNION ALL

        SELECT created_at,
               prompt_tokens,
               completion_tokens,
               COALESCE(llm_provider, 'unknown') AS llm_provider,
               COALESCE(llm_model,    'unknown') AS llm_model,
               'backtest_experiment_advisor' AS source
        FROM backtest_floor_suggests
        WHERE (prompt_tokens > 0 OR completion_tokens > 0)

        UNION ALL

        SELECT created_at,
               prompt_tokens,
               completion_tokens,
               COALESCE(llm_provider, 'unknown') AS llm_provider,
               COALESCE(llm_model,    'unknown') AS llm_model,
               'backtest_compare' AS source
        FROM backtest_compares
        WHERE (prompt_tokens > 0 OR completion_tokens > 0)
    """

    # Build per-query SQL by concatenation — _UNION_SQL is a hardcoded constant (not user
    # input), so these are not injection vectors.  Plain + avoids the S608 f-string check.
    _where = " WHERE created_at >= datetime('now', ?)"
    _from_union = " FROM (" + _UNION_SQL + ")"

    _total_q = (
        "SELECT COUNT(*) AS rows,"
        " COALESCE(SUM(prompt_tokens), 0) AS pt,"
        " COALESCE(SUM(completion_tokens), 0) AS ct" + _from_union + _where
    )
    _provider_q = (
        "SELECT llm_provider AS provider, llm_model AS model, COUNT(*) AS rows,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens"
        + _from_union
        + _where
        + " GROUP BY llm_provider, llm_model ORDER BY prompt_tokens + completion_tokens DESC"
    )
    _day_q = (
        "SELECT DATE(created_at) AS day, COUNT(*) AS rows,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens"
        + _from_union
        + _where
        + " GROUP BY DATE(created_at) ORDER BY day DESC"
    )
    _model_day_q = (
        "SELECT DATE(created_at) AS day, llm_provider AS provider, llm_model AS model,"
        " COUNT(*) AS rows,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens"
        + _from_union
        + _where
        + " GROUP BY DATE(created_at), llm_provider, llm_model ORDER BY day DESC"
    )
    _source_q = (
        "SELECT source, COUNT(*) AS rows,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens"
        + _from_union
        + _where
        + " GROUP BY source ORDER BY source"
    )

    with _connect(db_path) as conn:
        # Overall totals from the union
        row = conn.execute(_total_q, (cutoff_interval,)).fetchone()
        total_rows = row["rows"]
        total_pt = row["pt"]
        total_ct = row["ct"]

        # Per-provider/model breakdown
        provider_rows = conn.execute(_provider_q, (cutoff_interval,)).fetchall()

        # Per-day breakdown (all providers combined)
        day_rows = conn.execute(_day_q, (cutoff_interval,)).fetchall()

        # Per-provider+model per-day breakdown — powers the per-model chart in Settings.
        model_day_rows = conn.execute(_model_day_q, (cutoff_interval,)).fetchall()

        # Per-source breakdown — 'signal'=Signals/Explorer, 'backtest'=runs, 'backtest_review'=AI.
        source_rows = conn.execute(_source_q, (cutoff_interval,)).fetchall()

    _SOURCE_LABEL = {
        "signal": "Signals / Explorer",
        "backtest": "Backtesting runs",
        "backtest_review": "AI Review",
        "backtest_experiment_advisor": "Experiment Advisor",
        "backtest_compare": "Run Compare",
    }

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
        "by_model_day": [
            {
                "day": r["day"],
                "provider": r["provider"],
                "model": r["model"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "total_tokens": r["prompt_tokens"] + r["completion_tokens"],
            }
            for r in model_day_rows
        ],
        "by_source": [
            {
                "source": r["source"],
                "label": _SOURCE_LABEL.get(r["source"], r["source"]),
                "rows": r["rows"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "total_tokens": r["prompt_tokens"] + r["completion_tokens"],
            }
            for r in source_rows
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


def get_backtest_profiles(db_path: str | None = None) -> list[dict[str, Any]]:
    """Return all saved backtest parameter profiles, newest first."""
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, name, params_json, created_at FROM backtest_profiles ORDER BY id DESC"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "params": json.loads(r["params_json"]),
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


def save_backtest_profile(
    name: str,
    params: dict[str, Any],
    db_path: str | None = None,
) -> dict[str, Any]:
    """Upsert a named backtest profile.  If *name* already exists the params
    are updated in-place (created_at is preserved).  Returns the saved profile.
    """
    now = _now_iso()
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO backtest_profiles (name, params_json, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                params_json = excluded.params_json
            """,
            (name, json.dumps(params, default=str), now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, name, params_json, created_at FROM backtest_profiles WHERE name = ?",
            (name,),
        ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "params": json.loads(row["params_json"]),
        "createdAt": row["created_at"],
    }


def delete_backtest_profile(profile_id: int, db_path: str | None = None) -> bool:
    """Delete a backtest profile by id.  Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        cur = conn.execute("DELETE FROM backtest_profiles WHERE id = ?", (int(profile_id),))
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


# --------------------------------------------------------------------------- #
# Data-fetch cache (market data, OHLCV, news)
# --------------------------------------------------------------------------- #
def get_cached_data(key: str, db_path: str | None = None) -> str | None:
    """Return the raw JSON string for *key*, or None if not found."""
    try:
        with _connect(db_path) as conn:
            row = conn.execute("SELECT value FROM data_cache WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
    except Exception:
        return None


def set_cached_data(key: str, value: str, db_path: str | None = None) -> None:
    """Upsert *value* into the cache under *key*."""
    try:
        with _connect(db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO data_cache (key, value, cached_at)"
                " VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
                (key, value),
            )
            conn.commit()
    except Exception as _exc:  # cache writes must never block the main flow
        import logging as _logging

        _logging.getLogger(__name__).debug("data_cache write failed key=%s: %s", key, _exc)


def evict_cache_entries(older_than_hours: int = 168, db_path: str | None = None) -> int:
    """Delete cache entries older than *older_than_hours* hours.

    Default: 7 days.  Returns the number of rows deleted.
    """
    cutoff = (datetime.utcnow() - timedelta(hours=older_than_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _connect(db_path) as conn:
        n = conn.execute("DELETE FROM data_cache WHERE cached_at < ?", (cutoff,)).rowcount
        conn.commit()
    return n


def get_cache_stats(db_path: str | None = None) -> dict:
    """Return summary stats about the data_cache table."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt,"
            " SUM(LENGTH(value)) AS total_bytes,"
            " MIN(cached_at) AS oldest,"
            " MAX(cached_at) AS newest"
            " FROM data_cache"
        ).fetchone()
    return {
        "entry_count": row["cnt"] or 0,
        "total_bytes": row["total_bytes"] or 0,
        "oldest": row["oldest"],
        "newest": row["newest"],
    }


def clear_all_data(db_path: str | None = None) -> dict[str, int]:
    """Delete all transient data rows.  app_settings and ticker_memory are preserved."""
    with _connect(db_path) as conn:
        sig_rows = conn.execute("DELETE FROM signals").rowcount
        log_rows = conn.execute("DELETE FROM analysis_log").rowcount
        bt_rows = conn.execute("DELETE FROM backtest_runs").rowcount
        # backtest_trades deleted via ON DELETE CASCADE from backtest_runs
        fs_rows = conn.execute("DELETE FROM backtest_floor_suggests").rowcount
        cmp_rows = conn.execute("DELETE FROM backtest_compares").rowcount
        conn.commit()
    return {
        "signals_deleted": sig_rows,
        "analyses_deleted": log_rows,
        "backtest_runs_deleted": bt_rows,
        "floor_suggests_deleted": fs_rows,
        "compares_deleted": cmp_rows,
    }


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


# --------------------------------------------------------------------------- #
# Backtesting persistence
# --------------------------------------------------------------------------- #
def save_backtest_run(
    tickers: list[str],
    start_date: str,
    end_date: str,
    *,
    initial_balance: float = 10_000.0,
    confidence_floor: float | None = None,
    max_hold_days: int = 10,
    signal_mode: str = "rules",
    atr_multiple: float = 1.5,
    reward_risk: float = 2.0,
    requests_per_minute: int | None = None,
    scan_interval_minutes: int = 1440,
    llm_provider: str | None = None,
    llm_model: str | None = None,
    is_out_of_sample: bool = False,
    db_path: str | None = None,
) -> int:
    """Insert a new backtest_runs row with status='running' and return its id."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO backtest_runs
                (created_at, tickers, start_date, end_date, initial_balance,
                 confidence_floor, max_hold_days, signal_mode,
                 atr_multiple, reward_risk, requests_per_minute, scan_interval_minutes,
                 status, llm_provider, llm_model, is_out_of_sample)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
            """,
            (
                _now_iso(),
                json.dumps(tickers, default=str),
                start_date,
                end_date,
                initial_balance,
                confidence_floor,
                max_hold_days,
                signal_mode,
                atr_multiple,
                reward_risk,
                requests_per_minute,
                scan_interval_minutes,
                llm_provider or None,
                llm_model or None,
                1 if is_out_of_sample else 0,
            ),
        )
        conn.commit()
    return cur.lastrowid  # type: ignore[return-value]


def update_backtest_run(
    run_id: int,
    *,
    status: str,
    metrics: dict[str, Any] | None = None,
    error: str | None = None,
    llm_calls: int | None = None,
    llm_prompt_tokens: int | None = None,
    llm_completion_tokens: int | None = None,
    deployment_stage: str | None = None,
    db_path: str | None = None,
) -> None:
    """Update status, metrics_json, error, LLM usage, and deployment_stage for a run row.

    Any field left as ``None`` is preserved via COALESCE — callers that only
    touch ``status`` (e.g. the AI Review endpoint) will not wipe metrics or
    token counts written by the backtest engine.
    """
    metrics_json = json.dumps(metrics, default=str) if metrics is not None else None
    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE backtest_runs
               SET status                = ?,
                   metrics_json          = COALESCE(?, metrics_json),
                   error                 = COALESCE(?, error),
                   llm_calls             = COALESCE(?, llm_calls),
                   llm_prompt_tokens     = COALESCE(?, llm_prompt_tokens),
                   llm_completion_tokens = COALESCE(?, llm_completion_tokens),
                   deployment_stage      = COALESCE(?, deployment_stage)
             WHERE id = ?
            """,
            (
                status,
                metrics_json,
                error,
                llm_calls,
                llm_prompt_tokens,
                llm_completion_tokens,
                deployment_stage,
                run_id,
            ),
        )
        conn.commit()


def save_backtest_review_tokens(
    run_id: int,
    prompt_tokens: int,
    completion_tokens: int,
    db_path: str | None = None,
) -> None:
    """Persist the token usage from a 'Get AI Review' call against a backtest run."""
    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE backtest_runs
               SET review_prompt_tokens     = ?,
                   review_completion_tokens = ?
             WHERE id = ?
            """,
            (prompt_tokens, completion_tokens, run_id),
        )
        conn.commit()


def save_backtest_trade(
    run_id: int,
    ticker: str,
    signal_date: str,
    signal_type: str,
    confidence: float,
    *,
    source: str | None = None,
    entry: float | None = None,
    stop: float | None = None,
    target: float | None = None,
    exit_date: str | None = None,
    exit_price: float | None = None,
    outcome: str | None = None,
    r_multiple: float | None = None,
    reasons: list[str] | None = None,
    db_path: str | None = None,
) -> int:
    """Insert one backtest_trades row and return its id."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO backtest_trades
                (run_id, ticker, signal_date, type, confidence,
                 source, entry, stop, target,
                 exit_date, exit_price, outcome, r_multiple,
                 reasons, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                ticker.upper(),
                signal_date,
                signal_type,
                confidence,
                source,
                entry,
                stop,
                target,
                exit_date,
                exit_price,
                outcome,
                r_multiple,
                json.dumps(reasons or [], default=str),
                _now_iso(),
            ),
        )
        conn.commit()
    return cur.lastrowid  # type: ignore[return-value]


def get_backtest_runs(db_path: str | None = None) -> list[dict[str, Any]]:
    """Return all backtest_runs rows, newest first."""
    with _connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM backtest_runs ORDER BY created_at DESC").fetchall()
    result = []
    for row in rows:
        r = dict(row)
        r["tickers"] = json.loads(r.get("tickers") or "[]")
        if r.get("metrics_json"):
            r["metrics"] = json.loads(r["metrics_json"])
        else:
            r["metrics"] = None
        del r["metrics_json"]
        result.append(r)
    return result


def get_backtest_run(run_id: int, db_path: str | None = None) -> dict[str, Any] | None:
    """Return one backtest_run with its trades, or None if not found."""
    with _connect(db_path) as conn:
        row = conn.execute("SELECT * FROM backtest_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        run = dict(row)
        trades_rows = conn.execute(
            "SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY signal_date, id",
            (run_id,),
        ).fetchall()

    run["tickers"] = json.loads(run.get("tickers") or "[]")
    if run.get("metrics_json"):
        run["metrics"] = json.loads(run["metrics_json"])
    else:
        run["metrics"] = None
    del run["metrics_json"]

    trades = []
    for t in trades_rows:
        td = dict(t)
        td["reasons"] = json.loads(td.get("reasons") or "[]")
        trades.append(td)
    run["trades"] = trades
    return run


def delete_backtest_run(run_id: int, db_path: str | None = None) -> bool:
    """Delete a backtest_run and its trades (CASCADE). Returns True if deleted."""
    with _connect(db_path) as conn:
        # Enable FK support for this connection so CASCADE fires.
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.execute("DELETE FROM backtest_runs WHERE id = ?", (run_id,))
        conn.commit()
    return cur.rowcount > 0


def save_backtest_floor_suggest(
    run_id: int,
    recommended_floor: int,
    reasoning: str | None,
    trade_off: str | None,
    llm_provider: str | None,
    llm_model: str | None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    result_json: str | None = None,
    db_path: str | None = None,
) -> int:
    """Insert a parameter-advisor result row; return its id.

    Each button press creates a new row for full historicity.
    """
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO backtest_floor_suggests
                (run_id, recommended_floor, reasoning, trade_off, result_json,
                 llm_provider, llm_model,
                 prompt_tokens, completion_tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                recommended_floor,
                reasoning,
                trade_off,
                result_json,
                llm_provider,
                llm_model,
                prompt_tokens,
                completion_tokens,
                _now_iso(),
            ),
        )
        conn.commit()
        return cur.lastrowid or 0


def save_backtest_compare(
    run_ids: list[int],
    result_json: str | None,
    llm_provider: str | None,
    llm_model: str | None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    db_path: str | None = None,
) -> int:
    """Insert a multi-run comparison result row; return its id."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO backtest_compares
                (run_ids_json, result_json,
                 llm_provider, llm_model,
                 prompt_tokens, completion_tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                json.dumps(run_ids),
                result_json,
                llm_provider,
                llm_model,
                prompt_tokens,
                completion_tokens,
                _now_iso(),
            ),
        )
        conn.commit()
        return cur.lastrowid or 0


# --------------------------------------------------------------------------- #
# Paper trading helpers
# --------------------------------------------------------------------------- #


def save_paper_order(order: dict, db_path: str | None = None) -> int:
    """Insert a new paper order row and return its id."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO paper_orders
                (signal_id, ticker, side, alpaca_order_id, status,
                 notional, qty, entry_price, stop_price, take_profit_price,
                 filled_avg_price, filled_at, closed_at, realized_pnl,
                 signal_confidence, signal_source, signal_timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order.get("signal_id"),
                order["ticker"],
                order["side"],
                order.get("alpaca_order_id"),
                order.get("status", "pending"),
                order.get("notional"),
                order.get("qty"),
                order.get("entry_price"),
                order.get("stop_price"),
                order.get("take_profit_price"),
                order.get("filled_avg_price"),
                order.get("filled_at"),
                order.get("closed_at"),
                order.get("realized_pnl"),
                order.get("signal_confidence"),
                order.get("signal_source"),
                order.get("signal_timestamp"),
            ),
        )
        conn.commit()
        return cur.lastrowid or 0


def get_paper_orders(limit: int = 100, db_path: str | None = None) -> list[dict]:
    """Return recent paper orders (most recent first).

    Signal fields (confidence, source, timestamp) are stored directly on the
    order row at placement time.  The JOIN is kept as a fallback for rows
    created before the denormalised columns were added.
    """
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT po.*,
                   COALESCE(po.signal_confidence, s.confidence) AS signal_confidence,
                   COALESCE(po.signal_source,     s.source)     AS signal_source,
                   COALESCE(po.signal_timestamp,  s.timestamp)  AS signal_timestamp
            FROM paper_orders po
            LEFT JOIN signals s ON s.id = po.signal_id
            ORDER BY po.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_paper_order_status(
    alpaca_order_id: str,
    updates: dict,
    db_path: str | None = None,
) -> None:
    """Update mutable fields of a paper order identified by its Alpaca order ID."""
    allowed = {
        "status",
        "qty",
        "filled_avg_price",
        "filled_at",
        "closed_at",
        "realized_pnl",
    }
    fields = {k: v for k, v in updates.items() if k in allowed and v is not None}
    if not fields:
        return
    # Keys are validated against the allowlist above — no injection risk.
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = [*fields.values(), alpaca_order_id]
    with _connect(db_path) as conn:
        conn.execute(
            f"UPDATE paper_orders SET {set_clause} WHERE alpaca_order_id = ?",  # noqa: S608
            values,
        )
        conn.commit()


def get_paper_order_by_signal(signal_id: int, db_path: str | None = None) -> dict | None:
    """Return the paper order linked to a given signal_id, or None if not found."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM paper_orders WHERE signal_id = ?", (signal_id,)
        ).fetchone()
    return dict(row) if row else None


def get_open_order_by_ticker_side(
    ticker: str, side: str, db_path: str | None = None
) -> dict | None:
    """Return any non-terminal order for ticker+side, or None.

    Used to prevent duplicate open positions: if a pending/accepted/held order
    already exists for NVDA buy, we should not place another one.
    """
    terminal = ("cancelled", "canceled", "expired", "filled", "rejected", "done")
    placeholders = ",".join("?" * len(terminal))
    with _connect(db_path) as conn:
        row = conn.execute(
            f"SELECT * FROM paper_orders WHERE ticker = ? AND side = ?"  # noqa: S608
            f" AND status NOT IN ({placeholders}) LIMIT 1",
            (ticker, side, *terminal),
        ).fetchone()
    return dict(row) if row else None


def get_paper_order_by_alpaca_id(alpaca_order_id: str, db_path: str | None = None) -> dict | None:
    """Return a paper order by its Alpaca order ID, or None."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM paper_orders WHERE alpaca_order_id = ?",
            (alpaca_order_id,),
        ).fetchone()
    return dict(row) if row else None


# --------------------------------------------------------------------------- #
# Discovery helpers
# --------------------------------------------------------------------------- #
def save_discovery_run(sources: str, db_path: str | None = None) -> int:
    """Create a new discovery_runs row (status='running') and return its id."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO discovery_runs (created_at, sources, candidate_count, status)"
            " VALUES (?, ?, 0, 'running')",
            (_now_iso(), sources),
        )
        conn.commit()
        if cur.lastrowid is None:
            raise RuntimeError("insert into discovery_runs returned no lastrowid")
        return cur.lastrowid


def update_discovery_run(
    run_id: int,
    status: str,
    candidate_count: int = 0,
    error: str | None = None,
    db_path: str | None = None,
) -> None:
    """Update status / counts on an existing discovery_runs row."""
    with _connect(db_path) as conn:
        conn.execute(
            "UPDATE discovery_runs SET status=?, candidate_count=?, error=? WHERE id=?",
            (status, candidate_count, error, run_id),
        )
        conn.commit()


def save_discovery_candidates(
    run_id: int,
    candidates: list[dict],
    db_path: str | None = None,
) -> None:
    """Bulk-insert scored candidates for *run_id*."""
    now = _now_iso()
    rows = [
        (
            run_id,
            c.get("symbol") or c.get("ticker", ""),
            float(c.get("score", 0)),
            c.get("price"),
            c.get("percent_change"),
            c.get("volume"),
            c.get("source"),
            json.dumps(c.get("reasons") or []),
            json.dumps(c.get("components") or {}),
            now,
        )
        for c in candidates
    ]
    with _connect(db_path) as conn:
        conn.executemany(
            """INSERT INTO discovery_candidates
               (run_id, ticker, score, price, percent_change, volume,
                source, reasons, components, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()


def get_latest_discovery(db_path: str | None = None) -> dict | None:
    """Return the most-recent completed discovery run with its candidates.

    Returns ``None`` when no completed run exists yet.
    """
    with _connect(db_path) as conn:
        run_row = conn.execute(
            "SELECT * FROM discovery_runs WHERE status='done'" " ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if not run_row:
            return None
        run = dict(run_row)
        cand_rows = conn.execute(
            "SELECT * FROM discovery_candidates WHERE run_id=? ORDER BY score DESC",
            (run["id"],),
        ).fetchall()
    candidates = []
    for r in cand_rows:
        c = dict(r)
        for field in ("reasons", "components"):
            try:
                c[field] = json.loads(c[field] or "[]")
            except Exception:
                c[field] = []
        candidates.append(c)
    run["candidates"] = candidates
    return run


def get_discovery_history(limit: int = 20, db_path: str | None = None) -> list[dict]:
    """Return the most-recent *limit* discovery runs (newest first), without candidates.

    Each row: id, created_at, sources, candidate_count, status, error.
    """
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, created_at, sources, candidate_count, status, error"
            " FROM discovery_runs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_discovery_run_candidates(run_id: int, db_path: str | None = None) -> list[dict]:
    """Return all candidates for *run_id*, ordered by score descending."""
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT ticker, score, price, percent_change, volume, source, reasons, components"
            " FROM discovery_candidates WHERE run_id=? ORDER BY score DESC",
            (run_id,),
        ).fetchall()
    out = []
    for r in rows:
        c = dict(r)
        for field in ("reasons", "components"):
            try:
                c[field] = json.loads(c[field] or "[]")
            except Exception:
                c[field] = [] if field == "reasons" else {}
        out.append(c)
    return out


# --------------------------------------------------------------------------- #
# Watchlist group helpers
# --------------------------------------------------------------------------- #
def get_watchlist_groups(db_path: str | None = None) -> list[dict]:
    """Return all watchlist groups, tickers decoded from JSON."""
    with _connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM watchlist_groups ORDER BY name").fetchall()
    groups = []
    for r in rows:
        g = dict(r)
        try:
            g["tickers"] = json.loads(g.get("tickers") or "[]")
        except Exception:
            g["tickers"] = []
        groups.append(g)
    return groups


def save_watchlist_group(
    name: str,
    tickers: list[str],
    db_path: str | None = None,
) -> int:
    """Upsert a watchlist group by name; return the row id."""
    tickers_json = json.dumps([t.upper() for t in tickers])
    with _connect(db_path) as conn:
        existing = conn.execute("SELECT id FROM watchlist_groups WHERE name=?", (name,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE watchlist_groups SET tickers=? WHERE id=?",
                (tickers_json, existing["id"]),
            )
            conn.commit()
            return existing["id"]
        cur = conn.execute(
            "INSERT INTO watchlist_groups (name, tickers, created_at) VALUES (?, ?, ?)",
            (name, tickers_json, _now_iso()),
        )
        conn.commit()
        if cur.lastrowid is None:
            raise RuntimeError("insert into watchlist_groups returned no lastrowid")
        return cur.lastrowid


def delete_watchlist_group(group_id: int, db_path: str | None = None) -> bool:
    """Delete a watchlist group by id. Returns True if a row was deleted."""
    with _connect(db_path) as conn:
        n = conn.execute("DELETE FROM watchlist_groups WHERE id=?", (group_id,)).rowcount
        conn.commit()
    return n > 0


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
