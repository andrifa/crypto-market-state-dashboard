"""
Apply the daily news classification to the displayed scores.

The scheduled task reads the day's news and writes `news_impact.items` into
data/latest.json -- each item only gets a classification (horizon, direction,
size, a plain reason), never a number. This script turns that into score
shifts with a fixed formula, so the AI's judgement can't silently become
arbitrary arithmetic:

    item weight   minor 0.25 / moderate 0.5 / major 1.0, signed by direction
    horizon       short -> sentiment, medium -> momentum, long -> trend
    impact        sum of weights per horizon, clipped to [-1, 1]
    shift         impact * CAP, with CAP = 0.10 on the model's -1..1 scale

The 11-indicator base scores are kept in `scores_base` and are what the
backtest and history.csv describe; news is not in either (it has no
history to validate a weight against). The headline regime label and budget
action stay with the base model. If news moves the trend score across a
regime threshold the label hasn't followed, `news_flag` says so instead.

Run after the task has written news_impact, before it writes the narrative:
    python3 backend/apply_news.py
Idempotent: always starts from scores_base when present.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

from reading import REGIME_LABEL, confidence_level
from state import CONFIG, conviction_series

LATEST = Path(__file__).resolve().parent.parent / "data" / "latest.json"

CAP = 0.10
SIZE_WEIGHT = {"minor": 0.25, "moderate": 0.5, "major": 1.0}
DIRECTION_SIGN = {"positive": 1, "negative": -1}
HORIZON_TO_DIM = {"short": "sentiment", "medium": "momentum", "long": "trend"}


def _clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _zone(trend: float) -> str:
    t = CONFIG["regime_T"]
    return "Bull" if trend > t else "Bear" if trend < -t else "Neutral"


def main() -> int:
    d = json.loads(LATEST.read_text())
    ni = d.get("news_impact") or {}
    items = [
        it for it in ni.get("items", [])
        if it.get("horizon") in HORIZON_TO_DIM
        and it.get("direction") in DIRECTION_SIGN
        and it.get("size") in SIZE_WEIGHT
    ]

    base = d.get("scores_base") or d["scores"]
    d["scores_base"] = {k: base[k] for k in ("trend", "momentum", "sentiment")}
    base_conv = d.get("conviction_base", d.get("conviction"))
    d["conviction_base"] = base_conv

    impact = {h: 0.0 for h in HORIZON_TO_DIM}
    for it in items:
        impact[it["horizon"]] += DIRECTION_SIGN[it["direction"]] * SIZE_WEIGHT[it["size"]]
    impact = {h: round(_clip(v), 3) for h, v in impact.items()}
    shift = {HORIZON_TO_DIM[h]: round(v * CAP, 3) for h, v in impact.items()}

    adj = {k: round(_clip(d["scores_base"][k] + shift[k]), 3) for k in shift}
    d["scores"] = adj
    d["news_adjustment"] = shift
    ni["items"] = items
    ni["impact"] = impact
    ni["cap"] = CAP
    d["news_impact"] = ni

    # conviction on the adjusted scores (same formula as the model)
    vol = (d.get("context") or {}).get("vol_percentile")
    if vol is not None and base_conv is not None:
        c = conviction_series(
            pd.DataFrame({"trend": [adj["trend"]], "momentum": [adj["momentum"]], "sentiment": [adj["sentiment"]]}),
            pd.DataFrame({"_vol_pctl": [float(vol)]}),
        ).iloc[0]
        if pd.notna(c):
            d["conviction"] = int(c)
            d["conviction_level"] = confidence_level(int(c))

    # flag only when news itself pushed the trend score into a different regime zone
    z_base, z_adj = _zone(d["scores_base"]["trend"]), _zone(adj["trend"])
    flag = None
    if z_adj != z_base and z_adj != d.get("regime"):
        flag = (f"News moves the long-term score from {d['scores_base']['trend']:+.2f} to {adj['trend']:+.2f}, "
                f"into {REGIME_LABEL.get(z_adj, z_adj)} territory. The headline label stays "
                f"{d.get('headline')} until the 11-indicator model itself confirms the change.")
    d["news_flag"] = flag

    LATEST.write_text(json.dumps(d, indent=2, ensure_ascii=False))
    print(f"news items: {len(items)} | impact: {impact} | shift: {shift}")
    print(f"scores {d['scores_base']} -> {adj} | conviction {base_conv} -> {d.get('conviction')}")
    if flag:
        print("FLAG:", flag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
