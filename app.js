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
const METERS = [
  { key: "mayer_multiple", label: "Mayer Multiple", dp: 2, min: 0.5, max: 2.4, band: [0.8, 1.5],
    note: (v) => (v >= 1 ? "above trend" : "below trend"),
    why: "Price divided by the 200-day moving average — one number for “how far above or below trend are we”. Historically, readings below ~1 have been accumulation zones and above ~2.4 have marked blow-off tops. Coinbase Institutional's published market-regime rule is built on exactly this ratio." },
  { key: "ma200_slope_90d", label: "MA200 trend · 90d", pctd: 1, min: -0.25, max: 0.25, band: [0, 0.25],
    note: (v) => (v >= 0 ? "rising" : "falling"),
    why: "The change in the 200-day average over the last 90 days. Price can jump above the average for a week on a bounce; the average itself only turns after a genuine shift in the market. A rising slope is the confirmation that an uptrend is structural, not a relief rally." },
  { key: "ma_200w_multiple", label: "200-week MA multiple", dp: 2, min: 0.7, max: 6, band: [0.9, 3.0],
    note: (v) => (v >= 3 ? "stretched" : v <= 1.1 ? "near the floor" : "mid-cycle"),
    why: "Price divided by its 200-week (~4-year) moving average — a line BTC has only briefly traded below, at generational lows. Near 1 the market is historically cheap; 4–5× and above has marked every cycle blow-off top. It acts as a valuation counterweight to the trend signals: a market far above its long-term floor is scored more cautiously." },
  { key: "active_addr_ratio", label: "Active addresses vs 1y avg", dp: 2, min: 0.6, max: 1.6, band: [0.95, 1.4],
    note: (v) => (v >= 1 ? "expanding" : "contracting"),
    why: "Daily active Bitcoin addresses divided by their own 365-day average — a direct read on whether the network is being used more or less than a year ago. In the backtest this was the single most predictive input: rising on-chain usage led higher prices more reliably than any price-only momentum measure." },
  { key: "puell_multiple", label: "Puell Multiple", dp: 2, min: 0.3, max: 4, band: [0.5, 2.5],
    note: (v) => (v <= 0.6 ? "miner capitulation" : v >= 3 ? "miner euphoria" : "normal"),
    why: "Daily miner revenue divided by its 365-day average. Very low readings mean miners are under maximum stress and have historically sat near cycle bottoms; very high readings cluster around tops. Shown as context — on this ~3-cycle sample it was too noisy to score, but it is a widely-watched cycle gauge." },
  { key: "drawdown_from_ath", label: "Drawdown from ATH", pctd: 0, min: -0.85, max: 0, band: [-0.15, 0],
    note: () => "",
    why: "How far below the all-time high price currently sits. It separates an early wobble (−10%) from a full bear market (−60% or more) — situations that call for opposite budget postures even if both read as “down”." },
  { key: "rsi_weekly", label: "Weekly RSI", dp: 0, min: 20, max: 85, band: [35, 65],
    note: (v) => (v >= 70 ? "overbought" : v <= 35 ? "oversold" : "neutral"),
    why: "Relative Strength Index on a weekly candle, so it filters out daily noise. Above 70 is overbought (near-term pullback risk); below 35 is washed out (historically close to cycle lows). Weekly rather than daily because budget decisions run on weeks, not hours." },
  { key: "fear_greed", label: "Fear & Greed Index", dp: 0, min: 0, max: 100, band: [46, 54],
    note: (_, d) => d.sentiment_band,
    why: "A daily composite of volatility, volume/momentum, social media, BTC dominance and survey data, published by Alternative.me. It is the crowd-emotion gauge the whole industry references, so it gives marketing, product and leadership one shared vocabulary for “how does the market feel”." },
  { key: "funding_z", label: "Funding z-score", dp: 2, min: -3, max: 3, band: [-1.5, 1.5],
    note: (v) => (Math.abs(v) >= 1.5 ? "stretched" : "normal"),
    why: "The cost to hold a leveraged long on perpetual futures, standardised against its own recent range. Persistently high means too many crowded longs paying to stay in — fuel for a sharp correction. It is sentiment revealed by real money at risk, not a survey answer." },
  { key: "vol_percentile", label: "Volatility · percentile", pctd: 0, min: 0, max: 1, band: [0, 0.7],
    note: (v) => (v >= 0.7 ? "elevated" : "calm"),
    why: "Where 30-day realised volatility sits within its trailing two-year range. Volatility spikes cluster around capitulations and violent reversals, so a high reading lowers confidence in whatever the trend is currently saying." },
  { key: "btc_dominance", label: "BTC dominance", dp: 1, suffix: "%", min: 35, max: 70, band: null,
    note: () => "",
    why: "Bitcoin's share of total crypto market capitalisation. Rising dominance during a downturn signals a flight to relative safety; falling dominance during an uptrend signals risk appetite spreading into altcoins. Shown as context — it is not a scored input to the regime." },
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
    el("div", { class: "grid2" }, whyPanel(d), gaugePanel(d)),
    dimensionsPanel(d),
    indicatorsPanel(d),
    chartPanel(hist),
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
  ));
  return p;
}

