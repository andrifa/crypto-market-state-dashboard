"""
Human-readable layer (English).

Turns one state row (from state.build_state) into a reading the marketing /
leadership team can act on without knowing what "trend_score" means:

  - headline .......... "BULLISH", "NEUTRAL", "BEARISH"
  - summary ........... one line
  - action ............ SCALE UP / HOLD / CUT  + short rationale
  - confidence ........ HIGH / MEDIUM / LOW  (not a raw number)
  - reasons .......... bullet points built from the actual indicator values
  - watch ............ divergence note (when there is one)
  - text ............. full ready-to-paste block for Slack / dashboard
"""
from __future__ import annotations

import pandas as pd

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]

REGIME_LABEL = {
    "Bull": "BULLISH",
    "Neutral": "NEUTRAL",
    "Bear": "BEARISH",
    "Unknown": "NOT ENOUGH DATA",
}
REGIME_TAG = {
    "Bull": "market in an uptrend",
    "Neutral": "market in transition — direction unclear",
    "Bear": "market in a downtrend",
    "Unknown": "",
}
DIRECTION_LABEL = {
    "strengthening": "strengthening", "weakening": "weakening",
    "stable": "stable", "—": "—",
}
# Fear & Greed keeps the vendor's own English labels
SENTIMENT_LABEL = {
    "Extreme Fear": "Extreme Fear", "Fear": "Fear", "Neutral": "Neutral",
    "Greed": "Greed", "Extreme Greed": "Extreme Greed", "—": "—",
}
CYCLE_LABEL = {
    "early-bull": "early uptrend",
    "mid-bull": "mid uptrend",
    "late-bull / distribution risk": "late uptrend — watch for euphoria",
    "early-bear": "early downtrend",
    "mid / late-bear": "downtrend well underway",
    "capitulation": "capitulation (panic selling)",
    "transition": "transition phase",
    "—": "—",
}


def _date(ts: pd.Timestamp) -> str:
    return f"{ts.day} {_MONTHS[ts.month - 1]} {ts.year}"


def confidence_level(conv) -> str:
    if conv is None or pd.isna(conv):
        return "—"
    conv = int(conv)
    if conv >= 70:
        return "HIGH"
    if conv >= 45:
        return "MEDIUM"
    return "LOW"


def budget_action(regime: str, cycle: str, conv) -> tuple[str, str]:
    """(action title, rationale)."""
    conv = int(conv) if conv is not None and not pd.isna(conv) else 0
    if regime == "Bull":
        if "late uptrend" in CYCLE_LABEL.get(cycle, "") or conv < 55:
            return ("HOLD at planned level",
                    "Trend is still up but maturing / the signal isn't strong. "
                    "Don't add active-trader budget; watch for euphoria.")
        return ("SCALE UP acquisition budget",
                "Uptrend is solid. Increase acquisition, prioritise non-stablecoin / "
                "active-trader channels (they benefit most in this phase).")
    if regime == "Neutral":
        return ("HOLD at planned level",
                "Market is in transition — it could break either way. "
                "Not the time for big moves up or down; wait for the direction to confirm.")
    if regime == "Bear":
        if cycle == "capitulation":
            return ("HOLD budget + prepare a scale-up plan",
                    "Downtrend, but it's in the capitulation phase — a turn could be near. "
                    "Keep the d30 ROI stop-loss and ready a scale-up plan.")
        return ("CUT / defend tightly with a stop-loss",
                "Downtrend. Maintain acquisition with a d30 ROI stop-loss, shift messaging "
                "toward stablecoins, trim active-trader channels (they tend to churn "
                "before conditions improve).")
    return ("—", "Not enough data to give a recommendation.")


def reasons(row: pd.Series) -> list[str]:
    out = []
    mayer, slope = row.get("mayer"), row.get("ma_slope")
    dd, rsi_w = row.get("drawdown"), row.get("rsi_w")
    fz = row.get("funding_z")

    if pd.notna(mayer):
        gap = (mayer - 1) * 100
        side = "above" if gap >= 0 else "below"
        out.append(f"BTC price is {abs(gap):.0f}% {side} its 200-day average.")
    if pd.notna(slope):
        d = "rising" if slope >= 0 else "falling"
        out.append(f"The 200-day trend is {d} ({slope*100:+.0f}% over the last 90 days).")
    if pd.notna(dd) and dd < -0.10:
        out.append(f"Price is still {abs(dd)*100:.0f}% below its all-time high.")
    if pd.notna(rsi_w):
        if rsi_w >= 70:
            out.append(f"Weekly RSI {rsi_w:.0f} — elevated (near-term pullback risk).")
        elif rsi_w <= 35:
            out.append(f"Weekly RSI {rsi_w:.0f} — low (historically near cheap territory).")
    if pd.notna(fz):
        if fz >= 1.5:
            out.append("Perp funding is high — long positions are crowding (sharp-pullback risk).")
        elif fz <= -1.5:
            out.append("Perp funding is negative — short positions are crowded (often seen near bottoms).")
    return out


