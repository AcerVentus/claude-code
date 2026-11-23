"""Command line: python3 -m rfp_tracker <run|rebuild|add|show>   (run from the rfp-tracker folder)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import approach, config, digest, extract, register, sources
from .textutil import days_between, norm_title, short_hash, today

SEEN_KEEP_DAYS = 120
RAW_FIELDS = ("id", "kind", "source", "publisher", "title", "url", "published", "location", "text", "stated", "found")


def _paths(root: Path) -> dict[str, Path]:
    data = root / "data"
    return {
        "data": data,
        "signals": data / "signals.jsonl",
        "register": data / "opportunities.json",
        "previous": data / "previous.json",
        "state": data / "state.json",
        "csv": data / "pipeline.csv",
        "last_run": data / "last_run.json",
        "digests": root / "digests",
        "inbox": root / "inbox",
    }


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


def load_signals(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def save_signals(path: Path, signals: list[dict]) -> None:
    lines = [json.dumps(s, ensure_ascii=False, sort_keys=True) for s in sorted(signals, key=lambda s: (s["found"], s["id"]))]
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def publish(root: Path, cfg, signals: list[dict], day: str, health: dict) -> dict:
    """Rebuild the register from the signal log, then write the register, sheet and digest."""
    paths = _paths(root)
    opportunities, loose_jobs = register.build(signals, cfg, day)
    previous = _load_json(paths["previous"], [])
    delta = register.changes(previous, opportunities)
    usual = approach.usual_bidders(signals, cfg)
    advice = {opp["id"]: approach.advise(opp, cfg, usual) for opp in opportunities}
    for opp in opportunities:
        opp["approach"] = advice[opp["id"]]

    _write_json(paths["register"], opportunities)
    paths["csv"].write_text(digest.pipeline_csv(opportunities, advice), encoding="utf-8")
    hiring_rows = approach.hiring_targets(loose_jobs, cfg, day)
    text = digest.render(day, opportunities, signals, delta, advice, hiring_rows, health, cfg.profile)
    paths["digests"].mkdir(exist_ok=True)
    (paths["digests"] / f"{day}.md").write_text(text, encoding="utf-8")
    (paths["digests"] / "latest.md").write_text(text, encoding="utf-8")

    by_id = {o["id"]: o for o in opportunities}
    summary = {
        "date": day,
        "signals_total": len(signals),
        "signals_new": sum(1 for s in signals if s["found"] == day),
        "opportunities_active": sum(1 for o in opportunities if o["status"] == "active"),
        "new_opportunities": [{"id": i, "name": by_id[i]["name"], "stage": by_id[i]["stage"], "filed": by_id[i]["filed"]} for i in delta["new"]],
        "stage_changes": delta["stage"],
        "newly_named_firms": delta["parties"],
        "source_health": health,
        "digest": f"digests/{day}.md",
    }
    _write_json(paths["last_run"], summary)
    return summary


def cmd_run(args, root: Path) -> int:
    cfg = config.load(root / "config")
    paths = _paths(root)
    paths["data"].mkdir(exist_ok=True)
    day = args.date or today()
    state = _load_json(paths["state"], {"seen": {}, "last_run": ""})
    signals = load_signals(paths["signals"])
    known = {s["id"] for s in signals}
    known_titles = {norm_title(s["title"]) for s in signals if s["kind"] != "job"}

    # The first run of a day freezes yesterday's register, so "new today" survives reruns.
    if state.get("last_run") != day and paths["register"].exists():
        paths["previous"].write_text(paths["register"].read_text(encoding="utf-8"), encoding="utf-8")

    skip = set(filter(None, (args.skip or "").split(",")))
    health: dict = {}
    raw: list[dict] = []
    inbox_files: list[Path] = []
    if "inbox" not in skip and cfg.sources.get("inbox", {}).get("enabled", True):
        leads, inbox_files = sources.read_inbox(paths["inbox"], health)
        raw += leads
    if "news" not in skip:
        days = args.backfill or cfg.sources.get("news", {}).get("lookback_days", 3)
        raw += sources.collect_news(cfg, days, health)
    if "linkedin" not in skip:
        raw += sources.collect_linkedin(cfg, state["seen"], health)

    minimum = cfg.profile.get("min_score", 45)
    for item in raw:
        if item["id"] in known or (item["kind"] == "news" and norm_title(item["title"]) in known_titles):
            continue
        signal = extract.analyse(item, cfg)
        if not signal["published"]:
            signal["published"] = day
        if signal["score"] < minimum or days_between(signal["published"], day) > max(args.backfill or 0, 45):
            continue
        signal["found"] = day
        signals.append(signal)
        known.add(signal["id"])
        known_titles.add(norm_title(signal["title"]))
        health.setdefault(signal["source"], {"requests": 0, "ok": 0, "items": 0, "errors": []})
        health[signal["source"]]["kept"] = health[signal["source"]].get("kept", 0) + 1

    # A later run on the same day (say, inbox only) keeps the earlier run's figures for sources it skipped.
    earlier = _load_json(paths["last_run"], {})
    if earlier.get("date") == day:
        for source, stats in earlier.get("source_health", {}).items():
            if source not in health or not health[source]["requests"]:
                kept = health.get(source, {}).get("kept", 0)
                health[source] = dict(stats, kept=stats.get("kept", 0) + kept)

    save_signals(paths["signals"], signals)
    sources.archive_inbox(inbox_files, paths["inbox"])
    state["seen"] = {k: v for k, v in state["seen"].items() if days_between(v, day) <= SEEN_KEEP_DAYS}
    state["last_run"] = day
    _write_json(paths["state"], state)

    summary = publish(root, cfg, signals, day, health)
    _report(summary)
    return 0


def cmd_rebuild(args, root: Path) -> int:
    """Re-classify every stored signal with the current rules and watchlist, then republish."""
    cfg = config.load(root / "config")
    paths = _paths(root)
    day = args.date or today()
    minimum = cfg.profile.get("min_score", 45)
    signals = []
    for stored in load_signals(paths["signals"]):
        signal = extract.analyse({k: stored[k] for k in RAW_FIELDS if k in stored}, cfg)
        if signal["score"] >= minimum:
            signals.append(signal)
    save_signals(paths["signals"], signals)
    health = _load_json(paths["last_run"], {}).get("source_health", {}) if _load_json(paths["last_run"], {}).get("date") == day else {}
    _report(publish(root, cfg, signals, day, health))
    return 0


def cmd_add(args, root: Path) -> int:
    """File a lead of your own. It is written to the inbox and picked up at once."""
    lead = {"title": args.title, "kind": args.kind}
    for key in ("url", "text", "project", "client", "stage", "winner", "deadline", "note", "publisher", "published"):
        if getattr(args, key):
            lead[key] = getattr(args, key)
    if args.type:
        lead["contract_type"] = args.type
    if args.bidders:
        lead["bidders"] = [b.strip() for b in args.bidders.split(",") if b.strip()]
    if args.value:
        lead["value_usd"] = args.value
    inbox = _paths(root)["inbox"]
    inbox.mkdir(exist_ok=True)
    _write_json(inbox / f"lead-{short_hash(args.title, args.url or '')}.json", lead)
    args.skip, args.backfill = "news,linkedin", 0
    return cmd_run(args, root)


def cmd_show(args, root: Path) -> int:
    paths = _paths(root)
    by_id = {s["id"]: s for s in load_signals(paths["signals"])}
    needle = args.query.lower()
    hits = [o for o in _load_json(paths["register"], []) if needle in o["id"].lower() or needle in o["name"].lower()]
    if not hits:
        print(f"No opportunity matches '{args.query}'.")
        return 1
    for opp in hits:
        print(f"\n{opp['name']}  [{opp['id']}]")
        print(f"  {opp['client']} | {extract.STAGE_LABEL[opp['stage']]} | {opp['contract_type']} | {digest.money(opp['value_usd'])} | {opp['priority']} ({opp['score']})")
        for firm, info in opp["parties"].items():
            print(f"  firm: {firm} — {info['role']} ({info['type']})")
        for target in opp["approach"]["targets"]:
            print(f"  approach: {target['org']} — {target['why']} {target['offer']}")
        for sid in opp["signal_ids"]:
            s = by_id.get(sid)
            if s:
                print(f"  {s['published']} [{s['kind']}] {s['title']} — {s['publisher']} (score {s['score']} {s['score_parts']})\n      {s['url']}")
    return 0


def _report(summary: dict) -> None:
    print(f"Digest for {summary['date']}: {summary['digest']}")
    print(f"  signals: {summary['signals_new']} new, {summary['signals_total']} in the log")
    print(f"  opportunities: {len(summary['new_opportunities'])} new, {summary['opportunities_active']} active")
    for change in summary["stage_changes"]:
        print(f"  stage change: {change['id']} {change['from']} -> {change['to']}")
    for source, stats in summary["source_health"].items():
        flag = f"  PROBLEMS: {stats['errors'][:2]}" if stats.get("errors") else ""
        print(f"  {source}: {stats['ok']}/{stats['requests']} requests ok, {stats.get('kept', 0)} signals kept{flag}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="rfp_tracker", description=__doc__)
    parser.add_argument("--root", type=Path, default=config.ROOT, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="collect from every source, update the register, write today's digest")
    run.add_argument("--backfill", type=int, default=0, metavar="DAYS", help="ask the news sources for this many days (first run: 30)")
    run.add_argument("--skip", default="", metavar="SOURCES", help="comma-separated: news, linkedin, inbox")
    run.add_argument("--date", default="", help="run as if today were YYYY-MM-DD")
    run.set_defaults(func=cmd_run)

    rebuild = sub.add_parser("rebuild", help="re-classify stored signals after editing the config, then republish")
    rebuild.add_argument("--date", default="")
    rebuild.set_defaults(func=cmd_rebuild)

    add = sub.add_parser("add", help="file a lead of your own")
    add.add_argument("--title", required=True)
    for name in ("url", "text", "project", "client", "stage", "type", "bidders", "winner", "deadline", "note", "publisher", "published"):
        add.add_argument(f"--{name}", default="")
    add.add_argument("--value", type=float, default=0, help="contract value in US dollars")
    add.add_argument("--kind", default="manual", choices=["manual", "research"])
    add.add_argument("--date", default="")
    add.set_defaults(func=cmd_add)

    show = sub.add_parser("show", help="print an opportunity with its evidence")
    show.add_argument("query", help="part of an opportunity's name or id")
    show.set_defaults(func=cmd_show)

    args = parser.parse_args(argv)
    return args.func(args, args.root)


if __name__ == "__main__":
    sys.exit(main())
