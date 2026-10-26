"use strict";

/* Crypto Market State — dashboard renderer. Reads data/latest.json + data/history.csv.
   DOM/CSS structure matches dashboard-prototype.html exactly; only the data source
   changed from hardcoded constants to the real backend output. */

const SVGNS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "rect", "line", "text", "circle", "g", "polyline", "title"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const el = (tag, attrs = {}, ...kids) => {
  const e = SVG_TAGS.has(tag) ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  kids.forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(k)));
  return e;
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtUSD = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const fmtUSDm = (n, signed) => (n == null ? "—" : (n < 0 ? "-" : signed ? "+" : "") + "$" + Math.abs(n / 1e6).toFixed(1) + "M");
const fmtUSDb = (n, signed) => (n == null ? "—" : (n < 0 ? "-" : signed ? "+" : "") + "$" + Math.abs(n / 1e9).toFixed(2) + "B");
const fmtBTC = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US") + " BTC");
const fmtPct = (v, d = 0, signed) => (v == null || isNaN(v) ? "—" : (signed && v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%");
const fmtNum = (v, d = 2, signed) => (v == null || isNaN(v) ? "—" : (signed && v > 0 ? "+" : "") + (+v).toFixed(d));
const numStr = (v, d) => (v == null || isNaN(v) ? "—" : (+v).toFixed(d));
const fmtDate = (s) => { const [y, m, d] = s.split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; };

const REG_CLASS = { Bull: "up", Bear: "down", Neutral: "mid", Unknown: "mid" };

/* ---- full 35-indicator catalog, grouped horizon -> category -> items.
   key: null items have no free, reliable live source yet -- shown as "not tracked"
   with the real reason, never guessed. `why` is exposed as a title= tooltip so the
   flat ind-row layout (matching the prototype) doesn't need an expand affordance. */
const CATALOG = [
  { section: "Short-term signals · ~1 week", cats: [
    { name: "Sentiment & Crowd Behavior", items: [
      { label: "Fear & Greed Index", key: "fear_greed", fmt: (v) => numStr(v, 0), note: (v, d) => d.sentiment_band,
        why: "Daily composite of volatility, volume, social media and dominance (Alternative.me)." },
      { label: "Social Volume (X, Reddit)", key: "social_volume", search: true,
        why: "No free metered feed (LunarCrush, Santiment are paid) — the daily routine web-searches for a reported read instead of a precise index." },
    ]},
    { name: "Positioning & Leverage", items: [
      { label: "Funding Rate (z-score)", key: "funding_z", fmt: (v) => fmtNum(v, 2, true), note: (v) => (Math.abs(v) >= 1.5 ? "stretched" : "normal"),
        why: "Cost to hold a leveraged long, standardised against its own recent range." },
      { label: "Open Interest", key: "open_interest_usd", fmt: (v) => fmtUSDb(v), why: "Total value of open futures positions." },
      { label: "Long / Short Ratio", key: "long_short_ratio", fmt: (v) => fmtNum(v, 2), note: (v) => (v > 1 ? "long-tilted" : "short-tilted"),
        why: "Ratio of accounts positioned long vs short on futures." },
      { label: "Liquidation Volume (24h)", key: "liquidation_24h_usd", search: true, fmt: (v) => fmtUSDm(v),
        why: "CoinGlass's own feed needs a paid key — the daily routine web-searches for the figure as reported in news/analytics recaps instead." },
      { label: "Exchange Netflow (7d)", key: "exchange_netflow_7d_btc", search: true, fmt: (v) => fmtBTC(v),
        why: "Needs a paid on-chain provider (CryptoQuant, Glassnode) — the daily routine web-searches for a reported figure instead." },
    ]},
    { name: "Volatility", items: [
      { label: "Realized Vol Percentile (30d)", key: "vol_percentile", fmt: (v) => fmtPct(v, 0), note: (v) => (v >= 0.7 ? "elevated" : "calm"),
        why: "Where 30-day realised volatility sits within its trailing two-year range." },
      { label: "Implied Volatility (DVOL)", key: "dvol", fmt: (v) => fmtNum(v, 1), why: "Deribit's 30-day implied-volatility index." },
      { label: "Bollinger Band Width", key: "bollinger_width", fmt: (v) => fmtPct(v, 1), note: (v) => (v < 0.12 ? "squeeze forming" : v > 0.30 ? "wide / volatile" : "normal"),
        why: "(Upper − lower) / middle band, 20-day SMA ± 2 std-dev. Narrow readings often precede a sharp move either way." },
    ]},
    { name: "Catalysts & Events", items: [
      { label: "Macro Calendar", key: "next_fomc_meeting", fmt: (v) => new Date(v + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), note: () => "next FOMC",
        why: "Scraped from the Fed's own published meeting calendar (federalreserve.gov)." },
      { label: "Raw News Headlines", key: "headlines", search: true, headlines: true,
        why: "The daily routine web-searches for today's major BTC headlines and lists them with their source." },
      { label: "VIX", key: "vix", fmt: (v) => fmtNum(v, 1), why: "CBOE equity volatility index — a read on broader risk appetite." },
    ]},
  ]},
  { section: "Medium-term signals · ~1 month", cats: [
    { name: "Momentum", items: [
      { label: "Weekly RSI", key: "rsi_weekly", fmt: (v) => numStr(v, 0), note: (v) => (v >= 70 ? "overbought" : v <= 35 ? "oversold" : "neutral"),
        why: "Relative Strength Index on a weekly candle." },
      { label: "90-Day Rate of Change", key: "roc_90d", fmt: (v) => fmtPct(v, 0, true), why: "Price now vs. 90 days ago." },
      { label: "Breadth (% days > MA200)", key: "breadth_90d", fmt: (v) => fmtPct(v, 0), why: "Share of the last 90 days closing above the 200-day average." },
      { label: "50/200-Day MA Cross", key: "ma_cross", fmt: (v) => fmtPct(v, 1, true), note: (v) => (v > 0 ? "golden-cross side" : "death-cross side"),
        why: "Gap between the 50-day and 200-day averages." },
    ]},
    { name: "On-Chain Demand", items: [
      { label: "Active Address Ratio", key: "active_addr_ratio", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 1 ? "expanding" : "contracting"),
        why: "Daily active addresses vs. their own 365-day average." },
      { label: "Onchain / Spot Volume", key: "onchain_volume_usd", search: true, fmt: (v) => fmtUSDb(v),
        why: "Needs a paid on-chain volume feed — the daily routine web-searches for a reported figure instead." },
      { label: "Whale / Large-Holder Supply", key: "whale_supply_pct", search: true, fmt: (v) => fmtPct(v / 100, 1),
        why: "Needs a paid on-chain provider (wallet-cluster data) — the daily routine web-searches for a reported figure instead." },
    ]},
    { name: "Sentiment (Aggregate)", items: [
      { label: "Stablecoin Supply Ratio", key: "ssr", fmt: (v) => fmtNum(v, 2), why: "BTC market cap divided by total stablecoin supply." },
    ]},
    { name: "Macro & Market Structure", items: [
      { label: "BTC Dominance", key: "btc_dominance", fmt: (v) => fmtPct(v / 100, 1), why: "Bitcoin's share of total crypto market cap." },
      { label: "Fed Funds Rate", key: "fed_funds_rate", fmt: (v) => fmtPct(v / 100, 2), why: "US policy rate (FRED)." },
      { label: "Spot BTC ETF Flow (1d)", key: "etf_daily_net_flow_usd", fmt: (v) => fmtUSDm(v, true), why: "Net daily flow into US spot BTC ETFs." },
    ]},
  ]},
  { section: "Long-term signals · ~3–6 months", cats: [
    { name: "Price Trend Structure", items: [
      { label: "Mayer Multiple", key: "mayer_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 1 ? "above trend" : "below trend"),
        why: "Price divided by the 200-day average." },
      { label: "MA200 Slope (90d)", key: "ma200_slope_90d", fmt: (v) => fmtPct(v, 1, true), note: (v) => (v >= 0 ? "rising" : "falling"),
        why: "Change in the 200-day average itself over 90 days." },
      { label: "Pi-Cycle Top Gap", key: "pi_cycle_gap", fmt: (v) => fmtPct(v, 1, true), why: "SMA111 vs. 2×SMA350 — historically crosses near cycle tops." },
    ]},
    { name: "Cycle Valuation", items: [
      { label: "200-Week Multiple", key: "ma_200w_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 3 ? "stretched" : v <= 1.1 ? "near the floor" : "mid-cycle"),
        why: "Price vs. its 200-week (~4-year) average." },
      { label: "Puell Multiple", key: "puell_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v <= 0.6 ? "miner capitulation" : v >= 3 ? "miner euphoria" : "normal"),
        why: "Daily miner revenue vs. its 365-day average." },
      { label: "Short-Term Holder Cost Basis", key: "sth_cost_basis_usd", search: true, fmt: (v) => fmtUSD(v),
        why: "Needs a paid on-chain provider (UTXO-age data) — the daily routine web-searches for a reported figure instead." },
      { label: "LTH vs. STH Supply", key: "lth_sth_supply_ratio", search: true, fmt: (v) => fmtNum(v, 2),
        why: "Needs a paid on-chain provider (UTXO-age data) — the daily routine web-searches for a reported figure instead." },
      { label: "Drawdown from ATH", key: "drawdown_from_ath", fmt: (v) => fmtPct(v, 0), why: "How far below the all-time high price currently sits." },
    ]},
    { name: "Macro & Institutional", items: [
      { label: "US 10-Year Yield", key: "us_10y_yield", fmt: (v) => fmtPct(v / 100, 2), why: "Benchmark long-term US rate." },
      { label: "Corporate Treasury Holdings", key: "public_company_btc_treasury", fmt: (v) => fmtBTC(v), why: "BTC held by publicly traded companies (bitcointreasuries.net)." },
      { label: "Spot BTC ETF Flow (cumulative)", key: "etf_cum_net_flow_usd", fmt: (v) => fmtUSDb(v, true), why: "All-time net flow into US spot BTC ETFs since launch." },
    ]},
  ]},
];

async function main() {
  let d, hist, bt = null, idx = null;
  const want = new URLSearchParams(location.search).get("date");
  try { idx = await fetch("data/archive/index.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)); } catch (e) { /* archive is optional */ }
  let file = "data/latest.json", viewing = null;
  if (want && idx && idx.dates.length) {
    const before = idx.dates.filter((x) => x <= want);
    viewing = before.length ? before[before.length - 1] : idx.dates[0];   // closest day on or before, else the earliest saved
    if (viewing === idx.dates[idx.dates.length - 1]) viewing = null;   // newest saved day = today's page
    else file = `data/archive/${viewing}.json`;
  }
  try {
    const [a, b] = await Promise.all([
      fetch(file, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.json(); }),
      fetch("data/history.csv", { cache: "no-store" }).then((r) => r.text()),
    ]);
    d = a; hist = parseCSV(b);
  } catch (e) {
    document.getElementById("app").innerHTML = `<p class="err">Failed to load data: ${e.message}</p>`;
    return;
  }
  if (viewing) { AS_OF = Date.parse(d.date + "T12:00:00Z"); hist = hist.filter((r) => r.date <= d.date); }
  try { bt = await fetch("data/backtest.json", { cache: "no-store" }).then((r) => r.json()); } catch (e) { /* optional */ }
  renderTimebar(d, idx, viewing, want);

  const k = REG_CLASS[d.regime] || "mid";
  document.getElementById("brandDot").style.background =
    k === "up" ? "var(--teal-deep)" : k === "down" ? "var(--bear)" : "var(--purple)";
  document.getElementById("stamp").textContent =
    viewing ? `${fmtDate(d.date)} · saved snapshot` : `${fmtDate(d.date)} · updated ${(d.updated_utc || "").replace("T", " ").replace("Z", " UTC")}`;

  renderHero(d, k);
  renderOutlook(d, k, bt);
  renderHeat(hist);
  renderAnalysis(d);
  renderTriggers(d);
  renderNews(d);
  renderNarratives(d);
  renderTeams(d);
  renderSignals(d);
  renderScorecard(bt);
  renderMethodology();
  renderGlossary(d);
  buildNav();
  document.getElementById("footer").textContent = d.disclaimer || "";

  renderHalvingProgress();
  renderRangeButtons();
  renderChart(hist);
}

function parseCSV(txt) {
  const [head, ...rows] = txt.trim().split("\n");
  const cols = head.split(",");
  return rows.map((ln) => {
    const v = ln.split(","); const o = {};
    cols.forEach((c, i) => (o[c] = v[i]));
    ["close", "conviction", "trend_score", "momentum_score", "sentiment_score"].forEach((x) => (o[x] = +o[x]));
    return o;
  });
}

/* ------------------------------- hero ---------------------------- */
/* -------------------------- time travel: open any saved day -------------------------------------- */
function renderTimebar(d, idx, viewing, want) {
  const box = document.getElementById("timebar"), rail = document.getElementById("sidenav");
  if (!idx || !idx.dates.length) { box.remove(); return; }
  const first = idx.dates[0], latest = idx.dates[idx.dates.length - 1];
  const go = (date) => { location.search = !date || date >= latest ? "" : `?date=${date}`; };
  // the same picker lives in two places: above the page (narrow screens) and at the top of the
  // right-hand navigation rail (wide screens), so it stays in view while you scroll
  const picker = (suffix) => {
    const id = "pickDate" + suffix;
    const input = el("input", { type: "date", id, value: d.date, min: first, max: latest });
    input.addEventListener("change", () => { if (input.value) go(input.value); });
    const parts = [el("label", { for: id, text: "View a past day:" }), input];
    if (viewing) {
      const back = el("button", { class: "rng", type: "button" }, "Back to latest");
      back.addEventListener("click", () => go(null));
      parts.push(back);
    }
    parts.push(el("span", { class: "count", text: viewing
      ? `Saved page from ${fmtDate(d.date)}`
      : `${idx.dates.length} saved days (${fmtDate(first)} – ${fmtDate(latest)})` }));
    return parts;
  };
  box.append(el("div", { class: "tb-pick" }, ...picker("")));
  if (rail) rail.prepend(el("div", { class: "nav-date" }, ...picker("Rail")));
  if (viewing) {
    const note = want && want !== viewing
      ? ` There is no saved snapshot for ${fmtDate(want)}, so this is the closest ${want < first ? "later" : "earlier"} day.` : "";
    box.append(el("p", { class: "timebar-banner", html:
      `You are looking at the saved page from <b>${fmtDate(d.date)}</b>, not today's data. The price chart and score history stop at that day.${note} The backtest scorecard further down is always the current one.` }));
  }
}

function renderHero(d, k) {
  const hero = document.getElementById("hero");
  hero.textContent = "";
  hero.append(el("div", { class: "hero-top" },
    el("div", {},
      el("p", { class: "regime " + k, text: d.headline || "—" }),
      el("div", { class: "regime-tag", text: d.headline_tag || "" }),
      el("span", { class: "conf-tag " + (d.conviction_level || ""), text: "Overall confidence: " + (d.conviction_level || "—") })),
    el("div", { class: "asof" }, fmtUSD(d.price_btc), el("br"), "BTC · as of " + fmtDate(d.date))));

  if (d.action && d.action.title) {
    hero.append(el("div", { class: "takeaway", style: "margin-top:16px" },
      el("b", { text: "Budget action — " + d.action.title }), d.action.detail || ""));
  }
}

/* -------------------------- outlook (real trend/momentum/sentiment, ordered near->far) ---- */
/* Historical base-rate note per outlook row, computed from backtest.json's own
   already-disclosed regime/conviction tables -- a real hit rate from the
   2014-onward sample, not an invented probability. Framed as a historical
   pattern, not a promise: this dashboard is trailing by design, so any
   forward-looking note has to be an empirical base rate with its sample size
   attached, never a bare "will happen" statement. */
function convictionBand(conv) {
  if (conv == null) return null;
  if (conv < 40) return "low <40";
  if (conv < 60) return "mid 40-60";
  return "high >=60";
}
function historicalNote(bt, regime, conviction, horizonDays, horizonLabel) {
  if (!bt || !bt.regime) return "";
  const reg = bt.regime[String(horizonDays)] && bt.regime[String(horizonDays)][regime];
  if (!reg || reg.n < 30) return "";
  let s = `Historically, ${regime.toLowerCase()}-regime days like today's saw price higher ${horizonLabel} later ${Math.round(reg.win * 100)}% of the time (average move ${reg.mean >= 0 ? "+" : ""}${Math.round(reg.mean * 100)}%, from ${reg.n.toLocaleString()} such days since 2014).`;
  if ((regime === "Bull" || regime === "Bear") && horizonDays === 90 && bt.conviction) {
    const band = convictionBand(conviction);
    const cv = band && bt.conviction[band];
    if (cv && cv.n >= 30) {
      s += ` At today's conviction level, that same 90-day hit rate (in the regime's own direction) has run ${Math.round(cv.win * 100)}% historically (n=${cv.n.toLocaleString()}).`;
    }
  }
  s += " A historical pattern, not a guarantee — this covers ~2.9 market cycles.";
  return s;
}

/* -------------------------- score history: calendar + by-month views --------------------------------- */
const HEAT_TABS = [
  { key: "label", name: "Summary", sub: "headline label" },
  { key: "sentiment_score", name: "Short-term", sub: "mood" },
  { key: "momentum_score", name: "Medium-term", sub: "momentum" },
  { key: "trend_score", name: "Long-term", sub: "trend" },
];
// five bands, same words the analysis uses
const BANDS = [
  { id: "sb", word: "Strongly bullish", c: "var(--teal)", o: 0.95 },
  { id: "bl", word: "Bullish-leaning", c: "var(--teal)", o: 0.45 },
  { id: "n", word: "Neutral", c: "var(--muted)", o: 0.28 },
  { id: "br", word: "Bearish-leaning", c: "var(--bear)", o: 0.45 },
  { id: "sr", word: "Strongly bearish", c: "var(--bear)", o: 0.95 },
];
const LABEL_BANDS = {
  Bull: { word: "BULLISH", c: "var(--teal)", o: 0.75 },
  Neutral: { word: "NEUTRAL", c: "var(--purple-2)", o: 0.6 },
  Bear: { word: "BEARISH", c: "var(--bear)", o: 0.75 },
};
const bandOf = (v) => (v >= 0.45 ? BANDS[0] : v >= 0.15 ? BANDS[1] : v <= -0.45 ? BANDS[4] : v <= -0.15 ? BANDS[3] : BANDS[2]);
let heatTab = "label", heatView = "cal", heatMonths = 6, HEAT_DATA = [];

function renderHeat(hist) {
  if (hist) HEAT_DATA = hist;
  const root = document.getElementById("heat");
  const rows = HEAT_DATA.filter((r) => r.date);
  if (!rows.length) { root.remove(); return; }
  const tab = HEAT_TABS.find((t) => t.key === heatTab);
  const isLabel = heatTab === "label";
  const btns = (box, defs, cur, set) => {
    box.textContent = "";
    defs.forEach(([val, text]) => {
      const b = el("button", { class: "rng" + (cur === val ? " on" : "") }, text);
      b.addEventListener("click", () => { set(val); renderHeat(); });
      box.append(b);
    });
  };
  btns(document.getElementById("heatTabs"), HEAT_TABS.map((t) => [t.key, t.sub ? `${t.name} · ${t.sub}` : t.name]), heatTab, (v) => (heatTab = v));
  btns(document.getElementById("heatView"), [["cal", "Calendar"], ["month", "By month"]], heatView, (v) => (heatView = v));
  const rng = document.getElementById("heatRange");
  rng.textContent = "";
  if (heatView === "cal") btns(rng, [[3, "3M"], [6, "6M"], [12, "12M"]], heatMonths, (v) => (heatMonths = v));

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const valOf = (r) => (isLabel ? r.regime : r[tab.key]);
  const bandFor = (r) => {
    if (!r) return null;
    const v = valOf(r);
    if (isLabel) return v ? LABEL_BANDS[v] : null;
    return Number.isFinite(v) ? bandOf(v) : null;
  };
  const tipFor = (r) => {
    const v = valOf(r);
    return isLabel ? `${fmtDate(r.date)}\nSummary (headline label): ${LABEL_BANDS[v].word}`
      : `${fmtDate(r.date)}\n${tab.name} (${tab.sub}): ${v >= 0 ? "+" : ""}${v.toFixed(2)} — ${bandOf(v).word.toLowerCase()}`;
  };

  // ---- plain-words streak line ----
  const streak = document.getElementById("heatStreak");
  const key3 = (r) => {
    const v = valOf(r);
    if (isLabel) return v || null;
    if (!Number.isFinite(v)) return null;
    return v >= 0.15 ? "bullish-leaning" : v <= -0.15 ? "bearish-leaning" : "neutral";
  };
  const seq = rows.map((r) => ({ d: r.date, k: key3(r) })).filter((x) => x.k);
  const LBL = { Bull: "BULLISH", Neutral: "NEUTRAL", Bear: "BEARISH" };
  const say = (k) => (isLabel ? LBL[k] : k);
  if (seq.length) {
    const curK = seq[seq.length - 1].k;
    let i = seq.length - 1;
    while (i > 0 && seq[i - 1].k === curK) i--;
    const n = seq.length - i;
    let msg = `<b>${tab.name}${tab.sub ? " (" + tab.sub + ")" : ""}</b> is <b>${say(curK)}</b> ${AS_OF ? "on this day, and had been" : "today, and has been"} for ${n} day${n === 1 ? "" : "s"} (since ${fmtDate(seq[i].d)}).`;
    if (i > 0) {
      const prevK = seq[i - 1].k;
      let j = i - 1;
      while (j > 0 && seq[j - 1].k === prevK) j--;
      const m = i - j;
      msg += ` Before that it was ${say(prevK)} for ${m >= 60 ? "about " + Math.round(m / 30) + " months" : m + " day" + (m === 1 ? "" : "s")} (${fmtDate(seq[j].d)} – ${fmtDate(seq[i - 1].d)}).`;
    }
    streak.innerHTML = msg;
  } else streak.textContent = "";

  const body = document.getElementById("heatBody");
  body.textContent = "";
  const last = rows[rows.length - 1].date;
  const lastD = new Date(last + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);

  if (heatView === "cal") {
    const wrap = el("div", { class: "cal" + (heatMonths === 12 ? " m12" : "") });
    for (let m = heatMonths - 1; m >= 0; m--) {
      const first = new Date(Date.UTC(lastD.getUTCFullYear(), lastD.getUTCMonth() - m, 1));
      const nDays = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      const grid = el("div", { class: "cal-grid" });
      ["M", "T", "W", "T", "F", "S", "S"].forEach((x) => grid.append(el("div", { class: "cal-dow", text: x })));
      const offset = (first.getUTCDay() + 6) % 7;                       // Monday first
      for (let k = 0; k < offset; k++) grid.append(el("div", { class: "cal-cell blank" }));
      for (let day = 1; day <= nDays; day++) {
        const ds = iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day)));
        const r = ds <= last ? byDate.get(ds) : null;
        const band = bandFor(r);
        const cell = el("div", { class: "cal-cell" + (ds === last ? " today" : ""), title: band ? tipFor(r) : "" }, el("span", { text: String(day) }));
        if (band) cell.setAttribute("style", `--c:${band.c};--o:${band.o}`);
        grid.append(cell);
      }
      wrap.append(el("div", { class: "cal-month" },
        el("h5", { text: first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) }), grid));
    }
    body.append(wrap);
  } else {
    const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))];
    const grid = el("div", { class: "mg" });
    grid.append(el("div", {}));
    "JFMAMJJASOND".split("").forEach((x) => grid.append(el("div", { class: "mg-h", text: x })));
    years.forEach((y) => {
      grid.append(el("div", { class: "mg-y", text: y }));
      for (let mo = 1; mo <= 12; mo++) {
        const pre = `${y}-${String(mo).padStart(2, "0")}`;
        const rs = rows.filter((r) => r.date.startsWith(pre) && bandFor(r));
        const cell = el("div", { class: "mg-cell" });
        if (rs.length) {
          let band, tip;
          if (isLabel) {
            const cnt = {}; rs.forEach((r) => (cnt[r.regime] = (cnt[r.regime] || 0) + 1));
            const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
            band = LABEL_BANDS[top];
            tip = `${pre}: mostly ${band.word} (${Math.round((cnt[top] / rs.length) * 100)}% of ${rs.length} days)`;
          } else {
            const vs = rs.map((r) => r[tab.key]);
            const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
            const share = (f) => Math.round((vs.filter(f).length / vs.length) * 100);
            band = bandOf(avg);
            tip = `${new Date(pre + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}: ${band.word.toLowerCase()} on average (${avg >= 0 ? "+" : ""}${avg.toFixed(2)}). ` +
              `${share((v) => v >= 0.15)}% of days bullish-leaning or stronger, ${share((v) => v > -0.15 && v < 0.15)}% neutral, ${share((v) => v <= -0.15)}% bearish-leaning or stronger.`;
          }
          cell.setAttribute("style", `--c:${band.c};--o:${band.o}`);
          cell.setAttribute("title", tip);
        }
        grid.append(cell);
      }
    });
    body.append(grid);
  }

  const lg = document.getElementById("heatLegend");
  lg.textContent = "";
  (isLabel ? Object.values(LABEL_BANDS) : [...BANDS].reverse()).forEach((b) =>
    lg.append(el("span", {}, el("i", { style: `--c:${b.c};--o:${b.o}` }), b.word)));
  lg.append(el("span", {}, el("i", {}), isLabel ? "No data" : "No data yet"));
  document.getElementById("heatNote").textContent = heatView === "cal"
    ? `Each square is one day; the outlined square is ${AS_OF ? "the day you are viewing" : "today"}. Hover a day for its value. These are the model's own scores, so news adjustments are not in this history.`
    : "Each square is one month, coloured by its average. Hover for how many days were bullish, neutral or bearish. These are the model's own scores, so news adjustments are not in this history.";
}

