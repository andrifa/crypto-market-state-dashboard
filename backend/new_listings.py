"""
Collects everything the daily task needs to write the "New on Reku" part of the Narratives &
altcoins panel: which assets carry the "Baru" tag on reku.id/markets, how they traded, and what
was said about them recently (project posts on X, PANews headlines).

    python3 backend/new_listings.py            # full run -> private/new_listings_raw.json
    python3 backend/new_listings.py --no-x     # skip X (e.g. the login expired)
    python3 backend/new_listings.py --reuse-x  # keep the X posts already in private/x_posts.json
    python3 backend/new_listings.py --days 7   # how far back to look for posts / headlines
    python3 backend/new_listings.py --top 10   # only the first N rows of the New Listings tab (default 10)

Steps (each one degrades on its own; the summary at the end says what was and was not available):
  1. backend/reku_new_listings.js reads the New Listings tab (symbol, name, rupiah price, 24h change).
  2. CoinGecko ids: data/new_listings_map.json holds symbol -> id/x handle. A new symbol is matched on
     CoinGecko by symbol AND by rupiah price (must be within 3% of Reku's own quote), then its official X
     handle is read from CoinGecko. Anything that does not match is listed as `unmatched`, never guessed.
  3. CoinGecko market data (USD): 24h / 7d / 30d change, distance from all-time high, market-cap rank.
  4. backend/x_search.js reads the latest posts of each project's official X account (read-only, the
     logged-in profile from the panews-scraper app; X search itself is blocked for automation).
  5. PANews headlines of the last N days that mention the project's symbol or name.

Raw output stays in private/ (gitignored). The daily task reads it, keeps only what is dated and
sourced, and writes the short items into data/latest.json -> narratives.new_listings.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private"
MAP_FILE = ROOT / "data" / "new_listings_map.json"
CG = "https://api.coingecko.com/api/v3"
UA = {"User-Agent": "Mozilla/5.0"}


def log(msg: str) -> None:
    print(msg, flush=True)


def get(url: str, **kw):
    """GET with one retry after a pause (CoinGecko's free tier rate-limits quickly)."""
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=30, headers=UA, **kw)
            if r.status_code == 429 and attempt < 2:
                time.sleep(45)
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                log(f"  ! {url.split('?')[0]}: {e}")
                return None
            time.sleep(5)
    return None


def reku_listings() -> list[dict]:
    out = PRIVATE / "reku_new_listings.json"
    p = subprocess.run(["node", str(ROOT / "backend" / "reku_new_listings.js"), "--out", str(out)],
                       capture_output=True, text=True, timeout=180)
    if not out.exists():
        raise SystemExit("could not read reku.id/markets: " + (p.stderr or p.stdout)[-300:])
    j = json.loads(out.read_text())
    if not j.get("ok"):
        raise SystemExit("reku.id/markets: " + str(j.get("reason")))
    return j["items"]


def update_map(items: list[dict]) -> tuple[dict, list[str]]:
    """Make sure every listed symbol has a CoinGecko id (price-checked) and an X handle."""
    m = json.loads(MAP_FILE.read_text()) if MAP_FILE.exists() else {}
    todo = [i for i in items if i["symbol"] not in m]
    unmatched: list[str] = []
    if todo:
        log(f"  matching {len(todo)} new symbol(s) on CoinGecko")
        rows = get(f"{CG}/coins/markets", params={
            "vs_currency": "idr", "symbols": ",".join(i["symbol"].lower() for i in todo),
            "include_tokens": "all", "per_page": 250, "order": "market_cap_desc"}) or []
        for it in todo:
            sym, price = it["symbol"], it["price_idr"]
            cands = [c for c in rows if c["symbol"].upper() == sym and c.get("current_price") and price
                     and abs(c["current_price"] / price - 1) <= 0.03]
            if not cands:
                unmatched.append(sym)
                continue
            best = min(cands, key=lambda c: c.get("market_cap_rank") or 10**9)
            time.sleep(2.5)
            d = get(f"{CG}/coins/{best['id']}", params={
                "localization": "false", "tickers": "false", "market_data": "false",
                "community_data": "false", "developer_data": "false", "sparkline": "false"}) or {}
            links = d.get("links") or {}
            m[sym] = {"id": best["id"], "name": it["name"], "x": links.get("twitter_screen_name") or None,
                      "categories": [c for c in (d.get("categories") or []) if c][:3]}
            log(f"    {sym} -> {best['id']} (@{m[sym]['x']})")
        MAP_FILE.write_text(json.dumps(m, indent=2, ensure_ascii=False, sort_keys=True))
    return m, unmatched


def market_data(ids: list[str]) -> dict:
    rows = get(f"{CG}/coins/markets", params={
        "vs_currency": "usd", "ids": ",".join(ids), "per_page": 250,
        "price_change_percentage": "24h,7d,30d"}) or []
    return {r["id"]: r for r in rows}


def x_posts(handles: list[str], days: float) -> dict:
    out = PRIVATE / "x_posts.json"
    if out.exists():
        out.unlink()
    subprocess.run(["node", str(ROOT / "backend" / "x_search.js"), "--profiles", "--days", str(days), "--max", "8",
                    "--out", str(out), *handles], capture_output=True, text=True, timeout=1500)
    if not out.exists():
        return {"ok": False, "reason": "x_search produced no output", "accounts": {}}
    return json.loads(out.read_text())


