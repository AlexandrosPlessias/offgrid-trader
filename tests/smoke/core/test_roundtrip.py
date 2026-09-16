"""Round-trip test-notification token flow: single-use, TTL-bound, auth-exempt confirm."""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import app


def test_roundtrip_confirm(check):
    print("\n[roundtrip] test-notification confirm token flow")
    try:
        from backend.main import _UNPROTECTED_PATHS
        from backend.routes.notifications import _roundtrip_status, new_roundtrip_token

        client = TestClient(app)
        token = new_roundtrip_token()
        check("token starts pending", _roundtrip_status(token) == "pending")

        # Confirm needs no auth — the token is the proof (POST = ntfy http action).
        r = client.post(f"/notifications/test/confirm?token={token}")
        check(
            "confirm via POST succeeds (no auth)", r.status_code == 200, detail=str(r.status_code)
        )
        check("token confirmed after tap", _roundtrip_status(token) == "confirmed")

        # GET works too — a Telegram URL button opens it in a browser.
        t2 = new_roundtrip_token()
        r = client.get(f"/notifications/test/confirm?token={t2}")
        check("confirm via GET succeeds", r.status_code == 200, detail=str(r.status_code))
        check("second token confirmed", _roundtrip_status(t2) == "confirmed")

        # Unknown token is not confirmable → 410.
        r = client.post("/notifications/test/confirm?token=deadbeefdeadbeef")
        check("confirm of unknown token → 410", r.status_code == 410, detail=str(r.status_code))
        check("unknown token reports expired", _roundtrip_status("deadbeefdeadbeef") == "expired")

        check(
            "confirm endpoint is auth-exempt",
            "/notifications/test/confirm" in _UNPROTECTED_PATHS,
        )
        check(
            "status endpoint stays token-guarded (not exempt)",
            "/notifications/test/status" not in _UNPROTECTED_PATHS,
        )

    except Exception:
        import traceback as _tb

        check("roundtrip smoke", False, _tb.format_exc()[-400:])