function renderOutlook(d, k, bt) {
  const c = d.context || {}, s = d.scores || {};
  const conf = d.conviction_level || "MEDIUM";
  const rows = [
    { h: "Short-term", sub: "sentiment · ~1 week", dim: "sentiment", key: "short", score: s.sentiment, horizon: 30, horizonLabel: "30 days",
      text: c.fear_greed != null
        ? `Fear &amp; Greed reads <b>${numStr(c.fear_greed, 0)} (${d.sentiment_band || "—"})</b>, funding sits at a <b>${fmtNum(c.funding_z, 2, true)}</b> z-score, and the stablecoin supply ratio is <b>${fmtNum(c.ssr, 2)}</b>.`
        : "Sentiment inputs unavailable today." },
    { h: "Medium-term", sub: "momentum · ~1 month", dim: "momentum", key: "medium", score: s.momentum, horizon: 90, horizonLabel: "90 days",
      text: c.rsi_weekly != null
        ? `Weekly RSI is <b>${numStr(c.rsi_weekly, 0)}</b>, the 90-day rate of change is <b>${fmtPct(c.roc_90d, 0, true)}</b>, and breadth is <b>${fmtPct(c.breadth_90d, 0)}</b> of the last 90 days above the 200-day average.`
        : "Momentum inputs unavailable today." },
    { h: "Long-term", sub: "trend · ~3–6 months", dim: "trend", key: "long", score: s.trend, horizon: 180, horizonLabel: "180 days",
      text: c.mayer_multiple != null
        ? `Price is <b>${c.mayer_multiple >= 1 ? "above" : "below"}</b> its 200-day average (Mayer Multiple <b>${fmtNum(c.mayer_multiple, 2)}</b>), which is itself <b>${c.ma200_slope_90d >= 0 ? "rising" : "falling"}</b> (${fmtPct(c.ma200_slope_90d, 1, true)} over 90 days). The 200-week multiple is <b>${fmtNum(c.ma_200w_multiple, 2)}</b>.`
        : "Trend inputs unavailable today." },
  ];
  const box = document.getElementById("outlook");
  box.textContent = "";
  rows.forEach((o) => {
    const score = clamp(o.score ?? 0, -1, 1);
    const pct = ((score + 1) / 2) * 100;
    const color = score > 0.15 ? "var(--teal-deep)" : score < -0.15 ? "var(--bear)" : "var(--purple-2)";
    const note = historicalNote(bt, d.regime, d.conviction, o.horizon, o.horizonLabel);
    const adj = d.news_adjustment && d.news_adjustment[o.dim];
    const nsum = d.news_impact && d.news_impact.summary && d.news_impact.summary[o.key];
    // the momentum score looks back 90 days; say so when the last few weeks point the other way
    const rc = d.recent;
    let recentNote = "";
    if (rc && o.dim === "momentum" && Math.abs(rc.vs_ma50_pct) >= 0.005) {
      const gap = Math.abs(rc.vs_ma50_pct * 100).toFixed(1);
      if (rc.vs_ma50_pct < 0 && score > 0.15)
        recentNote = `Heads up: this score looks back 90 days. The last few weeks are softer: price is ${gap}% below its 50-day average${rc.days_below_ma50 > 1 ? ` (${rc.days_below_ma50} days in a row)` : ""} and ${Math.abs(rc.from_high_30d * 100).toFixed(1)}% below its 30-day high, so the coming weeks are less clear-cut than the number suggests.`;
      else if (rc.vs_ma50_pct > 0 && score < -0.15)
        recentNote = `Heads up: this score looks back 90 days. The last few weeks are better: price is ${gap}% above its 50-day average and ${Math.abs(rc.from_high_30d * 100).toFixed(1)}% below its 30-day high, so the coming weeks may be less weak than the number suggests.`;
    }
    const newsNote = adj ? `News effect on this score: ${adj > 0 ? "+" : ""}${adj.toFixed(2)}${nsum ? " — " + nsum : ""}` : "";
    box.append(el("div", { class: "outlook-row" },
      el("div", { class: "outlook-head" },
        el("div", { class: "h" }, o.h, el("span", { text: o.sub })),
        el("span", { class: "conf-tag " + conf, text: conf })),
      el("div", { class: "spectrum" }, el("div", { class: "mark", style: `left:${pct}%; color:${color}` })),
      el("div", { class: "spectrum-labels" }, el("span", { text: "Bearish" }), el("span", { text: "Neutral" }), el("span", { text: "Bullish" })),
      el("p", { class: "scenario", html: o.text }),
      recentNote ? el("p", { class: "scenario outlook-recent", text: recentNote }) : "",
      newsNote ? el("p", { class: "scenario outlook-news " + (adj > 0 ? "pos" : "neg"), text: newsNote }) : "",
      note ? el("p", { class: "scenario outlook-hist", text: note }) : ""));
  });
}

