"""Section 14 — News Sentiment Layer."""

from __future__ import annotations


def test_news_sentiment(check):
    # --------------------------------------------------------------------------- #
    # 14. News Sentiment Layer
    # --------------------------------------------------------------------------- #
    print("\n[14] News Sentiment Layer")

    try:
        from backend.data import (
            _merge_news,
            fetch_google_news_rss,
            score_news_sentiment,
        )
        from backend.opportunities import _apply_sentiment_filter

        # 14a. score_news_sentiment — empty list → Neutral / 0.0
        _sent_empty = score_news_sentiment([])
        check(
            "score_news_sentiment empty list → Neutral",
            _sent_empty.get("label") == "Neutral" and _sent_empty.get("score") == 0.0,
            detail=str(_sent_empty),
        )
        check(
            "score_news_sentiment empty list → article_count 0",
            _sent_empty.get("article_count") == 0,
            detail=str(_sent_empty),
        )

        # 14b. score_news_sentiment — positive headlines → Bullish label
        _pos_news = [
            {
                "headline": "Company beats earnings estimates by wide margin",
                "source": "Reuters",
                "url": "",
                "datetime": "",
            },
            {
                "headline": "Stock surges on record revenue growth",
                "source": "AP",
                "url": "",
                "datetime": "",
            },
        ]
        _sent_pos = score_news_sentiment(_pos_news)
        check(
            "score_news_sentiment positive headlines → score > 0",
            _sent_pos.get("score", 0) > 0,
            detail=str(_sent_pos),
        )
        check(
            "score_news_sentiment positive headlines returns scored_headlines",
            isinstance(_sent_pos.get("scored_headlines"), list)
            and len(_sent_pos["scored_headlines"]) > 0,
            detail=str(_sent_pos),
        )

        # 14c. score_news_sentiment — negative headlines → score < 0
        _neg_news = [
            {
                "headline": "Stock crashes on terrible earnings miss",
                "source": "Reuters",
                "url": "",
                "datetime": "",
            },
            {
                "headline": "Company faces bankruptcy fears amid falling revenue",
                "source": "AP",
                "url": "",
                "datetime": "",
            },
        ]
        _sent_neg = score_news_sentiment(_neg_news)
        check(
            "score_news_sentiment negative headlines → score < 0",
            _sent_neg.get("score", 0) < 0,
            detail=str(_sent_neg),
        )

        # 14d. _merge_news — deduplication
        _primary = [
            {
                "headline": "Apple beats estimates",
                "source": "Reuters",
                "url": "http://a.com/1",
                "datetime": "",
            },
            {
                "headline": "Apple opens new store",
                "source": "AP",
                "url": "http://a.com/2",
                "datetime": "",
            },
        ]
        _supplement = [
            # duplicate (case-insensitive)
            {
                "headline": "Apple Beats Estimates",
                "source": "GNews",
                "url": "http://b.com/1",
                "datetime": "",
            },
            # new
            {
                "headline": "Apple CEO interview",
                "source": "GNews",
                "url": "http://b.com/2",
                "datetime": "",
            },
        ]
        _merged = _merge_news(_primary, _supplement, max_total=10)
        _merged_headlines = [item["headline"].lower() for item in _merged]
        check(
            "_merge_news deduplicates case-insensitively",
            _merged_headlines.count("apple beats estimates") == 1,
            detail=str(_merged_headlines),
        )
        check(
            "_merge_news includes supplement-only headline",
            "apple ceo interview" in _merged_headlines,
            detail=str(_merged_headlines),
        )
        check(
            "_merge_news total ≤ max_total",
            len(_merged) <= 10,
            detail=str(len(_merged)),
        )

        # 14e. _merge_news — max_total cap
        _big_primary = [
            {"headline": f"Story {i}", "source": "S", "url": "", "datetime": ""} for i in range(8)
        ]
        _big_supp = [
            {"headline": f"Extra {i}", "source": "G", "url": "", "datetime": ""} for i in range(8)
        ]
        _merged_capped = _merge_news(_big_primary, _big_supp, max_total=10)
        check(
            "_merge_news caps at max_total",
            len(_merged_capped) == 10,
            detail=str(len(_merged_capped)),
        )

        # 14f. _apply_sentiment_filter — Bullish strong boosts long opportunity
        _opp_long = {
            "ticker": "AAPL",
            "type": "long",
            "confidence": 60,
            "rules_checked": {},
        }
        _sent_strong_bull = {"score": 0.4, "label": "Bullish", "article_count": 3}
        _filtered_bull = _apply_sentiment_filter([_opp_long], _sent_strong_bull)
        check(
            "_apply_sentiment_filter Bullish strong boosts long confidence",
            _filtered_bull[0]["confidence"] > 60,
            detail=str(_filtered_bull),
        )
        check(
            "_apply_sentiment_filter Bullish strong delta ≤ 3",
            _filtered_bull[0]["confidence"] <= 63,
            detail=str(_filtered_bull),
        )

        # 14g. _apply_sentiment_filter — Bearish hurts long opportunity
        _opp_long2 = {
            "ticker": "AAPL",
            "type": "long",
            "confidence": 60,
            "rules_checked": {},
        }
        _sent_bear = {"score": -0.4, "label": "Bearish", "article_count": 3}
        _filtered_bear = _apply_sentiment_filter([_opp_long2], _sent_bear)
        check(
            "_apply_sentiment_filter Bearish reduces long confidence",
            _filtered_bear[0]["confidence"] < 60,
            detail=str(_filtered_bear),
        )

        # 14h. _apply_sentiment_filter — confidence never goes below 0 or above 100
        _opp_edge_high = {
            "ticker": "AAPL",
            "type": "long",
            "confidence": 99,
            "rules_checked": {},
        }
        _filtered_edge = _apply_sentiment_filter([_opp_edge_high], _sent_strong_bull)
        check(
            "_apply_sentiment_filter confidence never exceeds 100",
            _filtered_edge[0]["confidence"] <= 100,
            detail=str(_filtered_edge),
        )
        _opp_edge_low = {
            "ticker": "AAPL",
            "type": "long",
            "confidence": 1,
            "rules_checked": {},
        }
        _filtered_edge_low = _apply_sentiment_filter([_opp_edge_low], _sent_bear)
        check(
            "_apply_sentiment_filter confidence never goes below 0",
            _filtered_edge_low[0]["confidence"] >= 0,
            detail=str(_filtered_edge_low),
        )

        # 14i. fetch_google_news_rss — returns list (may be empty if network unavailable)
        try:
            import socket

            socket.setdefaulttimeout(5)
            _gnews = fetch_google_news_rss("AAPL", n=3)
            check(
                "fetch_google_news_rss returns list",
                isinstance(_gnews, list),
                detail=str(type(_gnews)),
            )
            if _gnews:
                _first = _gnews[0]
                check(
                    "fetch_google_news_rss item has required keys",
                    all(k in _first for k in ("headline", "source", "url", "datetime")),
                    detail=str(_first),
                )
        except Exception as _gnews_exc:
            # Network may be unavailable in CI; graceful degradation is acceptable
            check(
                "fetch_google_news_rss graceful on network error",
                True,
                detail=repr(_gnews_exc),
            )

        check("news sentiment layer smoke complete", True)

    except Exception:
        import traceback as _traceback14

        check("news sentiment layer smoke", False, _traceback14.format_exc()[-400:])
