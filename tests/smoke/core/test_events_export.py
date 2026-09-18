"""Event log + data/config export smoke tests (no network, no real LLM)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import app


def test_events_and_export(check):
    from backend.database import export_app_settings, get_events, save_event, set_setting

    client = TestClient(app)

    # --- event log roundtrip ---
    save_event("scan", "smoke test event", meta={"k": "v"})
    events = get_events(limit=20)
    found = next((e for e in events if e["message"] == "smoke test event"), None)
    check("get_events returns the saved event", found is not None)
    check("event meta decoded to dict", isinstance((found or {}).get("meta"), dict))

    r = client.get("/events?limit=5")
    check("GET /events 200", r.status_code == 200, detail=str(r.status_code))
    check("GET /events shape", "events" in r.json())

    r = client.get("/events?category=scan&limit=5")
    check("GET /events category filter 200", r.status_code == 200, detail=str(r.status_code))

    # --- config export redacts secrets, keeps non-secrets ---
    set_setting("telegram_bot_token", "SECRET123")
    set_setting("__smoke_export_probe", "kept")
    cfg = export_app_settings(redact_secrets=True)
    raw_cfg = export_app_settings(redact_secrets=False)
    check("secret key redacted", cfg.get("telegram_bot_token") == "__REDACTED__")
    check("non-secret key preserved", cfg.get("__smoke_export_probe") == "kept")
    check("raw (unredacted) exposes the secret", raw_cfg.get("telegram_bot_token") == "SECRET123")
    # Clean up shared temp-DB state so later tests are unaffected.
    set_setting("telegram_bot_token", "")
    set_setting("__smoke_export_probe", "")

    r = client.get("/settings/export")
    check(
        "GET /settings/export 200 + shape",
        r.status_code == 200 and "settings" in r.json(),
        detail=str(r.status_code),
    )

    # --- data export shape ---
    r = client.get("/data/export")
    d = r.json()
    check("GET /data/export 200", r.status_code == 200, detail=str(r.status_code))
    check(
        "data export carries the expected top-level keys",
        all(k in d for k in ("signals", "paper_orders", "frac_positions", "discovery_runs")),
    )