/* -------------------------- analysis: reasons + watch + levels ---------------------- */
function renderAnalysis(d) {
  const box = document.getElementById("analysis");
  box.textContent = "";

  // 1. the one-line takeaway and the prices to watch come first, so they are not missed
  if (d.watch) box.append(el("div", { class: "takeaway" }, el("b", { text: "Key takeaway" }), d.watch));
  const c = d.context || {}, price = d.price_btc;
  const levels = [];
  if (price != null && c.drawdown_from_ath != null) levels.push([fmtUSD(price / (1 + c.drawdown_from_ath)), "all-time high"]);
  if (price != null && c.mayer_multiple) levels.push([fmtUSD(price / c.mayer_multiple), "200-day moving average"]);
  if (price != null && c.ma_200w_multiple) levels.push([fmtUSD(price / c.ma_200w_multiple), "200-week moving average"]);
  levels.push([fmtUSD(price), "spot price — " + (AS_OF ? "that day" : "today")]);
  box.append(el("p", { class: "levels-head", text: "Prices to watch" }));
  const lv = el("div", { class: "levels" });
  levels.forEach(([v, lab]) => lv.append(el("div", { class: "level" }, el("b", { text: v }), el("span", { text: lab }))));
  box.append(lv);

  // 2. one labelled row per timeframe (the daily write-up is always short, medium, long in that order)
  const TF = [["Short term", "about 1 week"], ["Medium term", "about 1 month"], ["Long term", "3–6 months"]];
  if (d.analysis && d.analysis.length) {
    const labelled = d.analysis.length === TF.length;
    d.analysis.forEach((p, i) => {
      if (!labelled) { box.append(el("p", { html: p })); return; }
      box.append(el("div", { class: "drv" },
        el("div", { class: "drv-label" }, el("b", { text: TF[i][0] }), el("span", { text: TF[i][1] })),
        el("p", { html: p })));
    });
    if (labelled) box.append(el("p", { class: "drv-foot", html: 'Each timeframe always looks at the same indicators — see the <a href="#sec-glossary">glossary</a> for which ones and how to read them.' }));
  } else if (d.reasons && d.reasons.length) {
    const ul = el("ul");
    d.reasons.forEach((r) => ul.append(el("li", { text: r })));
    box.append(ul);
  }
}


