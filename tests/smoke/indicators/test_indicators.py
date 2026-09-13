"""Section 6 — compute_indicators with mocked yfinance (no network)."""

from __future__ import annotations

from unittest import mock


def test_compute_indicators(check):
    # --------------------------------------------------------------------------- #
    # 6. compute_indicators with mocked yfinance (no network)
    # --------------------------------------------------------------------------- #
    _n = 300  # enough bars for EMA200
    _idx = list(range(_n))
    _price = [100.0 + i * 0.01 for i in _idx]
    _fake_ohlcv = {
        "Open": _price,
        "High": [p + 0.5 for p in _price],
        "Low": [p - 0.5 for p in _price],
        "Close": _price,
        "Volume": [1_000_000] * _n,
    }

    try:
        import pandas as pd

        _fake_df = pd.DataFrame(_fake_ohlcv)
        _fake_df.index = pd.date_range("2024-01-01", periods=_n, freq="1h")

        with mock.patch("yfinance.download", return_value=_fake_df):
            from backend.data import compute_indicators, fetch_finnhub_news

            ind = compute_indicators("TEST")

        check(
            "compute_indicators returns all three timeframes",
            set(ind.get("technicals", {}).keys()) >= {"1H", "4H", "1D"},
            detail=str(list(ind.get("technicals", {}).keys())),
        )
        tf_1h = (ind.get("technicals") or {}).get("1H") or {}
        check(
            "compute_indicators 1H has RSI and recommendation",
            tf_1h.get("RSI") is not None and tf_1h.get("recommendation") is not None,
            detail=str(tf_1h),
        )
        check(
            "fetch_finnhub_news returns [] when no key set",
            fetch_finnhub_news("TEST", "") == [],
        )
        # New: news returns List[Dict] when key is set
        fake_article = {
            "headline": "Test Co beats estimates",
            "source": "Reuters",
            "url": "https://example.com/1",
            "datetime": 1700000000,
            "summary": "extra field — should be ignored",
        }
        fake_client = mock.MagicMock()
        fake_client.company_news.return_value = [fake_article]
        with mock.patch("finnhub.Client", return_value=fake_client):
            news_result = fetch_finnhub_news("TEST", "fake_key_123")
        check(
            "fetch_finnhub_news returns List[Dict] with key set",
            isinstance(news_result, list)
            and len(news_result) == 1
            and isinstance(news_result[0], dict)
            and news_result[0].get("headline") == "Test Co beats estimates"
            and news_result[0].get("source") == "Reuters"
            and news_result[0].get("datetime") == 1700000000,
            detail=str(news_result),
        )
    except Exception as exc:  # pragma: no cover
        check("compute_indicators smoke", False, repr(exc))
        check("compute_indicators 1H has RSI and recommendation", False)
        check("fetch_finnhub_news returns [] when no key set", False)
        check("fetch_finnhub_news returns List[Dict] with key set", False)
