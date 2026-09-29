"""
Data layer — free sources; every one is keyless except fed_funds_rate_live.

Sources
-------
BTC daily close ............. Yahoo Finance  /v8/finance/chart/BTC-USD   (history to 2014-09)
BTC daily OHLC (recent) ..... Binance        /api/v3/klines              (cross-check + fills, to 2017-08)
Fear & Greed Index .......... alternative.me /fng                        (history to 2018-02)
Perp funding (BTC, ETH) ..... Binance        /fapi/v1/fundingRate        (history to ~2019-2020)
Stablecoin total supply ..... DefiLlama      /stablecoincharts/all       (history to ~2018)
BTC dominance (live only) ... CoinGecko      /global                     (context, forward-logged)
Open interest (live only) ... Binance        /futures/data/openInterestHist        (~30d retention on the source)
Long/short ratio (live) ..... Binance        /futures/data/globalLongShortAccountRatio (~30d retention on the source)
DVOL (live only) ............ Deribit        /public/get_volatility_index_data
US 10Y yield (live only) .... Yahoo Finance  /v8/finance/chart/%5ETNX
VIX (live only) ............. Yahoo Finance  /v8/finance/chart/%5EVIX
Fed Funds Rate (live, opt) .. FRED           /fred/series/observations   (needs FRED_API_KEY env var; skips to None without it)
BTC ETF flow (live only) .... SoSoValue      undocumented JSON endpoint, POST  (Farside is Cloudflare-blocked; this isn't)
Corp. treasury BTC (live) ... bitcointreasuries.net homepage, HTML scrape (regex on server-rendered totals)

The seven "live only" sources above have no useful public history (either the
exchange only retains ~30 days, or it's simplest as a forward-logged context
factor like dominance) — they're read fresh each run, not backfilled. The
last two are undocumented endpoints / HTML scrapes found by testing rather
than a published API, so they're the most likely of anything here to break.
Every other fetch is cached to data/raw/*.csv. Re-run with --refresh to force
a re-pull. All series are indexed by tz-naive UTC midnight timestamps (daily).
"""
from __future__ import annotations