/* -------------------------- section navigation -------------------------------------------------- */
function buildNav() {
  const nav = document.getElementById("sidenav");
  if (!nav) return;
  nav.querySelectorAll("a, .sep").forEach((x) => x.remove());   // keep the date picker at the top of the rail
  const bar = document.querySelector(".appbar");
  const setBar = () => document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px");
  setBar();
  if (window.ResizeObserver) new ResizeObserver(setBar).observe(bar);

  const panels = [...document.querySelectorAll(".panel[data-nav]")];
  const links = new Map();
  let appendix = false;
  panels.forEach((p) => {
    if (p.dataset.group === "appendix" && !appendix) { appendix = true; nav.append(el("span", { class: "sep", text: "Appendix" })); }
    const a = el("a", { href: "#" + p.id, text: p.dataset.nav });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      p.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", location.search + "#" + p.id);
    });
    links.set(p, a);
    nav.append(a);
  });

  if (!window.IntersectionObserver) return;
  const setOn = (p) => {
    links.forEach((a, q) => a.classList.toggle("on", q === p));
    const on = links.get(p);
    if (on && nav.scrollWidth > nav.clientWidth && getComputedStyle(nav).flexDirection === "row") {
      nav.scrollTo({ left: on.offsetLeft - 24, behavior: "smooth" });
    }
  };
  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => (e.isIntersecting ? seen.add(e.target) : seen.delete(e.target)));
    const first = panels.find((p) => seen.has(p));
    if (first) setOn(first);
  }, { rootMargin: "-25% 0px -60% 0px" });
  panels.forEach((p) => io.observe(p));
}

