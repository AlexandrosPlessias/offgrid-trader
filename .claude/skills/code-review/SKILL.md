---
name: code-review
description: Use when reviewing changes in offgrid-trader (pull requests, staged work, or a feature branch before merge) to produce context-aware findings about correctness, security, and the project's FastAPI/React conventions.
---

# Code Review — offgrid-trader

Review changes against how this repository is actually built, not against generic
style rules. Report only high-confidence findings, each with a severity
(`critical` / `important` / `minor`), the file and line, and a concrete fix.

## When to use

- Reviewing a pull request before merge.
- Self-reviewing a branch before pushing.
- Re-checking a change after CodeQL or reviewer feedback.

## Repository map

| Area | Path | Notes |
| --- | --- | --- |
| FastAPI app | `backend/main.py`, `backend/routes/` | One router module per domain; shared helpers live in `backend/routes/_models.py`. |
| Domain logic | `backend/analysis.py`, `backend/data.py`, `backend/discovery.py`, `backend/opportunities.py`, `backend/skills/` | Keep HTTP concerns out of these modules. |
| Persistence | `backend/database.py` | SQLite; settings go through `get_setting` / `set_setting`. |
| Background jobs | `backend/scheduler.py` | Scan loop, paper-order sync, discovery runs. |
| External APIs | `backend/alpaca.py` | URL/ID validation lives here — treat it as a security boundary. |
| Frontend | `frontend/src/pages/`, `frontend/src/components/`, `frontend/src/hooks/` | React 18 + Vite, plain CSS variables, no UI framework. |
| Smoke tests | `tests/smoke/<domain>/` | Pytest functions that take the `check` fixture from `tests/smoke/conftest.py`. |
| Workflows | `.github/workflows/` | Deploy (Fly.io + Vercel), scheduled app power, CodeQL. |

## Review checklist

**Critical**

- *Injection & untrusted input*: user-supplied tickers, source lists, order IDs and
  IDs embedded in URLs must be validated (`_clean_ticker`, `uuid.UUID(...)`,
  allow-lists) before they reach HTTP calls, SQL, or the shell.
- *Logging*: never log raw user input — wrap it with `_log_safe()` so CR/LF cannot
  forge log entries.
- *Exception exposure*: API responses and SSE frames must not leak stack traces or
  upstream error bodies; log the detail and return a generic message.
- *GitHub Actions*: never interpolate `${{ inputs.* }}` / `${{ github.event.* }}`
  into `run:` scripts — pass values through `env:` and quote the shell variable.
- *Secrets*: no API keys, tokens, or account IDs in code, tests, or committed config.

**Important**

- *Money and orders*: quantity, price rounding, and P&L must match Alpaca
  semantics. Distinguish opening bracket orders from close orders before
  computing `realized_pnl`, and only submit quantities Alpaca reports as
  available.
- *Caching*: every cache key must include all inputs that change the result
  (sources, limits, ticker, window), otherwise one caller poisons another.
- *Return-shape changes*: when a `backend/database.py` helper changes shape
  (for example `(rows, total)`), update every call site including smoke tests.
- *SSE streams*: frontend hooks must handle `step`, `retry`, `result` **and**
  `error` frames; an unhandled `error` leaves the UI stuck in an idle state.
- *Settings*: values persisted through `set_setting` are consumed later by the
  scheduler — validate them at write time, not only in the UI.

**Minor**

- *Accessibility*: icon-only buttons need an explicit `aria-label`; `title`
  alone is not a reliable accessible name.
- *Consistency*: reuse existing helpers instead of re-implementing them; follow
  the surrounding comment and naming style.
- *Dead code*: unused imports and locals are flagged by CodeQL — remove them.

## Workflow

1. Scope the change:
   - `git --no-pager diff --stat main...HEAD`
   - `git --no-pager diff main...HEAD`
2. For each changed file, walk the checklist above, starting with the area the
   file belongs to in the repository map.
3. Trace user input end-to-end: route handler → validation helper → domain
   module → external call / SQL / log.
4. Check the tests: behaviour changes in `backend/` should have a matching
   smoke test under `tests/smoke/<domain>/`.
5. Verify locally when the change is non-trivial:
   - `make lint` (ruff + flake8 + black --check + pytest on the host)
   - `python -m pytest tests/smoke -q`
   - `npm --prefix frontend run build`
6. Report findings grouped by severity. Skip formatting nitpicks, and say
   explicitly when a suspected issue turns out to be safe.

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- `SETUP.md` — local environment and tooling
- `USAGE.md` — end-user behaviour the UI changes must preserve
