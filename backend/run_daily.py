"""
Daily job. Run locally or from GitHub Actions cron.

  python backend/run_daily.py

Steps:
  1. refresh all free data sources
  2. compute the full state table (point-in-time)
  3. take the latest fully-populated row -> data/latest.json  (frontend + Slack read this)
  4. append/replace today's row in data/history.csv           (growing backtest set + chart data)
  5. print the plain-language reading

No secrets, no paid APIs. Exit non-zero on failure so CI surfaces it.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from fetch import (
    build_frame, btc_dominance_live, open_interest_live, long_short_ratio_live,
    dvol_live, us_10y_yield_live, vix_live, fed_funds_rate_live,
)
from state import build_state
from reading import friendly_row

DATA = Path(__file__).resolve().parent.parent / "data"
LATEST = DATA / "latest.json"
HISTORY = DATA / "history.csv"

DISCLAIMER = (
    "All indicators are trailing (they describe what already happened), not forecasts. "
    "This is a decision aid for budget posture, not a trading signal. "
    "Built on ~2.7 market cycles — treat it as direction, not a precise number."
)

HISTORY_COLS = [
    "date", "close", "regime", "direction", "sentiment_band", "conviction",
    "cycle", "trend_score", "momentum_score", "sentiment_score", "action_title",
]


def build_payload() -> dict:
    df = build_frame(refresh=True)
    st = build_state(df).dropna(subset=["trend_score"])
    if st.empty:
        raise RuntimeError("state table empty after build")

    row = st.iloc[-1]
    prev = st.iloc[-2] if len(st) > 1 else None
    fr = friendly_row(row, prev)

    dom = btc_dominance_live()
    oi = open_interest_live()
    ls_ratio = long_short_ratio_live()
    dvol = dvol_live()
    y10 = us_10y_yield_live()
    vix = vix_live()
    fed_funds = fed_funds_rate_live()

    payload = {
        "updated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "date": row.name.strftime("%Y-%m-%d"),
        "price_btc": fr["price"],
        "regime": row["regime"],
        "headline": fr["headline"],
        "headline_tag": fr["headline_tag"],
        "direction": row["direction"],
        "sentiment_band": row["sentiment_band"],
        "sentiment_label": fr["summary"].split("Sentiment: ")[-1],
        "conviction": fr["confidence_score"],
        "conviction_level": fr["confidence"],
        "cycle": row["cycle"],
        "cycle_label": fr["phase"],
        "action": {"title": fr["action_title"], "detail": fr["action_detail"]},
        "reasons": fr["reasons"],
        "watch": fr["watch"],
        "changed_today": fr["change"],
        "scores": {
            "trend": _f(row["trend_score"]),
            "momentum": _f(row["momentum_score"]),
            "sentiment": _f(row["sentiment_score"]),
        },
        "context": {
            "mayer_multiple": _f(row["mayer"]),
            "ma200_slope_90d": _f(row["ma_slope"]),
            "ma_200w_multiple": _f(row["ma_200w"]),
            "drawdown_from_ath": _f(row["drawdown"]),
            "rsi_weekly": _f(row["rsi_w"]),
            "active_addr_ratio": _f(row["activity"]),
            "puell_multiple": _f(row["puell"]),
            "fear_greed": _f(row["fng"]),
            "funding_z": _f(row["funding_z"]),
            "vol_percentile": _f(row["vol_pctl"]),
            "btc_dominance": None if dom is None else round(dom, 1),
            "ma_cross": _f(row["ma_cross"]),
            "roc_90d": _f(row["roc90"]),
            "breadth_90d": _f(row["breadth"]),
            "ssr": _f(row["ssr"]),
            "pi_cycle_gap": _f(row["pi_gap"]),
            "open_interest_usd": oi,
            "long_short_ratio": ls_ratio,
            "dvol": dvol,
            "us_10y_yield": y10,
            "vix": vix,
            "fed_funds_rate": fed_funds,
        },
        "text": fr["text"],
        "disclaimer": DISCLAIMER,
    }
    return payload, st


def _f(v):
    return None if pd.isna(v) else float(v)


def _with_titles(frame: pd.DataFrame) -> pd.DataFrame:
    f = frame.copy()
    f["date"] = f.index.strftime("%Y-%m-%d")
    f["action_title"] = [friendly_row(r)["action_title"] for _, r in f.iterrows()]
    return f[HISTORY_COLS]


def update_history(st: pd.DataFrame) -> None:
    tail = st.dropna(subset=["trend_score"])
    if HISTORY.exists():
        hist = pd.read_csv(HISTORY)
        out = _with_titles(tail.iloc[-15:])            # refresh only the recent tail
        hist = hist[~hist["date"].isin(out["date"])]
        full = pd.concat([hist, out], ignore_index=True).sort_values("date")
    else:
        full = _with_titles(tail)                       # first run: full backfill
    full.to_csv(HISTORY, index=False)


def main() -> int:
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        payload, st = build_payload()
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}", file=sys.stderr)
        return 1

    LATEST.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    update_history(st)

    print(payload["text"])
    print(f"\nwrote {LATEST.relative_to(DATA.parent)}  &  {HISTORY.relative_to(DATA.parent)}")
    print(f"history rows: {sum(1 for _ in open(HISTORY)) - 1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
