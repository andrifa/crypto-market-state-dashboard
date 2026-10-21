"use strict";

/* Glossary: plain-language explanations of every indicator that feeds the score, grouped by the
   timeframe it drives. The grouping and weights mirror backend/state.py (CONFIG w_sent / w_moment / w_trend)
   and never change from day to day -- only the values do. "today" lines read the live numbers. */

const GLOSSARY_GROUPS = [
  {
    key: "short", title: "Short term", sub: "about 1 week · mood and positioning · scored as “Sentiment”",
    note: "Moves the confidence level and the short-term read. Does not change the headline label.",
    items: [
      {
        name: "Fear & Greed Index", weight: "50% of the short-term score",
        what: "A 0–100 mood score for the crypto market, published daily by Alternative.me. It blends price swings, trading volume, social media activity, surveys and search trends.",
        read: "0–25 is extreme fear, 25–46 fear, 46–54 neutral, 54–75 greed, above 75 extreme greed. Very high means the crowd is excited and the market can get overheated. Very low means people are scared, which has often been close to a bottom.",
        today: (c) => {
          const v = c.fear_greed;
          if (v == null) return null;
          const band = v < 25 ? "extreme fear" : v < 46 ? "fear" : v < 54 ? "neutral" : v < 75 ? "greed" : "extreme greed";
          return `${Math.round(v)} out of 100 — ${band}.`;
        },
      },
      {
        name: "Funding rate", aka: "funding", weight: "30% of the short-term score",
        what: "On perpetual futures (bets on price with no expiry date), traders betting on a rise and traders betting on a fall pay each other a small fee every few hours. That fee is the funding rate. We look at how unusual it is compared with the last 90 days (see z-score).",
        read: "Unusually high: many traders are paying to bet on a rise, so bets are crowded on one side and a sharp pullback is more likely. Unusually low or negative: pessimism is crowded, which has often come near turning points. Near normal: nothing stands out.",
        today: (c) => {
          const z = c.funding_z;
          if (z == null) return null;
          const a = Math.abs(z);
          const word = a < 1 ? "normal, nothing looks crowded" : a < 1.5 ? "a little stretched" : z > 0 ? "crowded on the buying side" : "crowded on the selling side";
          return `z-score ${fmtNum(z, 2, true)} — ${word}.`;
        },
      },
      {
        name: "Stablecoin Supply Ratio", aka: "SSR", weight: "20% of the short-term score",
        what: "Bitcoin's total market value divided by the total value of all stablecoins (digital dollars such as USDT and USDC). Stablecoins are the cash sitting inside crypto, so this compares what Bitcoin is worth with the cash that could buy it.",
        read: "Lower than usual: a lot of cash is waiting relative to Bitcoin, so there is more potential buying power. Higher than usual: less cash on the sidelines. We score how far today's ratio is from its own pattern over the past year (see z-score).",
        today: (c) => (c.ssr == null ? null : `${numStr(c.ssr, 1)} — Bitcoin is worth about ${numStr(c.ssr, 1)}× all stablecoins combined.`),
      },
    ],
  },
  {
    key: "medium", title: "Medium term", sub: "the coming weeks to about 1 month · momentum · scored as “Momentum”",
    note: "Moves the confidence level and the medium-term read. Does not change the headline label.",
    items: [
      {
        name: "Weekly RSI", aka: "Relative Strength Index", weight: "30% of the medium-term score",
        what: "A 0–100 gauge of how strongly price has risen versus fallen over recent weeks (we use 14 weekly closes).",
        read: "Above about 70: buying has run hot, so the move is stretched and more fragile. Below about 35: selling has run hot, which has often come near a bottom. Around 50: balanced.",
        today: (c) => {
          const v = c.rsi_weekly;
          if (v == null) return null;
          const word = v < 35 ? "selling has run hot" : v < 45 ? "on the weak side" : v <= 55 ? "balanced" : v < 70 ? "firm, not stretched" : "buying has run hot";
          return `${Math.round(v)} — ${word}.`;
        },
      },
      {
        name: "Active addresses", weight: "30% of the medium-term score",
        what: "The number of Bitcoin addresses that sent or received coins on a day, compared with their own average over the past year.",
        read: "Above 1.00: more people are using the network than usual (activity is expanding). Below 1.00: usage is quieter than usual.",
        today: (c) => {
          const v = c.active_addr_ratio;
          if (v == null) return null;
          const word = v >= 1.05 ? "busier than usual" : v >= 0.95 ? "about normal" : "quieter than usual";
          return `${numStr(v, 2)} — ${word}.`;
        },
      },
      {
        name: "90-day price change", aka: "rate of change, ROC", weight: "24% of the medium-term score",
        what: "How much the Bitcoin price has changed over the last 90 days.",
        read: "Clearly positive: the market has been climbing for months. Clearly negative: it has been falling. We look at the direction and the size.",
        today: (c) => (c.roc_90d == null ? null : `${fmtPct(c.roc_90d, 1, true)} over the last 90 days.`),
      },
      {
        name: "Breadth", aka: "days above the 200-day average", weight: "16% of the medium-term score",
        what: "Of the last 90 days, the share that closed above the 200-day average price.",
        read: "Above 50%: most recent days were strong, and 70% or more is broad strength. If price is rising but this share is low, the gain came from one recent push rather than steady strength.",
        today: (c) => (c.breadth_90d == null ? null : `${fmtPct(c.breadth_90d, 0)} of the last 90 days closed above the 200-day average.`),
      },
    ],
  },
  {
    key: "long", title: "Long term", sub: "about 3–6 months · trend · scored as “Trend”",
    note: "This is the only group that sets the headline label (BULLISH / NEUTRAL / BEARISH).",
    items: [
      {
        name: "Mayer Multiple", weight: "34% of the long-term score",
        what: "Price divided by its 200-day average. 1.00 means price is exactly on the average.",
        read: "Above 1: price is above its long-term average, a healthy trend. Below 1: it is below, a weak trend. Far above 1 has historically meant overheated, and well below 1 a deep discount.",
        today: (c) => {
          const v = c.mayer_multiple;
          if (v == null) return null;
          const gap = Math.abs(v - 1) * 100;
          return `${numStr(v, 2)} — price is ${gap.toFixed(0)}% ${v >= 1 ? "above" : "below"} its 200-day average.`;
        },
      },
      {
        name: "200-day average slope", weight: "28% of the long-term score",
        what: "Whether the 200-day average itself is rising or falling, measured over the last 90 days.",
        read: "Rising: the long-term trend is up. Falling: it is still down. Price above the average while the average is still falling is an early recovery, not yet a confirmed uptrend.",
        today: (c) => {
          const v = c.ma200_slope_90d;
          if (v == null) return null;
          const word = v > 0.01 ? "rising" : v < -0.01 ? "falling" : "roughly flat";
          return `${fmtPct(v, 1, true)} over 90 days — ${word}.`;
        },
      },
      {
        name: "200-week valuation", aka: "200-week moving average multiple", weight: "20% of the long-term score",
        what: "Price divided by its 200-week (about 4-year) average.",
        read: "Close to 1: price is near its long-run average, which in past cycles was cheap with room to rise. Far above: stretched, with a higher risk of a pullback. In the score this works as a counterweight, so the trend reading does not just follow the price up.",
        today: (c) => {
          const v = c.ma_200w_multiple;
          if (v == null) return null;
          return `${numStr(v, 2)} — price is ${(Math.abs(v - 1) * 100).toFixed(0)}% ${v >= 1 ? "above" : "below"} its 200-week average.`;
        },
      },
      {
        name: "50/200-day cross", aka: "golden cross / death cross", weight: "18% of the long-term score",
        what: "The gap between the 50-day average and the 200-day average. When the faster 50-day line rises above the slower 200-day line it is called a golden cross. When it falls below, a death cross.",
        read: "Positive: the short-term trend is stronger than the long-term one (a bullish structure). Negative: weaker.",
        today: (c) => {
          const v = c.ma_cross;
          if (v == null) return null;
          return `${fmtPct(v, 1, true)} — the 50-day average is ${v >= 0 ? "above" : "below"} the 200-day average.`;
        },
      },
    ],
  },
  {
    key: "terms", title: "Terms used on this page", sub: "words that show up across the dashboard",
    note: "",
    items: [
      {
        name: "z-score", aka: "standard score",
        what: "A way to say how unusual a number is compared with its own recent history.",
        read: "0 is typical. About ±1 is a little unusual. ±2 or beyond is rare. It lets us compare things with different units on one scale.",
      },
      {
        name: "Moving average", aka: "MA, 50-day, 200-day, 200-week",
        what: "The average closing price over the last N days (or weeks). It smooths out daily noise.",
        read: "Price above a moving average suggests an uptrend, below suggests a downtrend. The 200-day line is the common “long-term trend line”.",
      },
      {
        name: "Headline label", aka: "regime: BULLISH / NEUTRAL / BEARISH",
        what: "The big word at the top. It comes only from the long-term (Trend) score: BULLISH above +0.15, BEARISH below −0.15, NEUTRAL in between. A new label needs 5 days in a row before it replaces the old one.",
        read: "It describes what has already happened, not a forecast.",
        today: (c, d) => (d.headline ? `${d.headline}.` : null),
      },
      {
        name: "Conviction", aka: "confidence, 0–100",
        what: "How much to trust the headline label today. It is higher when trend, momentum and sentiment agree, the trend is clearly away from neutral, sentiment is not at an extreme, and the market is calm. It is lower when signals conflict.",
        read: "Use it as a confidence level, not a probability.",
        today: (c, d) => (d.conviction == null ? null : `${d.conviction} out of 100${d.conviction_level ? " — " + String(d.conviction_level).toLowerCase() : ""}.`),
      },
    ],
  },
];

