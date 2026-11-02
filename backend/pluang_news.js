/*
 * Reads the crypto news list that Pluang publishes at https://pluang.com/news-feed (Crypto filter).
 * Pluang has no RSS and its site refuses plain HTTP clients (Akamai returns 403 to curl/requests), but a
 * real browser session is accepted: this opens the page with Playwright and calls the same public list
 * endpoint the page itself uses, from inside the page. Read-only, no login.
 *
 *   node backend/pluang_news.js [--pages 3] [--out private/pluang_news.json]
 *
 * Output: { ok, fetched, count, items: [ {id, title, summary, publisher, tag, signal, url, age} ] }
 * `age` is Pluang's own relative label ("5 hours ago"); the list is newest first. Exit code 2 = blocked/unreadable.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadPlaywright() {
  for (const p of ["playwright", path.join(os.homedir(), "Documents", "panews-scraper", "node_modules", "playwright")]) {
    try { return require(p); } catch (e) { /* try next */ }
  }
  throw new Error("playwright not found (expected in ~/Documents/panews-scraper/node_modules)");
}

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const OUT = arg("--out", null);
const PAGES = parseInt(arg("--pages", "3"), 10);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function finish(result, code) {
  const json = JSON.stringify(result, null, 2);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, json); }
  console.log(json);
  process.exit(code);
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    // Indonesian locale so titles come back in Bahasa Indonesia, as Pluang's own readers see them
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, locale: "id-ID",
                                         extraHTTPHeaders: { "Accept-Language": "id-ID,id;q=0.9" } });
    await page.goto("https://pluang.com/news-feed", { timeout: 60000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const res = await page.evaluate(async (pages) => {
      const out = [];
      for (let p = 1; p <= pages; p++) {
        const r = await fetch(`https://api-pluang.pluang.com/api/v1/news-service/news/list?assetType=CRYPTO&page=${p}&pageSize=20`);
        if (!r.ok) return { error: "HTTP " + r.status, out };
        const j = await r.json();
        const news = (j.data && j.data.news) || [];
        out.push(...news);
        if (news.length < 20) break;
      }
      return { out };
    }, PAGES);
    const items = (res.out || []).map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.longSummary || "",
      publisher: n.publisher || null,
      tag: (n.tag || [])[0] || null,
      signal: n.signal && n.signal.title || null,
      url: "https://pluang.com/news-feed/" + n.url,
      age: n.timeStamp || null,
    }));
    if (!items.length) finish({ ok: false, reason: res.error || "no items returned", fetched: new Date().toISOString(), items: [] }, 2);
    finish({ ok: true, fetched: new Date().toISOString(), count: items.length, items }, 0);
  } catch (e) {
    finish({ ok: false, reason: e.message.split("\n")[0], fetched: new Date().toISOString(), items: [] }, 2);
  } finally {
    await browser.close().catch(() => {});
  }
})();
