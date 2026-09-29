"use strict";

/* Crypto Market State — dashboard renderer. Reads data/latest.json + data/history.csv. */

const SVGNS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "rect", "line", "text", "circle", "g", "polyline"]);

const REG_KEY = { Bull: "Bull", Bear: "Bear", Neutral: "Neutral", Unknown: "Neutral" };
const REG_VAR = { Bull: "var(--bull)", Bear: "var(--bear)", Neutral: "var(--neutral)" };
const REG_WASH = { Bull: "var(--bull-wash)", Bear: "var(--bear-wash)", Neutral: "var(--neutral-wash)", Unknown: "transparent" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

const el = (tag, attrs = {}, ...kids) => {
  const e = SVG_TAGS.has(tag) ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(k));
  return e;
};
const fmtUSD = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const fmtUSDk = (n) => (n == null ? "—" : "$" + (n / 1000).toFixed(0) + "k");
const fmtUSDm = (n, signed) => (n == null ? "—" : (n < 0 ? "-" : signed ? "+" : "") + "$" + Math.abs(n / 1e6).toFixed(1) + "M");
const fmtUSDb = (n, signed) => (n == null ? "—" : (n < 0 ? "-" : signed ? "+" : "") + "$" + Math.abs(n / 1e9).toFixed(2) + "B");
const fmtBTC = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US") + " BTC");
const fmtPct = (v, d = 0, signed) => (v == null || isNaN(v) ? "—" : (signed && v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%");
const fmtNum = (v, d = 2, signed) => (v == null || isNaN(v) ? "—" : (signed && v > 0 ? "+" : "") + (+v).toFixed(d));
const numStr = (v, d) => (v == null || isNaN(v) ? "—" : (+v).toFixed(d));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtDate = (s) => { const [y, m, d] = s.split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const panel = (...kids) => el("div", { class: "panel" }, ...kids);
const ptitle = (t) => el("p", { class: "ptitle", text: t });

/* ---- explanations: why each signal is in the model ---- */
const DIM_WHY = {
  Trend: "Where price sits versus its own 200-day average and whether that average is itself rising or falling — the cleanest definition of an up- or down-trend. A price spike above a still-falling average is what separates a real bull from a bear-market bounce. It also carries a valuation counterweight, the 200-week multiple, so a market stretched far above its long-term floor is scored more cautiously.",
  Momentum: "How fast and how broadly the market is moving right now — weekly RSI, 90-day rate of change, the share of recent days that closed above the 200-day line, and the trend in active on-chain addresses. Momentum, and on-chain usage in particular, turns weeks before the slow trend average does, so it is what flags a bottom forming or a top rolling over early.",
  Sentiment: "How crowded and emotional the market is — the Fear & Greed Index, perp funding, and the stablecoin ratio combined. At extremes it marks exhaustion (euphoria near tops, panic near bottoms); in the middle it simply confirms the trend. It never moves the headline label, only the confidence and the watch notes.",
};

/* ---- full 35-indicator catalog, grouped horizon -> category -> items.
   `key` reads data.context[key]; `key: null` means we don't have a free,
   reliable source for it yet (see the "why not tracked" line) -- shown
   honestly rather than guessed or hidden. */
const CATALOG = [
  { horizon: "Short-term signals", sub: "~1 week", cats: [
    { name: "Sentiment & Crowd Behavior", items: [
      { label: "Fear & Greed Index", key: "fear_greed", fmt: (v) => numStr(v, 0), note: (v, d) => d.sentiment_band,
        why: "Daily composite of volatility, volume, social media and dominance, published by Alternative.me — the crowd-emotion gauge most of the industry references." },
      { label: "Social Volume (X, Reddit)", key: null,
        why: "Needs a paid social-listening feed (LunarCrush, Santiment) — not tracked yet." },
    ]},
    { name: "Positioning & Leverage", items: [
      { label: "Funding Rate (z-score)", key: "funding_z", fmt: (v) => fmtNum(v, 2, true), note: (v) => (Math.abs(v) >= 1.5 ? "stretched" : "normal"),
        why: "The cost to hold a leveraged long on perpetual futures, standardised against its own recent range. Persistently high means crowded longs paying to stay in — fuel for a sharp correction." },
      { label: "Open Interest", key: "open_interest_usd", fmt: (v) => fmtUSDb(v),
        why: "Total value of open futures positions. A fast rise alongside a price rally usually means the move is leverage-driven, not spot-led — more prone to a sharp unwind." },
      { label: "Long / Short Ratio", key: "long_short_ratio", fmt: (v) => fmtNum(v, 2), note: (v) => (v > 1 ? "long-tilted" : "short-tilted"),
        why: "Ratio of accounts positioned long vs short on futures. Very one-sided readings are a contrarian flag — crowded positioning has historically preceded the opposite move." },
      { label: "Liquidation Volume (24h)", key: null,
        why: "Needs a paid derivatives feed (e.g. CoinGlass API) — not tracked yet." },
      { label: "Exchange Netflow (7d)", key: null,
        why: "Needs a paid on-chain provider (CryptoQuant, Glassnode) — not tracked yet." },
    ]},
    { name: "Volatility", items: [
      { label: "Realized Vol Percentile (30d)", key: "vol_percentile", fmt: (v) => fmtPct(v, 0), note: (v) => (v >= 0.7 ? "elevated" : "calm"),
        why: "Where 30-day realised volatility sits within its trailing two-year range. Spikes cluster around capitulations and violent reversals." },
      { label: "Implied Volatility (DVOL)", key: "dvol", fmt: (v) => fmtNum(v, 1),
        why: "Deribit's 30-day implied-volatility index — the options market's own forecast of near-term price swings, not a trailing measure like realised vol." },
      { label: "Bollinger Band Width", key: null,
        why: "Derivable free from price history alone — just not wired into the pipeline yet." },
    ]},
    { name: "Catalysts & Events", items: [
      { label: "Macro Calendar", key: null,
        why: "No calendar feed wired in yet — FOMC/CPI dates are currently tracked manually." },
      { label: "Raw News Headlines", key: null,
        why: "Needs a news/sentiment API — not tracked yet." },
      { label: "VIX", key: "vix", fmt: (v) => fmtNum(v, 1),
        why: "CBOE equity volatility index — a read on broader risk appetite. Crypto often (not always) moves with, not against, equity-market fear." },
    ]},
  ]},
  { horizon: "Medium-term signals", sub: "~1 month", cats: [
    { name: "Momentum", items: [
      { label: "Weekly RSI", key: "rsi_weekly", fmt: (v) => numStr(v, 0), note: (v) => (v >= 70 ? "overbought" : v <= 35 ? "oversold" : "neutral"),
        why: "Relative Strength Index on a weekly candle, filtering out daily noise. Above 70 is overbought; below 35 is washed out." },
      { label: "90-Day Rate of Change", key: "roc_90d", fmt: (v) => fmtPct(v, 0, true),
        why: "Price now vs. 90 days ago. A simple, direct read on whether the medium-term trend is accelerating or stalling." },
      { label: "Breadth (% days > MA200)", key: "breadth_90d", fmt: (v) => fmtPct(v, 0),
        why: "Share of the last 90 days that closed above the 200-day average. Widening breadth means the uptrend is broadening, not just a few sharp days." },
      { label: "50 / 200-Day MA Cross", key: "ma_cross", fmt: (v) => fmtPct(v, 1, true), note: (v) => (v > 0 ? "golden-cross side" : "death-cross side"),
        why: "Gap between the 50-day and 200-day averages. Positive means the shorter average sits above the longer one (the golden-cross side) — a classic trend-following signal." },
    ]},
    { name: "On-Chain Demand", items: [
      { label: "Active Address Ratio", key: "active_addr_ratio", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 1 ? "expanding" : "contracting"),
        why: "Daily active addresses vs. their own 365-day average. In the backtest this was the single most predictive input — rising on-chain usage led price more reliably than any price-only measure." },
      { label: "Onchain / Spot Volume", key: null,
        why: "Needs a paid on-chain volume feed — not tracked yet." },
      { label: "Whale / Large-Holder Supply", key: null,
        why: "Needs a paid on-chain provider (wallet-cluster data) — not tracked yet." },
    ]},
    { name: "Sentiment (Aggregate)", items: [
      { label: "Stablecoin Supply Ratio", key: "ssr", fmt: (v) => fmtNum(v, 2),
        why: "BTC market cap divided by total stablecoin supply. A falling ratio means more stablecoin \"dry powder\" relative to BTC's size — room to keep buying." },
    ]},
    { name: "Macro & Market Structure", items: [
      { label: "BTC Dominance", key: "btc_dominance", fmt: (v) => fmtPct(v / 100, 1),
        why: "Bitcoin's share of total crypto market cap. Falling dominance in an uptrend usually means risk appetite is spreading into altcoins." },
      { label: "Fed Funds Rate", key: "fed_funds_rate", fmt: (v) => fmtPct(v / 100, 2),
        why: "US policy rate (FRED). Hikes are a real headwind for risk assets generally, crypto included — a genuinely new variable, not a crypto-native one." },
      { label: "Spot BTC ETF Flow (1d)", key: "etf_daily_net_flow_usd", fmt: (v) => fmtUSDm(v, true),
        why: "Net daily flow into US spot BTC ETFs — the clearest read on real institutional spot demand, as opposed to leverage-driven futures activity." },
    ]},
  ]},
  { horizon: "Long-term signals", sub: "~3–6 months", cats: [
    { name: "Price Trend Structure", items: [
      { label: "Mayer Multiple", key: "mayer_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 1 ? "above trend" : "below trend"),
        why: "Price divided by the 200-day average. Readings below ~1 have historically been accumulation zones; above ~2.4 has marked blow-off tops." },
      { label: "MA200 Slope (90d)", key: "ma200_slope_90d", fmt: (v) => fmtPct(v, 1, true), note: (v) => (v >= 0 ? "rising" : "falling"),
        why: "Change in the 200-day average itself over 90 days. A rising slope confirms an uptrend is structural, not just a relief rally." },
      { label: "Pi-Cycle Top Gap", key: "pi_cycle_gap", fmt: (v) => fmtPct(v, 1, true),
        why: "SMA111 vs. 2×SMA350. Historically crosses at or above zero close to major cycle tops — shown as context, not scored." },
    ]},
    { name: "Cycle Valuation", items: [
      { label: "200-Week Multiple", key: "ma_200w_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v >= 3 ? "stretched" : v <= 1.1 ? "near the floor" : "mid-cycle"),
        why: "Price vs. its 200-week (~4-year) average — a line BTC has only briefly traded below, at generational lows. A valuation counterweight to the trend signals." },
      { label: "Puell Multiple", key: "puell_multiple", fmt: (v) => fmtNum(v, 2), note: (v) => (v <= 0.6 ? "miner capitulation" : v >= 3 ? "miner euphoria" : "normal"),
        why: "Daily miner revenue vs. its 365-day average. Very low readings have sat near cycle bottoms; very high readings cluster around tops. Shown as context — too noisy to score on this sample." },
      { label: "Short-Term Holder Cost Basis", key: null,
        why: "Needs a paid on-chain provider (UTXO-age data) — not tracked yet." },
      { label: "LTH vs. STH Supply", key: null,
        why: "Needs a paid on-chain provider (UTXO-age data) — not tracked yet." },
      { label: "Drawdown from ATH", key: "drawdown_from_ath", fmt: (v) => fmtPct(v, 0),
        why: "How far below the all-time high price currently sits — separates an early wobble from a full bear market even when both read as \"down\"." },
    ]},
    { name: "Macro & Institutional", items: [
      { label: "US 10-Year Yield", key: "us_10y_yield", fmt: (v) => fmtPct(v / 100, 2),
        why: "Benchmark long-term US rate. A rising 10-year makes cash/bonds more competitive with risk assets — a slow but real headwind or tailwind." },
      { label: "Corporate Treasury Holdings", key: "public_company_btc_treasury", fmt: (v) => fmtBTC(v),
        why: "Total BTC held by publicly traded companies (bitcointreasuries.net). A slow-moving read on corporate-balance-sheet demand." },
      { label: "Spot BTC ETF Flow (cumulative)", key: "etf_cum_net_flow_usd", fmt: (v) => fmtUSDb(v, true),
        why: "All-time net flow into US spot BTC ETFs since launch — the multi-month trend behind the single-day number above." },
    ]},
  ]},
];

async function main() {
  const app = document.getElementById("app");
  let d, hist, bt = null;
  try {
    const [a, b] = await Promise.all([
      fetch("data/latest.json", { cache: "no-store" }).then((r) => r.json()),
      fetch("data/history.csv", { cache: "no-store" }).then((r) => r.text()),
    ]);
    d = a; hist = parseCSV(b);
  } catch (e) {
    app.innerHTML = `<p class="err">Failed to load data: ${e.message}</p>`;
    return;
  }
  try { bt = await fetch("data/backtest.json", { cache: "no-store" }).then((r) => r.json()); } catch (e) { /* optional */ }

  const k = REG_KEY[d.regime] || "Neutral";
  document.getElementById("brandDot").style.background = REG_VAR[k];
  document.getElementById("stamp").textContent =
    `${fmtDate(d.date)} · updated ${(d.updated_utc || "").replace("T", " ").replace("Z", " UTC")}`;

  app.textContent = "";
  app.append(
    heroPanel(d, k),
    dimensionsPanel(d),
    haloChartPanel(hist),
    analysisPanel(d),
    triggersPanel(d),
    teamsPanel(d),
    signalsPanel(d),
    scorecardPanel(bt),
    methodologyPanel(),
    el("p", { class: "disc", text: d.disclaimer || "" }),
  );
  wireExpanders(app);
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
function heroPanel(d, k) {
  const p = el("div", { class: "panel hero" });
  p.style.background = `color-mix(in srgb, ${REG_VAR[k]} 7%, var(--surface))`;
  p.append(el("div", { class: "hero-row" },
    el("div", {},
      el("h1", { class: "regime " + k, text: d.headline || "—" }),
      el("div", { class: "regime-tag", text: d.headline_tag || "" })),
    el("div", { class: "price" },
      el("span", { class: "n", text: fmtUSD(d.price_btc) }),
      el("span", { class: "l", text: "BTC" })),
  ));

  const t = clamp((d.scores && d.scores.trend) ?? 0, -1, 1);
  p.append(el("div", { class: "spectrum" },
    el("div", { class: "track" }, el("div", { class: "mark", style: `left:${clamp(((t + 1) / 2) * 100, 3, 97)}%; color:${REG_VAR[k]}` })),
    el("div", { class: "labels" }, el("span", { text: "Bearish" }), el("span", { text: "Neutral" }), el("span", { text: "Bullish" })),
  ));

  p.append(el("hr"));
  p.append(el("div", { class: "action" },
    el("div", { class: "lab", text: "Budget action" }),
    el("div", { class: "title", text: (d.action && d.action.title) || "—" }),
    el("div", { class: "detail", text: (d.action && d.action.detail) || "" }),
    el("span", { class: "conf-tag " + (d.conviction_level || ""), text: "Overall confidence: " + (d.conviction_level || "—") }),
  ));
  return p;
}

/* -------------------------- dimensions (= directional outlook) ------------------------- */
function dimensionsPanel(d) {
  const s = d.scores || {};
  const p = panel(ptitle("Engine dimensions — score −1 to +1"));
  [["Trend", s.trend], ["Momentum", s.momentum], ["Sentiment", s.sentiment]].forEach(([lab, v]) => {
    const body = el("div", {},
      divBar(v ?? 0),
      el("div", { class: "why-panel", hidden: "", text: DIM_WHY[lab] }));
    p.append(expander(lab, v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2), null, body));
  });
  return p;
}
function divBar(score) {
  const W = 260, H = 16, mid = W / 2, span = W / 2 - 6, s = clamp(score, -1, 1), x = mid + s * span;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  svg.append(el("rect", { x: 0, y: 5, width: W, height: 6, rx: 3, fill: "var(--hair)" }));
  svg.append(el("rect", { x: Math.min(mid, x), y: 5, width: Math.abs(x - mid), height: 6, rx: 3, fill: s >= 0 ? "var(--rk-teal)" : "var(--bear)" }));
  svg.append(el("line", { x1: mid, y1: 1, x2: mid, y2: 15, stroke: "var(--hair-strong)", "stroke-width": 1.5 }));
  svg.append(el("circle", { cx: x, cy: 8, r: 4.5, fill: "var(--ink)" }));
  return svg;
}

/* -------------------------- analysis (why + watch + levels) ------------------------ */
function analysisPanel(d) {
  const p = panel(ptitle("What's driving this"));
  if (d.reasons && d.reasons.length) {
    const ul = el("ul", { class: "why-ul" });
    d.reasons.forEach((r) => ul.append(el("li", { text: r })));
    p.append(ul);
  }
  if (d.watch) p.append(el("div", { class: "watch" }, el("b", { text: "Watch" }), document.createTextNode(d.watch)));
  if (d.changed_today) p.append(el("div", { class: "changed", text: d.changed_today }));

  const c = d.context || {};
  const price = d.price_btc;
  const levels = [];
  if (price != null && c.drawdown_from_ath != null) levels.push([fmtUSD(price / (1 + c.drawdown_from_ath)), "all-time high"]);
  if (price != null && c.mayer_multiple) levels.push([fmtUSD(price / c.mayer_multiple), "200-day moving average"]);
  if (price != null && c.ma_200w_multiple) levels.push([fmtUSD(price / c.ma_200w_multiple), "200-week moving average"]);
  levels.push([fmtUSD(price), "spot price — today"]);
  if (levels.length) {
    const lv = el("div", { class: "levels" });
    levels.forEach(([v, lab]) => lv.append(el("div", { class: "level" }, el("b", { text: v }), el("span", { text: lab }))));
    p.append(lv);
  }
  return p;
}

/* -------------------------- triggers (derived, not fabricated) ------------------------ */
function triggersPanel(d) {
  const p = panel(ptitle("What would change this view"));
  const c = d.context || {};
  const T = 0.15; // state.py CONFIG.regime_T
  const ma200 = c.mayer_multiple ? d.price_btc / c.mayer_multiple : null;
  const list = [];
  if (d.regime !== "Bull") list.push([`Trend score closes above <b>+${T}</b> for 5 straight days`, "Regime upgrades toward BULLISH"]);
  if (d.regime !== "Bear") list.push([`Trend score closes below <b>−${T}</b> for 5 straight days`, "Regime downgrades toward BEARISH"]);
  if (ma200 != null) {
    const side = d.price_btc >= ma200 ? "breaks back below" : "reclaims";
    list.push([`Price ${side} the 200-day average (<b>${fmtUSD(ma200)}</b>)`, "Directly moves the Trend score — the single biggest lever on the headline"]);
  }
  list.push(["Weekly RSI moves past <b>70</b> (overbought) or below <b>35</b> (oversold)", "Flags a Momentum stretch — often precedes a change in the confidence score"]);
  if (c.fear_greed != null) list.push([`Fear &amp; Greed moves to the opposite extreme of today's <b>${Math.round(c.fear_greed)}</b>`, "Sentiment dimension flips direction, changing overall confidence"]);

  const box = el("div", {});
  list.forEach(([cond, effect]) => box.append(el("div", { class: "trigger" }, el("span", { class: "arrow", text: "→" }),
    el("div", { class: "cond" }, el("span", { html: cond }), " — ", effect))));
  p.append(box);
  return p;
}

/* -------------------------- implications by team (rule-based on regime) ------------------------ */
const TEAM_NOTES = {
  Bull: [
    ["Leadership", "Uptrend is confirmed by the model — a reasonable base case for planning, not just an upside scenario."],
    ["Marketing", "Setup supports scaling acquisition spend, prioritising non-stablecoin and active-trader channels."],
    ["VIP / Commercial", "Good window for renewed high-value engagement and outreach."],
    ["Product / Ops", "Watch for volume and volatility spikes typical of a live uptrend — capacity, not direction, is the risk."],
    ["Research", "Owns: watching for the trend score to re-approach the neutral band, and validating which context indicators are worth promoting to scored."],
  ],
  Neutral: [
    ["Leadership", "Market is in transition — treat any near-term GTV swing as noise, not signal, for planning."],
    ["Marketing", "Hold current acquisition budget at plan; no clear direction to lean into yet."],
    ["VIP / Commercial", "No change to outreach cadence until the direction resolves."],
    ["Product / Ops", "No unusual load signal expected while the market stays directionless."],
    ["Research", "Owns: watching which dimension — trend, momentum or sentiment — breaks the tie first."],
  ],
  Bear: [
    ["Leadership", "Downtrend is confirmed by the model — plan for softer GTV, not a quick bounce."],
    ["Marketing", "Defend spend with a strict ROI stop-loss; shift messaging toward stablecoin products."],
    ["VIP / Commercial", "Expect reduced high-value engagement; hold outreach cadence rather than cutting it entirely."],
    ["Product / Ops", "Elevated risk of fast, high-volume down-moves — capitulation phases are the most volatile."],
    ["Research", "Owns: watching for capitulation signals (sentiment + volatility extremes) that flag a turn forming."],
  ],
};
function teamsPanel(d) {
  const p = panel(ptitle("Implications by team"));
  const rows = TEAM_NOTES[d.regime] || TEAM_NOTES.Neutral;
  const grid = el("div", { class: "teamgrid" });
  rows.forEach(([name, text]) => grid.append(el("div", { class: "teamcard" }, el("h4", { text: name }), el("p", { text }))));
  p.append(grid);
  return p;
}

/* -------------------------- supporting signals: full 35-indicator catalog ------------------------ */
function signalsPanel(d) {
  const c = d.context || {};
  const p = panel(ptitle("Supporting signals — full catalog"));
  p.append(el("p", { class: "cat-note", text: "35 indicators considered for this model. 25 have a free, live data feed and are shown with today's value; the rest are marked \"not tracked\" with the reason, not guessed." }));
  CATALOG.forEach((group) => {
    p.append(el("h3", { class: "sig-h", text: `${group.horizon} · ${group.sub}` }));
    const cg = el("div", { class: "catgrid" });
    group.cats.forEach((cat) => {
      const card = el("div", { class: "catcard" }, el("h4", { text: cat.name }));
      cat.items.forEach((item) => {
        const has = item.key != null && c[item.key] != null && !isNaN(c[item.key]);
        const disp = has ? item.fmt(c[item.key]) : "not tracked";
        const note = has && item.note ? item.note(c[item.key], d) : "";
        const body = el("div", { class: "why-panel", hidden: "", text: item.why });
        card.append(expander(item.label, disp, note, body, !has));
      });
      cg.append(card);
    });
    p.append(cg);
  });
  return p;
}

/* generic expandable row */
function expander(name, read, note, body, dim) {
  const btn = el("button", { class: "exp" + (dim ? " dim" : ""), type: "button", "aria-expanded": "false" },
    el("div", { class: "exp-head" },
      el("span", { class: "name", text: name }),
      el("span", { class: "read", html: `${read}${note ? ` <em>${note}</em>` : ""}` }),
      el("span", { class: "chev", text: "▶" })),
    body);
  return btn;
}
function wireExpanders(root) {
  root.querySelectorAll("button.exp").forEach((b) => {
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") === "true";
      b.setAttribute("aria-expanded", String(!open));
      const wp = b.querySelector(".why-panel");
      if (wp) wp.hidden = open;
    });
  });
}

