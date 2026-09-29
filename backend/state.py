"""
Scoring + state machine.

Raw indicators (indicators.compute_all) --> per-indicator scores in [-1, +1]
        --> three dimension scores (trend / momentum / sentiment)
        --> headline regime  (Bull / Neutral / Bear, with hysteresis)
          + direction        (strengthening / stable / weakening)
          + sentiment band   (Ryan's L1 vendor bands, kept for continuity)
          + conviction 0-100
          + cycle position
          + spend posture

Every threshold and weight lives in CONFIG so tuning is one auditable place.
Nothing here looks ahead: all inputs are trailing.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from indicators import compute_all, realized_vol

CONFIG = {
    # per-indicator squash steepness (k) — bigger k = saturates sooner
    "k_mayer": 3.0, "k_slope": 8.0, "k_cross": 12.0,
    "k_200w": 0.6, "k_activity": 4.0,
    "k_roc": 3.0, "k_funding": 0.8, "k_ssr": 0.8,
    "c_200w": 1.6,             # 200-week multiple considered "fair value" (score 0 here)
    "dd_scale": 0.35,          # drawdown at which structural score hits ~0 before going negative
    "pi_center": 0.25,         # pi-cycle gap considered "mid cycle"
    # dimension weights within each score (renormalised over whatever inputs exist that day)
    "w_trend":   {"mayer": 0.34, "slope": 0.28, "cross": 0.18, "ma_200w": 0.20},
    "w_moment":  {"rsi_w": 0.30, "roc90": 0.24, "breadth": 0.16, "activity": 0.30},
    "w_sent":    {"fng": 0.50, "funding": 0.30, "ssr": 0.20},
    # regime bands on trend_score, plus hysteresis
    "regime_T": 0.15,
    "confirm_days": 5,
    # direction deadband on the 20d change in momentum_score
    "dir_lookback": 20,
    "dir_deadband": 0.08,
    # fear & greed vendor bands (== Ryan L1)
    "fng_bands": [(25, "Extreme Fear"), (46, "Fear"), (54, "Neutral"), (75, "Greed"), (200, "Extreme Greed")],
}


# --------------------------------------------------------------------------- #
# scoring
# --------------------------------------------------------------------------- #
def _sq(x, k):
    return np.tanh(np.asarray(x, dtype=float) * k)


def score_indicators(ind: pd.DataFrame) -> pd.DataFrame:
    c = CONFIG
    s = pd.DataFrame(index=ind.index)

    # A — trend structure  (+ = uptrend)
    s["mayer"] = _sq(ind["mayer"] - 1.0, c["k_mayer"])
    s["slope"] = _sq(ind["ma_slope"], c["k_slope"])
    s["cross"] = _sq(ind["ma_cross"], c["k_cross"])
    # 200-week multiple as a valuation signal: cheap (near the line) -> room to run (+),
    # stretched far above it (blow-off) -> mean-reversion risk (-).
    s["ma_200w"] = -_sq(ind["ma_200w"] - c["c_200w"], c["k_200w"])

    # B — momentum / participation  (+ = strengthening)
    s["rsi_w"] = ((ind["rsi_w"] - 50.0) / 20.0).clip(-1, 1)
    s["roc90"] = _sq(ind["roc90"], c["k_roc"])
    s["breadth"] = ((ind["pct_above_200"] - 0.5) * 2.0).clip(-1, 1)
    s["activity"] = _sq(ind["activity"] - 1.0, c["k_activity"])

    # C — sentiment / positioning  (+ = greedy / euphoric, - = fearful / capitulation)
    s["fng"] = ((ind["fng"] - 50.0) / 50.0).clip(-1, 1)
    s["funding"] = _sq(ind["funding_z"], c["k_funding"])
    s["ssr"] = _sq(ind["ssr_z"], c["k_ssr"])

    # cycle-position raw helpers (not [-1,1] scores)
    s["_dd_health"] = (1.0 + ind["drawdown"] / c["dd_scale"]).clip(-1, 1)
    s["_pi"] = _sq(-(ind["pi_gap"]) - c["pi_center"], 3.0)   # -> negative near cycle tops
    s["_vol_pctl"] = ind["vol_pctl"]
    return s


def _wmean(s: pd.DataFrame, cols: dict) -> pd.Series:
    parts = [s[k] * w for k, w in cols.items()]
    wsum = pd.concat([s[k].notna() * w for k, w in cols.items()], axis=1).sum(axis=1)
    return pd.concat(parts, axis=1).sum(axis=1, min_count=1) / wsum.replace(0, np.nan)


def dimension_scores(s: pd.DataFrame) -> pd.DataFrame:
    c = CONFIG
    d = pd.DataFrame(index=s.index)
    d["trend"] = _wmean(s, c["w_trend"])
    d["momentum"] = _wmean(s, c["w_moment"])
    d["sentiment"] = _wmean(s, c["w_sent"])
    return d


# --------------------------------------------------------------------------- #
# regime with hysteresis
# --------------------------------------------------------------------------- #
def _raw_regime(t: float, T: float) -> str:
    if not np.isfinite(t):
        return "Unknown"
    if t > T:
        return "Bull"
    if t < -T:
        return "Bear"
    return "Neutral"


def regime_series(trend: pd.Series) -> pd.Series:
    c = CONFIG
    T, confirm = c["regime_T"], c["confirm_days"]
    raw = trend.apply(lambda x: _raw_regime(x, T))
    out, cur, run = [], "Unknown", 0
    prev = None
    for r in raw:
        if r == prev:
            run += 1
        else:
            run = 1
            prev = r
        if cur == "Unknown" and r != "Unknown":
            cur = r
        elif r != cur and r != "Unknown" and run >= confirm:
            cur = r
        out.append(cur)
    return pd.Series(out, index=trend.index, name="regime")


# --------------------------------------------------------------------------- #
# direction / sentiment band / conviction / cycle / posture
# --------------------------------------------------------------------------- #
def direction_series(momentum: pd.Series) -> pd.Series:
    c = CONFIG
    chg = momentum - momentum.shift(c["dir_lookback"])
    return chg.apply(
        lambda x: "strengthening" if x > c["dir_deadband"]
        else "weakening" if x < -c["dir_deadband"]
        else "stable" if np.isfinite(x) else "—"
    )


def fng_band(v: float) -> str:
    if not np.isfinite(v):
        return "—"
    for hi, name in CONFIG["fng_bands"]:
        if v <= hi:
            return name
    return "Extreme Greed"


def conviction_series(d: pd.DataFrame, s: pd.DataFrame) -> pd.Series:
    """
    0-100.  High = the three dimensions agree, the trend is well clear of the
    neutral band, sentiment is not at a froth/capitulation extreme, and vol is calm.
    Low = conflicting signals or a trend score hugging zero.
    """
    tr = d["trend"]
    strength = (tr.abs() / 0.45).clip(0, 1)                      # distance from neutral band

    mom_agree = np.sign(d["momentum"]).eq(np.sign(tr)).astype(float)
    sent_dir = np.sign(d["sentiment"]).eq(np.sign(tr))
    sent_extreme = d["sentiment"].abs() > 0.60
    sent_agree = np.select(
        [sent_dir & ~sent_extreme, sent_dir & sent_extreme],
        [1.0, 0.4], default=0.0,
    )
    align = (mom_agree + sent_agree) / 2.0                       # 0..1

    calm = 1.0 - ((s["_vol_pctl"] - 0.50) / 0.40).clip(0, 1)     # 1 calm .. 0 turbulent

    raw = 0.10 + 0.60 * strength * (0.5 + 0.5 * align) + 0.15 * align + 0.10 * calm
    return (100 * raw.clip(0, 1)).round().astype("Int64")


def cycle_series(regime: pd.Series, s: pd.DataFrame, d: pd.DataFrame) -> pd.Series:
    dd_health, pi, sent = s["_dd_health"], s["_pi"], d["sentiment"]
    vol = s["_vol_pctl"]
    flip = regime.ne(regime.shift(1))
    recent_flip = flip.rolling(30, min_periods=1).max().astype(bool)
    out = []
    for i, r in enumerate(regime):
        h, p, se, v, rf = dd_health.iat[i], pi.iat[i], sent.iat[i], vol.iat[i], recent_flip.iat[i]
        if r == "Bull":
            if (np.isfinite(p) and p < -0.35) and (np.isfinite(se) and se > 0.45):
                out.append("late-bull / distribution risk")
            elif rf:
                out.append("early-bull")
            else:
                out.append("mid-bull")
        elif r == "Bear":
            if (np.isfinite(se) and se < -0.55) and (np.isfinite(v) and v > 0.65):
                out.append("capitulation")
            elif np.isfinite(h) and h > 0.3:
                out.append("early-bear")
            else:
                out.append("mid / late-bear")
        elif r == "Neutral":
            out.append("transition")
        else:
            out.append("—")
    return pd.Series(out, index=regime.index, name="cycle")


def posture_series(regime: pd.Series, cycle: pd.Series, conviction: pd.Series) -> pd.Series:
    out = []
    for r, cy, cv in zip(regime, cycle, conviction):
        cv = int(cv) if pd.notna(cv) else 0
        if r == "Bull":
            if "late-bull" in cy or cv < 55:
                out.append("Stay in, capped — hold acquisition at plan, watch for froth, do not add NS budget.")
            else:
                out.append("Lean in — scale acquisition, prioritise NS / market-beta channels.")
        elif r == "Neutral":
            out.append("Hold — keep spend at plan, no large moves up or down until direction resolves.")
        elif r == "Bear":
            if cy == "capitulation":
                out.append("Defend + prepare — keep d30 ROI stop-loss, ready a scale-up plan for the turn.")
            else:
                out.append("Defend — maintain with d30 ROI stop-loss, shift messaging to stablecoin, trim NS channels.")
        else:
            out.append("—")
    return pd.Series(out, index=regime.index, name="posture")


# --------------------------------------------------------------------------- #
# top-level
# --------------------------------------------------------------------------- #
def build_state(df: pd.DataFrame) -> pd.DataFrame:
    """df from fetch.build_frame -> full daily state table."""
    ind = compute_all(df)
    s = score_indicators(ind)
    d = dimension_scores(s)

    reg = regime_series(d["trend"])
    st = pd.DataFrame(index=df.index)
    st["close"] = df["close"]
    st["trend_score"] = d["trend"].round(3)
    st["momentum_score"] = d["momentum"].round(3)
    st["sentiment_score"] = d["sentiment"].round(3)
    st["regime"] = reg
    st["direction"] = direction_series(d["momentum"])
    st["sentiment_band"] = ind["fng"].apply(fng_band)
    st["conviction"] = conviction_series(d, s)
    st["cycle"] = cycle_series(reg, s, d)
    st["posture"] = posture_series(reg, st["cycle"], st["conviction"])
    # keep a few raw context values for the dashboard
    st["mayer"] = ind["mayer"].round(3)
    st["ma_slope"] = ind["ma_slope"].round(4)
    st["ma_200w"] = ind["ma_200w"].round(2)
    st["drawdown"] = ind["drawdown"].round(3)
    st["rsi_w"] = ind["rsi_w"].round(1)
    st["activity"] = ind["activity"].round(3)
    st["puell"] = ind["puell"].round(3)
    st["fng"] = ind["fng"]
    st["funding_z"] = ind["funding_z"].round(2)
    st["vol_pctl"] = ind["vol_pctl"].round(2)
    st["bb_width"] = ind["bb_width"].round(4)
    # these already feed the score (cross/roc90/breadth/ssr -> trend & momentum & sentiment;
    # pi_gap -> cycle_series) but were never surfaced for the dashboard/reasoning layer to see
    st["ma_cross"] = ind["ma_cross"].round(4)
    st["roc90"] = ind["roc90"].round(4)
    st["breadth"] = ind["pct_above_200"].round(3)
    st["ssr"] = df["ssr"].round(2)
    st["pi_gap"] = ind["pi_gap"].round(4)
    return st


if __name__ == "__main__":
    from fetch import build_frame

    st = build_state(build_frame())
    cols = ["close", "trend_score", "momentum_score", "sentiment_score",
            "regime", "direction", "sentiment_band", "conviction", "cycle"]
    print(st[cols].dropna(subset=["regime"]).tail(15).to_string())
    print("\n--- today ---")
    row = st.dropna(subset=["trend_score"]).iloc[-1]
    for k in ["close", "regime", "direction", "sentiment_band", "conviction", "cycle", "posture"]:
        print(f"  {k:15s} {row[k]}")

    # regime transition log
    r = st["regime"]
    tr = st[r.ne(r.shift(1)) & r.notna()]
    print(f"\nregime transitions: {len(tr)}  (~{len(tr)/((st.index[-1]-st.index[0]).days/365):.1f}/yr)")
    print(tr[["regime"]].assign(price=st["close"].round(0)).to_string())
