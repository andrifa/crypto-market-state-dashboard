"""
Pure indicator functions. Every output is a daily Series aligned to the input
index and uses only trailing data (no lookahead), so the same code is correct
for a historical backtest and for today's single reading.

Grouped by the three orthogonal dimensions of the regime model:
  A  Trend / price structure   — "where are we in the cycle"
  B  Momentum / participation  — "which way is it turning"
  C  Sentiment / positioning   — "how crowded is the trade"
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def trailing_z(s: pd.Series, window: int) -> pd.Series:
    m = s.rolling(window, min_periods=max(30, window // 3)).mean()
    sd = s.rolling(window, min_periods=max(30, window // 3)).std()
    return (s - m) / sd.replace(0, np.nan)


def trailing_pct_rank(s: pd.Series, window: int) -> pd.Series:
    """Fraction of the trailing `window` values <= the current value (0..1)."""
    return s.rolling(window, min_periods=max(30, window // 3)).apply(
        lambda x: (x <= x[-1]).mean(), raw=True
    )


def squash(x: pd.Series | float, k: float = 1.0):
    """Map an unbounded signal to [-1, 1]."""
    return np.tanh(np.asarray(x, dtype=float) * k)


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0.0)
    dn = -d.clip(upper=0.0)
    rs = up.ewm(alpha=1 / n, min_periods=n).mean() / dn.ewm(alpha=1 / n, min_periods=n).mean()
    return 100 - 100 / (1 + rs)


# --------------------------------------------------------------------------- #
# A — trend / price structure
# --------------------------------------------------------------------------- #
def mayer_multiple(close: pd.Series, n: int = 200) -> pd.Series:
    return close / sma(close, n)


def ma_slope(close: pd.Series, n: int = 200, lookback: int = 90) -> pd.Series:
    m = sma(close, n)
    return m / m.shift(lookback) - 1.0


def ma_cross(close: pd.Series, fast: int = 50, slow: int = 200) -> pd.Series:
    return sma(close, fast) / sma(close, slow) - 1.0


def drawdown_from_ath(close: pd.Series) -> pd.Series:
    return close / close.cummax() - 1.0


def pi_cycle_gap(close: pd.Series) -> pd.Series:
    """SMA111 / (2*SMA350) - 1.  Crosses >= 0 near historical cycle tops."""
    return sma(close, 111) / (2.0 * sma(close, 350)) - 1.0


def ma_multiple(close: pd.Series, n: int) -> pd.Series:
    """Price / SMA(n).  n=730 -> 2-year multiple, n=1400 -> 200-week multiple."""
    return close / sma(close, n)


def puell_multiple(miner_rev: pd.Series) -> pd.Series:
    """Daily miner revenue (USD) / its own 365-day average. Low ~ cycle bottoms, high ~ tops."""
    return miner_rev / miner_rev.rolling(365, min_periods=200).mean()


def activity_ratio(adr_act: pd.Series) -> pd.Series:
    """Active addresses / their 365-day average. >1 = on-chain usage expanding vs its year."""
    return adr_act / adr_act.rolling(365, min_periods=200).mean()


# --------------------------------------------------------------------------- #
# B — momentum / participation
# --------------------------------------------------------------------------- #
def rsi_weekly(close: pd.Series, n: int = 14) -> pd.Series:
    wk = close.resample("W-MON").last()
    return rsi(wk, n).reindex(close.index).ffill()


def roc(close: pd.Series, n: int = 90) -> pd.Series:
    return close / close.shift(n) - 1.0


def pct_days_above_ma(close: pd.Series, n: int = 200, window: int = 90) -> pd.Series:
    above = (close > sma(close, n)).astype(float)
    return above.rolling(window, min_periods=window).mean()


def realized_vol(close: pd.Series, n: int = 30) -> pd.Series:
    lr = np.log(close).diff()
    return lr.rolling(n, min_periods=n).std() * np.sqrt(365.0)


def vol_percentile(close: pd.Series, n: int = 30, window: int = 730) -> pd.Series:
    return trailing_pct_rank(realized_vol(close, n), window)


# --------------------------------------------------------------------------- #
# C — sentiment / positioning
# --------------------------------------------------------------------------- #
def funding_z(funding: pd.Series, window: int = 365) -> pd.Series:
    return trailing_z(funding, window)


def ssr_z(ssr: pd.Series, window: int = 365) -> pd.Series:
    return trailing_z(ssr, window)


# --------------------------------------------------------------------------- #
# one call → every raw indicator as a DataFrame
# --------------------------------------------------------------------------- #
def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """
    df must have columns: close, fng, funding, ssr  (from fetch.build_frame).
    Returns a DataFrame of raw indicator values (not yet scored).
    """
    c = df["close"]
    out = pd.DataFrame(index=df.index)

    # A — trend / structure
    out["mayer"] = mayer_multiple(c, 200)
    out["ma_slope"] = ma_slope(c, 200, 90)
    out["ma_cross"] = ma_cross(c, 50, 200)
    out["ma_2y"] = ma_multiple(c, 730)
    out["ma_200w"] = ma_multiple(c, 1400)
    out["drawdown"] = drawdown_from_ath(c)
    out["pi_gap"] = pi_cycle_gap(c)
    out["puell"] = puell_multiple(df["miner_rev"]) if "miner_rev" in df else np.nan

    # B — momentum / participation
    out["rsi_w"] = rsi_weekly(c, 14)
    out["roc90"] = roc(c, 90)
    out["pct_above_200"] = pct_days_above_ma(c, 200, 90)
    out["vol_pctl"] = vol_percentile(c, 30, 730)
    out["activity"] = activity_ratio(df["adr_act"]) if "adr_act" in df else np.nan

    # C — sentiment / positioning
    out["fng"] = df["fng"]
    out["funding_z"] = funding_z(df["funding"], 365)
    out["ssr_z"] = ssr_z(df["ssr"], 365)

    return out


if __name__ == "__main__":
    from fetch import build_frame

    ind = compute_all(build_frame())
    print(ind.tail(8).round(4).to_string())
    print("\nfirst fully-populated row:", ind.dropna().index.min().date())
