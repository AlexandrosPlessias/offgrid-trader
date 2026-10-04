# Backlog item 9 — Report comparator + on-demand range reports

## Context

The four report types (`eod_frac`, `eod_orders`, `weekly_frac`, `weekly_orders`) each summarise a
**single** window. A weekly report can say "P&L +$42 this week" but never "…up from −$18 last week."
The "cross-week" language in the weekly prompts refers to patterns *within* the current 7 days, not
this-week-vs-last-week.

Goal: let the user pick any two already-persisted reports of the same type and see the **delta** —
is performance improving or regressing, and on which metrics. Two layers:

- **Layer 1** — a fast deterministic diff (no LLM): performance metrics *and* the tuning knobs in
  force at each report's generation time. The config deltas are what make the comparison *causal*
  rather than merely descriptive — the user sees which settings changed alongside how performance moved.
- **Layer 2** — an on-demand "trading master" LLM review returning good / bad / improve sections with
  concrete suggested values.

The diff itself needs no data re-query, because `reports.context_json` already persists structured,
numbers-only metrics. But two gaps have to be closed first, and each is a prerequisite rather than a
nice-to-have:

- **No tuning snapshot is persisted** (Step 1), so config deltas would otherwise show today's live
  values instead of the settings actually in force.
- **Only two window sizes exist** — 1 day and 7 days (Step 1b). Comparing month-over-month or
  quarter-over-quarter is impossible until reports can be run over arbitrary ranges. That in turn
  surfaces a truncation bug in how report data is queried, which must be fixed before any long-range
  report can be trusted.

**Decisions made:**
- Layer 1 diff is computed **server-side** via `GET /reports/compare` (an explicit, unit-testable
  contract with server-side type-mismatch rejection).
- The UI lives **inline in the existing Orders/Frac tabs**, mirroring the Backtest comparator.
- The comparison is **visual as well as tabular** — a diverging "what moved" chart and a
  week-over-week overlay, on a validated colourblind-safe palette (Step 5b).
- The reviewer receives each report's **full snapshot**, is gated by a **deterministic strictness
  grade** computed before the call, and returns **structured tuning suggestions** (Step 4).
- The comparator gets its **own model override**, so a deeper reasoning model can be used for it
  than for the nightly digests (Step 4b).
- Reports can also be run **on demand over any range** — monthly, quarterly, yearly or explicit
  dates — which is what makes month-over-month and quarter-over-quarter comparisons possible at all
  (Step 1b). This carries a correctness fix the long ranges depend on.

---

## Step 0 — Branch and commit the backlog updates

