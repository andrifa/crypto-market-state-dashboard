"""
Collects what competing Indonesian exchanges published recently, so the daily task can tell the SEO team
which topics and search phrases the competition is working on.

    python3 backend/competitor_seo.py            # -> private/competitor_raw.json
    python3 backend/competitor_seo.py --days 7   # how far back to look (default 7)

Sources (all public pages, read-only, a few requests per run):
  Pintu   https://pintu.co.id/news          RSS feed https://pintu.co.id/news/rss-feed.xml (the latest ~65 posts)
  Indodax https://indodax.com/academy/artikel/   no RSS and the WordPress API is locked, so: the Yoast sitemap
          (newest post-sitemap, with last-modified times) -> each recent article page -> title, meta description,
          published time and section
  Pluang  https://pluang.com/news-feed     no RSS and the site refuses plain HTTP clients, so backend/pluang_news.js
          reads the crypto list through a real browser session (Crypto filter; the latest ~60 items, about 1-2 days)

Each item gets topic labels from the keyword lists below, so the summary can count what is being covered. The
labels are a simple keyword match on title + description, not a ranking or search-volume figure. Nothing here
knows what Reku itself has published: the SEO team compares the list with Reku's own content.
Each source degrades on its own; `sources` in the output says what was and was not available.
"""
from __future__ import annotations

import html
import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private"
UA = {"User-Agent": "Mozilla/5.0"}

# topic label -> words (matched in lower-case title + description). Order only affects display.
TOPICS = {
    "Harga & prediksi Bitcoin": ["prediksi harga bitcoin", "harga bitcoin", "bitcoin hari ini", "harga btc", "btc turun", "btc naik", "bitcoin turun", "bitcoin naik", "bitcoin anjlok", "bitcoin menguat"],
    "Bitcoin (sejarah, pasokan, whitepaper)": ["whitepaper", "satoshi", "halving", "ditambang", "18 tahun", "sejarah bitcoin"],
    "Keamanan bursa & peretasan": ["hack", "diretas", "peretas", "pencurian", "keamanan", "insiden", "proof of reserve", "bukti cadangan", "cadangan", "exploit", "dicuri", "security"],
    "Binance": ["binance"],
    "ETF & dana institusi": ["etf", "institusi", "strategy", "treasury", "perbendaharaan", "blackrock", "bitmine", "strive"],
    "Altcoin & sinyal": ["altcoin", "sinyal", "rekomendasi", "token unlock", "unlock"],
    "Ethereum": ["ethereum", "eth"],
    "XRP": ["xrp", "ripple"],
    "Solana & L1/L2": ["solana", "avalanche", "layer 2", "layer-2", "sui", "aptos", "cardano"],
    "Meme coin": ["doge", "dogecoin", "shiba", "meme", "pepe"],
    "Stablecoin": ["stablecoin", "usdt", "usdc", "tether"],
    "Whale & arus dana": ["whale", "arus keluar", "arus masuk", "inflow", "outflow", "borong"],
    "Makro, Fed & politik": ["the fed", "suku bunga", "inflasi", "pemilu", "nasdaq", "dolar as", "tarif", "hormuz", "cpi", "pengangguran", "nfp"],
    "Regulasi & pajak": ["ojk", "bappebti", "regulasi", "pajak", "clarity", "sec", "undang-undang", "aturan"],
    "Saham AS & indeks": ["saham", "nasdaq", "s&p", "wall street", "stock"],
    "Kurs & mata uang": ["kurs", "dirham", "won", "yen", "ringgit", "euro"],
    "Edukasi & panduan (cara, apa itu)": ["cara", "apa itu", "panduan", "tutorial", "pengertian", "belajar"],
    "Emas, perak & logam mulia": ["emas", "perak", "antam", "logam mulia"],
    "Review proyek & token": ["review", "ulasan", "proyek", "airdrop", "testnet", "mainnet"],
    "Mining & hardware": ["mining", "penambangan", "antminer", "bitmain", "hashrate"],
    "Produk & bantuan bursa": ["open order", "deposit", "penarikan", "withdraw", "fitur", "cara membatalkan", "cara daftar", "verifikasi"],
}


def log(msg: str) -> None:
    print(msg, flush=True)


