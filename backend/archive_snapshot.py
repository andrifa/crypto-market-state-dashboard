"""
Save today's final reading as a dated snapshot so any past day can be reopened.

    python3 backend/archive_snapshot.py

Copies data/latest.json to data/archive/<date>.json (the date inside the file,
not the clock) and rebuilds data/archive/index.json, which the dashboard's date
picker reads. Run it as the LAST step of the daily task, after the written
analysis is final, so the archive holds the finished page and not the template
fallback. Running it again the same day just overwrites that day's file.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
LATEST = DATA / "latest.json"
ARCHIVE = DATA / "archive"


def write_snapshot(d: dict) -> Path:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    path = ARCHIVE / f"{d['date']}.json"
    path.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    return path


def rebuild_index() -> dict:
    items = {}
    for f in sorted(ARCHIVE.glob("????-??-??.json")):
        d = json.loads(f.read_text())
        items[f.stem] = {"regime": d.get("regime"), "headline": d.get("headline"), "price": d.get("price_btc")}
    index = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "dates": list(items), "items": items}
    (ARCHIVE / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    return index


if __name__ == "__main__":
    snap = json.loads(LATEST.read_text())
    p = write_snapshot(snap)
    idx = rebuild_index()
    print(f"archived {p.name} | {len(idx['dates'])} snapshots ({idx['dates'][0]} .. {idx['dates'][-1]})")