/* -------------------------- scorecard ----------------------- */
function scorecardPanel(bt) {
  const sc = bt && bt.scorecard;
  if (!sc) return document.createTextNode("");
  const D = sc.directional || {};
  const d90 = D[90] || D["90"] || {};
  const pc = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  const p = panel(ptitle("Backtest accuracy"));

  const stats = el("div", { class: "stats" });
  const stat = (big, lab) => el("div", { class: "stat" },
    el("div", { class: "big", text: big }), el("div", { class: "lab", text: lab }));
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
      el("td", { text: lbl }), el("td", { text: pc(r.bull_up_rate) }),
      el("td", { text: pc(r.bear_down_rate) }), el("td", { text: pc(r.directional_accuracy) })));
  });
  p.append(tbl);

  p.append(el("p", { class: "sc-note", text:
    `${sc.span ? sc.span[0] + "–" + sc.span[1] : ""} · ~${sc.cycles} market cycles · ${sc.days} days · `
    + `${sc.transitions} regime changes (${sc.per_year}/yr) · median lag at a cycle turn ${sc.turn_median_lag_days ?? "—"} days. Recomputed daily.` }));

  const body = el("div", { class: "why-panel", hidden: "", html:
    "This tool's job is the <b>daily glance</b>: is the market bull, bear or neutral right now? So the headline "
    + "number is <b>phase agreement</b> — on what share of days did the label match the cycle the market was "
    + "actually in (dated after the fact from the price history). It missed on "
    + `${pc(sc.phase_wrong_rate)} of days, almost all of them in the ~3 months after a turn while a `
    + "200-day-average system catches up. It is a lagging summary: it tells you the <i>established</i> regime, "
    + "not the one just beginning — the confidence score and the “watch” note cover “is a change coming”.<br><br>"
    + "The table below is a stricter test — on every BULLISH day, was BTC actually higher N days later? — but that "
    + "asks the label to <i>predict</i>, which no trailing indicator does well. Bear rows score low because by the "
    + "time BEARISH is confirmed, most of the drop is done and price is often already bouncing. The 1–3 year rows "
    + "(greyed) are meaningless: over multi-year windows BTC almost always rose, so any bearish call is scored "
    + "“wrong” and only ~2–4 independent windows exist.<br><br>"
    + "Built on ~3 cycles of history — read as direction and magnitude, not precision." });
  p.append(expander("How to read these numbers", "read", null, body));
  return p;
}