/* ------------------------------- why ---------------------------- */
function whyPanel(d) {
  const p = panel(ptitle("Why this reading"));
  if (d.reasons && d.reasons.length) {
    const w = el("div", { class: "why" });
    const ul = el("ul");
    d.reasons.forEach((r) => ul.append(el("li", { text: r })));
    w.append(ul);
    p.append(w);
  }
  if (d.watch) p.append(el("div", { class: "watch" }, el("b", { text: "Watch" }), document.createTextNode(d.watch)));
  if (d.changed_today) p.append(el("div", { class: "changed", text: d.changed_today }));
  return p;
}

/* ------------------------------ gauges ------------------------- */
function gaugePanel(d) {
  const p = panel(ptitle("Confidence & sentiment"));
  const stack = el("div", { class: "gstack" });
  stack.append(gaugeBlock("Signal confidence", `${d.conviction_level} · ${d.conviction ?? "—"}/100`,
    arcGauge(d.conviction ?? 0, [45, 70])));
  const fg = (d.context && d.context.fear_greed) ?? null;
  stack.append(gaugeBlock("Fear & Greed", d.sentiment_band || "—", fngDial(fg)));
  p.append(stack);
  return p;
}
const gaugeBlock = (k, v, body) => el("div", {},
  el("div", { class: "gcap" }, el("span", { class: "k", text: k }), el("span", { class: "v", text: v })), body);

