"""LLM connectivity smoke test — tests every configured provider.

Reads credentials from the environment (or .env with --env) and runs a
minimal JSON-mode prompt against each provider that has credentials present.
Providers tested:
  - ollama      always tested (no key needed; skipped if unreachable)
  - groq        tested when GROQ_API_KEY is set
  - custom      tested when LLM_BASE_URL + LLM_MODEL are set

HOW TO RUN
----------
Use the project venv (has openai + all backend deps already):

    .venv/bin/python3 tests/smoke/llm_connectivity.py

The .env at the project root is loaded automatically.
The venv is created by: make lint   (or bash tests/lint/dev_check.sh)

Or install openai system-wide and run directly:

    pip3 install "openai>=1.30,<2.0"
    python3 tests/smoke/llm_connectivity.py

Exits 0 if every tested provider passes, 1 if any fails.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Minimal prompt
# ---------------------------------------------------------------------------
_SYSTEM = "You are a concise assistant. Always reply with valid JSON only."
_USER = (
    "Reply with exactly this JSON and nothing else: " '{"status": "ok", "provider": "<your name>"}'
)

_PROVIDER_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
}
_PROVIDER_DEFAULT_MODELS = {
    "groq": "llama-3.3-70b-versatile",
}

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
NC = "\033[0m"


def _ok(msg: str) -> None:
    print(f"{GREEN}  ✓ {msg}{NC}")


def _fail(msg: str) -> None:
    print(f"{RED}  ✗ {msg}{NC}")


def _info(msg: str) -> None:
    print(f"{CYAN}  → {msg}{NC}")


def _hdr(msg: str) -> None:
    print(f"\n{BOLD}{CYAN}── {msg} ──{NC}")


# ---------------------------------------------------------------------------
# .env loader — strips inline comments, never overrides real env vars
# ---------------------------------------------------------------------------
def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.split("#")[0].strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


# ---------------------------------------------------------------------------
# Provider test functions
# ---------------------------------------------------------------------------
def _test_ollama(host: str, model: str, timeout: int) -> tuple[bool, str]:
    import urllib.request

    url = f"{host.rstrip('/')}/api/chat"
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": _USER},
            ],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.0},
        }
    ).encode()

    req = urllib.request.Request(  # noqa: S310
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            body = json.loads(resp.read())
        content = body.get("message", {}).get("content", "")
        parsed = json.loads(content)
        said = parsed.get("provider")
        return True, f"status={parsed.get('status')!r}  model_said_provider={said!r}"
    except urllib.error.URLError as exc:
        return False, f"Cannot reach Ollama at {host}: {exc.reason}"
    except TimeoutError:
        return False, f"Timed out after {timeout}s (model may still be loading)"
    except json.JSONDecodeError as exc:
        return False, f"Response is not valid JSON: {exc}"


def _test_cloud(
    provider: str, api_key: str, base_url: str, model: str, timeout: int
) -> tuple[bool, str]:
    try:
        import openai
    except ImportError:
        return False, "openai package not installed — run: pip install openai"

    client = openai.OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": _USER},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        content = completion.choices[0].message.content or ""
        parsed = json.loads(content)
        tokens_in = getattr(completion.usage, "prompt_tokens", "?")
        tokens_out = getattr(completion.usage, "completion_tokens", "?")
        return (
            True,
            f"status={parsed.get('status')!r}  tokens={tokens_in}→{tokens_out}",
        )
    except openai.APIConnectionError as exc:
        return False, f"Cannot reach {provider} ({base_url}): {exc}"
    except openai.APITimeoutError:
        return False, f"Timed out after {timeout}s"
    except openai.APIStatusError as exc:
        return False, f"HTTP {exc.status_code}: {exc.message}"
    except json.JSONDecodeError as exc:
        return False, f"Response is not valid JSON: {exc}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    root = Path(__file__).parent.parent.parent
    _load_dotenv(root / ".env")
    _info(f"Config from {root / '.env'}")

    cloud_timeout = int(os.getenv("CLOUD_LLM_TIMEOUT", "60"))

    # ── Collect providers to test ────────────────────────────────────────────
    # Each entry: (label, fn, *args)
    tests: list[tuple[str, dict[str, str]]] = []

    # Ollama — always add (report skip if unreachable, not a hard failure)
    tests.append(
        (
            "ollama",
            {
                "host": os.getenv("OLLAMA_HOST", "http://localhost:11434"),
                "model": os.getenv("OLLAMA_MODEL", "qwen2.5:14b"),
                "timeout": os.getenv("OLLAMA_TIMEOUT", "120"),
            },
        )
    )

    # Groq — only if key is present
    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        tests.append(
            (
                "groq",
                {
                    "api_key": groq_key,
                    "base_url": _PROVIDER_BASE_URLS["groq"],
                    "model": os.getenv("GROQ_MODEL") or _PROVIDER_DEFAULT_MODELS["groq"],
                    "timeout": str(cloud_timeout),
                },
            )
        )

    # Custom — only if base URL + model are set
    custom_url = os.getenv("LLM_BASE_URL", "")
    custom_model = os.getenv("LLM_MODEL", "")
    if custom_url and custom_model:
        tests.append(
            (
                "custom",
                {
                    "api_key": os.getenv("LLM_API_KEY", ""),
                    "base_url": custom_url,
                    "model": custom_model,
                    "timeout": str(cloud_timeout),
                },
            )
        )

    print(f"\n{BOLD}══ LLM connectivity smoke test ══{NC}")
    print(f"  Providers to test: {', '.join(t[0] for t in tests)}\n")

    # ── Run each provider ────────────────────────────────────────────────────
    results: list[tuple[str, bool, str, float]] = []

    for provider, cfg in tests:
        _hdr(provider.upper())
        t0 = time.monotonic()

        if provider == "ollama":
            print(f"  {DIM}host={cfg['host']}  model={cfg['model']}{NC}")
            success, detail = _test_ollama(cfg["host"], cfg["model"], int(cfg["timeout"]))
        else:
            print(f"  {DIM}base_url={cfg['base_url']}  model={cfg['model']}{NC}")
            success, detail = _test_cloud(
                provider,
                cfg["api_key"],
                cfg["base_url"],
                cfg["model"],
                int(cfg["timeout"]),
            )

        elapsed = time.monotonic() - t0
        if success:
            _ok(f"{elapsed:.1f}s — {detail}")
        else:
            _fail(f"{elapsed:.1f}s — {detail}")
        results.append((provider, success, detail, elapsed))

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{BOLD}══ Summary ══{NC}")
    all_passed = True
    for provider, success, _, elapsed in results:
        if success:
            print(f"  {GREEN}✓{NC}  {BOLD}{provider:<12}{NC}  {elapsed:.1f}s")
        else:
            print(f"  {RED}✗{NC}  {BOLD}{provider:<12}{NC}  {elapsed:.1f}s")
            all_passed = False

    print()
    if all_passed:
        print(f"{GREEN}{BOLD}  All providers OK ✓{NC}\n")
        return 0
    else:
        failed = [p for p, s, _, __ in results if not s]
        print(f"{RED}{BOLD}  Failed: {', '.join(failed)}{NC}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