function renderGlossary(d) {
  const box = document.getElementById("glossary");
  if (!box) return;
  box.textContent = "";
  const c = d.context || {};

  box.append(el("p", { class: "gl-note", html:
    "Each timeframe always looks at the <b>same fixed set of indicators</b>: 3 for the short term, 4 for the medium term and 4 for the long term. " +
    "The list does not change from day to day — only the numbers do. Open a group to see what each indicator means and how to read it." }));

  const map = el("div", { class: "gl-map" });
  GLOSSARY_GROUPS.filter((g) => g.key !== "terms").forEach((g) => {
    const ul = el("ul");
    g.items.forEach((it) => ul.append(el("li", { text: it.name })));
    map.append(el("div", {}, el("b", { text: g.title }), el("small", { text: g.sub.split(" · ")[0] }), ul));
  });
  box.append(map);

  const search = el("input", { class: "gl-search", id: "glSearch", type: "search", placeholder: "Search a term, e.g. RSI", "aria-label": "Search the glossary" });
  box.append(search);

  const groups = [];
  GLOSSARY_GROUPS.forEach((g, gi) => {
    const det = el("details", { class: "gl-group" });
    if (gi === 0) det.setAttribute("open", "");
    det.append(el("summary", {}, g.title, el("small", { text: g.sub })));
    if (g.note) det.append(el("p", { class: "gl-note", text: g.note }));
    const items = g.items.map((it) => {
      const t = it.today ? it.today(c, d) : null;
      const card = el("div", { class: "gl-item" },
        el("h5", { text: it.aka ? `${it.name} (${it.aka})` : it.name }),
        el("p", { html: `<span class="gl-k">What it is</span><br>${it.what}` }),
        el("p", { html: `<span class="gl-k">How to read it</span><br>${it.read}` }));
      if (it.weight) card.append(el("p", { html: `<span class="gl-k">Weight</span><br>${it.weight}` }));
      if (t) card.append(el("p", { class: "gl-today", html: `<span class="gl-k">${AS_OF ? "On this day" : "Today"}</span><br>${t}` }));
      det.append(card);
      return { card, text: (it.name + " " + (it.aka || "") + " " + it.what + " " + it.read).toLowerCase() };
    });
    groups.push({ det, items });
    box.append(det);
  });

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    groups.forEach(({ det, items }) => {
      let any = false;
      items.forEach(({ card, text }) => { const hit = !q || text.includes(q); card.hidden = !hit; any = any || hit; });
      det.hidden = !any;
      if (q && any) det.setAttribute("open", "");
    });
  });
}