function arcGauge(value, ticks = []) {
  const W = 240, H = 128, cx = 120, cy = 116, r = 96, sw = 11;
  const pt = (f) => [cx + r * Math.cos(Math.PI * (1 - f)), cy - r * Math.sin(Math.PI * (1 - f))];
  const arc = (f0, f1) => { const [x0, y0] = pt(f0), [x1, y1] = pt(f1); return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const f = clamp(value / 100, 0, 1);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  svg.append(el("path", { d: arc(0, 1), fill: "none", stroke: "var(--hair)", "stroke-width": sw, "stroke-linecap": "round" }));
  svg.append(el("path", { d: arc(0, f), fill: "none", stroke: "var(--rk-purple)", "stroke-width": sw, "stroke-linecap": "round" }));
  ticks.forEach((tk) => { const [x, y] = pt(tk / 100); const xi = cx + (r - sw) * Math.cos(Math.PI * (1 - tk / 100)), yi = cy - (r - sw) * Math.sin(Math.PI * (1 - tk / 100)); svg.append(el("line", { x1: x, y1: y, x2: xi, y2: yi, stroke: "var(--surface)", "stroke-width": 2 })); });
  const [mx, my] = pt(f);
  svg.append(el("circle", { cx: mx, cy: my, r: 7, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2.5 }));
  svg.append(el("text", { x: cx, y: cy - 8, "text-anchor": "middle", "font-family": "Space Grotesk, sans-serif", "font-size": 28, "font-weight": 600, fill: "var(--ink)" }, value == null ? "—" : String(Math.round(value))));
  return svg;
}
function fngDial(value) {
  const W = 240, H = 128, cx = 120, cy = 116, r = 96, sw = 11;
  const pt = (f) => [cx + r * Math.cos(Math.PI * (1 - f)), cy - r * Math.sin(Math.PI * (1 - f))];
  const arc = (f0, f1) => { const [x0, y0] = pt(f0), [x1, y1] = pt(f1); return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  [[0, 25, "var(--bear)"], [25, 46, "#CC7A5A"], [46, 54, "var(--gold)"], [54, 75, "#43B3A6"], [75, 100, "var(--bull)"]]
    .forEach(([a, b, c]) => svg.append(el("path", { d: arc(a / 100, b / 100), fill: "none", stroke: c, "stroke-width": sw })));
  if (value != null) {
    const f = clamp(value / 100, 0, 1);
    const [mx, my] = pt(f);
    svg.append(el("circle", { cx: mx, cy: my, r: 7, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2.5 }));
    svg.append(el("text", { x: cx, y: cy - 8, "text-anchor": "middle", "font-family": "Space Grotesk, sans-serif", "font-size": 28, "font-weight": 600, fill: "var(--ink)" }, String(Math.round(value))));
  }
  return svg;
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

/* -------------------------- dimensions ------------------------- */
function dimensionsPanel(d) {
  const s = d.scores || {};
  const p = panel(ptitle("Engine dimensions — score −1 to +1"));
  [["Trend", s.trend], ["Momentum", s.momentum], ["Sentiment", s.sentiment]].forEach(([lab, v]) => {
    const body = el("div", {},
      divBar(v ?? 0),
      el("div", { class: "why-panel", hidden: "" , text: DIM_WHY[lab] }));
    p.append(expander(lab, v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2), null, body));
  });
  return p;
}

/* -------------------------- indicators ------------------------ */
function indicatorsPanel(d) {
  const x = d.context || {};
  const p = panel(ptitle("Supporting indicators"));
  METERS.forEach((m) => {
    const v = x[m.key];
    const has = v != null && !isNaN(v);
    const disp = !has ? "—" : (m.pctd != null ? (v * 100).toFixed(m.pctd) + "%" : v.toFixed(m.dp) + (m.suffix || ""));
    const note = has ? (m.note(v, d) || "").trim() : "";

    const track = el("div", { class: "track-lite" });
    if (has) {
      const f = clamp((v - m.min) / (m.max - m.min), 0, 1) * 100;
      if (m.band) {
        const b0 = clamp((m.band[0] - m.min) / (m.max - m.min), 0, 1) * 100;
        const b1 = clamp((m.band[1] - m.min) / (m.max - m.min), 0, 1) * 100;
        track.append(el("div", { class: "band", style: `left:${b0}%; width:${b1 - b0}%` }));
      }
      track.append(el("div", { class: "pin", style: `left:${f}%` }));
    }
    const body = el("div", {}, track, el("div", { class: "why-panel", hidden: "", text: m.why }));
    p.append(expander(m.label, disp, note, body));
  });
  return p;
}

/* generic expandable row */
function expander(name, read, note, body) {
  const btn = el("button", { class: "exp", type: "button", "aria-expanded": "false" },
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
    + "Every input is trailing — it describes what the market has already done, it does not forecast. Validated "
    + "on ~3 market cycles: it flagged every major cycle top and bottom in that window, a median of about three "
    + "months after the price extreme. Treat it as direction rather than a precise number. Thresholds and weights "
    + "are all in one place in the source (state.py → CONFIG)." });
  p.append(expander("Regime logic, confidence, and limits", "read", null, body));
  return p;
}

/* ----------------------------- chart ------------------------- */
function chartPanel(rows) {
  const p = panel();
  const head = el("div", { class: "chart-head" });
  head.append(el("p", { class: "ptitle", text: "BTC & regime — history", style: "margin:0; flex:0 1 auto;" }));
  const rng = el("div", { class: "rng" });
  head.append(rng);
  p.append(head);
  const readout = el("div", { class: "readout" });
  const box = el("div", {});
  p.append(readout, box);
  const legend = el("div", { class: "legend" });
  [["Bull", "Bullish"], ["Neutral", "Neutral"], ["Bear", "Bearish"]].forEach(([k, lab]) =>
    legend.append(el("span", { html: `<i style="background:${REG_WASH[k]}"></i>${lab}` })));
  p.append(legend);

  const ranges = { "1Y": 365, "3Y": 1095, "All": 1e9 };
  let cur = "3Y";
  const draw = () => {
    rng.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.textContent === cur));
    box.textContent = "";
    box.append(renderChart(rows.slice(Math.max(0, rows.length - ranges[cur])), readout));
  };
  Object.keys(ranges).forEach((k) => {
    const b = el("button", { text: k });
    b.onclick = () => { cur = k; draw(); };
    rng.append(b);
  });
  draw();
  return p;
}