/* -------------------------- methodology ---------------------- */
function methodologyPanel() {
  const p = panel(ptitle("How the reading is built"));
  const body = el("div", { class: "why-panel", hidden: "", html:
    "The headline regime comes from the <b>Trend</b> dimension only: BULLISH above +0.15, BEARISH below −0.15, "
    + "NEUTRAL in between, with a five-day confirmation so the label does not flip on noise. Trend blends the "
    + "Mayer Multiple, the 200-day slope, the 50/200 cross and a 200-week valuation counterweight. "
    + "<b>Momentum</b> adds weekly RSI, 90-day rate of change, breadth and the on-chain active-address trend; "
    + "<b>Sentiment</b> blends Fear &amp; Greed, perp funding and the stablecoin ratio. Momentum and Sentiment "
    + "never move the label — they set the direction arrow, the confidence score and the watch notes.<br><br>"
    + "Confidence rises when the three dimensions agree, the trend score sits well clear of the neutral band, "
    + "sentiment is not at a froth or capitulation extreme, and volatility is calm.<br><br>"
    + "The \"Supporting signals\" catalog below lists 35 indicators considered for this model. Only the ones above "
    + "feed the score; most of the rest are shown as live context, and a handful are marked \"not tracked\" because "
    + "they need a paid on-chain or derivatives data provider we haven't wired in.<br><br>"
    + "Every input is trailing — it describes what the market has already done, it does not forecast. Validated "
    + "on ~3 market cycles: it flagged every major cycle top and bottom in that window, a median of about three "
    + "months after the price extreme. Treat it as direction rather than a precise number. Thresholds and weights "
    + "are all in one place in the source (state.py → CONFIG)." });
  p.append(expander("Regime logic, confidence, and limits", "read", null, body));
  return p;
}

