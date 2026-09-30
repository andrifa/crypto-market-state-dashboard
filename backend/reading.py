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


def _lean(score) -> str:
    """Plain-English direction for a -1..1 dimension score, so a reader gets the
    verdict up front instead of having to infer it from a list of numbers."""
    if score is None or pd.isna(score):
        return "unclear (inputs missing)"
    if score >= 0.45:
        label = "strongly bullish"
    elif score >= 0.15:
        label = "bullish-leaning"
    elif score <= -0.45:
        label = "strongly bearish"
    elif score <= -0.15:
        label = "bearish-leaning"
    else:
        label = "neutral"
    return f"{label} ({score:+.2f} of a possible ±1)"


def analysis_paragraphs(row: pd.Series) -> list[str]:
    """
    Fallback for the richer multi-paragraph narrative panel: rule-based, real
    numbers only, no invented specifics. This is what shows before the daily
    reasoning routine's first pass of the day, and whenever it's unavailable --
    the routine's LLM-written version (grounded in the same context numbers)
    normally overwrites this with a more natural read. Each paragraph opens
    with an explicit lean verdict (bullish/neutral/bearish + score) before the
    supporting detail, so the direction isn't left for the reader to infer.
    """
    out = []

    fng, fz, ssr, vol, bb = (row.get(k) for k in ("fng", "funding_z", "ssr", "vol_pctl", "bb_width"))
    parts = []
    if pd.notna(fng):
        band = row.get("sentiment_band", "")
        parts.append(f"Fear & Greed sits at {fng:.0f} ({band})")
    if pd.notna(fz):
        stretch = "stretched" if abs(fz) >= 1.5 else "not stretched"
        parts.append(f"funding is at a {fz:+.2f} z-score ({stretch} leverage positioning)")
    if pd.notna(ssr):
        parts.append(f"the stablecoin supply ratio is {ssr:.2f}")
    if parts:
        s = f"Short-term sentiment is {_lean(row.get('sentiment_score'))}: " + ", ".join(parts) + "."
        if pd.notna(vol):
            calm = "calm" if vol < 0.5 else "elevated" if vol < 0.7 else "turbulent"
            s += f" Realised volatility sits at the {vol*100:.0f}th percentile of its two-year range ({calm})"
            if pd.notna(bb):
                squeeze = " — a narrow reading that has often preceded a sharper move either way" if bb < 0.12 else ""
                s += f", with Bollinger band width at {bb*100:.0f}%{squeeze}."
            else:
                s += "."
        if pd.notna(fng) and pd.notna(fz):
            if fng >= 70 and fz < 0.5:
                s += " Sentiment is running warmer than actual leverage, a milder setup than a fully leveraged rally."
            elif fng <= 30 and fz > -0.5:
                s += " Sentiment is more fearful than positioning suggests, which historically has left less room for a leverage-driven flush."
        out.append(s)

    rsi_w, roc90, breadth, cross, act = (row.get(k) for k in ("rsi_w", "roc90", "breadth", "ma_cross", "activity"))
    parts = []
    if pd.notna(rsi_w):
        state = "overbought" if rsi_w >= 70 else "oversold" if rsi_w <= 35 else "neutral-to-firm"
        parts.append(f"weekly RSI is {rsi_w:.0f} ({state})")
    if pd.notna(roc90):
        parts.append(f"the 90-day rate of change is {roc90*100:+.0f}%")
    if pd.notna(breadth):
        parts.append(f"breadth is {breadth*100:.0f}% of the last 90 days above the 200-day average")
    if parts:
        s = f"Medium-term momentum is {_lean(row.get('momentum_score'))}: " + ", ".join(parts) + "."
        if pd.notna(cross):
            side = "the golden-cross side" if cross > 0 else "the death-cross side"
            s += f" The 50/200-day average gap is {cross*100:+.1f}%, on {side}."
        if pd.notna(act):
            trend_word = "expanding" if act >= 1 else "contracting"
            s += f" On-chain activity is {trend_word} versus its own year-average (ratio {act:.2f})."
        if pd.notna(breadth) and pd.notna(roc90) and roc90 > 0 and breadth < 0.5:
            s += " The gap between the headline price gain and this thinner participation is the main tension in this window."
        out.append(s)

    mayer, slope, ma200w, dd, puell, pi_gap = (
        row.get(k) for k in ("mayer", "ma_slope", "ma_200w", "drawdown", "puell", "pi_gap")
    )
    parts = []
    if pd.notna(mayer):
        parts.append(f"price is {'above' if mayer >= 1 else 'below'} its 200-day average (Mayer Multiple {mayer:.2f})")
    if pd.notna(slope):
        parts.append(f"that average is {'rising' if slope >= 0 else 'falling'} ({slope*100:+.1f}% over 90 days)")
    if pd.notna(ma200w):
        val_word = "stretched" if ma200w >= 3 else "near the floor" if ma200w <= 1.1 else "mid-cycle"
        parts.append(f"the 200-week multiple is {ma200w:.2f} ({val_word})")
    if pd.notna(dd) and dd < -0.05:
        parts.append(f"price is {abs(dd)*100:.0f}% below its all-time high")
    if parts:
        s = f"Long-term trend is {_lean(row.get('trend_score'))}: " + ", ".join(parts) + "."
        if pd.notna(puell):
            miner_word = "capitulation" if puell <= 0.6 else "euphoria" if puell >= 3 else "a normal range"
            s += f" The Puell Multiple is {puell:.2f}, in {miner_word} for miner economics (context only — not scored)."
        if pd.notna(pi_gap):
            s += (f" The Pi-Cycle gap is {pi_gap*100:+.1f}% (context only — not scored; "
                  "this measure has historically moved above zero near past cycle tops).")
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
