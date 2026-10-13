"""
Rally / drop study: what does Reku's trading value (GTV) do after BTC makes a
big 7-day move?

Reads the private daily GTV export (stable vs non-stable, in IDR) from a path
given on the command line and writes ONLY ratios to data/gtv_signal.json --
no rupiah amounts, no raw rows -- because the dashboard is public. The CSV
itself is never copied into the repo.

    python3 backend/gtv_study.py "/path/to/Daily GTV ....csv"

Method (same as the original study, kept simple on purpose):
  * GTV is divided by its own weekday median (removes the weekday pattern) and
    smoothed over 7 days.
  * "Normal" = the average of that smoothed GTV over the 28 days before the
    trigger day; effect at +h days = smoothed GTV at +h / normal - 1.
  * Trigger = BTC 7-day return above +8% (rally) or below -8% (drop). Triggers
    less than 14 days after the previous one are the same episode, so each
    episode counts once.
  * Luck check: draw the same number of random, 14-day-apart days many times and
    count how often a random draw does as well as the real episodes.
  * Stability check: first half of the period vs second half.
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from fetch import build_frame

OUT = Path(__file__).resolve().parent.parent / "data" / "gtv_signal.json"
THRESHOLD = 0.08
WINDOW = 14
HORIZONS = (0, 7, 14, 28)
SPLIT = "2025-07-01"


def load_gtv(path: str) -> pd.DataFrame:
    rows = []
    with open(path, newline="") as f:
        r = csv.reader(f)
        next(r)
        for x in r:
            if len(x) >= 4 and x[1] and x[2] and x[3]:
                rows.append((x[1], x[2].strip(), float(x[3])))
    df = pd.DataFrame(rows, columns=["date", "coin", "gtv"])
    df["date"] = pd.to_datetime(df["date"], format="%d-%m-%Y")
    p = df.pivot_table(index="date", columns="coin", values="gtv", aggfunc="sum").sort_index()
    p.columns = ["non_stable" if "non" in c else "stable" for c in p.columns]
    return p


def declustered(mask: pd.Series, gap: int = WINDOW) -> pd.DatetimeIndex:
    out, last = [], None
    for d in mask[mask].index:
        if last is None or (d - last).days >= gap:
            out.append(d)
            last = d
    return pd.DatetimeIndex(out)


def main(path: str) -> int:
    g = load_gtv(path)
    close = build_frame(refresh=False)["close"].reindex(g.index)
    ret7 = close.pct_change(7)

    adj = g.copy()
    for c in g.columns:
        adj[c] = g[c] / g[c].groupby(g.index.dayofweek).transform("median")
    sm = adj.rolling(7).mean()
    base = sm.shift(1).rolling(28).mean()

    valid = pd.Series(True, index=g.index)
    valid.iloc[:40] = False
    valid.iloc[-30:] = False
    rng = np.random.default_rng(11)

    def effect(col: str, h: int) -> pd.Series:
        return sm[col].shift(-h) / base[col] - 1

    def study(mask: pd.Series, col: str, lower_tail: bool) -> dict:
        ev = declustered(mask & valid)
        gaps = pd.Series(ev).diff().dt.days.fillna(999)
        res = {"episodes": int(len(ev)), "separate": int((gaps >= 45).sum())}
        for h in HORIZONS:
            o = effect(col, h)
            v = o.reindex(ev).dropna()
            pool = o[valid].dropna()
            sims = []
            for _ in range(2000):
                pick = rng.choice(pool.index, size=len(v) * 3, replace=False)
                pick = declustered(pd.Series(True, index=sorted(pick)))[: len(v)]
                sims.append(pool.reindex(pick).mean())
            sims = np.array(sims)
            p = float((sims <= v.mean()).mean() if lower_tail else (sims >= v.mean()).mean())
            h1, h2 = v[v.index < SPLIT], v[v.index >= SPLIT]
            res[f"d{h}"] = {
                "avg_pct": round(float(v.mean()) * 100),
                "typical_pct": round(float(pool.mean()) * 100),
                "luck_p": round(p, 3),
                "above_10pct_share": round(float((v > 0.10).mean()) * 100),
                "above_10pct_share_random": round(float((pool > 0.10).mean()) * 100),
                "first_half_pct": None if h1.empty else round(float(h1.mean()) * 100),
                "second_half_pct": None if h2.empty else round(float(h2.mean()) * 100),
                "n_second_half": int(len(h2)),
            }
        return res

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "gtv_period": [str(g.index.min().date()), str(g.index.max().date())],
        "threshold": THRESHOLD,
        "window_days": WINDOW,
        "method": "GTV vs its own 28-day normal, weekday-adjusted, 7-day smoothed; each episode counted once; luck check vs random days. Ratios only.",
        "rally": {"non_stable": study(ret7 > THRESHOLD, "non_stable", False),
                  "stable": study(ret7 > THRESHOLD, "stable", False)},
        "drop": {"non_stable": study(ret7 < -THRESHOLD, "non_stable", True)},
    }
    OUT.write_text(json.dumps(out, indent=2))
    r = out["rally"]["non_stable"]
    print(f"rally episodes {r['episodes']} (~{r['separate']} separate): "
          + ", ".join(f"+{h}d {r[f'd{h}']['avg_pct']:+d}%" for h in HORIZONS))
    d = out["drop"]["non_stable"]
    print(f"drop episodes {d['episodes']}: " + ", ".join(f"+{h}d {d[f'd{h}']['avg_pct']:+d}%" for h in HORIZONS))
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1]))