/* -------------------------- triggers (derived from real numbers) -------------------- */
function renderTriggers(d) {
  const S = d.scenarios, L = d.levels;
  const box = document.getElementById("triggers");
  box.textContent = "";
  if (!S || !L) { box.closest(".panel").remove(); return; }
  const fmt = (p) => `<b>${fmtUSD(p.level)}</b> (${p.name})`;
  const next = (p) => (p.next && p.next.length ? ` Next levels to watch: ${p.next.map(fmt).join(", ")}.` : "");
  const rows = [];
  const sh = S.short;
  if (sh) {
    // this week, sized to how far Bitcoin has actually been moving lately
    rows.push(["up", "Turns up", `A daily close above ${fmt(sh.up)} would show buyers are taking control.${next(sh.up)}`]);
    rows.push(["mid", "Sideways", `In a typical week lately Bitcoin has swung about <b>${fmtUSD(sh.typical_week_swing)}</b> from its high to its low. While price stays between <b>${fmtUSD(sh.low)}</b> and <b>${fmtUSD(sh.high)}</b>, expect choppy back-and-forth moves with no clear direction.`]);
    rows.push(["down", "Turns down", `A daily close below ${fmt(sh.down)} would show sellers are taking over.${next(sh.down)}`]);
    if (S.down && S.down.level < sh.low) rows.push(["mid", "Bigger floor", `The longer-term picture only weakens below ${fmt(S.down)}, so a dip inside this week's zone is not a change of trend.`]);
  } else {
    rows.push(["up", "Turns up", S.up
      ? `A daily close above ${fmt(S.up)} would show buyers are in control.${next(S.up)}`
      : `Price is at its all-time high area (${fmtUSD(L.ath)}); there is no resistance above, so watch how long it holds.`]);
    rows.push(["mid", "Sideways", `While price stays between <b>${fmtUSD(S.range[0])}</b> and <b>${fmtUSD(S.range[1])}</b>, expect choppy back-and-forth moves with no clear direction. Neither buyers nor sellers have taken control inside this zone.`]);
    if (S.down) rows.push(["down", "Turns down", `A daily close below ${fmt(S.down)} would show sellers are taking over.${next(S.down)}`]);
  }
  rows.forEach(([cls, tag, html]) => box.append(el("div", { class: "scn" },
    el("span", { class: "scn-tag " + cls, text: tag }), el("p", { class: "scn-text", html }))));
  box.append(el("p", { class: "chart-note", text: `Price now ${fmtUSD(S.price)}. Levels use daily closing prices and mark where a move would be confirmed or broken — they are reference points, not a forecast.` }));
}

/* -------------------------- news impact on the score ---------------------------------------- */
function renderNews(d) {
  const panel = document.getElementById("news-panel");
  const ni = d.news_impact, items = ni && ni.items;
  if (!items || !items.length) { panel.remove(); return; }
  const box = document.getElementById("news");
  box.textContent = "";
  const cap = ni.cap || 0.1, imp = ni.impact || {};
  const HZ = { short: "Short term", medium: "Medium term", long: "Long term" };
  const DIM = { short: "mood score", medium: "momentum score", long: "trend score" };
  const sg = (v) => (v > 0 ? "+" : "") + v.toFixed(2);
  const sums = el("div", { class: "news-sums" });
  ["short", "medium", "long"].forEach((h) => {
    const v = (imp[h] || 0) * cap;
    sums.append(el("div", { class: "news-sum" },
      el("div", { class: "lab", text: `${HZ[h]} · ${DIM[h]}` }),
      el("div", { class: "big " + (v > 0 ? "pos" : v < 0 ? "neg" : ""), text: v === 0 ? "no change" : sg(v) })));
  });
  box.append(sums);
  if (d.news_flag) box.append(el("p", { class: "news-flag", text: d.news_flag }));
  ["short", "medium", "long"].forEach((h) => {
    const group = items.filter((i) => i.horizon === h);
    if (!group.length) return;
    box.append(el("h4", { class: "news-h", text: HZ[h] }));
    group.forEach((i) => {
      const head = i.url
        ? el("a", { href: i.url, target: "_blank", rel: "noopener", text: i.headline })
        : el("span", { text: i.headline });
      box.append(el("div", { class: "news-item" },
        el("span", { class: "news-pill " + i.direction, text: `${i.direction === "positive" ? "Positive" : "Negative"} · ${i.size}` }),
        el("div", {}, el("div", { class: "news-head" }, head, i.source ? el("i", { text: ` — ${i.source}` }) : ""),
          el("p", { class: "news-why", text: i.why }))));
    });
  });
  box.append(el("p", { class: "chart-note", text: `Each headline is classified by direction, size and time horizon, and the shift is calculated with a fixed formula (minor 0.25 / moderate 0.5 / major 1.0 per item), capped at ±${cap.toFixed(2)} per score. This adjustment is not part of the backtest, and the BULLISH / NEUTRAL / BEARISH label and budget action stay with the 12-indicator model.` }));
}

/* -------------------------- narratives & altcoins (written daily from PANews + CoinGecko) ---- */
function renderNarratives(d) {
  const panel = document.getElementById("narratives-panel");
  const list = d.narratives && d.narratives.items;
  if (!list || !list.length) { panel.remove(); return; }
  const box = document.getElementById("narratives");
  box.textContent = "";
  if (d.narratives.as_of) panel.querySelector(".kicker").textContent = `Narratives & altcoins · ${fmtDate(d.narratives.as_of)}`;
  list.forEach((n) => {
    const card = el("div", { class: "narr" },
      el("h4", { text: n.theme }),
      el("p", { class: "narr-why", text: n.why }));
    if (n.tokens && n.tokens.length) {
      const row = el("div", { class: "narr-tokens" });
      n.tokens.forEach((t) => {
        const ch = t.change_24h_pct;
        const cls = ch == null ? "" : ch >= 0 ? " up" : " down";
        row.append(el("span", { class: "token" + cls, title: t.note || "" },
          el("b", { text: t.symbol }), ch == null ? "" : ` ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`,
          t.note ? el("i", { text: ` · ${t.note}` }) : ""));
      });
      card.append(row);
    }
    if (n.marketing_angle) card.append(el("p", { class: "narr-angle" }, el("b", { text: "Campaign angle: " }), n.marketing_angle));
    if (n.sources && n.sources.length) {
      const src = el("p", { class: "narr-src", text: "Source: " });
      n.sources.slice(0, 3).forEach((x, i) => {
        if (i) src.append(", ");
        src.append(el("a", { href: x.url, target: "_blank", rel: "noopener", text: x.title }));
      });
      card.append(src);
    }
    box.append(card);
  });
  box.append(el("p", { class: "chart-note", text: "Compiled from PANews newsflashes and CoinGecko 24h price data. Describes what is already moving; not a recommendation to buy any token." }));
}

