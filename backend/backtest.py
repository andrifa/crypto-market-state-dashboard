"""
Backtest / validation.  Answers the only question that lets us defend this to users:
does the reading actually separate what happens next?

Runs entirely on trailing data (state.build_state is point-in-time), then joins
FORWARD BTC returns and measures:

  1. per-indicator monotonicity   — does each factor's score rank forward returns?
  2. dimension-score monotonicity  — same, for trend / momentum / sentiment
  3. regime separation             — Bull vs Neutral vs Bear forward return & risk
  4. conviction calibration        — does higher conviction => cleaner move?
  5. whipsaw                       — transitions/yr, median regime duration
  6. decision uplift               — weight acquisition by regime vs weight-nothing

Forward-return windows overlap, so the effective sample is ~N/h. Every mean is
printed with a horizon-deflated standard error and that caveat stands.

Writes data/backtest.json for the frontend + prints a report.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from fetch import build_frame
from indicators import compute_all
from state import build_state, score_indicators, dimension_scores

HORIZONS = [30, 90, 180]
OUT = Path(__file__).resolve().parent.parent / "data" / "backtest.json"


# --------------------------------------------------------------------------- #
# stats helpers (no scipy dependency)
# --------------------------------------------------------------------------- #
def spearman(x: pd.Series, y: pd.Series):
    m = x.notna() & y.notna()
    x, y = x[m], y[m]
    if len(x) < 50:
        return np.nan, np.nan, len(x)
    rx, ry = x.rank().to_numpy(), y.rank().to_numpy()
    rho = np.corrcoef(rx, ry)[0, 1]
    n = len(x)
    t = rho * np.sqrt(max(n - 2, 1) / max(1 - rho**2, 1e-12))
    # two-sided p from a normal approx to the t (n is large here)
    p = 2 * (1 - _norm_cdf(abs(t)))
    return rho, p, n


def _norm_cdf(z):
    return 0.5 * (1 + np.math.erf(z / np.sqrt(2))) if hasattr(np, "math") else 0.5 * (1 + _erf(z / np.sqrt(2)))


def _erf(x):
    # Abramowitz-Stegun 7.1.26
    s = 1 if x >= 0 else -1
    x = abs(x)
    t = 1 / (1 + 0.3275911 * x)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-x * x)
    return s * y


def bucket_means(score: pd.Series, fwd: pd.Series, q: int = 5):
    m = score.notna() & fwd.notna()
    if m.sum() < q * 20:
        return None
    b = pd.qcut(score[m].rank(method="first"), q, labels=False)
    g = fwd[m].groupby(b)
    return g.mean(), g.std(), g.count()


def defl_se(std, count, horizon):
    eff = np.maximum(count / horizon, 2)
    return std / np.sqrt(eff)


# --------------------------------------------------------------------------- #
def run():
    df = build_frame()
    st = build_state(df)
    ind = compute_all(df)
    s = score_indicators(ind)
    d = dimension_scores(s)

    close = df["close"]
    fwd = {h: close.shift(-h) / close - 1.0 for h in HORIZONS}

    report = {"generated": pd.Timestamp.now(tz="UTC").isoformat(), "rows": int(len(st)),
              "span": [str(st.index.min().date()), str(st.index.max().date())], "horizons": HORIZONS}

    # ---- 1. per-indicator monotonicity ----------------------------------- #
    print("\n" + "=" * 78)
    print("1. PER-INDICATOR  —  Spearman(score, forward return)   [keep if monotone & same sign]")
    print("=" * 78)
    print(f"{'indicator':14s} " + "".join(f"{'rho@'+str(h):>12s}{'p':>7s}" for h in HORIZONS))
    per_ind = {}
    for col in ["mayer", "slope", "cross", "ma_200w",
                "rsi_w", "roc90", "breadth", "activity", "fng", "funding", "ssr"]:
        row, cells = {}, ""
        for h in HORIZONS:
            rho, p, n = spearman(s[col], fwd[h])
            row[h] = {"rho": None if np.isnan(rho) else round(rho, 3), "p": None if np.isnan(p) else round(p, 4), "n": n}
            cells += f"{rho:>12.3f}{p:>7.3f}" if not np.isnan(rho) else f"{'--':>12s}{'--':>7s}"
        per_ind[col] = row
        print(f"{col:14s} {cells}")
    report["per_indicator"] = per_ind

    # ---- 1b. context-only indicators  —  candidates for promotion to scored ---- #
    # These 5 are computed from data we already have full history for (price,
    # miner revenue), unlike the rest of the "context" catalog (dominance, OI,
    # DVOL, VIX, ETF flow, ...) which is fetched live-only -- no historical series
    # exists to backtest those against. Raw (unscored) values, tested the same way,
    # so a consistently monotone rho here is the actual evidence for promoting one
    # to the scored model instead of leaving it display-only.
    print("\n" + "=" * 78)
    print("1b. CONTEXT-ONLY INDICATORS  —  not in the score; same test, to flag promotion candidates")
    print("=" * 78)
    print(f"{'indicator':14s} " + "".join(f"{'rho@'+str(h):>12s}{'p':>7s}" for h in HORIZONS))
    ctx_ind = {}
    for col in ["drawdown", "pi_gap", "vol_pctl", "bb_width", "puell"]:
        row, cells = {}, ""
        for h in HORIZONS:
            rho, p, n = spearman(ind[col], fwd[h])
            row[h] = {"rho": None if np.isnan(rho) else round(rho, 3), "p": None if np.isnan(p) else round(p, 4), "n": n}
            cells += f"{rho:>12.3f}{p:>7.3f}" if not np.isnan(rho) else f"{'--':>12s}{'--':>7s}"
        ctx_ind[col] = row
        print(f"{col:14s} {cells}")
    report["context_indicators"] = ctx_ind

    # ---- 2. dimension scores ------------------------------------------- #
    print("\n" + "=" * 78)
    print("2. DIMENSION SCORES  —  quintile mean forward return (%)  [want monotone increasing]")
    print("=" * 78)
    dims = {}
    for name in ["trend", "momentum", "sentiment"]:
        line = f"{name:10s}"
        dims[name] = {}
        for h in HORIZONS:
            res = bucket_means(d[name], fwd[h], 5)
            if res is None:
                line += f"   h{h}: n/a"
                continue
            mean, std, cnt = res
            se = defl_se(std, cnt, h)
            q = "  ".join(f"{v*100:+5.0f}±{e*100:.0f}" for v, e in zip(mean, se))
            line += f"\n   h{h:<3d} Q1..Q5:  {q}"
            dims[name][h] = [round(v, 4) for v in mean.tolist()]
        rho, p, _ = spearman(d[name], fwd[90])
        line += f"\n            Spearman@90 = {rho:+.3f} (p={p:.4f})"
        print(line + "\n")
    report["dimension_quintiles"] = dims

    # ---- 3. regime separation ---------------------------------------- #
    print("=" * 78)
    print("3. REGIME SEPARATION  —  forward return by headline regime")
    print("=" * 78)
    reg = st["regime"]
    regrep = {}
    for h in HORIZONS:
        print(f"\n  horizon {h}d")
        print(f"    {'regime':9s} {'n':>6s} {'mean%':>8s} {'se%':>6s} {'median%':>8s} {'win%':>6s} {'worst%':>8s}")
        regrep[h] = {}
        for g in ["Bull", "Neutral", "Bear"]:
            v = fwd[h][reg == g].dropna()
            if len(v) < 30:
                continue
            se = v.std() / np.sqrt(max(len(v) / h, 2))
            row = dict(n=int(len(v)), mean=round(float(v.mean()), 4), se=round(float(se), 4),
                       median=round(float(v.median()), 4), win=round(float((v > 0).mean()), 3),
                       worst=round(float(v.min()), 4))
            regrep[h][g] = row
            print(f"    {g:9s} {row['n']:6d} {row['mean']*100:8.1f} {row['se']*100:6.1f} "
                  f"{row['median']*100:8.1f} {row['win']*100:6.0f} {row['worst']*100:8.1f}")
    report["regime"] = regrep

    # ---- 4. conviction calibration --------------------------------- #
    print("\n" + "=" * 78)
    print("4. CONVICTION  —  forward 90d return in the regime's direction, by conviction band")
    print("=" * 78)
    conv = st["conviction"].astype("float")
    signed = fwd[90] * reg.map({"Bull": 1, "Bear": -1, "Neutral": np.nan})
    cr = {}
    for lo, hi, lab in [(0, 40, "low <40"), (40, 60, "mid 40-60"), (60, 101, "high >=60")]:
        v = signed[(conv >= lo) & (conv < hi)].dropna()
        if len(v) < 30:
            continue
        se = v.std() / np.sqrt(max(len(v) / 90, 2))
        cr[lab] = dict(n=int(len(v)), mean=round(float(v.mean()), 4), se=round(float(se), 4), win=round(float((v > 0).mean()), 3))
        print(f"    {lab:10s} n={len(v):5d}  mean {v.mean()*100:+5.1f} ± {se*100:.1f}   win {100*(v>0).mean():.0f}%")
    report["conviction"] = cr

    # ---- 5. whipsaw ----------------------------------------------- #
    tr = reg[reg.ne(reg.shift(1)) & reg.notna() & (reg != "Unknown")]
    yrs = (st.index[-1] - st.index[0]).days / 365
    durs = np.diff([i for i in range(len(reg))][:1] + list(np.where(reg.ne(reg.shift(1)))[0]) + [len(reg)])
    report["whipsaw"] = {"transitions": int(len(tr)), "per_year": round(len(tr) / yrs, 2),
                         "median_run_days": int(np.median(durs[durs > 0]))}
    print("\n" + "=" * 78)
    print(f"5. WHIPSAW  —  {len(tr)} transitions over {yrs:.1f}y = {len(tr)/yrs:.1f}/yr, "
          f"median run {int(np.median(durs[durs>0]))}d")
    print("=" * 78)

    # ---- 5b. cycle-turn detection ------------------------------- #
    print("\n" + "=" * 78)
    print("5b. CYCLE-TURN DETECTION  —  did the label flip near each major top / bottom?")
    print("=" * 78)
    cl = close.to_numpy()
    idx = close.index
    warm = idx.searchsorted(pd.Timestamp("2015-09-01"))   # model has no output before this
    turns, i, ath_i = [], warm + 1, warm
    while i < len(cl):
        if cl[i] > cl[ath_i]:
            ath_i = i
        elif cl[i] <= cl[ath_i] * 0.45:            # 55%+ down from the running high = an unambiguous bear
            peak_i = ath_i
            j, min_i = peak_i, peak_i
            while j < len(cl):
                if cl[j] < cl[min_i]:
                    min_i = j
                if j > min_i + 30 and cl[j] >= cl[min_i] * 1.7:   # 70% recovery confirms the low
                    break
                j += 1
            if min_i - peak_i >= 90:               # ignore flash crashes / bear-market bounces
                turns.append(("top", peak_i))
                turns.append(("bottom", min_i))
            ath_i = min_i
            i = min_i + 1
            continue
        i += 1

    reg_np = reg.to_numpy()
    tr_pos = np.where((reg.ne(reg.shift(1))) & reg.notna() & (reg != "Unknown"))[0]
    detail, hit = [], 0
    for kind, pi in turns:
        want_out = "Bull" if kind == "top" else "Bear"
        lo, hi = -30, 160
        best = None
        for tp in tr_pos:
            lag = (idx[tp] - idx[pi]).days
            if lo <= lag <= hi and reg_np[tp - 1] == want_out and reg_np[tp] != want_out:
                if best is None or abs(lag) < abs(best):
                    best = lag
        detail.append({"kind": kind, "date": str(idx[pi].date()),
                       "price": int(cl[pi]), "detected": best is not None, "lag_days": best})
        hit += best is not None
        tag = f"flip {best:+d}d" if best is not None else "MISSED"
        print(f"  {kind:7s} {idx[pi].date()}  ${int(cl[pi]):>7,}   {tag}")
    n_turns = len(turns)
    rate = hit / n_turns if n_turns else 0.0
    lags = [d["lag_days"] for d in detail if d["detected"]]
    med_lag = int(np.median(lags)) if lags else None
    print(f"\n  detected {hit}/{n_turns} = {rate*100:.0f}%   median lag {med_lag}d "
          f"(negative = the label turned before the price extreme)")
    report["turns"] = {"n": n_turns, "detected": hit, "rate": round(rate, 3),
                       "median_lag_days": med_lag, "detail": detail}

    # ---- 5c. phase agreement  —  does the DAILY label match the cycle it was in? --
    pts = sorted(turns, key=lambda t: t[1])
    phase = np.array([None] * len(cl), dtype=object)
    for k in range(len(pts) - 1):
        (k0, i0), (_, i1) = pts[k], pts[k + 1]
        phase[i0:i1] = "up" if k0 == "bottom" else "down"
    phase[pts[-1][1]:] = "up" if pts[-1][0] == "bottom" else "down"
    phase[:pts[0][1]] = "down" if pts[0][0] == "bottom" else "up"
    mm = phase != None                                             # noqa: E711
    lab = reg_np[mm]
    ph = phase[mm]
    agree = ((lab == "Bull") & (ph == "up")) | ((lab == "Bear") & (ph == "down")) | (lab == "Neutral")
    wrong = ((lab == "Bull") & (ph == "down")) | ((lab == "Bear") & (ph == "up"))
    report["phase_agreement"] = {
        "days": int(mm.sum()),
        "agree_rate": round(float(agree.mean()), 3),
        "wrong_way_rate": round(float(wrong.mean()), 3),
    }
    print(f"\n5c. PHASE AGREEMENT  —  the daily label matched the actual bull/bear phase on "
          f"{agree.mean()*100:.0f}% of days; pointed the wrong way on {wrong.mean()*100:.0f}% "
          f"(those days cluster in the ~3 months after each turn while the label catches up)")

    # ---- 6. decision uplift ------------------------------------- #
    print("\n" + "=" * 78)
    print("6. DECISION UPLIFT  —  proxy: acquisition value realised = forward 180d BTC return")
    print("   weight days by regime, compare mean realised outcome vs flat weighting")
    print("=" * 78)
    w = reg.map({"Bull": 1.5, "Neutral": 1.0, "Bear": 0.5})
    r180 = fwd[180]
    m = w.notna() & r180.notna()
    flat = r180[m].mean()
    weighted = np.average(r180[m], weights=w[m])
    # equity curve: hold `position` = regime weight / 1.5, realised daily fwd(1)
    pos = (reg.map({"Bull": 1.0, "Neutral": 0.4, "Bear": 0.0})).reindex(st.index).fillna(0.0)
    dret = close.pct_change().shift(-1)
    strat = (1 + pos * dret).cumprod()
    bh = (1 + dret).cumprod()
    report["decision"] = {
        "flat_mean_fwd180": round(float(flat), 4),
        "regime_weighted_mean_fwd180": round(float(weighted), 4),
        "uplift_pct_points": round(float((weighted - flat) * 100), 2),
        "equity_strategy_x": round(float(strat.dropna().iloc[-1]), 2),
        "equity_buyhold_x": round(float(bh.dropna().iloc[-1]), 2),
        "strategy_maxdd": round(float((strat / strat.cummax() - 1).min()), 3),
        "buyhold_maxdd": round(float((bh / bh.cummax() - 1).min()), 3),
    }
    for k, v in report["decision"].items():
        print(f"    {k:32s} {v}")

    # ---- 7. scorecard  (plain-language accuracy summary) --------- #
    print("\n" + "=" * 78)
    print("7. SCORECARD")
    print("=" * 78)
    sc = {"span": report["span"], "days": int(len(st)),
          "cycles": round(yrs / 4.2, 1), "transitions": int(len(tr)),
          "per_year": round(len(tr) / yrs, 2)}

    # directional accuracy across horizons from 1 month to 3 years.
    # NOTE: at long horizons BTC is almost always up, so raw accuracy converges to the
    # base rate — the model's real contribution is EDGE = accuracy - base_up_rate, and the
    # effective (non-overlapping) sample shrinks fast, so read the long rows with caution.
    dacc = {}
    horizons = [30, 90, 180, 365, 730, 1095]
    for h in horizons:
        f = (close.shift(-h) / close - 1.0) if h not in fwd else fwd[h]
        bull = f[(reg == "Bull")].dropna()
        bear = f[(reg == "Bear")].dropna()
        hits = (bull > 0).sum() + (bear <= 0).sum()
        tot = len(bull) + len(bear)
        base = float((f.dropna() > 0).mean())
        acc = hits / tot if tot else float("nan")
        n_eff = round(tot / h, 1)                    # ~ non-overlapping windows
        dacc[h] = {
            "directional_accuracy": round(acc, 3),
            "bull_up_rate": round(float((bull > 0).mean()), 3) if len(bull) else None,
            "bear_down_rate": round(float((bear <= 0).mean()), 3) if len(bear) else None,
            "base_up_rate": round(base, 3),
            "edge": round(acc - base, 3),
            "n": int(tot), "n_effective": n_eff,
        }
        lbl = f"{h}d" if h < 365 else f"{h // 365}y"
        print(f"  {lbl:>4s}  accuracy {acc*100:4.1f}%   edge {acc*100 - base*100:+4.1f}pt   "
              f"(base {base*100:.0f}% · BULLISH→up {(bull>0).mean()*100:.0f}% · "
              f"BEARISH→down {(bear<=0).mean()*100 if len(bear) else float('nan'):.0f}% · "
              f"~{n_eff} independent windows)")
    sc["directional"] = dacc

    # per-run accuracy: for each contiguous regime run, did price move the expected way
    # from the day the label appeared to the day it changed?
    runid = (reg != reg.shift()).cumsum()
    run_rows = []
    for _, g in st.groupby(runid):
        r = g["regime"].iloc[0]
        if r not in ("Bull", "Bear"):
            continue
        chg = g["close"].iloc[-1] / g["close"].iloc[0] - 1.0
        run_rows.append((r, len(g), chg, (chg > 0) if r == "Bull" else (chg < 0)))
    rr = pd.DataFrame(run_rows, columns=["regime", "days", "chg", "correct"])
    sc["per_run"] = {
        "n_runs": int(len(rr)),
        "correct": int(rr["correct"].sum()),
        "accuracy": round(float(rr["correct"].mean()), 3),
        "bull": {"n": int((rr.regime == "Bull").sum()),
                 "accuracy": round(float(rr.loc[rr.regime == "Bull", "correct"].mean()), 3),
                 "avg_move": round(float(rr.loc[rr.regime == "Bull", "chg"].mean()), 3)},
        "bear": {"n": int((rr.regime == "Bear").sum()),
                 "accuracy": round(float(rr.loc[rr.regime == "Bear", "correct"].mean()), 3),
                 "avg_move": round(float(rr.loc[rr.regime == "Bear", "chg"].mean()), 3)},
    }
    print(f"\n  per-run: {sc['per_run']['correct']}/{sc['per_run']['n_runs']} directional runs "
          f"moved the expected way = {sc['per_run']['accuracy']*100:.0f}%  "
          f"(Bull runs {sc['per_run']['bull']['accuracy']*100:.0f}%, "
          f"Bear runs {sc['per_run']['bear']['accuracy']*100:.0f}% — "
          f"bear calls arrive after most of the drop, so price often rises during the label)")

    ok = sum(1 for h in HORIZONS
             if regrep.get(h, {}).get("Bull", {}).get("mean", -9)
             > regrep[h].get("Neutral", {}).get("mean", -9)
             > regrep[h].get("Bear", {}).get("mean", -9))
    sc["ordering_horizons_ok"] = f"{ok}/{len(HORIZONS)}"
    sc["phase_agree_rate"] = report["phase_agreement"]["agree_rate"]
    sc["phase_wrong_rate"] = report["phase_agreement"]["wrong_way_rate"]
    sc["turn_detection_rate"] = report["turns"]["rate"]
    sc["turns_detected"] = f'{report["turns"]["detected"]}/{report["turns"]["n"]}'
    sc["turn_median_lag_days"] = report["turns"]["median_lag_days"]
    sc["decision_uplift_pp"] = report["decision"]["uplift_pct_points"]
    sc["strategy_x"] = report["decision"]["equity_strategy_x"]
    sc["buyhold_x"] = report["decision"]["equity_buyhold_x"]
    sc["strategy_maxdd"] = report["decision"]["strategy_maxdd"]
    sc["buyhold_maxdd"] = report["decision"]["buyhold_maxdd"]
    sc["headline"] = (
        f"Over {sc['days']} days ({report['span'][0]}–{report['span'][1]}, ~{sc['cycles']} cycles): "
        f"the label flagged {sc['turns_detected']} major cycle tops and bottoms, a median "
        f"{sc['turn_median_lag_days']} days after the price extreme. "
        f"For shorter calls, 90-day directional accuracy is {dacc[90]['directional_accuracy']*100:.0f}% "
        f"(BULLISH→up {dacc[90]['bull_up_rate']*100:.0f}%, BEARISH→down/flat "
        f"{dacc[90]['bear_down_rate']*100:.0f}%) vs a {dacc[90]['base_up_rate']*100:.0f}% base rate — "
        f"crypto is noisy at that range, so most of the value is in the turn calls and in risk: "
        f"following the posture lifted the acquisition-value proxy {sc['decision_uplift_pp']:+.1f} points "
        f"and cut the worst drawdown from {abs(sc['buyhold_maxdd'])*100:.0f}% to "
        f"{abs(sc['strategy_maxdd'])*100:.0f}%. Small sample (~{sc['cycles']} cycles) — direction, not precision."
    )
    report["scorecard"] = sc
    print("\n  " + sc["headline"])

    OUT.write_text(json.dumps(report, indent=2, default=str))
    print(f"\nwrote {OUT}")
    return report


if __name__ == "__main__":
    run()
