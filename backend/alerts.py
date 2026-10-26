"""
Detect the day's significant events from the data the pipeline already produces,
so the daily task knows whether there is anything worth telling the team about.

    python3 backend/alerts.py              # writes data/alerts/<date>.json
    python3 backend/alerts.py --replay 30  # dry run over the last 30 saved days, prints only

Pure arithmetic on data/latest.json, data/history.csv and the saved snapshots in
data/archive/ -- no model judgement in the trigger itself. The daily task adds the
written summary (`messages`) and records what it sent (`posted`) in the same file;
re-running on the same day keeps both.

Events (severity decides whether they are worth a message on their own):
  high    price crosses a multiple of $10,000, the 200-day or 200-week average, or makes a
          new all-time high; a 1-day move of 5%+; a Rally watch signal starts; the
          headline label changes
  medium  price crosses another $5,000 step, the 50-day average, or breaks its prior
          30/90-day high or low; price dipped below (or spiked above) a multiple of $10,000
          during the last 24 hours and came back; Fear & Greed enters an extreme zone; news
          pushes a score across a label threshold
  low     reserved for informational events (none today)
An event already reported in the last 3 days is marked `repeat` and does not trigger a message.
"""
from __future__ import annotations

import json
import sys
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
LATEST = ROOT / "data" / "latest.json"
HISTORY = ROOT / "data" / "history.csv"
ARCHIVE = ROOT / "data" / "archive"
OUT_DIR = ROOT / "data" / "alerts"

ROUND_STEP = 5_000
BIG_ROUND = 10_000
BIG_MOVE_1D = 0.05
REPEAT_DAYS = 3
FNG_LOW, FNG_HIGH = 25, 75
MA_LEVELS = {"ma_200": ("200-day average", "high"), "ma_200w": ("200-week average", "high"), "ma_50": ("50-day average", "medium")}


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def _crossed(prev: float, now: float, level: float):
    """'down' / 'up' when the move from prev to now passes through level, else None."""
    if prev >= level > now:
        return "down"
    if prev <= level < now:
        return "up"
    return None


