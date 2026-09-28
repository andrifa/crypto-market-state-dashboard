# Crypto Market Regime Monitor

One daily read on the state of the crypto market (BULLISH / NEUTRAL / BEARISH) plus
an acquisition-budget posture recommendation. All data is **100% free, no API keys**.

## How it works

```
GitHub Actions (cron 01:30 UTC)
  └─ python backend/run_daily.py
        ├─ pull free data   (Yahoo Finance, Binance, alternative.me, DefiLlama)
        ├─ compute state     (trailing indicators, point-in-time)
        ├─ write data/latest.json      ← read by the frontend & Slack
        └─ append data/history.csv     ← backtest dataset + chart data
  └─ commit data/* to main
        └─ GitHub Pages rebuilds automatically  → index.html + app.js (static)
```

No server, no database, no cost.

## One-time setup

1. Push this repo to GitHub.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main` / folder `/ (root)`.
3. **Settings → Actions → General** → Workflow permissions: *Read and write*.
4. **Actions → daily-market-regime → Run workflow** for the first run (history backfill).
5. Dashboard is live at `https://<user>.github.io/<repo>/`.

## Run locally

```bash
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
.venv/bin/python backend/run_daily.py          # update data + print the reading
.venv/bin/python -m http.server 8000            # open http://localhost:8000
```

## Backtest / validation

```bash
.venv/bin/python backend/backtest.py           # writes data/backtest.json + a report
```

Tests: per-factor monotonicity vs forward returns, regime separation, conviction
calibration, whipsaw, and decision uplift (weighting acquisition by regime vs flat).

## Methodology (short)

Three orthogonal dimensions, combined transparently (not fitted weights):

| Dimension | Indicators | Answers |
|---|---|---|
| **A — Trend** | Mayer Multiple, MA200 slope, MA50/200 cross | where we are in the cycle |
| **B — Momentum** | weekly RSI, 90d ROC, % of days above MA200 | which way it is turning |
| **C — Sentiment** | Fear & Greed, funding z-score, Stablecoin Supply Ratio | how crowded the trade is |

`trend_score` → regime (Bull/Neutral/Bear, with a 5-day confirmation hysteresis).
Confidence = agreement across the three dimensions + distance from the band edges
+ how calm volatility is.

**Note:** every indicator is trailing (not a forecast). This is a decision aid for
budget posture, not a trading signal. Built on ~2.7 market cycles — treat it as
direction, not a precise number. Thresholds & weights live in `backend/state.py`
→ `CONFIG`.