/* ----------------------- halving / 50-200 cross chart (real data) ------------------- */
const HALVINGS = ["2016-07-09", "2020-05-11", "2024-04-20"]; // 2012-11-28 predates our price history
const MS_DAY = 86400000;
const LAST_HALVING = Date.parse("2024-04-20T00:00:00Z");
const BLOCKS_PER_DAY = 144; // ~10-minute block target
function halvingProgress() {
  const daysSince = (Date.now() - LAST_HALVING) / MS_DAY;
  const blocksSince = daysSince * BLOCKS_PER_DAY;
  const pct = clamp((blocksSince / 210000) * 100, 0, 99.9);
  const blocksLeft = Math.max(0, Math.round(210000 - blocksSince));
  const nextDate = new Date(LAST_HALVING + (210000 / BLOCKS_PER_DAY) * MS_DAY);
  return { pct, blocksLeft, nextDate };
}

function haloChartPanel(rows) {
  const p = panel();
  p.append(el("p", { class: "ptitle", text: "BTC price history — halving cycles & the 50/200-day cross" }));
  const prog = halvingProgress();
  const progBox = el("div", { class: "halving-progress" },
    el("div", { class: "pct", text: prog.pct.toFixed(0) + "%" }),
    el("div", { class: "bar-col" },
      el("div", { class: "bar" }, el("div", { class: "bar-fill", style: `width:${prog.pct}%` })),
      el("div", { class: "cap", text: `Progress to the next halving — ~${prog.blocksLeft.toLocaleString()} blocks left, est. ${prog.nextDate.toLocaleDateString("en-US", { month: "short", year: "numeric" })}. Block-height math, not a price call.` })));
  p.append(progBox);

  const rngBox = el("div", { class: "rng chart-rng" });
  p.append(rngBox);
  const chartWrap = el("div", { class: "chart-wrap" });
  const svg = el("svg", { viewBox: "0 0 900 320", preserveAspectRatio: "xMidYMid meet" });
  chartWrap.append(svg);
  p.append(chartWrap);

  const ranges = [["1Y", 1], ["3Y", 3], ["5Y", 5], ["10Y", 10], ["All", null]];
  let cur = null;
  const draw = () => {
    rngBox.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.y === cur || (b.dataset.y === "null" && cur === null)));
    renderHaloChart(svg, rows, cur, prog);
  };
  ranges.forEach(([label, years]) => {
    const b = el("button", { text: label, "data-y": String(years) });
    b.onclick = () => { cur = years; draw(); };
    rngBox.append(b);
  });
  draw();

  const legend = el("div", { class: "legend chart-legend" });
  [["up", "Price, up day"], ["down", "Price, down day"], ["sma50", "50-day MA"], ["sma200", "200-day MA"],
   ["halving", "Halving"], ["golden", "Golden cross"], ["death", "Death cross"], ["next-halving", "Next halving (est.)"]]
    .forEach(([cls, lab]) => legend.append(el("span", { class: "lg" }, el("i", { class: "sw " + cls }), lab)));
  p.append(legend);
  p.append(el("p", { class: "chart-note", text: "Purely historical — no projected path. Trend structure only; the read for what's next is in \"Engine dimensions\" above." }));
  return p;
}

