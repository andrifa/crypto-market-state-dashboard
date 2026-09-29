"""
Data layer — 100% free sources, no API keys.

Sources
-------
BTC daily close ............. Yahoo Finance  /v8/finance/chart/BTC-USD   (history to 2014-09)
BTC daily OHLC (recent) ..... Binance        /api/v3/klines              (cross-check + fills, to 2017-08)
Fear & Greed Index .......... alternative.me /fng                        (history to 2018-02)
Perp funding (BTC, ETH) ..... Binance        /fapi/v1/fundingRate        (history to ~2019-2020)
Stablecoin total supply ..... DefiLlama      /stablecoincharts/all       (history to ~2018)
BTC dominance (live only) ... CoinGecko      /global                     (context, forward-logged)

Every fetch is cached to data/raw/*.csv. Re-run with --refresh to force a re-pull.
All series are indexed by tz-naive UTC midnight timestamps (daily).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
RAW.mkdir(parents=True, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (market-regime-monitor research)"}
TIMEOUT = 45


def _get(url: str, params: dict | None = None, tries: int = 4, pause: float = 2.0):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(pause * (i + 2))
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(pause * (i + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url} :: {last}")


def _daily_index(ts_ms) -> pd.DatetimeIndex:
    return (
        pd.to_datetime(pd.Series(ts_ms), unit="ms", utc=True)
        .dt.tz_localize(None)
        .dt.normalize()
    )


# --------------------------------------------------------------------------- #
# BTC daily close — Yahoo Finance (long history, keyless)
# --------------------------------------------------------------------------- #
def btc_close_yahoo(refresh: bool = False) -> pd.Series:
    cache = RAW / "btc_yahoo.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["close"]

    js = _get(
        "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD",
        {"period1": 1_410_912_000, "period2": int(time.time()), "interval": "1d"},
    )
    res = js["chart"]["result"][0]
    closes = res["indicators"]["quote"][0]["close"]
    s = pd.Series(closes, index=_daily_index([t * 1000 for t in res["timestamp"]]), name="close")
    s = s[~s.index.duplicated(keep="last")].sort_index().dropna()
    s.to_frame().to_csv(cache)
    return s


# --------------------------------------------------------------------------- #
# BTC daily OHLC — Binance spot (keyless), 2017-08 onward
# --------------------------------------------------------------------------- #
def btc_klines_binance(refresh: bool = False) -> pd.DataFrame:
    cache = RAW / "btc_binance.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)

    rows, start = [], 1_502_928_000_000  # 2017-08-17
    while True:
        js = _get(
            "https://api.binance.com/api/v3/klines",
            {"symbol": "BTCUSDT", "interval": "1d", "limit": 1000, "startTime": start},
        )
        if not js:
            break
        rows.extend(js)
        start = js[-1][0] + 86_400_000
        if len(js) < 1000:
            break
        time.sleep(0.3)

    df = pd.DataFrame(rows, columns=[
        "ot", "open", "high", "low", "close", "volume", "ct", "qav", "trades", "tbb", "tbq", "ig"
    ])
    df.index = _daily_index(df["ot"])
    df = df[["open", "high", "low", "close", "volume"]].astype(float)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df.to_csv(cache)
    return df


# --------------------------------------------------------------------------- #
# Fear & Greed Index — alternative.me
# --------------------------------------------------------------------------- #
def fear_greed(refresh: bool = False) -> pd.Series:
    cache = RAW / "fng.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["fng"]

    js = _get("https://api.alternative.me/fng/", {"limit": 0, "format": "json"})
    d = js["data"]
    s = pd.Series(
        [int(x["value"]) for x in d],
        index=_daily_index([int(x["timestamp"]) * 1000 for x in d]),
        name="fng",
    ).sort_index()
    s = s[~s.index.duplicated(keep="last")]
    s.to_frame().to_csv(cache)
    return s


# --------------------------------------------------------------------------- #
# Perp funding rate — Binance USD-M futures
# --------------------------------------------------------------------------- #
def funding_rate(symbol: str = "BTCUSDT", refresh: bool = False) -> pd.Series:
    cache = RAW / f"funding_{symbol}.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["funding"]

    rows, start = [], 1_567_296_000_000  # ~2019-09-01
    while True:
        js = _get(
            "https://fapi.binance.com/fapi/v1/fundingRate",
            {"symbol": symbol, "limit": 1000, "startTime": start},
        )
        if not js:
            break
        rows.extend(js)
        start = js[-1]["fundingTime"] + 1
        if len(js) < 1000:
            break
        time.sleep(0.3)

    raw = pd.Series(
        [float(x["fundingRate"]) for x in rows],
        index=pd.to_datetime([x["fundingTime"] for x in rows], unit="ms"),
        name="funding",
    )
    daily = raw.groupby(raw.index.normalize()).mean()
    daily.index.name = None
    daily = daily[~daily.index.duplicated(keep="last")].sort_index()
    daily.to_frame().to_csv(cache)
    return daily


# --------------------------------------------------------------------------- #
# Stablecoin total supply — DefiLlama
# --------------------------------------------------------------------------- #
def stablecoin_supply(refresh: bool = False) -> pd.Series:
    cache = RAW / "stablecoin_supply.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["stbl"]

    js = _get("https://stablecoins.llama.fi/stablecoincharts/all")
    idx, val = [], []
    for row in js:
        idx.append(int(row["date"]) * 1000)
        tc = row.get("totalCirculatingUSD", {})
        v = tc.get("peggedUSD") if isinstance(tc, dict) else None
        val.append(float(v) if v is not None else np.nan)
    s = pd.Series(val, index=_daily_index(idx), name="stbl").sort_index()
    s = s[~s.index.duplicated(keep="last")].ffill()
    s.to_frame().to_csv(cache)
    return s


# --------------------------------------------------------------------------- #
# Miner revenue — blockchain.com charts (full history from 2009) -> Puell
# --------------------------------------------------------------------------- #
def miner_revenue(refresh: bool = False) -> pd.Series:
    cache = RAW / "miner_revenue.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["miner_rev"]
    js = _get("https://api.blockchain.info/charts/miners-revenue",
              {"timespan": "all", "format": "json", "sampled": "false"})
    v = js["values"]
    s = pd.Series([p["y"] for p in v], index=_daily_index([p["x"] * 1000 for p in v]), name="miner_rev")
    s = s[~s.index.duplicated(keep="last")].sort_index()
    s = s[s > 0]
    s.to_frame().to_csv(cache)
    return s


# --------------------------------------------------------------------------- #
# Network activity + market cap — CoinMetrics community API (2011+, keyless)
# --------------------------------------------------------------------------- #
def network_stats(refresh: bool = False) -> pd.DataFrame:
    cache = RAW / "network_stats.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)
    js = _get("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics",
              {"assets": "btc", "metrics": "AdrActCnt,TxCnt,CapMrktCurUSD",
               "frequency": "1d", "page_size": 10000, "start_time": "2011-01-01"})
    rows = js.get("data", [])
    idx = _daily_index([pd.Timestamp(r["time"]).value // 10**6 for r in rows])
    df = pd.DataFrame({
        "adr_act": [float(r.get("AdrActCnt")) if r.get("AdrActCnt") else np.nan for r in rows],
        "tx_cnt": [float(r.get("TxCnt")) if r.get("TxCnt") else np.nan for r in rows],
        "mcap": [float(r.get("CapMrktCurUSD")) if r.get("CapMrktCurUSD") else np.nan for r in rows],
    }, index=idx)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df.to_csv(cache)
    return df


# --------------------------------------------------------------------------- #
# BTC dominance — CoinGecko /global (live snapshot; context factor)
# --------------------------------------------------------------------------- #
def btc_dominance_live() -> float | None:
    try:
        js = _get("https://api.coingecko.com/api/v3/global", tries=2)
        return float(js["data"]["market_cap_percentage"]["btc"])
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Assemble one aligned daily frame
# --------------------------------------------------------------------------- #
def build_frame(refresh: bool = False) -> pd.DataFrame:
    """
    Master daily frame. Index = UTC midnight. Columns:
      close     BTC close USD  (Yahoo base, gaps + latest filled from Binance)
      fng       Fear & Greed 0-100
      funding   mean(BTC, ETH) daily perp funding rate
      stbl      stablecoin total supply USD
      ssr       BTC market cap / stbl   (Stablecoin Supply Ratio)
    """
    y = btc_close_yahoo(refresh)
    try:
        b = btc_klines_binance(refresh)["close"]
    except Exception:
        b = pd.Series(dtype=float)

    full_idx = pd.date_range(y.index.min(), max(y.index.max(), b.index.max() if len(b) else y.index.max()), freq="D")
    close = y.reindex(full_idx).combine_first(b.reindex(full_idx))
    # prefer Binance for the trailing 10 days (Yahoo can post a stale/rounded last point)
    if len(b):
        tail = b.index.max() - pd.Timedelta(days=10)
        close.loc[close.index >= tail] = b.reindex(full_idx).loc[close.index >= tail].combine_first(
            close.loc[close.index >= tail]
        )
    close = close.ffill(limit=3).rename("close")

    fng = fear_greed(refresh).reindex(close.index)

    f_btc = funding_rate("BTCUSDT", refresh)
    try:
        f_eth = funding_rate("ETHUSDT", refresh)
        funding = pd.concat([f_btc, f_eth], axis=1).mean(axis=1)
    except Exception:
        funding = f_btc
    funding = funding.reindex(close.index)

    stbl = stablecoin_supply(refresh).reindex(close.index).ffill()

    try:
        miner_rev = miner_revenue(refresh).reindex(close.index).ffill(limit=3)
    except Exception:
        miner_rev = pd.Series(np.nan, index=close.index)
    try:
        ns = network_stats(refresh).reindex(close.index).ffill(limit=5)
        adr_act, mcap = ns["adr_act"], ns["mcap"]
    except Exception:
        adr_act = mcap = pd.Series(np.nan, index=close.index)

    # SSR = BTC market cap / stablecoin supply. Prefer the real market cap (CoinMetrics);
    # fall back to a price-only proxy (still trends the same direction) if that feed is missing.
    mcap_for_ssr = mcap.where(mcap.notna(), close * 19_800_000)
    ssr = (mcap_for_ssr / stbl).rename("ssr")

    df = pd.DataFrame({
        "close": close, "fng": fng, "funding": funding, "stbl": stbl, "ssr": ssr,
        "miner_rev": miner_rev, "adr_act": adr_act, "mcap": mcap,
    })
    df = df[df["close"].notna()].sort_index()
    return df


if __name__ == "__main__":
    refresh = "--refresh" in sys.argv
    df = build_frame(refresh=refresh)
    print(f"rows: {len(df)}   {df.index.min().date()} -> {df.index.max().date()}\n")
    print("coverage (first non-null date):")
    for c in df.columns:
        s = df[c].dropna()
        print(f"  {c:9s} {str(s.index.min().date()) if len(s) else '---':>12}  n={len(s)}")
    print("\ntail:")
    print(df.tail(6).round(5))