def panews(days: float) -> list[dict]:
    """PANews headlines of the last `days` days (same open API the panews-scraper app uses)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    items: list[dict] = []
    for skip in range(0, 1500, 50):
        page = get("https://universal-api.panewslab.com/articles",
                   params={"type": "NEWS", "isShowInList": "true", "take": 50, "skip": skip})
        if not isinstance(page, list) or not page:
            break
        stop = False
        for a in page:
            t = datetime.fromisoformat(a["publishedAt"].replace("Z", "+00:00"))
            if t < cutoff:
                stop = True
                continue
            items.append({"id": a["id"], "title": a.get("title") or "", "desc": a.get("desc") or "",
                          "published": t.isoformat(), "url": f"https://www.panews.io/articles/{a['id']}"})
        if stop:
            break
        time.sleep(0.4)
    return items


def mentions(text: str, sym: str, name: str) -> bool:
    if re.search(rf"(?<![A-Za-z0-9])\$?{re.escape(sym)}(?![A-Za-z0-9])", text):
        # short or common-word symbols need the dollar sign or the project name beside them
        if len(sym) > 3 or "$" + sym in text or re.search(re.escape(name), text, re.I):
            return True
    return bool(len(name) > 3 and re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", text, re.I))


def main() -> int:
    args = sys.argv[1:]
    days = float(args[args.index("--days") + 1]) if "--days" in args else 7
    top = int(args[args.index("--top") + 1]) if "--top" in args else 10
    use_x = "--no-x" not in args
    reuse_x = "--reuse-x" in args
    PRIVATE.mkdir(exist_ok=True)

    log("1. Reku New Listings")
    items = reku_listings()
    log(f"  {len(items)} asset(s) on the New Listings tab; using the first {top} (the order shown on the page)")
    items = items[:top]
    # a listing that does not trade at all (price 0) cannot be matched or discussed
    items = [i for i in items if i["price_idr"]]

    log("2. CoinGecko ids and X handles")
    m, unmatched = update_map(items)
    ids = [m[i["symbol"]]["id"] for i in items if i["symbol"] in m]

    log("3. CoinGecko market data")
    time.sleep(20)  # the id lookups above use up the free tier's per-minute allowance
    md = market_data(ids)

    xs: dict = {"ok": False, "reason": "skipped", "accounts": {}}
    if use_x and reuse_x and (PRIVATE / "x_posts.json").exists():
        xs = json.loads((PRIVATE / "x_posts.json").read_text())
        log("4. X posts: reusing private/x_posts.json")
    elif use_x:
        handles = sorted({m[i["symbol"]]["x"] for i in items if i["symbol"] in m and m[i["symbol"]].get("x")})
        log(f"4. X posts from {len(handles)} official account(s) (a few minutes)")
        xs = x_posts(handles, days)
        log(f"  {'ok' if xs.get('ok') else 'not available: ' + str(xs.get('reason'))}")

    log("5. PANews headlines")
    news = panews(days)
    log(f"  {len(news)} headline(s) in the last {days:g} days")

    assets = []
    for it in items:
        sym = it["symbol"]
        info = m.get(sym)
        row = {"symbol": sym, "name": it["name"], "reku": {k: it[k] for k in (
            "price_idr", "change_24h_pct", "volume_coins", "market_cap_idr")}}
        if info:
            c = md.get(info["id"]) or {}
            row.update({
                "coingecko_id": info["id"], "categories": info.get("categories"), "x_handle": info.get("x"),
                "market": {"price_usd": c.get("current_price"), "rank": c.get("market_cap_rank"),
                          "change_24h_pct": c.get("price_change_percentage_24h_in_currency"),
                          "change_7d_pct": c.get("price_change_percentage_7d_in_currency"),
                          "change_30d_pct": c.get("price_change_percentage_30d_in_currency"),
                          "from_ath_pct": c.get("ath_change_percentage"), "ath_date": c.get("ath_date")},
                "x_status": ((xs.get("meta") or {}).get(info.get("x") or "") or {"status": "no_handle" if not info.get("x") else "unknown"}),
                "x_posts": ((xs.get("accounts") or {}).get(info.get("x") or "") or []),
                "panews": [{k: n[k] for k in ("title", "desc", "published", "url")}
                           for n in news if mentions(n["title"] + " " + n["desc"], sym, it["name"])][:6],
            })
        else:
            row["unmatched"] = True
        assets.append(row)

    out = {"fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days,
           "x_ok": bool(xs.get("ok")), "x_reason": xs.get("reason"), "unmatched": unmatched, "assets": assets}
    (PRIVATE / "new_listings_raw.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    for a in assets:
        st = a.get("x_status") or {}
        log(f"  {a['symbol']:9} @{a.get('x_handle') or '-':16} X: {st.get('status', '-'):10} last post {str(st.get('last_post') or '-')[:10]}  "
            f"{len(a.get('x_posts') or [])} recent, {len(a.get('panews') or [])} PANews")
    with_news = [a["symbol"] for a in assets if a.get("x_posts") or a.get("panews")]
    log(f"\nDone: {len(assets)} assets, {len(with_news)} with posts or headlines: {', '.join(with_news) or '-'}")
    if unmatched:
        log(f"Not matched (no CoinGecko coin within 3% of Reku's price): {', '.join(unmatched)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