Branch off **`main`**. The `feat/reset-trading-state` work is already merged — it landed squashed as
`b517273` (PR #28), alongside `72a7851` (PR #27, the four-way report split). Both prerequisites this
item depends on (`reports.context_json` and the four report types) are therefore present on `main`.

```
git checkout main && git pull
git checkout -b feat/backlog-9-report-comparator
```

Verified before switching: `BACKLOG.md` is byte-identical between the old HEAD and `origin/main`, so
the uncommitted edit (items 6 and 8 marked ✅) carries over cleanly with no stash and no conflict.
Every file this plan touches is likewise identical, so all line references below are valid on `main`.

Then stage `BACKLOG.md`, show `git diff --stat`, and **ask before committing**. No `Co-Authored-By`
trailer.

---

## Step 1 — Prerequisite: persist the tuning snapshot (blocks everything else)

`_current_tuning(mode)` ([backend/routes/reports.py:214](backend/routes/reports.py#L214)) returns the
effective knobs (DB override → env default) but is **only** interpolated into the LLM prompt as
`TUNING_CONFIG` at [reports.py:367](backend/routes/reports.py#L367). It is never persisted, so
historical comparisons would show *current* live values rather than the settings actually in force.

In `_run_report`, right after `context` is built at
[reports.py:597](backend/routes/reports.py#L597):

```python
context["tuning"] = _current_tuning(mode)
```

It then flows into `context_json` at [reports.py:732](backend/routes/reports.py#L732) unchanged.

While here: `_llm_report` re-derives the mode by string-sniffing `report_type`
([reports.py:364](backend/routes/reports.py#L364)) even though `_run_report` already has an explicit
`mode` param. Read the snapshot off `context["tuning"]` instead of recomputing it.

**Consequence:** only reports generated *after* this ships carry a tuning snapshot. Pre-existing
reports (and pre-migration rows where `context_json IS NULL`) must degrade gracefully — the API
returns `config_available: false` and the UI says so rather than rendering a misleading empty diff.

---

## Step 1b — On-demand range reports (monthly / quarterly / yearly / custom)

Today only two windows exist: `eod` (1 day) and `weekly` (7 days), hard-coded as
`days = 7 if period == "weekly" else 1` ([reports.py:524](backend/routes/reports.py#L524)). The user
wants to run a report over any range on demand — monthly, quarterly, yearly, or explicit dates.
This pairs naturally with the comparator: month-over-month and quarter-over-quarter are the
comparisons worth making.

### The blocker that must be fixed first

`_run_report` fetches `get_recent_signals(limit=500)`, `get_paper_orders(limit=500)` and
`get_frac_positions(limit=500)` and then filters by date **in Python**
([reports.py:530-541](backend/routes/reports.py#L530)). None of those three DB functions accepts a
date filter. At 1–7 days, 500 rows is comfortably enough. **At monthly and beyond it silently
truncates** — the report would look complete while quietly dropping the oldest rows in the window.

The fix is **date-scoped SQL**, not a bigger limit. Add `since` / `until` filtered queries
(`get_signals_since`, `get_paper_orders_since`, `get_frac_positions_since`) that push the window
into a SQL `WHERE` clause, and have `_run_report` use them. `get_paper_orders_for_tickers`
([database.py:2157](backend/database.py#L2157)) is the existing precedent for a scoped query.
This also quietly corrects EoD/weekly, which are only right today because 500 happens to exceed a
week's volume.

**Watch the all-time figures.** `_economics(all_orders)` / `_frac_economics(all_frac)`
([reports.py:542-543](backend/routes/reports.py#L542)) are deliberately passed the *unfiltered* list
to give all-time context alongside the window. That intent must be preserved — but it should come
from a SQL aggregate rather than a truncated 500-row slice, or the "all-time" number is simply wrong
on any mature database. Do not let the window-scoping change silently redefine these.

### Periods and windows

`monthly` (30d), `quarterly` (90d), `yearly` (365d), and `custom` (explicit `start`/`end`).

- **API** — `GET /reports/range?period=monthly|quarterly|yearly&mode=frac|orders` and
  `GET /reports/range?start=YYYY-MM-DD&end=YYYY-MM-DD&mode=frac|orders`.
- **Validation** — `start < end`, `end` not in the future, and a maximum span (3 years) to bound
  token cost and query time.
- **Report types** follow the existing `{period}_{mode}` convention: `monthly_frac`,
  `quarterly_orders`, `yearly_frac`, `custom_orders`, … so they persist and list like any other.

### Prompts — two new files, not eight

`_compose_report` resolves `report_{report_type}.md`, which would mean eight near-identical new
prompts. Instead add **one per mode** — `report_range_frac.md` / `report_range_orders.md` —
parameterised by a `{{WINDOW_LABEL}}` token, and resolve to them for every range period. There is
already precedent for prompt fallback at [reports.py:451](backend/routes/reports.py#L451)
(`report_eod.md` / `report_weekly.md` as legacy fallbacks).

### Adaptive bucketing

Per-day breakdowns are weekly-only today and would produce 365 points on a yearly report. Bucket by
span: **≤31 days → per day · ≤1 year → per week · >1 year → per month.** Keep emitting the existing
`signals_by_day` / `bracket_by_day` / `frac_by_day` key names so the current chart code keeps
working, and add a `bucket_granularity: "day" | "week" | "month"` marker for axis labelling.

### Interaction with the comparator

`_report_comparability` (Step 4) must also compare **window length** for range reports. Two
`custom_frac` reports share a `type` but a 10-day window against a 90-day window is meaningless —
grade that pair `none`. Materially different spans (>20%) cannot be compared honestly.

### Scheduling

**On-demand only — no new cron.** The Cloudflare free plan allows 5 cron triggers and
[infra/cron-worker/wrangler.toml](infra/cron-worker/wrangler.toml) already uses all 5.

### UI

A "Run report" control at the top of the Reports page: preset buttons (Monthly / Quarterly / Yearly)
plus custom date pickers — mirroring the Backtest tab's existing `3M / 6M / 1Y / 2Y` presets and
date pickers rather than inventing a new control.

---

## Step 2 — Database layer (`backend/database.py`)

1. **`get_report_record(report_id)`** — a scoped single-row fetch. `get_report_records()`
   ([database.py:1330](backend/database.py#L1330)) is list-only, caps at 200, and omits
   `llm_provider` / `prompt_tokens` / `completion_tokens`. Do **not** fetch a list and filter in
   Python for two known ids — select the row by id directly.

2. **`report_compares` table** in `_SCHEMA`, mirroring `backtest_compares`
   ([database.py:168-178](backend/database.py#L168)):
   `id, report_a_id, report_b_id, result_json, llm_provider, llm_model, prompt_tokens,
   completion_tokens, created_at`.

3. **`save_report_compare(...)`** writer, mirroring `save_backtest_compare`
   ([database.py:2030-2061](backend/database.py#L2030)).

4. **Token usage** — add a `UNION ALL` arm emitting `'report_compare' AS source` to `_UNION_SQL`
   (after the `backtest_compares` arm at [database.py:676-683](backend/database.py#L676)), and a
   `_SOURCE_LABEL["report_compare"] = "Report Compare"` entry at
   [database.py:760](backend/database.py#L760). There is no generic token-recording helper — a
   source exists purely by being a union arm.

5. **Purge/cascade** — add `DELETE FROM report_compares` alongside the existing
   `backtest_compares` deletes at [database.py:1094](backend/database.py#L1094), `:1142`, `:1163`.

---

## Step 3 — Layer 1: `GET /reports/compare?a=<id>&b=<id>`

New route in [backend/routes/reports.py](backend/routes/reports.py), plus a module-level
`_compare_reports(ra, rb) -> dict` helper so Layer 2 reuses the identical diff (the analogue of
`_compute_comparability` at [backtest.py:33](backend/routes/backtest.py#L33)).

**Validation ladder:**
- either id missing → `404`
- `ra["type"] != rb["type"]` → `409` with a clear message (can't compare frac against orders)
- either `context_json` is `NULL`/unparseable → `422` "no structured data" (pre-migration rows)

**Metric deltas.** Pick the economics block matching the type's mode — `frac_economics` for
`*_frac`, `bracket_economics` for `*_orders`. This matters: the off-mode block is zeroed by
`_zero_eco` and has 7 keys vs the live block's 9 (no `win_pnl`/`loss_pnl`), so always diff the
*on-mode* block. Rows: the economics keys, plus `signals_count`, plus the mode-scoped
`blocked_events` keys.

Each row: `{key, label, a, b, delta, pct_delta, higher_is_better}`.
- `pct_delta` is `null` when `a == 0` (undefined, not infinity) — likewise `delta` is `null` when
  either side is `None` (e.g. `win_rate` is `None` with zero closed trades).
- `higher_is_better`: `true` for P&L / win rate / wins / closed trades; `false` for losses and every
  `blocked_events` counter; `null` for genuinely directionless figures (`open_positions`,
  `notional_open`, `signals_count`) so the UI leaves them uncoloured.

**Config deltas.** Diff the two `context["tuning"]` dicts, returning **only changed** keys as
`{key, a, b}`. If either report lacks the snapshot, return `config_available: false` with an empty list.

Response: `{type, a: {...meta}, b: {...meta}, metrics: [...], config: [...], config_available: bool}`.

---

## Step 4 — Layer 2: `POST /reports/compare/review`

Body `{a: int, b: int}`. Mirrors `POST /backtest/compare`
([backtest.py:236-388](backend/routes/backtest.py#L236)) step for step:

1. Same validation ladder as Step 3.
2. Prompts: new `backend/prompts/report_compare_system.md` + `report_compare_user.md`. Note reports.py
   uses `_render_prompt(filename, tokens)` with `{{TOKEN}}` **double**-brace syntax
   ([reports.py:206](backend/routes/reports.py#L206)) — not backtest.py's single-brace `_load_prompt`.
3. `raw, model_used, pt, ct = await asyncio.to_thread(call_llm, user_prompt, system_prompt)`;
   `LLMError` → `503`.
4. Strip ``` fences → `json.loads` → hardcoded fallback dict on parse failure.
5. `_validate_llm_json(result, "report_compare.schema.json")` (new schema in
   `backend/prompts/schemas/`) + one-shot `_repair_llm_json(raw, errs, call_llm, system_prompt)`.
6. Attach `model_used` / `prompt_tokens` / `completion_tokens`; persist via `save_report_compare`
   in a `try/except` (non-fatal, matching [backtest.py:385](backend/routes/backtest.py#L385)).
   Resolve the provider at the call site: `get_setting("llm_provider") or get_settings().llm.provider`.

### What the reviewer is given — the full snapshot, not just the diff

The LLM payload carries **three** blocks, not only the deterministic diff:

1. **`report_a` / `report_b` — each report's complete `context_json` snapshot**, verbatim: both
   economics blocks, `signals` (up to 20, with ticker/type/confidence), `top_bracket_movers` /
   `top_frac_movers`, `blocked_events`, the weekly-only `signals_by_day` and `bracket_by_day` /
   `frac_by_day`, `daily_summaries`, and the full `tuning` snapshot. Plus each report's `headline`
   and `report_date`. The reviewer should see the whole state of each period, not a reduction of it.
2. **`diff`** — the Step 3 `_compare_reports` output, so the LLM reasons over the *same* numbers the
   user is looking at and cannot silently derive different ones.
3. **`comparability`** — the strictness verdict below, computed before the call.

### Strictness — a deterministic gate computed *before* the LLM call

Add `_report_comparability(ra, rb) -> tuple[str, list[str]]` returning a
`"full" | "partial" | "none"` grade plus reasons, mirroring `_compute_comparability`
([backtest.py:33-65](backend/routes/backtest.py#L33)). The backend decides this, not the LLM, so the
model cannot talk itself into a stronger claim than the data supports. Factors:

- **Sample size** — closed trades below a floor (~5) on either side makes any win-rate delta noise.
- **Window adjacency** — are these genuinely consecutive periods (a true week-over-week) or two
  arbitrary windows? Flag non-adjacent pairs.
- **Window overlap** — an EoD report whose date falls inside the other's 7-day window double-counts;
  flag it.
- **Window length** — for range reports, materially different spans (>20%) grade `none`.
- **Tuning snapshot present on both sides** — without it, *no causal claim is permitted at all*.
- **Signal-volume disparity** — a large gap in `signals_count` means different opportunity sets.

The grade and reasons go into the payload and are echoed back in the response, so the UI can badge
the verdict exactly as the Backtest comparator does.

### Prompt design — strict by construction

The system prompt casts the LLM as an expert trading coach and binds it to hard rules:

- Return **good / bad / improve** sections.
- **Respect the supplied `comparability` grade** — on `partial` or `none` it must lead with that
  limitation and downgrade its language; it may never upgrade the grade.
- **No causality from small samples.** With few closed trades, say "not statistically meaningful"
  rather than narrating noise as a trend.
- **Every regression must either name the specific config change that plausibly caused it, or state
  explicitly that no config change explains it.** Speculation must be labelled as such.
- **State a confidence level per claim.**
- `improve` items are structured, not prose:
  `{setting, current_value, proposed_value, rationale, expected_effect, confidence}`.
- **Mode scoping is a hard constraint** — suggestions may only reference keys present in that
  report's persisted `tuning` snapshot. A frac report must never suggest `PAPER_MAX_POSITIONS`;
  an orders report must never suggest `FRAC_BUDGET`. Enforce this in the JSON schema too, so a
  violation is caught by `_validate_llm_json` and repaired rather than shown to the user.

Fires only on explicit request, never automatically.

---

## Step 4b — Model override for the comparator (`llm_model_report_compare`)

Reports are the only feature with a per-feature model override today, and the comparator must join
them. There is **no named-profile concept** in this codebase — despite the "Configured profiles" UI
copy, it is a flat DB key per feature whose value is a single `"provider:model"` string (empty =
fall back to the global primary). Do **not** build a profile table.

New setting key: **`llm_model_report_compare`**, following the existing
`f"llm_model_{report_type}"` convention ([reports.py:352](backend/routes/reports.py#L352)).

**Resolution logic** — replicate [reports.py:352-375](backend/routes/reports.py#L352) in the compare
endpoint:

```python
raw_override = get_setting("llm_model_report_compare", "")
provider_override, model_override = (
    raw_override.split(":", 1) if ":" in raw_override else (None, raw_override or None)
)
raw, model_used, pt, ct = await asyncio.to_thread(
    partial(call_llm, user_prompt, system_prompt,
            model=model_override, use_fallback=True,
            _primary_provider_override=provider_override)
)
```

Caveat worth knowing: when `_primary_provider_override` is set, `call_llm` takes credentials from
**env vars only** ([analysis.py:576-583](backend/analysis.py#L576)) — the DB `llm_api_key` /
`llm_base_url` belong to the primary provider. Also note `llm_reasoning_effort` is global-only;
there is no per-feature reasoning effort, and this plan does not add one.

**Wiring** — five touch points, each mirroring the four existing report keys:

| Where | Change |
|---|---|
| [settings.py:73-84](backend/routes/settings.py#L73) | new `llm_model_report_compare` field on `LLMSettingRequest` |
| [settings.py:465-470](backend/routes/settings.py#L465) | add the key to the persist-loop tuple |
| [settings.py:364-368](backend/routes/settings.py#L364) | return it from `GET /settings` |
| [SettingsPage.jsx:1501-1504](frontend/src/pages/SettingsPage.jsx#L1501), `:1856-1859`, `:1895-1898`, `:2754-2757` | new state var, hydrate, POST body field, and a fifth row in the "Report models" mapped array |
| [docs/wiki/settings.md:40-56](docs/wiki/settings.md#L40) | add a row to the per-report model override table |

The control is the same `<select className="settings-select">` as the other four, with the same
`""` = "— same as primary model —" default. Label it "Report Compare" and place it directly after
the four report rows in the existing **Report models** section
([SettingsPage.jsx:2743-2802](frontend/src/pages/SettingsPage.jsx#L2743)) — no new settings section.

This matters more here than for a normal report: the comparator is the one place where a stronger
reasoning model is worth the tokens, so the user should be able to point it at a deeper model than
the nightly EoD digests use.

> Range reports (Step 1b) get **one** shared key, `llm_model_range`, rather than one per period —
> eight more dropdowns would bloat the Settings section for no real gain.

---

## Step 5 — Frontend ([frontend/src/pages/ReportsPage.jsx](frontend/src/pages/ReportsPage.jsx))

Mirror [BacktestPage.jsx](frontend/src/pages/BacktestPage.jsx) throughout:

- **State** — `compareSel` as a `Set` of report ids (`BacktestPage.jsx:166`), capped at 2. A
  `useEffect` clears the LLM verdict whenever the selection changes (`:170`).
- **Checkbox** in each `HistoryList` card ([ReportsPage.jsx:740-797](frontend/src/pages/ReportsPage.jsx#L740))
  with `e.stopPropagation()` so ticking doesn't also open the report (`BacktestPage.jsx:1815`).
  Disable unticked boxes at 2 selected, and disable/annotate cards whose `type` differs from the
  first pick — surfacing the same-type rule in the UI instead of only as a 409. The Orders tab holds
  both `eod_orders` and `weekly_orders`, so the tab alone does not guarantee matching types.
- **Delete** must drop the id from `compareSel` (`BacktestPage.jsx:408`).
- **Comparison panel** replaces the viewer when 2 are selected, in this order: delta stat tiles →
  "what moved" chart → per-day overlay (weekly only) → metric delta table (A, B, Δ, %Δ with up/down
  colour driven by `higher_is_better`) → config delta table → review button. When `config_available`
  is false, render an inline note that the snapshot predates tuning capture.
- **Review button** — `'⏳ Analysing…'` / `'🧠 Get trading-master review'`, styled `btn-primary btn-sm`
  (`BacktestPage.jsx:2056`). The verdict renders as:
  - a **comparability badge** first (full / partial / none + reasons), so the caveat is read before
    the conclusions — mirroring `BacktestPage.jsx:2079-2116`;
  - **good / bad / improve** sections, where each `improve` item is a structured row
    (setting · current → proposed · expected effect · confidence), not a prose blob;
  - a `model_used` + total-token footer (`:2117`) — which will show the
    `llm_model_report_compare` override when one is set.
- Reuse `fmtPct` / `fmtNum` from `../utils/fmt` — do not write new formatters.

Add a `report_compare` zero-state card to
[frontend/src/pages/UsageSection.jsx:271](frontend/src/pages/UsageSection.jsx#L271) (the populated
cards already render generically from `by_source`).

---

## Step 5b — Diagrams

Charts are Recharts, matching the existing `ReportCharts`
([ReportsPage.jsx:181](frontend/src/pages/ReportsPage.jsx#L181)).

### Palette — validated, do not eyeball or substitute

The app is **dark-only** (no theme toggle, no `prefers-color-scheme` rule), so only the dark surface
needs validating. Both pairs below were run through the dataviz validator and pass every check:

| Role | Colours | Result |
|---|---|---|
| **A / B series identity** (categorical) | A `#2563eb` blue · B `#d97706` amber | all pass — CVD deutan/protan ΔE 32.3, tritan 29.3 |
| **Improve / regress** (diverging) | improve `#0d9488` teal-600 · regress `#e11d48` rose-600 · neutral gray midpoint | all pass — deutan ΔE 10.2 (above the ≥8 target) |

Two things this encodes deliberately:

- **A/B are blue/amber, not green/red.** Green and red are *reserved* for improve/regress polarity
  here; painting "report B" green would collide with "green = improved".
- **The existing `CHART_GREEN #4ade80` / `CHART_RED #f87171`
  ([ReportsPage.jsx:66-68](frontend/src/pages/ReportsPage.jsx#L66)) FAIL validation** — deutan ΔE 7.9
  and both outside the lightness band. Red-green is the classic deuteranopia failure (~8% of men).
  Do **not** reuse them for the new charts. Leave the existing `ReportCharts` alone (out of scope);
  define the validated constants alongside them for the comparator.

Re-run before shipping if any colour changes:
`node scripts/validate_palette.js "<hex,hex>" --mode dark` from the dataviz skill directory.

### Diagram 1 — "What moved" diverging bar (the headline)

The data's job is **polarity plus magnitude ranking**, which is exactly a horizontal diverging bar:
one bar per metric, centred on a zero axis, right/teal = improved, left/rose = regressed. This is
the literal answer to the backlog's question — "is performance improving or regressing, and on
which metrics."

- **Polarity must be normalised by `higher_is_better`, not by the raw sign of Δ.** A fall in
  `losses`, `budget_cap_hits` or `position_cap_hits` is an *improvement* and must point right/teal.
  Getting this backwards makes the chart assert the opposite of the truth — this is the single
  highest-risk detail in the whole feature.
- Exclude rows where `higher_is_better` is `null` (directionless — `open_positions`, `notional_open`,
  `signals_count`) or `pct_delta` is `null` (A-side was zero). They stay in the table, just not here.
- Sort by `|pct_delta|` descending so the biggest movers read first.
- **Secondary encoding is required** (and also covers the CVD guidance): bar direction, a ▲/▼ glyph,
  and a direct value label per bar. Identity is never colour-alone.
- Single series → no legend (the title names it); direct labels, not a number on every gridline.

### Diagram 2 — Per-period overlay (two comparable multi-day reports)

Job is **change over time**: two lines, A and B, on a shared **bucket-index** axis rather than
calendar dates — aligning the two periods is the entire point. This is the direct analogue of the
Backtest comparator's overlaid R curves
([BacktestPage.jsx:369-383](frontend/src/pages/BacktestPage.jsx#L369), rendered `:2009-2053`); reuse
that layout.

- Source: `signals_by_day` (both modes), plus `bracket_by_day.pnl` (orders) or `frac_by_day.pnl` (frac).
- Axis labels follow `bucket_granularity` from Step 1b (day / week / month).
- **One axis per chart — never a dual axis.** P&L in dollars and signal counts are different scales,
  so they are **two stacked charts**, not one chart with two y-axes. (The dataviz skill flags
  dual-axis as the #1 charting mistake.)
- 2 series → legend always present, plus direct labels at the line ends.
- Crosshair + shared tooltip, the default hover layer for line/area.
- Render only when both reports carry bucket data. EoD reports have none — hide the card entirely
  rather than drawing an empty axis.

### Diagram 3 — Delta stat tiles (deliberately not a chart)

The three headline deltas (P&L, win rate, closed trades) are single numbers, so they get a KPI row,
not a plot. Reuse the existing `StatPill` ([ReportsPage.jsx:207](frontend/src/pages/ReportsPage.jsx#L207))
for visual consistency: B's value large, the Δ beneath it, coloured by the validated diverging pair.

### Explicitly not charted

- **A-vs-B paired magnitude bars** — the delta table already gives exact A, B, Δ, %Δ. Plotting
  metrics with incompatible units ($, %, counts) together would require either a forbidden dual axis
  or a meaningless normalisation.
- **Config deltas** — categorical key→value changes. A table is the right form.

### Mark specs

4px rounded data-ends anchored to the zero baseline, 2px lines, ≥8px markers, a 2px surface gap
between adjacent bars, recessive grid and axes, and text in the existing text tokens — never in the
series colour.

---

## Step 6 — Documentation and screenshots

- [docs/wiki/reports.md](docs/wiki/reports.md) — a comparator section covering both layers, the
  same-type rule, the comparability grades and what each means, the range-report periods, and the
  "reports generated before this release have no config snapshot" caveat.
- [docs/wiki/settings.md:40-56](docs/wiki/settings.md#L40) — add `llm_model_report_compare` and
  `llm_model_range` to the per-report model override table.
- [docs/wiki/api.md](docs/wiki/api.md) — document `GET /reports/range`, `GET /reports/compare` and
  `POST /reports/compare/review`.
- [docs/wiki/backtesting.md:411](docs/wiki/backtesting.md#L411) — add `report_compare` to the AI Usage
  sources table.
- **Screenshot refresh** — `docs/screenshots/20-reports.png` is now stale (checkboxes, range
  controls, comparison panel, charts). Recapture it; capture is manual, there is no script. Consider
  a second shot of the comparison panel itself, since the diagrams are the feature's most visual part.

---

## Verification

1. **Prerequisite** — generate a fresh report (`GET /reports/eod/frac`), then confirm its
   `context_json` contains a `tuning` object with the frac knobs and *not* `PAPER_MAX_POSITIONS`.
2. **Range reports** — the truncation bug is the thing to prove fixed:
   - Seed (or find) a window with **more than 500** signals/orders and run a yearly report; confirm
     the totals match a direct SQL `COUNT`/`SUM` over the same window. This is the regression the
     old `limit=500` path would silently fail.
   - Confirm the all-time economics figures did **not** change meaning versus a pre-change report.
   - Check bucketing flips day → week → month at the 31-day and 1-year boundaries.
   - Confirm validation rejects `start > end`, a future `end`, and a span beyond 3 years.
3. **Layer 1 happy path** — two same-type reports return metric rows with correct Δ/%Δ; verify
   `pct_delta` is `null` (not `Infinity`) when the A-side value is `0`, and that changing a setting
   between two report generations shows up in the config delta table.
4. **Rejections** — mismatched types → `409`; unknown id → `404`; a report with
   `context_json IS NULL` → `422`; two custom reports with very different spans → comparability `none`.
5. **Layer 2** — the review returns populated good / bad / improve sections with concrete proposed
   values, scoped to the right flow. Confirm a new `report_compares` row, and that Settings → AI
   Usage shows a "Report Compare" source with non-zero tokens. Specifically check strictness:
   - Compare two reports with very few closed trades and confirm the verdict leads with the
     `partial`/`none` comparability caveat instead of narrating noise as a trend.
   - Confirm a **frac** comparison never suggests `PAPER_MAX_POSITIONS` (and vice versa) — the
     schema should reject it before it reaches the user.
   - Compare two reports with **no** tuning snapshot and confirm the review makes no causal claims.
6. **Model override** — set Settings → Report models → Report Compare to a non-primary
   `provider:model`, re-run a review, and confirm the footer reports that model and AI Usage
   attributes the tokens to it. Then clear it and confirm it falls back to the primary.
7. **UI end-to-end** — run the app (`make up` / the `run` skill), open Reports, run a monthly report,
   tick two same-type reports, confirm the delta tables render with correct up/down colouring, run
   the review, then delete one selected report and confirm the panel clears without error. Verify on
   mobile width too.
8. **Charts** — the validator checks colour, not layout, so **render and look at them**:
   - Find (or construct) a pair where `losses` fell and confirm that bar points **right and teal** —
     the `higher_is_better` inversion is the likeliest thing to get backwards.
   - Confirm directionless metrics (`signals_count`, `open_positions`) are absent from the diverging
     chart but still present in the table.
   - Compare two **EoD** reports and confirm the overlay card is hidden, not empty.
   - Eyeball for label collisions and overflow at desktop and mobile width.
9. **Smoke tests** — add a section to `tests/smoke/` covering the diff maths (zero-division, `None`
   win rate), the `higher_is_better` polarity inversion, the date-scoped queries returning >500 rows,
   the 409/422 rejections, and missing-tuning degradation.
10. **Lint** — run `make lint` **once at the end**, after all edits. Ask before running it.

---

## Commits plan

Implement everything first, then run `make lint` **once** at the end and fix any fallout. Only then
lay down the commits — the sequence below is close to file-disjoint, so stage per commit by path.

For **every** commit: stage explicitly by path, show `git diff --stat`, and **ask before running
`git commit`**. No `Co-Authored-By` trailer on any of them.

| # | Commit | Scope |
|---|---|---|
| 1 | `docs: mark backlog items 6 and 8 as shipped` | `BACKLOG.md` + this plan file. Lands first so the branch starts from a truthful backlog. |
| 2 | `feat(reports): persist tuning snapshot into context_json` | Step 1. Small and isolated, but blocks everything else — config deltas are impossible without it. |
| 3 | `fix(reports): scope report queries by date in SQL` | Step 1b's blocker. A standalone correctness fix that also repairs existing EoD/weekly, shipped *before* anything depends on it. |
| 4 | `feat(reports): on-demand range reports` | Step 1b backend — periods, `GET /reports/range`, the two range prompts, adaptive bucketing, validation, `llm_model_range`. |
| 5 | `feat(reports): range report UI` | Step 1b frontend — preset buttons and custom date pickers. |
| 6 | `feat(reports): deterministic comparator API` | Step 2 (`get_report_record`, `report_compares` table, token union arm, purge) + Step 3 (`GET /reports/compare`). No LLM yet. |
| 7 | `feat(reports): trading-master review for comparisons` | Step 4 (comparability gate, full-snapshot payload, prompts, schema, `POST /reports/compare/review`) + Step 4b (`llm_model_report_compare` and its Settings wiring). |
| 8 | `feat(reports): comparator UI with delta tables and charts` | Step 5 + Step 5b — checkboxes, delta tables, the validated palette, both diagrams. |
| 9 | `test: smoke coverage for comparator and range reports` | The test section from Verification. |
| 10 | `docs: document comparator and range reports` | Step 6 — wiki pages, settings table, API docs, refreshed screenshots. |

Rationale for the ordering: commits 2 and 3 are prerequisites that stand on their own and are worth
reviewing in isolation; 4–5 deliver range reports end-to-end; 6–8 deliver the comparator in
deterministic-then-LLM-then-UI order so each is independently testable; 9–10 close out.

If review feedback lands mid-sequence, fix it as a **new** commit rather than amending — several of
these will already be pushed.