/* -------------------------- implications for marketing (rule-based fallback) -------- */
const MARKETING_FALLBACK = {
  Bull: "Setup supports scaling acquisition spend, prioritising non-stablecoin and active-trader channels.",
  Neutral: "Hold current acquisition budget at plan; no clear direction to lean into yet.",
  Bear: "Defend spend with a strict ROI stop-loss; shift messaging toward stablecoin products.",
};
/* -------------------------- rally watch: described in plain words inside "Implications for marketing" ---- */
function rallyWatchBlock(d) {
  const rw = d.rally_watch, st = rw && rw.stats;
  if (!rw || !st) return null;
  const R = st.rally.non_stable, S = st.rally.stable, D = st.drop.non_stable;
  const pct = (v, dp = 1) => `${v > 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(dp)}%`;
  const line = Math.round(rw.threshold * 100), win = rw.window_days;
  const share = Math.round((R.d0.avg_pct / R.d14.avg_pct) * 100 / 5) * 5;
  const NU = st.new_users;
  const sgn = (v) => `${v > 0 ? "+" : "−"}${Math.abs(v)}%`;
  const upSentence = (NU && NU.rally) ? `New users arrive later than trading value does. Two weeks after a rally signal, new sign-ups were on average <b>${sgn(NU.rally.signups.d14.avg_pct)}</b> and first-time depositors <b>${sgn(NU.rally.first_deposits.d14.avg_pct)}</b> above normal, and after four weeks <b>${sgn(NU.rally.signups.d28.avg_pct)}</b> and <b>${sgn(NU.rally.first_deposits.d28.avg_pct)}</b> (about ${NU.rally.first_deposits.d28.typical_pct ? sgn(NU.rally.first_deposits.d28.typical_pct) : "0%"} on a random day). In the first week they moved only ${sgn(NU.rally.signups.d7.avg_pct)} and ${sgn(NU.rally.first_deposits.d7.avg_pct)}, so sign-ups are not an early warning. Use the signal to start acquisition messages early instead.` : "";
  const downSentence = (NU && NU.drop) ? `New users also slow down: two weeks after a drop signal, sign-ups were on average <b>${sgn(NU.drop.signups.d14.avg_pct)}</b> and first-time depositors <b>${sgn(NU.drop.first_deposits.d14.avg_pct)}</b> below normal.` : "";
  const paras = [];
  let pillClass = "mid", pillText = "No signal";

  if (rw.state === "rally") {
    const n = rw.episode.days_ago;
    pillClass = "up"; pillText = `Rally signal · day ${n} of ${win}`;
    paras.push(`Bitcoin is <b>${pct(rw.ret_7d)}</b> over the last 7 days, past the +${line}% line. It first crossed that line on ${fmtDate(rw.episode.date)}, so we are on <b>day ${n} of a ${win}-day window</b>.`);
    paras.push(`Since 2024 this has happened ${R.episodes} times (about ${R.separate} separate rallies). Each time, non-stablecoin trading value kept rising afterwards: on average <b>${R.d7.avg_pct}%</b> above its normal level after one week and <b>${R.d14.avg_pct}%</b> after two weeks, against about ${R.d14.typical_pct}% on a random day. Only about ${share}% of that rise had happened on the day the signal fired, so most of it comes after. Two weeks later, trading value was more than 10% above normal in ${R.d14.above_10pct_share}% of cases (${R.d14.above_10pct_share_random}% on a random day).`);
    if (upSentence) paras.push(upSentence);
    paras.push(n <= 7
      ? `<b>What to do:</b> this is the window to act. Campaigns that go live in the next few days can reach users while activity is still building. Lead with active-trader and non-stablecoin channels. Plan stablecoin offers for about a month from now, because stablecoin trading value tended to follow later (about ${S.d28.avg_pct}% above normal after four weeks).`
      : `<b>What to do:</b> the rise usually levels off around two weeks in, so only launch what can go live within a few days. Spend the rest of the effort on a follow-up for stablecoin users, whose trading value tended to rise later (about ${S.d28.avg_pct}% above normal after four weeks).`);
  } else if (rw.state === "drop") {
    const n = rw.episode.days_ago;
    pillClass = "down"; pillText = `Drop signal · day ${n} of ${win}`;
    paras.push(`Bitcoin is <b>${pct(rw.ret_7d)}</b> over the last 7 days, past the −${line}% line. It first crossed that line on ${fmtDate(rw.episode.date)}, so we are on <b>day ${n} of a ${win}-day window</b>.`);
    paras.push(`Since 2024 this has happened ${D.episodes} times. Two weeks later, non-stablecoin trading value was on average about <b>${Math.abs(D.d14.avg_pct)}% below</b> its normal level, while a random day is about ${D.d14.typical_pct}% above. In the most recent months this did not repeat (${D.d14.second_half_pct}% from ${D.d14.n_second_half} cases), so treat it as a caution, not a rule.`);
    if (downSentence) paras.push(downSentence);
    paras.push(`<b>What to do:</b> hold promotions aimed at active traders for now. Lead with safety and trust messages and stablecoin products, and keep some budget in reserve so you can move fast when the next rally signal fires.`);
  } else {
    paras.push(`Bitcoin is <b>${pct(rw.ret_7d)}</b> over the last 7 days. A rally signal needs +${line}% (a close above <b>${fmtUSD(rw.needs_up)}</b>), and a drop signal needs −${line}% (a close below <b>${fmtUSD(rw.needs_down)}</b>).` +
      (rw.last_rally ? ` The last rally signal was on ${fmtDate(rw.last_rally.date)}, ${rw.last_rally.days_ago} days ago, and its ${win}-day window has ended.` : ""));
    paras.push(`When a rally signal fired in the past, non-stablecoin trading value kept rising for about two weeks, to on average <b>${R.d14.avg_pct}%</b> above its normal level (about ${R.d14.typical_pct}% on a random day). Only about ${share}% of that rise had happened when the signal fired.`);
    if (upSentence) paras.push(upSentence);
    paras.push(`<b>What to do:</b> keep normal spend, and use quiet days to prepare. Because most of the rise comes after the signal and lasts about two weeks, have a campaign ready that can go live within 2–3 days of a signal.`);
  }
  const caveat = rw.state === "drop" ? "" :
    `How far to trust this: it rests on about ${R.separate} rallies. In the most recent months the effect was smaller (${R.d14.second_half_pct}% after two weeks, from ${R.d14.n_second_half} cases), so treat it as a strong hint, not a promise.`;

  const box = el("div", { class: "rw" },
    el("div", { class: "rw-head" }, el("span", { class: "rw-title", text: "Rally watch" }), el("span", { class: "scn-tag " + pillClass, text: pillText })));
  paras.forEach((t) => box.append(el("p", { html: t })));
  if (caveat) box.append(el("p", { class: "rw-caveat", text: caveat }));
  box.append(el("p", { class: "chart-note", text: `"Normal level" means the average of the 4 weeks before the signal. Based on Reku's daily trading value${NU ? ", sign-ups and first deposits" : ""} since ${fmtDate(st.gtv_period[0])}; only % changes are shown, never amounts or user counts. Signal = Bitcoin up or down more than ${line}% in 7 days.` }));
  return box;
}

const SEGMENTS = [
  ["social", "Social media & content"],
  ["seo", "SEO"],
  ["paid", "Paid digital marketing (ads)"],
  ["crm", "CRM (existing users)"],
  ["research", "Research (signals)"],
];
const STANCE_CLASS = { Increase: "up", Hold: "mid", Reduce: "down", Prepare: "mid", Monitor: "mid" };

function renderTeams(d) {
  const grid = document.getElementById("teams");
  grid.textContent = "";
  const rw = rallyWatchBlock(d);
  if (rw) grid.append(rw);

  const text = (d.team_notes && d.team_notes.marketing) || MARKETING_FALLBACK[d.regime] || MARKETING_FALLBACK.Neutral;
  const seg = d.marketing_segments;
  if (!seg || !SEGMENTS.some(([k]) => seg[k])) {          // task hasn't written the split yet
    grid.append(el("div", { class: "teamcard" }, el("h4", { text: "Marketing" }), el("p", { text })));
    return;
  }
  grid.append(el("p", { class: "seg-overall" }, el("b", { text: "Overall: " }), text));
  const cards = el("div", { class: "seg-grid" });
  SEGMENTS.forEach(([key, name]) => {
    const s = seg[key];
    if (!s) return;
    const card = el("div", { class: "seg" },
      el("div", { class: "seg-head" },
        el("h4", { text: name }),
        s.stance ? el("span", { class: "scn-tag " + (STANCE_CLASS[s.stance] || "mid"), text: s.stance }) : ""),
      el("p", { class: "seg-strategy", text: s.strategy || "" }));
    if (s.actions && s.actions.length) {
      const ul = el("ul", { class: "seg-actions" });
      s.actions.forEach((a) => ul.append(el("li", {}, el("b", { text: a.what }), a.detail ? ` — ${a.detail}` : "")));
      card.append(ul);
    }
    cards.append(card);
  });
  grid.append(cards);
}

/* -------------------------- supporting signals: full 35-indicator catalog ----------- */
function renderSignals(d) {
  const c = d.context || {};
  const sf = d.search_findings || {};
  const grid = document.getElementById("grid");
  grid.textContent = "";
  grid.append(el("p", { class: "cat-note",
    text: "35 indicators considered for this model. 27 have a free, direct live feed; the other 8 are attempted by the daily reasoning routine via web search instead (shown with a source + date, less precise than a real feed) — marked \"not tracked\" on days it finds nothing credible. Hover a row for why it's in the model." }));
  CATALOG.forEach((group) => {
    grid.append(el("div", { class: "sig-section" }, el("h3", { text: group.section })));
    const cg = el("div", { class: "catgrid" });
    group.cats.forEach((cat) => {
      const card = el("div", { class: "catcard" }, el("h4", { text: cat.name }));
      cat.items.forEach((item) => {
        if (item.headlines) {
          const list = Array.isArray(sf[item.key]) ? sf[item.key] : [];
          const has = list.length > 0;
          const ind = el("div", { class: "ind" },
            el("div", { class: "ind-row", title: item.why },
              el("span", { class: "ind-name", text: item.label }),
              el("span", { class: "ind-val" + (has ? " searched" : " dim") }, has ? `${list.length} found` : "not tracked")));
          if (has) {
            const ul = el("ul", { class: "ind-headlines" });
            list.slice(0, 5).forEach((h) => {
              ul.append(el("li", {},
                el("a", { href: h.url, target: "_blank", rel: "noopener", text: h.title }),
                " ", el("span", { class: "src", text: h.source ? `— ${h.source}` : "" })));
            });
            ind.append(ul);
          }
          card.append(ind);
          return;
        }
        let raw, has, disp, note, why = item.why;
        if (item.search) {
          const rec = sf[item.key];
          raw = rec ? rec.value : null;
          has = raw != null && raw !== "";
          disp = has ? (item.fmt ? item.fmt(raw) : String(raw)) : "not tracked";
          note = has ? "web search" : "";
          if (has && rec.source_name) {
            why = `${item.why} Source: ${rec.source_name}${rec.as_of ? ` (${rec.as_of})` : ""}.${rec.note ? " " + rec.note : ""}`;
          }
        } else {
          raw = item.key != null ? c[item.key] : null;
          has = raw != null && raw !== "" && (typeof raw === "string" || !isNaN(raw));
          disp = has ? item.fmt(raw) : "not tracked";
          note = has && item.note ? item.note(raw, d) : "";
        }
        card.append(el("div", { class: "ind" },
          el("div", { class: "ind-row", title: why },
            el("span", { class: "ind-name", text: item.label }),
            el("span", { class: "ind-val" + (has ? (item.search ? " searched" : "") : " dim") }, disp,
              note ? el("span", { class: "ind-note" + (item.search ? " searched" : "") , text: note }) : ""))));
      });
      cg.append(card);
    });
    grid.append(cg);
  });
}

