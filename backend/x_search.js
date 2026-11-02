/*
 * Read-only reader of recent posts from X (Twitter) accounts, using the same logged-in Chrome profile
 * as the panews-scraper app (~/twitter_session/persistent). The login stays on this Mac: nothing here
 * stores or prints cookies, and the script never posts, likes or follows.
 *
 *   node backend/x_search.js --profiles [--days 7] [--max 8] [--out private/x_posts.json] handle1 handle2 ...
 *
 * X's search page returns HTTP 404 for automated browsers, but account pages load, so we read each
 * project's own timeline. Pinned posts are skipped (they are old by design); replies are not shown on
 * the main timeline. Output JSON:
 *   { ok, reason?, accounts: { "<handle>": [ {id, time, text, url, repost, likes, replies, reposts} ] },
 *     meta: { "<handle>": { status: "ok" | "not_found" | "suspended" | "restricted" | "error", last_post: ISO time of the newest
 *             non-pinned post even if older than --days (null if none), n_recent } } }
 * status tells an account that does not exist (wrong handle) apart from one that is simply quiet.
 * Exit code 0 = ran, 2 = not logged in / profile locked / blocked (the daily task then skips X and relies
 * on PANews and web search only).
 *
 * Pace: ~8 s per account plus a pause between accounts, so ~25 accounts take about 5 minutes.
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

const args = process.argv.slice(2);
const opt = { days: 7, max: 8, out: null };
const handles = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--days") opt.days = parseFloat(args[++i]);
  else if (args[i] === "--max") opt.max = parseInt(args[++i], 10);
  else if (args[i] === "--out") opt.out = args[++i];
  else if (args[i] === "--profiles") continue;
  else handles.push(args[i].replace(/^@/, ""));
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = path.join(os.homedir(), "twitter_session", "persistent");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(result, code) {
  const json = JSON.stringify(result, null, 2);
  if (opt.out) { fs.mkdirSync(path.dirname(opt.out), { recursive: true }); fs.writeFileSync(opt.out, json); }
  console.log(json);
  process.exit(code);
}

(async () => {
  if (!handles.length) finish({ ok: false, reason: "no handles given", accounts: {} }, 2);
  const { chromium } = loadPlaywright();
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      executablePath: CHROME,
      // Playwright's default --enable-automation flag makes X refuse its data calls; without it the logged-in session works.
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled", "--window-position=1600,0"],
      viewport: null,
    });
  } catch (e) {
    finish({ ok: false, reason: "could not open the X profile (is a panews-scraper window using it?): " + e.message.split("\n")[0], accounts: {} }, 2);
  }

  const result = { ok: true, fetched: new Date().toISOString(), days: opt.days, accounts: {}, meta: {}, errors: {} };
  const cutoff = Date.now() - opt.days * 86400 * 1000;
  try {
    const page = await ctx.newPage();
    for (let hi = 0; hi < handles.length; hi++) {
      const h = handles[hi];
      try {
        await page.goto("https://x.com/" + h, { timeout: 60000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(6000);
        if (/\/i\/flow\/login|\/login/.test(page.url()) || (await page.$('a[href="/login"]'))) {
          result.ok = false;
          result.reason = "X is not logged in on this profile (log in again from the panews-scraper app)";
          break;
        }
        const body = await page.evaluate(() => document.body.innerText.slice(0, 4000));
        let status = "ok";
        if (/this account doesn.t exist|account doesn.t exist|hmm\.\.\.this page doesn.t exist/i.test(body)) status = "not_found";
        else if (/account suspended/i.test(body)) status = "suspended";
        else if (/these posts are protected|this account.s posts are protected/i.test(body)) status = "restricted";
        else if (!(await page.$('article[data-testid="tweet"]')) && /something went wrong/i.test(body)) status = "error";
        if (status !== "ok") {
          result.accounts[h] = [];
          result.meta[h] = { status, last_post: null, n_recent: 0 };
          if (hi < handles.length - 1) await sleep(3000 + Math.random() * 3000);
          continue;
        }
        const seen = new Map();
        let latest = null;
        let idle = 0;
        for (let s = 0; s < 5 && idle < 2; s++) {
          const batch = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
              const ctxt = ((a.querySelector('[data-testid="socialContext"]') || {}).textContent || "");
              if (/pinned/i.test(ctxt)) return;
              const t = a.querySelector("time");
              const link = t && t.closest("a");
              const m = link && link.href.match(/status\/(\d+)/);
              if (!m) return;
              const num = (sel) => ((a.querySelector(sel) || {}).textContent || "0").trim() || "0";
              out.push({
                id: m[1],
                time: t.getAttribute("datetime"),
                text: ((a.querySelector('[data-testid="tweetText"]') || {}).textContent || "").trim(),
                url: link.href.split("?")[0],
                repost: /reposted|retweeted/i.test(ctxt),
                replies: num('[data-testid="reply"]'),
                reposts: num('[data-testid="retweet"]'),
                likes: num('[data-testid="like"]'),
              });
            });
            return out;
          });
          let added = 0;
          for (const tw of batch) {
            if (tw.time && (!latest || tw.time > latest)) latest = tw.time;
            if (!seen.has(tw.id) && new Date(tw.time).getTime() >= cutoff) { seen.set(tw.id, tw); added++; }
          }
          idle = added ? 0 : idle + 1;
          if (seen.size >= opt.max) break;
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(2000 + Math.random() * 1000);
        }
        result.accounts[h] = [...seen.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, opt.max);
        result.meta[h] = { status: "ok", last_post: latest, n_recent: seen.size };
      } catch (e) {
        result.errors[h] = e.message.split("\n")[0];
        result.meta[h] = { status: "error", last_post: null, n_recent: 0 };
      }
      if (hi < handles.length - 1) await sleep(3000 + Math.random() * 3000);
    }
  } catch (e) {
    result.ok = false;
    result.reason = e.message.split("\n")[0];
  }
  try { await ctx.close(); } catch (e) { /* ignore */ }
  finish(result, result.ok ? 0 : 2);
})();