function renderHaloChart(svg, rows, years, prog) {
  svg.innerHTML = "";
  const series = rows.filter((r) => r.close > 0).map((r) => ({ t: Date.parse(r.date + "T00:00:00Z"), price: r.close }));
  if (!series.length) return;
  const sma = (n) => {
    const out = new Array(series.length).fill(null);
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i].price;
      if (i >= n) sum -= series[i - n].price;
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  };
  const sma50 = sma(50), sma200 = sma(200);
  const crosses = [];
  for (let i = 1; i < series.length; i++) {
    if (sma50[i - 1] == null || sma200[i - 1] == null) continue;
    const prevDiff = sma50[i - 1] - sma200[i - 1], diff = sma50[i] - sma200[i];
    if (prevDiff <= 0 && diff > 0) crosses.push({ t: series[i].t, type: "golden", price: (sma50[i] + sma200[i]) / 2 });
    else if (prevDiff >= 0 && diff < 0) crosses.push({ t: series[i].t, type: "death", price: (sma50[i] + sma200[i]) / 2 });
  }

  const lastData = series[series.length - 1].t;
  const tMax = years === null ? prog.nextDate.getTime() : lastData;
  const tMin = years ? Math.max(series[0].t, lastData - years * 365 * MS_DAY) : series[0].t;
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

  const make = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

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
    const label = new Date(t).toLocaleDateString("en-US", years && years <= 3 ? { month: "short", year: "2-digit" } : { year: "numeric" });
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

  if (years === null) {
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
    gpx.append(make("line", {
      x1: x(series[ia].t).toFixed(1), y1: y(p0).toFixed(1),
      x2: x(series[ib].t).toFixed(1), y2: y(p1).toFixed(1),
      class: p1 >= p0 ? "up" : "down",
    }));
  }
  svg.append(gpx);

  const linePath = (getVal) => {
    let dpath = "";
    idx.forEach((i) => {
      const v = getVal(i);
      if (v == null) return;
      const cmd = dpath ? "L" : "M";
      dpath += `${cmd}${x(series[i].t).toFixed(1)} ${y(v).toFixed(1)} `;
    });
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
}

main();