def _lean_word(score) -> str:
    """Plain-language direction for a -1..1 dimension score (no decimals shown)."""
    if score is None or pd.isna(score):
        return "unclear"
    if score >= 0.45:
        return "strongly positive"
    if score >= 0.15:
        return "leaning positive"
    if score <= -0.45:
        return "strongly negative"
    if score <= -0.15:
        return "leaning negative"
    return "neutral"


def analysis_paragraphs(row: pd.Series) -> list[str]:
    """
    Fallback for the "What's driving this" panel: rule-based, real numbers only.
    Written for a non-technical reader -- one verdict, the one or two drivers that
    actually matter, and what would change the picture; no indicator dump (the
    full numbers live in the indicator catalog). The daily scheduled task's
    LLM-written version normally replaces this with a more natural read.
    """
    out = []

    fng, fz = row.get("fng"), row.get("funding_z")
    sent_lean = _lean_word(row.get("sentiment_score"))
    if pd.notna(fng):
        band = str(row.get("sentiment_band", "")).lower()
        s = f"Short term, the mood is {sent_lean}: the market is in a state of {band} (Fear & Greed {fng:.0f}/100)."
        if pd.notna(fz):
            if fz >= 1.5:
                s += " Traders are paying a notable premium to bet on rises, a sign long positions are getting crowded, so a sharp pullback is more likely if sentiment cools."
            elif fz <= -1.5:
                s += " Traders are paying to bet on falls, a sign pessimism is crowded, which has often come near turning points."
            else:
                s += " Leverage looks normal rather than crowded, so the mood isn't being pushed by risky bets."
        out.append(s)

    rsi_w, roc90, breadth = row.get("rsi_w"), row.get("roc90"), row.get("breadth")
    mom_lean = _lean_word(row.get("momentum_score"))
    if pd.notna(roc90):
        s = f"Over the coming weeks, momentum is {mom_lean}: price is {roc90*100:+.0f}% over the last 90 days."
        if pd.notna(breadth) and roc90 > 0 and breadth < 0.55:
            s += f" But only {breadth*100:.0f}% of those days closed above the long-term average, so the gain is concentrated in a recent push rather than broad strength."
        elif pd.notna(rsi_w) and rsi_w >= 70:
            s += " Buying has run hot, so the move is more stretched than usual."
        elif pd.notna(rsi_w) and rsi_w <= 35:
            s += " Selling has run hot, which has often come near a bottom."
        out.append(s)

    mayer, slope, dd = row.get("mayer"), row.get("ma_slope"), row.get("drawdown")
    trend_lean = _lean_word(row.get("trend_score"))
    if pd.notna(mayer):
        side = "above" if mayer >= 1 else "below"
        s = f"Over the longer run, the trend is {trend_lean}: price sits {side} its 200-day average"
        if pd.notna(slope):
            s += f", and that average is itself {'rising' if slope >= 0 else 'still falling'}"
        s += "."
        if pd.notna(slope) and mayer >= 1 and slope < 0:
            s += " That is an early recovery, not yet a confirmed uptrend."
        if pd.notna(dd) and dd < -0.15:
            s += f" Price is also still {abs(dd)*100:.0f}% below its all-time high."
        out.append(s)

    return out


def marketing_note(row: pd.Series) -> str:
    """
    Rule-based fallback for the Marketing card in "Implications by team" -- unlike
    action_detail (overall budget posture), this is channel/messaging-specific and
    grounded in the day's actual momentum/sentiment/breadth numbers, not just regime.
    """
    regime = row.get("regime", "Unknown")
    cycle = row.get("cycle", "—")
    conv = row.get("conviction")
    conv = int(conv) if conv is not None and not pd.isna(conv) else None
    band = row.get("sentiment_band", "—")
    roc90, breadth = row.get("roc90"), row.get("breadth")

    if regime == "Bull":
        if "late uptrend" in CYCLE_LABEL.get(cycle, "") or (conv is not None and conv < 55):
            s = "Lean toward non-stablecoin and active-trader channels, but keep the increase modest"
        else:
            s = "Scale acquisition spend toward non-stablecoin and active-trader channels"
        bits = []
        if pd.notna(roc90):
            bits.append(f"the {roc90*100:.0f}% 90-day move gives campaigns a real growth story to lead with")
        if pd.notna(breadth) and breadth < 0.5:
            bits.append(f"breadth is only {breadth*100:.0f}%, so don't frame this as a broad, settled uptrend")
        if band in ("Greed", "Extreme Greed"):
            bits.append(f"sentiment ({band}) is already warm, so lead with the trend, not FOMO urgency")
        return s + (" — " + "; ".join(bits) + "." if bits else ".")

    if regime == "Neutral":
        s = "Hold acquisition spend at plan across channels; there isn't a clear enough directional story yet to favour one channel over another."
        if band in ("Fear", "Extreme Fear"):
            s += f" Sentiment is {band.lower()}, so avoid greed-framed messaging until the picture clarifies."
        elif band in ("Greed", "Extreme Greed"):
            s += f" Sentiment ({band}) is running ahead of the actual trend, so avoid hype-driven creative."
        return s

    if regime == "Bear":
        if cycle == "capitulation":
            return ("Defend spend with a strict ROI stop-loss, but keep a scale-up plan ready — capitulation "
                    "phases can turn quickly, and stablecoin-first messaging still fits until a turn is confirmed.")
        s = "Shift messaging toward stablecoin products and defend spend with a strict ROI stop-loss"
        if pd.notna(roc90) and roc90 < 0:
            s += (f"; the {abs(roc90)*100:.0f}% 90-day decline is reason enough to trim active-trader channel "
                  "spend specifically, since it tends to churn hardest here.")
        else:
            s += "."
        return s

    return "Not enough data yet to give channel-specific guidance."