/* -------------------------- scorecard (same visual system) -------------------------- */
function renderScorecard(bt) {
  const p = document.getElementById("scorecard");
  p.textContent = "";
  const sc = bt && bt.scorecard;
  if (!sc) { p.remove(); return; }
  const D = sc.directional || {};
  const d90 = D[90] || D["90"] || {};
  const pc = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  p.append(el("p", { class: "kicker", text: "Backtest accuracy" }));

  const stats = el("div", { class: "stats" });
  const stat = (big, lab) => el("div", { class: "stat" }, el("div", { class: "big", text: big }), el("div", { class: "lab", text: lab }));
  stats.append(
    stat(pc(sc.phase_agree_rate), "days the label matched the market's actual bull / bear phase"),
    stat(sc.turns_detected || "—", `major cycle turns flagged (median ${sc.turn_median_lag_days ?? "—"} days late)`),
    stat(`${pc(d90.bull_up_rate)} / ${pc(d90.bear_down_rate)}`, "when BULLISH → price higher · when BEARISH → price lower, 90 days"),
    stat(`−${Math.round(Math.abs(sc.strategy_maxdd) * 100)}% vs −${Math.round(Math.abs(sc.buyhold_maxdd) * 100)}%`, "worst drawdown: acting on the label vs buy & hold"),
  );
  p.append(stats);

  const tbl = el("table", { class: "sc" });
  tbl.append(el("tr", {}, el("th", { text: "Checked after…" }),
    el("th", { text: "BULLISH → price ↑" }), el("th", { text: "BEARISH → price ↓" }), el("th", { text: "Overall" })));
  [[30, "30 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [730, "2 years"], [1095, "3 years"]].forEach(([h, lbl]) => {
    const r = D[h] || D[String(h)];
    if (!r) return;
    tbl.append(el("tr", { style: h >= 365 ? "opacity:.6" : null },
      el("td", { text: lbl }), el("td", { text: pc(r.bull_up_rate) }), el("td", { text: pc(r.bear_down_rate) }), el("td", { text: pc(r.directional_accuracy) })));
  });
  p.append(tbl);
  p.append(el("p", { class: "sc-note", text:
    `${sc.span ? sc.span[0] + "–" + sc.span[1] : ""} · ~${sc.cycles} market cycles · ${sc.days} days · `
    + `${sc.transitions} regime changes (${sc.per_year}/yr) · median lag at a cycle turn ${sc.turn_median_lag_days ?? "—"} days. Recomputed daily.` }));

  // does a higher score really mean better results afterwards? (average 90-day return by fifth of days)
  const dq = bt.dimension_quintiles;
  if (dq && dq.sentiment && dq.momentum && dq.trend) {
    const sg = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}%`;
    const step = (a) => a.slice(1).filter((v, i) => v > a[i]).length;
    const verdict = (a) => (step(a) === 4 ? "Yes, every step" : step(a) === 3 ? "Yes, almost every step" : "Only partly");
    const top = Math.max(...["sentiment", "momentum", "trend"].map((k) => Math.max(...(dq[k]["90"] || [0]))));
    p.append(el("p", { class: "sc-sub", text: "Does a higher score really mean better results afterwards?" }));
    p.append(el("p", { class: "sc-note", style: "margin-top:0", html:
      "Every day since 2014 is sorted by its score into five equal groups, from the <b>lowest</b> scores to the <b>highest</b>. "
      + "Each bar is how much Bitcoin gained on average over the <b>next 90 days</b> after the days in that group. "
      + "If the score is useful, the bars should rise from left to right." }));
    [["Short term", "mood score", "sentiment"], ["Medium term", "momentum score", "momentum"], ["Long term", "trend score", "trend"]].forEach(([lbl, sub, k]) => {
      const q = dq[k] && dq[k]["90"];
      if (!q) return;
      const bars = el("div", { class: "qbars" });
      q.forEach((v, i) => bars.append(el("div", { class: "qb", title: `${["Lowest", "Low", "Middle", "High", "Highest"][i]} fifth of scores: Bitcoin ${sg(v)} on average over the next 90 days` },
        el("span", { class: "qv", text: sg(v) }),
        el("i", { style: `height:${Math.max(4, (Math.max(v, 0) / top) * 64)}px` }))));
      p.append(el("div", { class: "qrow" },
        el("div", { class: "ql" }, el("b", { text: lbl }), el("span", { text: sub })),
        el("div", {}, bars, el("div", { class: "qend" }, el("span", { text: "lowest scores" }), el("span", { text: "highest scores" }))),
        el("div", { class: "qs" }, el("b", { text: `${sg(q[0])} → ${sg(q[4])}` }), el("span", { text: `Rises with the score? ${verdict(q)}` }))));
    });
    p.append(el("p", { class: "sc-note", html:
      "Bitcoin rose a lot over this period, so every bar is positive; look at the <b>gap</b> between the first and last bar. "
      + "This is a look back at how the scores behaved, not a forecast for today. The medium-term score includes price vs its 50-day average (added 26 October 2026) and was recomputed with it." }));
  }

  const body = el("div", { class: "why-body", hidden: "", html:
    "This tool's job is the <b>daily glance</b>: is the market bull, bear or neutral right now? So the headline number is <b>phase agreement</b> — "
    + "on what share of days did the label match the cycle the market was actually in (dated after the fact). It missed on "
    + `${pc(sc.phase_wrong_rate)} of days, almost all in the ~3 months after a turn while a 200-day-average system catches up.<br><br>`
    + "The table is a stricter test — on every BULLISH day, was BTC actually higher N days later? — which asks the label to <i>predict</i>, which no "
    + "trailing indicator does well. The 1–3 year rows (greyed) are near-meaningless: over multi-year windows BTC almost always rose.<br><br>"
    + "Built on ~3 cycles of history — read as direction and magnitude, not precision." });
  p.append(whyToggle("How to read these numbers", body));
}

/* -------------------------- methodology (same visual system) ------------------------ */
function renderMethodology() {
  const p = document.getElementById("methodology");
  p.append(el("p", { class: "kicker", text: "How the reading is built" }));
  const body = el("div", { class: "why-body", hidden: "", html:
    "The headline regime comes from the <b>Trend</b> dimension only: BULLISH above +0.15, BEARISH below −0.15, NEUTRAL in between, with a five-day "
    + "confirmation so the label doesn't flip on noise. Trend blends the Mayer Multiple, the 200-day slope, the 50/200 cross and a 200-week valuation "
    + "counterweight. <b>Momentum</b> adds weekly RSI, 90-day rate of change, breadth, active-address trend and (since 26 October 2026) how far price is from its 50-day average, so the score notices the last few weeks as well as the last 90 days; <b>Sentiment</b> blends Fear &amp; Greed, "
    + "perp funding and the stablecoin ratio. Momentum and Sentiment never move the label — they set confidence and the watch notes.<br><br>"
    + "The \"Supporting signals\" catalog lists 35 indicators considered for this model. Only the ones above feed the score; most of the rest are live "
    + "context. 8 of them have no free API (paid on-chain/derivatives providers only) — the daily reasoning routine web-searches for a reported figure "
    + "for those instead, shown with its source and date; on a day it finds nothing credible, that row reads \"not tracked\".<br><br>"
    + "The three scores shown include a small news adjustment (at most ±0.10 each, from headlines classified by size and time horizon). That part is not backtested, so the BULLISH / NEUTRAL / BEARISH label and the budget action stay with the 12-indicator model; if news pushes a score across a label threshold, the page flags it instead of changing the label.<br><br>"
    + "Every input is trailing — it describes what already happened, it does not forecast. Validated on ~3 market cycles: it flagged every major cycle "
    + "top and bottom, a median of about three months after the price extreme. Thresholds and weights all live in one place (state.py → CONFIG)." });
  p.append(whyToggle("Regime logic, confidence, and limits", body));
}
function whyToggle(label, body) {
  const btn = el("button", { class: "why-toggle", type: "button", text: label + " ▸" });
  btn.addEventListener("click", () => {
    body.hidden = !body.hidden;
    btn.textContent = label + (body.hidden ? " ▸" : " ▾");
  });
  const wrap = el("div", {}, btn, body);
  return wrap;
}

/* ----------------------- halving / 50-200 cross chart (real data) ------------------- */
const HALVINGS = ["2016-07-09", "2020-05-11", "2024-04-20"]; // 2012-11-28 predates our price history
const MS_DAY = 86400000;
const LAST_HALVING = Date.parse("2024-04-20T00:00:00Z");
let AS_OF = null;   // set when viewing a saved day, so 'now' means that day
const BLOCKS_PER_DAY = 144; // ~10-minute block target
function halvingProgress() {
  const daysSince = ((AS_OF ?? Date.now()) - LAST_HALVING) / MS_DAY;
  const blocksSince = daysSince * BLOCKS_PER_DAY;
  const pct = clamp((blocksSince / 210000) * 100, 0, 99.9);
  const blocksLeft = Math.max(0, Math.round(210000 - blocksSince));
  const nextDate = new Date(LAST_HALVING + (210000 / BLOCKS_PER_DAY) * MS_DAY);
  return { pct, blocksLeft, nextDate };
}
function renderHalvingProgress() {
  const prog = halvingProgress();
  const box = document.getElementById("halvingProgress");
  box.textContent = "";
  const dateLabel = prog.nextDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  box.append(
    el("div", { class: "pct", text: prog.pct.toFixed(0) + "%" }),
    el("div", { class: "bar-col" },
      el("div", { class: "bar" }, el("div", { class: "bar-fill", style: `width:${prog.pct}%` })),
      el("div", { class: "cap" }, `Progress to the next halving — ~${prog.blocksLeft.toLocaleString()} blocks left, est. ${dateLabel}. Block-height math, not a price call.`)));
}

const CHART_RANGES = [{ label: "1Y", years: 1 }, { label: "3Y", years: 3 }, { label: "5Y", years: 5 }, { label: "10Y", years: 10 }, { label: "All", years: null }];
let chartYears = null;
let CHART_ROWS = null;
function renderRangeButtons() {
  const box = document.getElementById("chartRange");
  box.textContent = "";
  CHART_RANGES.forEach((r) => {
    const btn = el("button", { class: "rng" + (chartYears === r.years ? " on" : "") }, r.label);
    btn.addEventListener("click", () => { chartYears = r.years; renderRangeButtons(); renderChart(CHART_ROWS); });
    box.append(btn);
  });
}

function renderChart(rows) {
  if (rows) CHART_ROWS = rows;
  const svg = document.getElementById("chartSvg");
  svg.innerHTML = "";
  const series = CHART_ROWS.filter((r) => r.close > 0).map((r) => ({ t: Date.parse(r.date + "T00:00:00Z"), price: r.close }));
  if (!series.length) return;
  const prog = halvingProgress();

  const smaCalc = (n) => {
    const out = new Array(series.length).fill(null);
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i].price;
      if (i >= n) sum -= series[i - n].price;
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  };
  const sma50 = smaCalc(50), sma200 = smaCalc(200);
  const crosses = [];
  for (let i = 1; i < series.length; i++) {
    if (sma50[i - 1] == null || sma200[i - 1] == null) continue;
    const prevDiff = sma50[i - 1] - sma200[i - 1], diff = sma50[i] - sma200[i];
    if (prevDiff <= 0 && diff > 0) crosses.push({ t: series[i].t, type: "golden", price: (sma50[i] + sma200[i]) / 2 });
    else if (prevDiff >= 0 && diff < 0) crosses.push({ t: series[i].t, type: "death", price: (sma50[i] + sma200[i]) / 2 });
  }

  const lastData = series[series.length - 1].t;
  const tMax = chartYears === null ? prog.nextDate.getTime() : lastData;
  const tMin = chartYears ? Math.max(series[0].t, lastData - chartYears * 365 * MS_DAY) : series[0].t;
  const W = 900, H = 320, padL = 48, padR = 12, padT = 16, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  let i0 = series.findIndex((d) => d.t >= tMin);
  if (i0 < 0) i0 = 0;
  if (i0 > 0) i0--;
  const idx = []; for (let i = i0; i < series.length; i++) idx.push(i);
  const prices = idx.map((i) => series[i].price);
  const logMin = Math.log10(Math.min(...prices) * 0.85);
  const logMax = Math.log10(Math.max(...prices) * 1.15);
  const x = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const y = (p) => padT + (1 - (Math.log10(p) - logMin) / (logMax - logMin)) * plotH;

  const make = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  const epochBounds = [series[0].t, ...HALVINGS.map((d) => Date.parse(d + "T00:00:00Z")), prog.nextDate.getTime()];
  const gb = make("g", { class: "epoch-bands" });
  for (let e = 0; e < epochBounds.length - 1; e++) {
    if (e % 2 !== 0) continue;
    const es = epochBounds[e], ee = epochBounds[e + 1];
    if (ee < tMin || es > tMax) continue;
    const rx0 = x(Math.max(es, tMin)), rx1 = x(Math.min(ee, tMax));
    gb.append(make("rect", { x: rx0.toFixed(1), y: padT, width: Math.max(0, rx1 - rx0).toFixed(1), height: (H - padT - padB).toFixed(1), class: "epoch-band" }));
  }
  svg.append(gb);

  const gy = make("g", { class: "cy-axis" });
  [1, 10, 100, 1000, 10000, 100000, 1000000].forEach((pv) => {
    const lp = Math.log10(pv);
    if (lp < logMin || lp > logMax) return;
    const py = y(pv);
    gy.append(make("line", { x1: padL, x2: W - padR, y1: py.toFixed(1), y2: py.toFixed(1) }));
    const t = make("text", { x: 6, y: (py + 3).toFixed(1) });
    t.textContent = pv >= 1000 ? "$" + Math.round(pv / 1000) + "k" : "$" + pv;
    gy.append(t);
  });
  svg.append(gy);

  const gx = make("g", { class: "cx-axis" });
  for (let k = 0; k <= 4; k++) {
    const t = tMin + ((tMax - tMin) * k) / 4;
    const px = x(t);
    const label = new Date(t).toLocaleDateString("en-US", chartYears && chartYears <= 3 ? { month: "short", year: "2-digit" } : { year: "numeric" });
    const txt = make("text", { x: px.toFixed(1), y: H - 6, "text-anchor": k === 4 ? "end" : k === 0 ? "start" : "middle" });
    txt.textContent = label;
    gx.append(txt);
  }
  svg.append(gx);

  const gh = make("g", { class: "c-halving" });
  HALVINGS.forEach((dstr) => {
    const t = Date.parse(dstr + "T00:00:00Z");
    if (t < tMin || t > tMax) return;
    const px = x(t);
    gh.append(make("line", { x1: px.toFixed(1), x2: px.toFixed(1), y1: padT, y2: H - padB }));
    const txt = make("text", { x: (px + 4).toFixed(1), y: padT + 10, "text-anchor": "start" });
    txt.textContent = "Halving";
    gh.append(txt);
  });
  svg.append(gh);

  if (chartYears === null) {
    const t = prog.nextDate.getTime();
    if (t >= tMin && t <= tMax) {
      const px = x(t);
      const gn = make("g", { class: "c-halving c-halving-next" });
      gn.append(make("line", { x1: px.toFixed(1), x2: px.toFixed(1), y1: padT, y2: H - padB }));
      const txt = make("text", { x: (px + 4).toFixed(1), y: padT + 10, "text-anchor": "start" });
      txt.textContent = `Next halving (est., ${prog.pct.toFixed(0)}% there)`;
      gn.append(txt);
      svg.append(gn);
    }
  }

  const gpx = make("g", { class: "c-price-seg" });
  for (let kk = 1; kk < idx.length; kk++) {
    const ia = idx[kk - 1], ib = idx[kk];
    const p0 = series[ia].price, p1 = series[ib].price;
    gpx.append(make("line", { x1: x(series[ia].t).toFixed(1), y1: y(p0).toFixed(1), x2: x(series[ib].t).toFixed(1), y2: y(p1).toFixed(1), class: p1 >= p0 ? "up" : "down" }));
  }
  svg.append(gpx);

  const linePath = (getVal) => {
    let dpath = "";
    idx.forEach((i) => { const v = getVal(i); if (v == null) return; dpath += `${dpath ? "L" : "M"}${x(series[i].t).toFixed(1)} ${y(v).toFixed(1)} `; });
    return dpath.trim();
  };
  svg.append(make("path", { class: "c-sma200", d: linePath((i) => sma200[i]) }));
  svg.append(make("path", { class: "c-sma50", d: linePath((i) => sma50[i]) }));

  crosses.forEach((c) => {
    if (c.t < tMin || c.t > tMax) return;
    const g = make("g", { class: "c-cross " + c.type });
    const circle = make("circle", { cx: x(c.t).toFixed(1), cy: y(c.price).toFixed(1), r: 4 });
    const title = make("title", {});
    title.textContent = (c.type === "golden" ? "Golden cross — " : "Death cross — ") + new Date(c.t).toLocaleDateString("en-US", { month: "short", year: "numeric" });
    circle.append(title);
    g.append(circle);
    svg.append(g);
  });

  // "same stage of the cycle": today's halving-progress % replayed at the equivalent
  // point of every era, so past cycles can be visually compared at today's stage.
  const gm = make("g", { class: "epoch-marker" });
  for (let e = 0; e < epochBounds.length - 1; e++) {
    const es = epochBounds[e], ee = epochBounds[e + 1];
    const mt = e === epochBounds.length - 2 ? lastData : es + (prog.pct / 100) * (ee - es);
    if (mt < tMin || mt > tMax) continue;
    const px = x(mt);
    gm.append(make("line", { x1: px.toFixed(1), x2: px.toFixed(1), y1: padT, y2: H - padB }));
    const bw = 34, bh = 14, by = H - padB - bh - 5;
    gm.append(make("rect", { x: (px - bw / 2).toFixed(1), y: by.toFixed(1), width: bw, height: bh, rx: 3 }));
    const txt = make("text", { x: px.toFixed(1), y: (by + bh - 4).toFixed(1), "text-anchor": "middle" });
    txt.textContent = prog.pct.toFixed(0) + "%";
    gm.append(txt);
  }
  svg.append(gm);
}

main();