def topics_for(text: str) -> list[str]:
    """Whole-word / whole-phrase match, so "eth" does not match "method" and "sec" does not match "second"."""
    t = text.lower()
    return [name for name, words in TOPICS.items()
            if any(re.search(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", t) for w in words)]


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def get(url: str, **kw):
    for attempt in range(2):
        try:
            r = requests.get(url, timeout=30, headers=UA, **kw)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            if attempt == 1:
                log(f"  ! {url}: {e}")
                return None
            time.sleep(3)
    return None


def pintu(cutoff: datetime) -> list[dict]:
    r = get("https://pintu.co.id/news/rss-feed.xml")
    if not r:
        return []
    items = []
    for it in ET.fromstring(r.content).iter("item"):
        when = parsedate_to_datetime(it.findtext("pubDate")).astimezone(timezone.utc)
        if when < cutoff:
            continue
        title, desc = clean(it.findtext("title")), clean(it.findtext("description"))
        items.append({"title": title, "url": it.findtext("link"), "date": when.strftime("%Y-%m-%d"),
                      "description": desc[:300], "section": None})
    return items


def indodax(cutoff: datetime, limit: int = 80) -> list[dict]:
    idx = get("https://indodax.com/academy/sitemap_index.xml")
    if not idx:
        return []
    maps = re.findall(r"<loc>([^<]*post-sitemap\d*\.xml)</loc>", idx.text)
    cands: list[tuple[str, str]] = []
    for sm in maps[-2:]:  # the newest sitemaps hold the newest posts
        r = get(sm)
        if r:
            cands += re.findall(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", r.text)
    cands = [(u, m) for u, m in cands if "/academy/en/" not in u
             and datetime.fromisoformat(m) >= cutoff]
    cands.sort(key=lambda a: a[1], reverse=True)
    items = []
    for url, _ in cands[:limit]:
        r = get(url)
        time.sleep(0.3)
        if not r:
            continue
        h = r.text
        pub = re.search(r'article:published_time" content="([^"]+)', h)
        when = datetime.fromisoformat(pub.group(1)) if pub else None
        if not when or when < cutoff:  # lastmod also moves when an old post is edited
            continue
        title = re.search(r'property="og:title" content="([^"]+)', h)
        desc = re.search(r'name="description" content="([^"]+)', h)
        sec = re.search(r'"articleSection":\[([^\]]+)\]', h)
        items.append({"title": clean(title.group(1)) if title else url, "url": url,
                      "date": when.astimezone(timezone.utc).strftime("%Y-%m-%d"),
                      "description": clean(desc.group(1))[:300] if desc else "",
                      "section": ", ".join(re.findall(r'"([^"]+)"', sec.group(1))) if sec else None})
    return items


def pluang() -> list[dict]:
    out = PRIVATE / "pluang_news.json"
    subprocess.run(["node", str(ROOT / "backend" / "pluang_news.js"), "--out", str(out)],
                   capture_output=True, text=True, timeout=180)
    if not out.exists():
        return []
    j = json.loads(out.read_text())
    if not j.get("ok"):
        log(f"  ! pluang: {j.get('reason')}")
        return []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = []
    for n in j["items"]:
        slug = n["url"].rsplit("/", 1)[-1].replace("-", " ")
        # titles come back in English; the page address is the Indonesian phrase Pluang publishes under
        items.append({"title": n["title"], "url": n["url"], "date": today, "age": n.get("age"),
                      "slug_id": slug, "description": clean(n.get("summary"))[:300], "section": n.get("tag"),
                      "publisher": n.get("publisher")})
    return items


def main() -> int:
    args = sys.argv[1:]
    days = float(args[args.index("--days") + 1]) if "--days" in args else 7
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    PRIVATE.mkdir(exist_ok=True)

    sources: dict[str, dict] = {}
    comps: dict[str, dict] = {}
    for name, fn in (("Pintu", lambda: pintu(cutoff)), ("Indodax", lambda: indodax(cutoff)), ("Pluang", pluang)):
        log(f"{name}")
        items = fn()
        for it in items:
            # title + address phrase + section only: descriptions are long and make the match noisy (Pluang titles are English)
            it["topics"] = topics_for(" ".join([it["title"], it.get("slug_id") or "", it.get("section") or ""]))
        c = Counter(t for it in items for t in it["topics"])
        dates = sorted({it["date"] for it in items})
        sources[name] = {"ok": bool(items), "count": len(items), "from": dates[0] if dates else None, "to": dates[-1] if dates else None}
        # pages that repeat every day with a new date/number ("Harga ... Hari Ini 2 November 2026") are programmatic SEO
        daily = [it for it in items if re.search(r"hari ini", it["title"], re.I)]
        comps[name] = {"count": len(items), "topic_counts": dict(c.most_common()),
                       "daily_template_posts": len(daily), "daily_template_examples": [d["title"] for d in daily[:4]],
                       "items": items}
        log(f"  {len(items)} item(s), {dates[0] if dates else '-'} to {dates[-1] if dates else '-'}; top topics: "
            + ", ".join(f"{k} ({v})" for k, v in c.most_common(4)))

    overall: Counter = Counter()
    who: dict[str, set] = {}
    for name, c in comps.items():
        for t in c["topic_counts"]:
            overall[t] += c["topic_counts"][t]
            who.setdefault(t, set()).add(name)
    out = {"fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days, "sources": sources,
           "topic_overview": [{"topic": t, "posts": n, "competitors": sorted(who[t])} for t, n in overall.most_common()],
           "competitors": comps}
    (PRIVATE / "competitor_raw.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    log("\nDone -> private/competitor_raw.json")
    for t in out["topic_overview"][:8]:
        log(f"  {t['topic']:38} {t['posts']:3} posts  {', '.join(t['competitors'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