import os
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
RAW.mkdir(parents=True, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (market-regime-monitor research)"}
TIMEOUT = 45


_PERMANENT_CODES = {401, 403, 451}  # geo-block / auth failure -- retrying never helps


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
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code in _PERMANENT_CODES:
                raise
            last = e
            time.sleep(pause * (i + 1))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(pause * (i + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url} :: {last}")


def _post(url: str, json_body: dict, tries: int = 3, pause: float = 2.0):
    last = None
    for i in range(tries):
        try:
            r = requests.post(url, json=json_body, headers=UA, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(pause * (i + 2))
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(pause * (i + 1))
    raise RuntimeError(f"POST failed after {tries} tries: {url} :: {last}")


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


def funding_rate_bybit(symbol: str = "BTCUSDT", refresh: bool = False) -> pd.Series:
    """
    Fallback for funding_rate(): Binance's futures API (fapi.binance.com) returns
    HTTP 451 from US-hosted IPs, including GitHub Actions' shared runners — a
    geo-block, confirmed by testing, not transient. Bybit's public funding-rate
    endpoint isn't blocked the same way. History only goes back to ~Sep 2020
    (vs Binance's ~2019), which just means funding_z has no value before that
    -- it doesn't affect current scoring.
    """
    cache = RAW / f"funding_bybit_{symbol}.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["funding"]

    rows, end = [], int(time.time() * 1000)
    floor = 1_598_918_400_000  # 2020-09-01, before Bybit's linear-perp launch
    while end > floor:
        js = _get("https://api.bybit.com/v5/market/funding/history",
                   {"category": "linear", "symbol": symbol, "limit": 200, "endTime": end})
        lst = js.get("result", {}).get("list", [])
        if not lst:
            break
        rows.extend(lst)
        end = min(int(x["fundingRateTimestamp"]) for x in lst) - 1
        time.sleep(0.2)

    raw = pd.Series(
        [float(x["fundingRate"]) for x in rows],
        index=pd.to_datetime([int(x["fundingRateTimestamp"]) for x in rows], unit="ms"),
        name="funding",
    )
    daily = raw.groupby(raw.index.normalize()).mean()
    daily.index.name = None
    daily = daily[~daily.index.duplicated(keep="last")].sort_index()
    daily.to_frame().to_csv(cache)
    return daily


def funding_rate_okx(inst_id: str = "BTC-USDT-SWAP", refresh: bool = False) -> pd.Series:
    """
    Second fallback for funding_rate(): confirmed both Binance (451) and Bybit
    (403) block GitHub Actions' shared runners entirely -- not just the futures
    host, their whole API, spot included. OKX's public endpoint isn't blocked,
    but its funding-rate-history only retains ~3 months via REST (a documented
    OKX limit, not a block), so this can't backfill years like Binance can --
    only useful for keeping funding_z alive on recent data when the other two
    are unreachable.
    """
    cache = RAW / f"funding_okx_{inst_id}.csv"
    if cache.exists() and not refresh:
        return pd.read_csv(cache, index_col=0, parse_dates=True)["funding"]

    rows, after = [], None
    for _ in range(40):  # ~3 months / (100 recs * 8h) is well under this
        params = {"instId": inst_id, "limit": 100}
        if after:
            params["after"] = after
        js = _get("https://www.okx.com/api/v5/public/funding-rate-history", params, tries=2)
        lst = js.get("data", [])
        if not lst:
            break
        rows.extend(lst)
        after = min(int(x["fundingTime"]) for x in lst)
        time.sleep(0.3)

    raw = pd.Series(
        [float(x["fundingRate"]) for x in rows],
        index=pd.to_datetime([int(x["fundingTime"]) for x in rows], unit="ms"),
        name="funding",
    )
    daily = raw.groupby(raw.index.normalize()).mean()
    daily.index.name = None
    daily = daily[~daily.index.duplicated(keep="last")].sort_index()
    daily.to_frame().to_csv(cache)
    return daily


def funding_rate_any(symbol_binance: str = "BTCUSDT", symbol_bybit: str = "BTCUSDT",
                      inst_id_okx: str = "BTC-USDT-SWAP", refresh: bool = False) -> pd.Series:
    """Binance first (longest history), then Bybit, then OKX (~3mo only), empty
    series (not a crash) if all three fail -- a missing sentiment input
    shouldn't take down the whole daily run. Which one actually answers depends
    on where this runs: none of them block every environment the same way."""
    for fn, arg in ((funding_rate, symbol_binance), (funding_rate_bybit, symbol_bybit),
                     (funding_rate_okx, inst_id_okx)):
        try:
            s = fn(arg, refresh)
            if len(s):
                return s
        except Exception:
            continue
    return pd.Series(dtype=float, name="funding")


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
# Positioning, volatility & macro — live snapshots only (context factors).
# Binance's futures history endpoints only retain ~30 days regardless of the
# limit requested, so (like btc_dominance_live) these just read today's value
# rather than pretending to backfill years of history that isn't there.
# --------------------------------------------------------------------------- #
def open_interest_live(symbol: str = "BTCUSDT", inst_id_okx: str = "BTC-USDT-SWAP") -> float | None:
    """
    BTC futures open interest, USD notional. Binance blocks GitHub Actions'
    runners with a 451 on its ENTIRE API, spot included (confirmed by testing --
    not just fapi.*), so a Binance spot price can't be used to convert a
    coin-denominated fallback. OKX gives USD directly and isn't blocked, so it
    goes first; Bybit (also confirmed reachable in some environments, though
    blocked on GitHub Actions) is the last resort, priced via CoinGecko.
    """
    try:
        js = _get("https://fapi.binance.com/futures/data/openInterestHist",
                   {"symbol": symbol, "period": "1d", "limit": 1}, tries=2)
        return float(js[-1]["sumOpenInterestValue"])
    except Exception:
        pass
    try:
        js = _get("https://www.okx.com/api/v5/public/open-interest", {"instId": inst_id_okx}, tries=2)
        return float(js["data"][0]["oiUsd"])
    except Exception:
        pass
    try:
        js = _get("https://api.bybit.com/v5/market/open-interest",
                   {"category": "linear", "symbol": symbol, "intervalTime": "1d", "limit": 1}, tries=2)
        oi_coin = float(js["result"]["list"][0]["openInterest"])
        price = float(_get("https://api.coingecko.com/api/v3/simple/price",
                            {"ids": "bitcoin", "vs_currencies": "usd"}, tries=2)["bitcoin"]["usd"])
        return oi_coin * price
    except Exception:
        return None


def long_short_ratio_live(symbol: str = "BTCUSDT", inst_id_okx: str = "BTC-USDT-SWAP") -> float | None:
    """Accounts long/short ratio (>1 = more accounts long). Binance first, OKX
    and Bybit as fallbacks -- see open_interest_live for why this order."""
    try:
        js = _get("https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
                   {"symbol": symbol, "period": "1d", "limit": 1}, tries=2)
        return float(js[-1]["longShortRatio"])
    except Exception:
        pass
    try:
        js = _get("https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract",
                   {"instId": inst_id_okx, "period": "1D", "limit": 1}, tries=2)
        return float(js["data"][0][1])
    except Exception:
        pass
    try:
        js = _get("https://api.bybit.com/v5/market/account-ratio",
                   {"category": "linear", "symbol": symbol, "period": "1d", "limit": 1}, tries=2)
        row = js["result"]["list"][0]
        return float(row["buyRatio"]) / float(row["sellRatio"])
    except Exception:
        return None


def dvol_live(currency: str = "BTC") -> float | None:
    """Deribit's DVOL — 30-day implied volatility index. Public endpoint, no key."""
    try:
        js = _get("https://www.deribit.com/api/v2/public/get_volatility_index_data",
                   {"currency": currency, "resolution": 86400,
                    "start_timestamp": int((time.time() - 3 * 86400) * 1000),
                    "end_timestamp": int(time.time() * 1000)}, tries=2)
        rows = js["result"]["data"]
        return float(rows[-1][4])  # [ts, open, high, low, close]
    except Exception:
        return None


def us_10y_yield_live() -> float | None:
    """US 10-year Treasury yield, %. Yahoo Finance ^TNX, no key."""
    try:
        js = _get("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX",
                   {"range": "5d", "interval": "1d"}, tries=2)
        return float(js["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception:
        return None


def vix_live() -> float | None:
    """CBOE Volatility Index. Yahoo Finance ^VIX, no key."""
    try:
        js = _get("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX",
                   {"range": "5d", "interval": "1d"}, tries=2)
        return float(js["chart"]["result"][0]["meta"]["regularMarketPrice"])
    except Exception:
        return None


def fed_funds_rate_live() -> float | None:
    """
    Effective Fed Funds Rate, %. FRED (St. Louis Fed) — the one series here that
    needs a free API key (https://fred.stlouisfed.org/docs/api/api_key.html),
    read from the FRED_API_KEY env var. Returns None if the key isn't set, so
    this degrades quietly rather than failing the whole run — the rate only
    moves ~8x/year around FOMC meetings, so a missing day costs little.
    """
    api_key = os.environ.get("FRED_API_KEY")
    if not api_key:
        return None
    try:
        js = _get("https://api.stlouisfed.org/fred/series/observations",
                   {"series_id": "FEDFUNDS", "api_key": api_key, "file_type": "json",
                    "sort_order": "desc", "limit": 1}, tries=2)
        return float(js["observations"][0]["value"])
    except Exception:
        return None


def etf_btc_flow_live() -> dict | None:
    """
    US spot BTC ETF flows via SoSoValue's own JSON endpoint. Undocumented (found
    by testing, not from published API docs) and no key needed — could change
    shape or start requiring auth without notice, so treat as best-effort.
    Farside (the more commonly cited source) blocks plain HTTP with a Cloudflare
    JS challenge and isn't reachable this way at all.
    Returns {"daily_net_flow_usd", "cum_net_flow_usd", "total_net_assets_usd"}.
    """
    try:
        js = _post("https://api.sosovalue.xyz/openapi/v2/etf/currentEtfDataMetrics",
                    {"type": "us-btc-spot"}, tries=2)
        d = js["data"]
        return {
            "daily_net_flow_usd": float(d["dailyNetInflow"]["value"]),
            "cum_net_flow_usd": float(d["cumNetInflow"]["value"]),
            "total_net_assets_usd": float(d["totalNetAssets"]["value"]),
        }
    except Exception:
        return None


def public_company_btc_treasury_live() -> float | None:
    """
    BTC held by publicly traded companies, from bitcointreasuries.net's homepage.
    Plain HTML scrape (regex on the server-rendered category totals) — no API,
    no key, but depends on their markup staying the same shape. Unlike Farside,
    this page isn't behind a Cloudflare JS challenge for a simple GET.
    """
    try:
        r = requests.get("https://bitcointreasuries.net/", headers=UA, timeout=TIMEOUT)
        r.raise_for_status()
        r.encoding = "utf-8"  # the server doesn't declare charset, so requests mis-guesses
        # otherwise, mangling the ₿ symbol just before the number
        m = re.search(r'href="/"[^>]*>.{0,600}?font-btc[^>]*>[^<]{0,6}</span>\s*([\d,]+)', r.text)
        return float(m.group(1).replace(",", "")) if m else None
    except Exception:
        return None


_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]


def next_fomc_meeting_live() -> str | None:
    """
    Next FOMC meeting date (YYYY-MM-DD), scraped from the Fed's own calendar
    page -- plain server-rendered HTML, not behind any block. Meeting dates
    read as "Month DD-DD[*]"; a negative lookbehind skips "Released Month DD,
    YYYY" mentions of minutes/statements, which use the same month-day shape.
    """
    try:
        today = datetime.now(timezone.utc).date()
        r = requests.get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
                          headers=UA, timeout=TIMEOUT)
        r.raise_for_status()
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))

        def meetings_for_year(year):
            i = text.find(f"{year} FOMC Meetings")
            if i == -1:
                return []
            j = text.find(f"{year - 1} FOMC Meetings", i + 10)
            block = text[i:j if j != -1 else i + 3000]
            out = []
            for dm in re.finditer(r"(?<!Released )(" + "|".join(_MONTHS) + r")\s+(\d{1,2})(?:-(\d{1,2}))?\*?", block):
                month = _MONTHS.index(dm.group(1)) + 1
                try:
                    out.append(date(year, month, int(dm.group(2))))
                except ValueError:
                    pass
            return out

        candidates = sorted(set(meetings_for_year(today.year) + meetings_for_year(today.year + 1)))
        upcoming = [d for d in candidates if d >= today]
        return upcoming[0].isoformat() if upcoming else None
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

    f_btc = funding_rate_any("BTCUSDT", "BTCUSDT", "BTC-USDT-SWAP", refresh)
    f_eth = funding_rate_any("ETHUSDT", "ETHUSDT", "ETH-USDT-SWAP", refresh)
    if len(f_btc) and len(f_eth):
        funding = pd.concat([f_btc, f_eth], axis=1).mean(axis=1)
    else:
        funding = f_btc if len(f_btc) else f_eth
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