def detect(cur: dict, closes: pd.Series, prev_snap: dict | None, live: dict | None = None) -> list[dict]:
    """closes = daily closes strictly BEFORE cur['date'] (oldest first)."""
    ev: list[dict] = []
    price = float(cur["price_btc"])
    day = cur["date"]
    if closes.empty:
        return ev
    prev = float(closes.iloc[-1])

    def add(id_, type_, severity, title, **facts):
        ev.append({"id": f"{id_}", "type": type_, "severity": severity, "title": title, "facts": facts})

    # --- round-number crossings
    lo, hi = min(prev, price), max(prev, price)
    first = int(lo // ROUND_STEP) * ROUND_STEP
    for lvl in range(first, int(hi) + ROUND_STEP, ROUND_STEP):
        if lvl <= 0:
            continue
        way = _crossed(prev, price, lvl)
        if way:
            sev = "high" if lvl % BIG_ROUND == 0 else "medium"
            add(f"round:{lvl}:{way}", "level_cross", sev,
                f"BTC {'fell below' if way == 'down' else 'rose above'} {_usd(lvl)}",
                level=lvl, direction=way, price=round(price), previous_close=round(prev))

    # --- average lines (today's value of the line)
    levels = cur.get("levels") or {}
    for key, (name, sev) in MA_LEVELS.items():
        lvl = levels.get(key)
        way = _crossed(prev, price, lvl) if lvl else None
        if way:
            add(f"{key}:{way}", "level_cross", sev,
                f"BTC {'fell below' if way == 'down' else 'rose above'} its {name} ({_usd(lvl)})",
                level=round(lvl), direction=way, price=round(price), previous_close=round(prev), name=name)

    # --- breaking the prior 30 / 90-day range and the all-time high (levels exclude today)
    for n in (30, 90):
        win = closes.iloc[-n:]
        if len(win) < n:
            continue
        if price > win.max():
            add(f"high_{n}d:up", "range_break", "medium", f"BTC broke above its {n}-day high ({_usd(win.max())})",
                level=round(float(win.max())), direction="up", price=round(price))
        elif price < win.min():
            add(f"low_{n}d:down", "range_break", "medium", f"BTC broke below its {n}-day low ({_usd(win.min())})",
                level=round(float(win.min())), direction="down", price=round(price))
    if price > closes.max():
        add("ath:up", "range_break", "high", f"BTC made a new all-time high ({_usd(price)})",
            level=round(float(closes.max())), direction="up", price=round(price))

    # --- big one-day move
    chg = price / prev - 1
    if abs(chg) >= BIG_MOVE_1D:
        add(f"move_1d:{'up' if chg > 0 else 'down'}", "big_move", "high",
            f"BTC {'jumped' if chg > 0 else 'dropped'} {abs(chg) * 100:.1f}% in a day",
            change_pct=round(chg * 100, 1), price=round(price), previous_close=round(prev))

    # --- Rally watch signal starting today
    rw = cur.get("rally_watch") or {}
    epi = rw.get("episode")
    if rw.get("state") in ("rally", "drop") and epi and epi.get("days_ago") == 0:
        word = "Rally" if rw["state"] == "rally" else "Drop"
        add(f"rally_watch:{rw['state']}", "signal", "high",
            f"{word} signal fired: Bitcoin is {rw['ret_7d'] * 100:+.1f}% over 7 days",
            state=rw["state"], ret_7d=rw["ret_7d"], window_days=rw.get("window_days"))

    # --- headline label change
    prev_regime = prev_snap.get("regime") if prev_snap else None
    if prev_regime and cur.get("regime") and prev_regime != cur["regime"]:
        add(f"regime:{cur['regime']}", "label_change", "high",
            f"Headline label changed from {prev_snap.get('headline')} to {cur.get('headline')}",
            before=prev_snap.get("headline"), after=cur.get("headline"))

    # --- Fear & Greed entering an extreme zone
    fng = (cur.get("context") or {}).get("fear_greed")
    pfng = ((prev_snap or {}).get("context") or {}).get("fear_greed")
    if fng is not None and pfng is not None:
        if fng <= FNG_LOW < pfng:
            add("fng:extreme_fear", "mood", "medium", f"Fear & Greed fell into extreme fear ({fng:.0f})", value=fng, previous=pfng)
        elif fng >= FNG_HIGH > pfng:
            add("fng:extreme_greed", "mood", "medium", f"Fear & Greed rose into extreme greed ({fng:.0f})", value=fng, previous=pfng)

    # --- news pushing a score over a label threshold
    if cur.get("news_flag"):
        add(f"news_flag:{day}", "news", "medium", "News moves a score across a headline-label threshold",
            detail=cur["news_flag"])

    # --- a level was breached during the last 24h and price came back (needs the live ticker)
    if live:
        low24, high24 = live.get("low24"), live.get("high24")
        top = min(prev, price)
        bot = max(prev, price)
        if low24 is not None and low24 < top:
            for lvl in range(int(low24 // ROUND_STEP) * ROUND_STEP, int(top) + 1, ROUND_STEP):
                if lvl > 0 and low24 < lvl <= top and lvl % BIG_ROUND == 0:
                    add(f"dip:{lvl}", "intraday", "medium",
                        f"BTC dipped below {_usd(lvl)} in the last 24 hours (low {_usd(low24)}) and recovered",
                        level=lvl, low_24h=round(low24), price=round(price))
        if high24 is not None and high24 > bot:
            for lvl in range(int(bot // ROUND_STEP) * ROUND_STEP, int(high24) + 1, ROUND_STEP):
                if lvl > 0 and bot <= lvl < high24 and lvl % BIG_ROUND == 0:
                    add(f"spike:{lvl}", "intraday", "medium",
                        f"BTC pushed above {_usd(lvl)} in the last 24 hours (high {_usd(high24)}) and pulled back",
                        level=lvl, high_24h=round(high24), price=round(price))
    return ev


def _live_ticker() -> dict | None:
    """24h low/high from Binance. Optional: any failure just means no intraday events."""
    try:
        import requests
        r = requests.get("https://api.binance.com/api/v3/ticker/24hr", params={"symbol": "BTCUSDT"}, timeout=10)
        r.raise_for_status()
        j = r.json()
        return {"low24": float(j["lowPrice"]), "high24": float(j["highPrice"]), "last": float(j["lastPrice"])}
    except Exception:
        return None


def _prev_snapshot(day: str) -> dict | None:
    files = sorted(p for p in ARCHIVE.glob("20??-??-??.json") if p.stem < day)
    return json.loads(files[-1].read_text()) if files else None


def _recent_ids(day: str) -> set[str]:
    start = (_date.fromisoformat(day) - timedelta(days=REPEAT_DAYS)).isoformat()
    ids: set[str] = set()
    for p in OUT_DIR.glob("20??-??-??.json"):
        if start <= p.stem < day:
            ids |= {e["id"] for e in json.loads(p.read_text()).get("events", []) if not e.get("repeat")}
    return ids


def _closes_before(day: str) -> pd.Series:
    h = pd.read_csv(HISTORY, usecols=["date", "close"])
    h = h[h["date"] < day]
    return pd.Series(h["close"].values, index=h["date"])


def run() -> int:
    cur = json.loads(LATEST.read_text())
    day = cur["date"]
    events = detect(cur, _closes_before(day), _prev_snapshot(day), _live_ticker())
    seen = _recent_ids(day)
    for e in events:
        e["repeat"] = e["id"] in seen
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{day}.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    out = {
        "date": day,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "price": round(float(cur["price_btc"])),
        "events": events,
        "notify": any(e["severity"] in ("high", "medium") and not e["repeat"] for e in events),
        "messages": old.get("messages", []),     # written by the daily task
        "posted": old.get("posted", []),         # appended by the daily task after sending
    }
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"{day}: {len(events)} event(s), notify={out['notify']}")
    for e in events:
        print(f"  [{e['severity']}{' repeat' if e['repeat'] else ''}] {e['title']}")
    return 0


def replay(n: int) -> int:
    days = sorted(p.stem for p in ARCHIVE.glob("20??-??-??.json"))[-n:]
    fired = 0
    for day in days:
        cur = json.loads((ARCHIVE / f"{day}.json").read_text())
        ev = detect(cur, _closes_before(day), _prev_snapshot(day), None)
        loud = [e for e in ev if e["severity"] in ("high", "medium")]
        fired += bool(loud)
        for e in ev:
            print(f"{day} [{e['severity']}] {e['title']}")
    print(f"\n{fired} of {len(days)} saved days would have triggered a message")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--replay":
        sys.exit(replay(int(sys.argv[2]) if len(sys.argv) > 2 else 30))
    sys.exit(run())
