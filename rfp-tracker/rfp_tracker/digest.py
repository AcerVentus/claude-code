"""Render the daily digest (Markdown) and the pipeline sheet (CSV)."""

from __future__ import annotations

import csv
import io
from datetime import date

from .approach import URGENCY_LABEL
from .extract import STAGE_LABEL

MAX_TARGETS = 15
MAX_HIRING = 20
PIPELINE_STAGES = ["tender", "bid_evaluation", "planned", "awarded", "execution", ""]


def money(value) -> str:
    if not value:
        return ""
    return f"${value / 1e9:.1f}bn".replace(".0bn", "bn") if value >= 1e9 else f"${value / 1e6:.0f}m"


def _cell(text) -> str:
    return str(text or "").replace("|", "/").replace("\n", " ").strip()


def _link(text: str, url: str) -> str:
    text = _cell(text).replace("[", "(").replace("]", ")")
    return f"[{text}]({url})" if url.startswith("http") else text


def _nice_date(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%a %d %b %Y")
    except ValueError:
        return iso


def _facts(opp: dict) -> str:
    facts = [
        opp["client"] or "Client unclear",
        STAGE_LABEL[opp["stage"]],
        opp["contract_type"],
        money(opp["value_usd"]),
        f"deadline {opp['deadline']}" if opp["deadline"] else "",
        f"{opp['priority']} priority (score {opp['score']})",
    ]
    return " · ".join(f for f in facts if f)


def _firms(opp: dict) -> str:
    order = {"winner": 0, "bidder": 1, "contractor": 2, "hiring": 3, "named": 4}
    firms = sorted(opp["parties"].items(), key=lambda kv: (order[kv[1]["role"]], kv[0]))
    return ", ".join(f"{name} ({info['role']})" for name, info in firms)


def _evidence(opp: dict, by_id: dict, limit: int = 4) -> list[str]:
    signals = sorted((by_id[s] for s in opp["signal_ids"] if s in by_id), key=lambda s: s["published"], reverse=True)
    lines = []
    for signal in signals[:limit]:
        what = f"{signal['publisher']} is hiring: {signal['title']}" if signal["kind"] == "job" else signal["title"]
        source = "" if signal["kind"] == "job" else f" — {signal['publisher'] or signal['source']}"
        lines.append(f"  - {_link(what, signal['url'])}{source}, {signal['published']}")
    if len(signals) > limit:
        lines.append(f"  - …and {len(signals) - limit} more in the register")
    return lines


def _opportunity_block(opp: dict, advice: dict, by_id: dict) -> list[str]:
    lines = [f"### {opp['name']}", "", _facts(opp), ""]
    if opp["parties"]:
        lines.append(f"- **Firms named:** {_firms(opp)}")
    for target in advice["targets"][:5]:
        lines.append(f"- **Approach {target['org']}** ({URGENCY_LABEL[target['urgency']].lower()}): {target['why']} {target['offer']}")
    for note in advice["notes"] + opp["notes"]:
        lines.append(f"- {note}")
    lines.append("- **Evidence:**")
    lines += _evidence(opp, by_id)
    lines.append("")
    return lines


def render(day: str, opportunities, signals, delta, advice, hiring_rows, health, profile) -> str:
    by_id = {s["id"]: s for s in signals}
    by_opp = {o["id"]: o for o in opportunities}
    today_signals = [s for s in signals if s["found"] == day]
    today_jobs = [s for s in today_signals if s["kind"] == "job"]
    new = [by_opp[i] for i in delta["new"]]
    touched = set(delta["new"]) | set(delta["updated"]) | {c["id"] for c in delta["stage"]}
    active = [o for o in opportunities if o["status"] == "active"]

    out = [f"# ADNOC enquiry watch — {_nice_date(day)}", ""]
    out.append(
        f"**Today:** {len(new)} new opportunit{'y' if len(new) == 1 else 'ies'} · {len(delta['stage'])} stage change"
        f"{'' if len(delta['stage']) == 1 else 's'} · {len(today_signals) - len(today_jobs)} new news/lead signals · "
        f"{len(today_jobs)} new hiring signals. **Register:** {len(active)} active opportunities."
    )
    out.append("")

    # 1. Who to approach
    rows = []
    for opp in active:
        for target in advice[opp["id"]]["targets"]:
            fresh = opp["id"] in touched
            rows.append((target["urgency"], not fresh, -opp["score"], opp["id"], opp["name"], target, fresh))
    for target in hiring_rows:
        rows.append((target["urgency"], not target["fresh"], -target["score"], "hiring", target["label"], target, target["fresh"]))
    rows.sort(key=lambda r: r[:3])
    out += ["## 1. Who to approach", ""]
    if rows:
        out += ["| When | Who | Opportunity | Why | What to offer | Find the people |", "|---|---|---|---|---|---|"]
        seen = set()
        for urgency, _, _, opp_id, name, target, fresh in rows:
            if (target["org"], opp_id) in seen or len(seen) >= MAX_TARGETS:
                continue
            seen.add((target["org"], opp_id))
            people = " · ".join(_link(link["role"], link["url"]) for link in target["links"][:3])
            out.append(
                f"| {URGENCY_LABEL[urgency]} | **{_cell(target['org'])}** | {'🆕 ' if fresh else ''}{_cell(name)[:70]} | "
                f"{_cell(target['why'])[:260]} | {_cell(target['offer'])} | {people} |"
            )
        out += ["", "🆕 = new or changed today. The people links open a LinkedIn search in your own browser; the tracker never reads profiles.", ""]
    else:
        out += ["Nothing to act on yet.", ""]

    # 2. New today
    out += ["## 2. New today", ""]
    if new:
        for opp in sorted(new, key=lambda o: -o["score"]):
            out += _opportunity_block(opp, advice[opp["id"]], by_id)
    else:
        out += ["No new opportunities today.", ""]

    # 3. Movement
    out += ["## 3. Movement on tracked opportunities", ""]
    moved = False
    for change in delta["stage"]:
        opp = by_opp[change["id"]]
        out.append(f"- **{opp['name']}** moved from *{STAGE_LABEL[change['from']]}* to *{STAGE_LABEL[change['to']]}*.")
        moved = True
    for change in delta["parties"]:
        opp = by_opp[change["id"]]
        named = ", ".join(f"{firm} ({opp['parties'][firm]['role']})" for firm in change["added"])
        out.append(f"- **{opp['name']}**: newly named — {named}.")
        moved = True
    for opp_id in delta["updated"]:
        opp = by_opp[opp_id]
        fresh = [by_id[s] for s in opp["signal_ids"] if s in by_id and by_id[s]["found"] == day]
        for signal in fresh[:3]:
            what = f"{signal['publisher']} is hiring: {signal['title']}" if signal["kind"] == "job" else signal["title"]
            out.append(f"- **{opp['name']}**: {_link(what, signal['url'])} ({signal['published']})")
            moved = True
    if not moved:
        out.append("No movement today.")
    out.append("")

    # 4. Hiring signals
    out += ["## 4. Hiring signals", ""]
    if today_jobs:
        out += [
            "Firms advertising roles that name ADNOC work. *Bidding* roles point to a live tender; *engineering* roles to a won or expected award.",
            "",
            "| Employer | Role | Signal | ADNOC company / project named | Posted |",
            "|---|---|---|---|---|",
        ]
        rank = {"bidding": 0, "engineering": 1, "other": 2, "execution": 3}
        for job in sorted(today_jobs, key=lambda s: (rank[s["job_phase"]], -s["score"]))[:MAX_HIRING]:
            named = " / ".join(x for x in (job["client"], job["project"]) if x)
            out.append(
                f"| **{_cell(job['publisher'])}** | {_link(job['title'], job['url'])} | {job['job_phase']} | {_cell(named)} | {job['published']} |"
            )
        if len(today_jobs) > MAX_HIRING:
            out.append(f"\n…and {len(today_jobs) - MAX_HIRING} more in data/signals.jsonl.")
    else:
        out.append("No new hiring signals today.")
    out.append("")

    # 5. Forward look
    ahead = [o for o in active if o.get("outlook") or o["stage"] == "planned"]
    out += ["## 5. Forward look", "", "Advance notice: plans, approvals and tender programmes that come before an enquiry.", ""]
    if ahead:
        for opp in sorted(ahead, key=lambda o: o["last_published"], reverse=True)[:12]:
            newest = by_id.get(opp["signal_ids"][-1], {})
            tail = f" — {opp['client']}" if opp["client"] else ""
            out.append(f"- {_link(opp['headline'], newest.get('url', ''))}{tail}, {opp['last_published']}")
    else:
        out.append("Nothing on the horizon in the sources this month.")
    out.append("")

    # 6. Pipeline
    out += ["## 6. Pipeline", ""]
    filed = [o for o in active if o["filed"]]
    for stage in PIPELINE_STAGES:
        group = [o for o in filed if o["stage"] == stage]
        if not group:
            continue
        out += [f"**{STAGE_LABEL[stage]}**", "", "| Opportunity | Client | Type | Value | Firms named | Last news | Priority |", "|---|---|---|---|---|---|---|"]
        for opp in sorted(group, key=lambda o: -o["score"]):
            out.append(
                f"| {_cell(opp['name'])} | {_cell(opp['client'])} | {opp['contract_type']} | {money(opp['value_usd'])} | "
                f"{_cell(_firms(opp))[:140]} | {opp['last_published']} | {opp['priority']} |"
            )
        out.append("")
    if not filed:
        out += ["No named projects in the register yet.", ""]

    # 6. Unfiled
    unfiled = [o for o in active if not o["filed"]]
    if unfiled:
        out += [
            "## 7. Other leads (not yet filed under a named project)",
            "",
            "Stories the tracker could not tie to a project in `config/watchlist.toml`. Add a `[[project]]` entry to track one by name.",
            "",
            "| Lead | Client | Stage | Type | Value | Firms named | Date |",
            "|---|---|---|---|---|---|---|",
        ]
        for opp in sorted(unfiled, key=lambda o: (o["last_published"], o["score"]), reverse=True)[:25]:
            first = by_id.get(opp["signal_ids"][-1], {})
            out.append(
                f"| {_link(opp['headline'][:110], first.get('url', ''))} | {_cell(opp['client'])} | {STAGE_LABEL[opp['stage']]} | "
                f"{opp['contract_type']} | {money(opp['value_usd'])} | {_cell(_firms(opp))[:100]} | {opp['last_published']} |"
            )
        if len(unfiled) > 25:
            out.append(f"\n…and {len(unfiled) - 25} older leads in data/opportunities.json.")
        out.append("")

    # Source health
    out += ["## Source health", "", "| Source | Requests | Succeeded | Signals kept | Problems |", "|---|---|---|---|---|"]
    for source, stats in health.items():
        problems = "; ".join(stats.get("errors", [])[:2]) or "none"
        extra = f" ({stats['adverts_read']} adverts read of {stats['adverts_listed']} listed)" if "adverts_read" in stats else ""
        out.append(f"| {source} | {stats['requests']} | {stats['ok']} | {stats.get('kept', 0)}{extra} | {_cell(problems)[:160]} |")
    if not health:
        out.append("| (no collection in this run) | | | | |")
    out += [
        "",
        f"*Built for {profile.get('company', 'us')} from public sources. Headlines and adverts are leads, not confirmation: "
        "check the source before you act. ADNOC's own tender portal is not public, so invitations issued only there will not appear here.*",
        "",
    ]
    return "\n".join(out)


def pipeline_csv(opportunities: list[dict], advice: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        ["id", "opportunity", "client", "stage", "contract_type", "value_usd", "priority", "score", "status", "winner", "bidders",
         "other_firms", "approach_first", "deadline", "first_seen", "last_news", "signals"]
    )
    for opp in opportunities:
        roles: dict[str, list[str]] = {}
        for firm, info in opp["parties"].items():
            roles.setdefault(info["role"], []).append(firm)
        targets = advice.get(opp["id"], {}).get("targets", [])
        writer.writerow(
            [
                opp["id"], opp["name"], opp["client"], STAGE_LABEL[opp["stage"]], opp["contract_type"],
                int(opp["value_usd"]) if opp["value_usd"] else "", opp["priority"], opp["score"], opp["status"],
                "; ".join(roles.get("winner", [])), "; ".join(roles.get("bidder", [])),
                "; ".join(roles.get("contractor", []) + roles.get("hiring", []) + roles.get("named", [])),
                targets[0]["org"] if targets else "", opp["deadline"], opp["first_published"], opp["last_published"], len(opp["signal_ids"]),
            ]
        )
    return buffer.getvalue()
