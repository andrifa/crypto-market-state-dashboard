/*
 * Reads the assets that carry the "Baru" (new) tag on https://reku.id/markets (New Listings tab).
 * The page is rendered in the browser, so this opens it with Playwright (no login needed).
 *
 *   node backend/reku_new_listings.js [--out private/reku_new_listings.json]
 *
 * Output: { ok, fetched, count, items: [ {symbol, name, price_idr, change_24h_pct, high_24h_idr, low_24h_idr, volume_coins, market_cap_idr} ] }
 * Exit code 0 = ran, 2 = the page or the tab could not be read.
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

const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;

function finish(result, code) {
  const json = JSON.stringify(result, null, 2);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, json); }
  console.log(json);
  process.exit(code);
}

// "Rp4.149" -> 4149, "Rp416,4" -> 416.4, "Rp0" -> 0 (Indonesian number format)
const idr = (s) => parseFloat(s.replace(/[^\d,]/g, "").replace(",", "."));
// "+0,36%" / "-2,21%" / "6,51%" -> number
const pct = (s) => { const n = parseFloat(s.replace("%", "").replace(",", ".")); return isNaN(n) ? null : n; };
// "1.870.218" -> 1870218 (coins traded in 24h)
const count = (s) => parseFloat(s.replace(/\./g, "").replace(",", "."));
// "2,8T" / "966,5B" / "272,2B" / "50,8M" -> rupiah (T trillion, B billion, M million)
const idrCap = (s) => {
  const m = s.match(/^([\d.,]+)\s*([TBM])?$/i);
  if (!m) return null;
  return parseFloat(m[1].replace(/\./g, "").replace(",", ".")) * ({ t: 1e12, b: 1e9, m: 1e6 }[(m[2] || "").toLowerCase()] || 1);
};

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto("https://reku.id/markets", { timeout: 60000, waitUntil: "domcontentloaded" });
    const tab = page.locator("text=New Listings >> visible=true").first();
    await tab.waitFor({ timeout: 30000 });
    await tab.click();
    await page.waitForTimeout(3500);
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== "Baru") continue;
      // desktop layout: Name, Baru, SYMBOL/IDR, price, 24h change, 24h high, 24h low, volume, market cap
      const sym = lines[i + 1] || "", price = lines[i + 2] || "", chg = lines[i + 3] || "";
      if (!/\/IDR$/.test(sym) || !/^Rp/.test(price)) continue;
      items.push({
        symbol: sym.replace("/IDR", ""),
        name: lines[i - 1],
        price_idr: idr(price),
        change_24h_pct: pct(chg),
        high_24h_idr: idr(lines[i + 4] || ""),
        low_24h_idr: idr(lines[i + 5] || ""),
        volume_coins: count(lines[i + 6] || "0"),
        market_cap_idr: idrCap(lines[i + 7] || ""),
      });
    }
    if (!items.length) finish({ ok: false, reason: "no 'Baru' rows found on the New Listings tab", items: [] }, 2);
    finish({ ok: true, fetched: new Date().toISOString(), count: items.length, items }, 0);
  } catch (e) {
    finish({ ok: false, reason: e.message.split("\n")[0], items: [] }, 2);
  } finally {
    await browser.close().catch(() => {});
  }
})();
