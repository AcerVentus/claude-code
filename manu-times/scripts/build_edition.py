#!/usr/bin/env python3
"""Merge desk files into the live edition of The Manu Times.

Usage: build_edition.py RAW_DIR [--note "what changed"] [--new-day]

Every *.json file in RAW_DIR is an object keyed by section id (front, world, us,
politics, europe, gulf, asia, africa, americas, business, markets, stocks, tech,
energy, healthcare, research, opinion). Sections in the desk files replace the
same sections in data/edition.json; sections not supplied keep their last
version, so an hourly update can refresh only what changed.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EDITION = ROOT / "data" / "edition.json"
LAUNCH = dt.date(2026, 11, 27)
SECTIONS = {"front", "world", "us", "politics", "europe", "gulf", "asia", "africa", "americas",
            "business", "markets", "stocks", "tech", "energy", "healthcare", "research", "opinion",
            "cartoon", "explainers"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("raw_dir")
    ap.add_argument("--note", default="")
    ap.add_argument("--new-day", action="store_true", help="start a fresh daily edition (clears the update log)")
    args = ap.parse_args()

    edition = json.loads(EDITION.read_text()) if EDITION.exists() else {}
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.date()
    meta = edition.get("meta", {})
    if args.new_day or meta.get("date") != today.isoformat():
        meta["update_log"] = []

    merged = []
    for f in sorted(pathlib.Path(args.raw_dir).glob("*.json")):
        try:
            data = json.loads(f.read_text())
        except json.JSONDecodeError as e:
            print(f"skip {f.name}: invalid JSON ({e})", file=sys.stderr)
            continue
        for key, val in data.items():
            if key in SECTIONS and isinstance(val, dict):
                edition[key] = val
                merged.append(key)
            else:
                print(f"skip {f.name}:{key}: unknown section", file=sys.stderr)

    meta.update({
        "name": "The Manu Times",
        "date": today.isoformat(),
        "edition_no": (today - LAUNCH).days + 1,
        "updated_at": now.isoformat().replace("+00:00", "Z"),
    })
    note = args.note or (f"Updated: {', '.join(sorted(set(merged)))}" if merged else "Edition checked; no changes")
    meta.setdefault("update_log", []).append({"time": meta["updated_at"], "note": note})
    meta["update_log"] = meta["update_log"][-24:]
    edition["meta"] = meta

    EDITION.parent.mkdir(parents=True, exist_ok=True)
    EDITION.write_text(json.dumps(edition, ensure_ascii=False, indent=1) + "\n")
    print(f"edition No. {meta['edition_no']} written; sections merged: {sorted(set(merged))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