function renderChart(data, readout) {
  const W = 760, H = 290, P = { l: 42, r: 8, t: 10, b: 20 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xs = (i) => P.l + (iw * i) / Math.max(1, data.length - 1);
  const lp = data.map((d) => Math.log10(d.close));
  let lo = Math.min(...lp), hi = Math.max(...lp);
  const pad = (hi - lo) * 0.06 || 0.1; lo -= pad; hi += pad;
  const ys = (v) => P.t + ih - (ih * (Math.log10(v) - lo)) / (hi - lo);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });

  let s = 0;
  for (let i = 1; i <= data.length; i++) {
    if (i === data.length || data[i].regime !== data[s].regime) {
      svg.append(el("rect", { x: xs(s), y: P.t, width: Math.max(0.5, xs(i - 1) - xs(s)), height: ih, fill: REG_WASH[data[s].regime] || "transparent" }));
      s = i;
    }
  }
  for (let e = -1; e <= 7; e++) for (const m of [1, 2, 5]) {
    const v = m * Math.pow(10, e);
    if (Math.log10(v) < lo || Math.log10(v) > hi) continue;
    const y = ys(v);
    svg.append(el("line", { x1: P.l, x2: W - P.r, y1: y, y2: y, stroke: "var(--hair)", "stroke-width": 1 }));
    svg.append(el("text", { x: 2, y: y + 3, fill: "var(--muted)", "font-size": 10 }, v >= 1000 ? v / 1000 + "k" : "" + v));
  }
  let py = null;
  data.forEach((d, i) => {
    const yr = d.date.slice(0, 4);
    if (yr !== py) { py = yr; svg.append(el("line", { x1: xs(i), x2: xs(i), y1: P.t, y2: P.t + ih, stroke: "var(--hair-strong)", "stroke-width": 1, "stroke-dasharray": "2 3" })); svg.append(el("text", { x: xs(i) + 3, y: H - 6, fill: "var(--muted)", "font-size": 10 }, yr)); }
  });
  svg.append(el("path", { d: data.map((d, i) => (i ? "L" : "M") + xs(i).toFixed(1) + " " + ys(d.close).toFixed(1)).join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 1.6, "stroke-linejoin": "round" }));

  const vline = el("line", { y1: P.t, y2: P.t + ih, stroke: "var(--rk-teal)", "stroke-width": 1, opacity: 0 });
  const dot = el("circle", { r: 3.4, fill: "var(--rk-teal)", opacity: 0 });
  svg.append(vline, dot);
  const move = (evt) => {
    const b = svg.getBoundingClientRect();
    const px = ((evt.touches ? evt.touches[0].clientX : evt.clientX) - b.left) * (W / b.width);
    let i = clamp(Math.round(((px - P.l) / iw) * (data.length - 1)), 0, data.length - 1);
    const d = data[i];
    vline.setAttribute("x1", xs(i)); vline.setAttribute("x2", xs(i)); vline.setAttribute("opacity", 1);
    dot.setAttribute("cx", xs(i)); dot.setAttribute("cy", ys(d.close)); dot.setAttribute("opacity", 1);
    readout.innerHTML = `${d.date} &nbsp; <b>${fmtUSD(d.close)}</b> &nbsp; <span style="color:${REG_VAR[REG_KEY[d.regime]]}">${d.regime}</span> &nbsp; confidence ${d.conviction}`;
  };
  const leave = () => { vline.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); readout.textContent = ""; };
  svg.addEventListener("mousemove", move);
  svg.addEventListener("mouseleave", leave);
  svg.addEventListener("touchmove", move, { passive: true });
  svg.addEventListener("touchend", leave);
  return svg;
}

main();
