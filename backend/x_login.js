/*
 * Opens a Chrome window on the X login page so a person can log in by hand. The session is saved in the
 * dashboard's own browser profile (default ~/twitter_session/dashboard), which backend/x_search.js then
 * reads with. This script never types a username, password or code: you do that in the window.
 *
 *   node backend/x_login.js [--timeout 600]      wait up to N seconds for the login to finish (default 600)
 *   X_PROFILE=/path/to/profile node backend/x_login.js   use another profile folder
 *
 * Prints "LOGGED_IN @handle" when the login worked, "TIMEOUT" otherwise. To switch to another account later,
 * delete the profile folder (or log out in the window) and run this again.
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

const ti = process.argv.indexOf("--timeout");
const TIMEOUT = (ti > -1 ? parseInt(process.argv[ti + 1], 10) : 600) * 1000;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = process.env.X_PROFILE || path.join(os.homedir(), "twitter_session", "dashboard");

(async () => {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(PROFILE, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      executablePath: CHROME,
      ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: null,
    });
  } catch (e) {
    console.log("ERROR could not open the profile (is another window using it?): " + e.message.split("\n")[0]);
    process.exit(2);
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://x.com/i/flow/login", { timeout: 60000, waitUntil: "domcontentloaded" }).catch(() => {});
  console.log("WINDOW_OPEN log in to X in the Chrome window (profile: " + PROFILE + ")");

  const started = Date.now();
  let handle = null;
  while (Date.now() - started < TIMEOUT) {
    await page.waitForTimeout(2000);
    try {
      const link = await page.$('[data-testid="AppTabBar_Profile_Link"], nav a[aria-label="Profile"]');
      if (link) {
        const href = await link.getAttribute("href");
        if (href) { handle = href.replace(/^\//, ""); break; }
      }
    } catch (e) { /* page navigating */ }
  }
  if (handle) {
    await page.waitForTimeout(4000);          // let the session cookies reach the profile on disk
    console.log("LOGGED_IN @" + handle);
  } else {
    console.log("TIMEOUT no login detected");
  }
  await ctx.close().catch(() => {});
  process.exit(handle ? 0 : 2);
})();