def watch(row: pd.Series) -> str | None:
    regime = row.get("regime")
    ts, ms = row.get("trend_score"), row.get("momentum_score")
    band = row.get("sentiment_band")

    if pd.notna(ts) and pd.notna(ms) and ts < 0 < ms and regime in ("Bear", "Neutral"):
        return ("Price and momentum are improving while the long-term trend is still down — "
                "a classic 'bottom turning' pattern. If the 200-day trend flattens, "
                "it may move up to BULLISH.")
    if pd.notna(ts) and pd.notna(ms) and ms < 0 < ts and regime in ("Bull", "Neutral"):
        return ("Momentum is weakening even though the trend is still up — "
                "watch for a possible reversal.")
    if band in ("Greed", "Extreme Greed") and regime != "Bull":
        return (f"Sentiment ({band}) is far more optimistic than actual price conditions — "
                "beware a false signal.")
    if band in ("Fear", "Extreme Fear") and regime == "Bull":
        return (f"Sentiment ({band}) is still pessimistic despite the uptrend — "
                "historically that leaves room to keep rising.")
    return None


def friendly_row(row: pd.Series, prev: pd.Series | None = None) -> dict:
    regime = row.get("regime", "Unknown")
    conv = row.get("conviction")
    cycle = row.get("cycle", "—")
    band = row.get("sentiment_band", "—")
    direction = row.get("direction", "—")

    action_title, action_detail = budget_action(regime, cycle, conv)
    change = None
    if prev is not None and prev.get("regime") not in (None, regime):
        change = f"Status changed from {REGIME_LABEL.get(prev.get('regime'), '—')} → {REGIME_LABEL.get(regime)}."

    d = {
        "date": _date(row.name) if hasattr(row, "name") and row.name is not None else "",
        "headline": REGIME_LABEL.get(regime, regime),
        "headline_tag": REGIME_TAG.get(regime, ""),
        "summary": f"Momentum {DIRECTION_LABEL.get(direction, direction)} · "
                   f"Sentiment: {SENTIMENT_LABEL.get(band, band)}",
        "phase": CYCLE_LABEL.get(cycle, cycle),
        "confidence": confidence_level(conv),
        "confidence_score": None if conv is None or pd.isna(conv) else int(conv),
        "action_title": action_title,
        "action_detail": action_detail,
        "reasons": reasons(row),
        "change": change,
        "watch": watch(row),
        "analysis": analysis_paragraphs(row),
        "marketing_note": marketing_note(row),
        "price": None if pd.isna(row.get("close")) else round(float(row["close"])),
    }
    d["text"] = render_text(d)
    return d


def render_text(d: dict) -> str:
    W = 54
    line = "━" * W
    L = [line, f"CRYPTO MARKET STATE — {d['date']}", line, ""]
    tag = f" ({d['headline_tag']})" if d["headline_tag"] else ""
    L.append(f"  ▍ {d['headline']}{tag}")
    L.append(f"    {d['summary']}")
    L.append(f"    Phase: {d['phase']}")
    L.append(f"    Signal confidence: {d['confidence']}")
    L.append("")
    L.append(f"  ➔ BUDGET ACTION: {d['action_title']}")
    for seg in _wrap(d["action_detail"], W - 6):
        L.append(f"    {seg}")
    if d["reasons"]:
        L.append("")
        L.append("  Why:")
        for a in d["reasons"]:
            segs = _wrap(a, W - 6)
            L.append(f"  • {segs[0]}")
            for s in segs[1:]:
                L.append(f"    {s}")
    L.append("")
    L.append(f"  Changed today: {d['change'] or '—'}")
    if d["watch"]:
        L.append("  Watch:")
        for s in _wrap(d["watch"], W - 6):
            L.append(f"    {s}")
    L.append(line)
    return "\n".join(L)


def _wrap(text: str, width: int) -> list[str]:
    words, cur, out = text.split(), "", []
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            out.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        out.append(cur)
    return out or [""]


if __name__ == "__main__":
    from fetch import build_frame
    from state import build_state

    st = build_state(build_frame()).dropna(subset=["trend_score"])
    print(friendly_row(st.iloc[-1], st.iloc[-2])["text"])
