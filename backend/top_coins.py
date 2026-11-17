"""
Collects what the daily task needs to write the "Top coins" panel of Narratives & altcoins: the ten largest
cryptocurrencies by market cap (stablecoins and wrapped / liquid-staking copies left out), how they traded, and what
was reported about each in the last days (X search, PANews headlines).

    python3 backend/top_coins.py              # -> private/top_coins_raw.json
    python3 backend/top_coins.py --no-x       # skip X (e.g. the login expired)
    python3 backend/top_coins.py --days 3     # how far back to look for posts / headlines (default 3)
    python3 backend/top_coins.py --top 10     # how many coins

Steps (each one degrades on its own; the summary at the end says what was and was not available):
  1. CoinGecko markets (USD, market-cap order) with 24h / 7d / 30d change and distance from the all-time high.
     CoinGecko's stablecoin, yield-bearing stablecoin, wrapped, liquid-staking and tokenized-gold categories are
     removed, and so is anything held near $1 within 3% for 30 days (tokenized loans and funds). Bitcoin stays (it is
     simply the largest) while USDT, USDC, WBTC, stETH and similar are not counted as separate coins.
  2. X search (backend/x_search.js --search): for each coin, posts of the last N days that mention its cashtag or name,
     no replies, at least 25 likes, X's own "top" order. Search is used instead of reading the project's timeline so
     that independent reporting shows up, not only the project's own statements.
  3. PANews headlines of the last N days that mention the symbol or name.

Raw output stays in private/ (gitignored). The daily task keeps only what is dated and sourced and writes the short
lines into data/latest.json -> narratives.top_coins.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from new_listings import CG, ROOT, PRIVATE, get, log, mentions, panews  # noqa: E402

EXCLUDE_CATEGORIES = ("stablecoins", "yield-bearing-stablecoins", "wrapped-tokens", "liquid-staking-tokens", "tokenized-gold")


def category_ids(cat: str) -> set[str]:
    rows = get(f"{CG}/coins/markets", params={"vs_currency": "usd", "category": cat, "per_page": 250,
                                              "order": "market_cap_desc"}) or []
    return {r["id"] for r in rows}


def top_by_market_cap(top: int) -> list[dict]:
    excluded: set[str] = set()
    for cat in EXCLUDE_CATEGORIES:
        excluded |= category_ids(cat)
        time.sleep(2.5)
    rows = get(f"{CG}/coins/markets", params={
        "vs_currency": "usd", "order": "market_cap_desc", "per_page": 60,
        "price_change_percentage": "24h,7d,30d"}) or []
    return [r for r in rows if r["id"] not in excluded and not _pegged(r)][:top]


def _pegged(r: dict) -> bool:
    """A token held near $1 for a month (e.g. a tokenized loan or fund share) behaves like a stablecoin, not like a coin
    to report on. Real coins do not stay within 3% over 30 days."""
    p, m30 = r.get("current_price"), r.get("price_change_percentage_30d_in_currency")
    return p is not None and 0.9 <= p <= 1.1 and m30 is not None and abs(m30) < 3


def x_search(queries: list[str], days: float) -> dict:
    out = PRIVATE / "top_coins_x.json"
    if out.exists():
        out.unlink()
    subprocess.run(["node", str(ROOT / "backend" / "x_search.js"), "--search", "--days", str(days), "--max", "6",
                    "--min-likes", "25", "--sort", "top", "--out", str(out), *queries],
                   capture_output=True, text=True, timeout=1500)
    if not out.exists():
        return {"ok": False, "reason": "x_search produced no output", "accounts": {}}
    return json.loads(out.read_text())


def main() -> int:
    args = sys.argv[1:]
    days = float(args[args.index("--days") + 1]) if "--days" in args else 3
    top = int(args[args.index("--top") + 1]) if "--top" in args else 10
    use_x = "--no-x" not in args
    PRIVATE.mkdir(exist_ok=True)

    log("1. CoinGecko top coins by market cap (stablecoins, wrapped and staked copies removed)")
    coins = top_by_market_cap(top)
    if not coins:
        log("  ! CoinGecko returned nothing")
        return 1
    log("  " + ", ".join(f"{c['symbol'].upper()}" for c in coins))

    queries = {c["id"]: f'${c["symbol"].upper()} OR "{c["name"]}"' for c in coins}
    xs: dict = {"ok": False, "reason": "skipped", "accounts": {}}
    if use_x:
        log(f"2. X search for {len(coins)} coins (a few minutes)")
        xs = x_search(list(queries.values()), days)
        log(f"  {'ok' if xs.get('ok') else 'not available: ' + str(xs.get('reason'))}")

    log("3. PANews headlines")
    news = panews(days)
    log(f"  {len(news)} headline(s) in the last {days:g} days")

    items = []
    for c in coins:
        sym, name = c["symbol"].upper(), c["name"]
        q = queries[c["id"]]
        posts = (xs.get("accounts") or {}).get(q) or []
        items.append({
            "symbol": sym, "name": name, "coingecko_id": c["id"], "rank": c.get("market_cap_rank"),
            "price_usd": c.get("current_price"), "market_cap_usd": c.get("market_cap"),
            "change_24h_pct": c.get("price_change_percentage_24h_in_currency"),
            "change_7d_pct": c.get("price_change_percentage_7d_in_currency"),
            "change_30d_pct": c.get("price_change_percentage_30d_in_currency"),
            "from_ath_pct": c.get("ath_change_percentage"),
            "x_status": (xs.get("meta") or {}).get(q) or {"status": "unknown"},
            "x_posts": [{k: p.get(k) for k in ("time", "author", "text", "url", "likes", "reposts")} for p in posts],
            "panews": [{k: n[k] for k in ("title", "desc", "published", "url")}
                       for n in news if mentions(n["title"] + " " + n["desc"], sym, name)][:5],
        })

    out = {"fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days,
           "x_ok": bool(xs.get("ok")), "x_reason": xs.get("reason"), "coins": items}
    (PRIVATE / "top_coins_raw.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    for i in items:
        log(f"  {i['rank']:>3} {i['symbol']:6} ${i['price_usd']:>12,.2f}  24h {i['change_24h_pct'] or 0:+5.1f}%  "
            f"X {len(i['x_posts'])} posts, PANews {len(i['panews'])}")
    log("\nDone -> private/top_coins_raw.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
