"""The opportunity register: signals grouped into opportunities.

The register is a view. It is rebuilt from data/signals.jsonl on every run, so a new project
alias in the watchlist refiles past signals too.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter

from .config import Config
from .extract import STAGES
from .textutil import days_between, norm_title, short_hash, slug

GENERIC_CLIENT = "ADNOC (Group)"
STORY_WINDOW_DAYS = 21  # two unfiled signals further apart than this are different stories
STAGE_WINDOW_DAYS = 21  # an opportunity's stage comes from signals this close to its latest one
DORMANT_AFTER_DAYS = 60

_STOP = set(
    "a an the of in on to for with at by from its it is are as and or new us usd bn billion million mn m adnoc abu dhabi uae "
    "contract contracts project projects says said will be has have after over into amid".split()
)
# Capitalised words too common to identify a story on their own.
_COMMON_PROPER = set(
    "borouge taziz fertiglobe ruwais adnoc onshore offshore gas energy engineering phase project contract epc feed pmc uae abu dhabi gulf middle east oil company group "
    "international national petroleum construction services limited llc plc co ltd the new major".split()
)
_ROLE_RANK = {"winner": 5, "bidder": 4, "contractor": 3, "hiring": 2, "named": 1}


def _tokens(title: str) -> set[str]:
    return {t for t in norm_title(title).split() if t not in _STOP and len(t) > 1}


def _proper(title: str) -> set[str]:
    """Names in a sentence-case headline. A Title Case Headline says nothing about which words are names."""
    words = [w for w in re.findall(r"\b[A-Za-z][\w'\-]{2,}\b", title)]
    capitalised = [w for w in words if w[0].isupper()]
    if not words or len(capitalised) / len(words) > 0.6:
        return set()
    return {w.lower() for w in capitalised} - _COMMON_PROPER


def _clients_agree(a: str, b: str) -> bool:
    return not a or not b or a == b or GENERIC_CLIENT in (a, b)


def _same_story(cluster: dict, signal: dict) -> bool:
    if not any(abs(days_between(m["published"], signal["published"])) <= STORY_WINDOW_DAYS for m in cluster["members"]):
        return False
    if not _clients_agree(cluster["client"], signal["client"]):
        return False
    tokens, proper = _tokens(signal["title"]), _proper(signal["title"])
    firms = {name for name, role in signal["parties"].items() if role != "hiring"}
    for member in cluster["members"]:
        other = _tokens(member["title"])
        union = tokens | other
        if union and len(tokens & other) / len(union) >= 0.5:
            return True
        if len(proper & _proper(member["title"])) >= 2:
            return True
        # The same firm, client and stage within days of each other is one event told twice.
        same_client = signal["client"] and signal["client"] == member["client"] != GENERIC_CLIENT
        same_stage = not signal["stage"] or not member["stage"] or signal["stage"] == member["stage"]
        shared = firms & {name for name, role in member["parties"].items() if role != "hiring"}
        if shared and same_client and same_stage:
            return True
        if shared and signal["stage"] == member["stage"] == "awarded" and abs(days_between(member["published"], signal["published"])) <= 10:
            return True
    return False


def _priority(score: int) -> str:
    return "High" if score >= 85 else "Medium" if score >= 65 else "Low"


def _summarise(key: str, name: str, members: list[dict], cfg: Config, today: str) -> dict:
    members = sorted(members, key=lambda s: (s["published"], s["id"]))
    latest = members[-1]["published"]
    recent = [m for m in members if days_between(m["published"], latest) <= STAGE_WINDOW_DAYS]
    # Headline stage: what the newest staged signal says (the most advanced one, if several share that day).
    # A project can have several packages at different stages, so the others seen lately are kept in `also`.
    staged = [m for m in recent if m["stage"] and m["kind"] != "job"] or [m for m in members if m["stage"]]
    newest = max((m["published"] for m in staged), default="")
    stage = max((m["stage"] for m in staged if m["published"] == newest), key=STAGES.index, default="")
    also = {}
    for m in staged:
        if m["stage"] != stage and m in recent:
            also[m["stage"]] = {"stage": m["stage"], "headline": m["title"], "date": m["published"], "url": m["url"]}
    # The stated project client wins; otherwise the most often named specific client.
    project = next((p for p in cfg.projects if p.name == name), None)
    clients = Counter(m["client"] for m in members if m["client"] and m["client"] != GENERIC_CLIENT)
    client = (project.client if project and project.client else "") or (
        clients.most_common(1)[0][0] if clients else GENERIC_CLIENT if any(m["client"] for m in members) else ""
    )
    types = Counter(m["contract_type"] for m in (recent or members) if m["contract_type"] and m["kind"] != "job")
    contract_type = types.most_common(1)[0][0] if types else ""
    values = [m["value_usd"] for m in members if m.get("value_usd")]

    parties: dict[str, dict] = {}
    for m in members:
        for firm, role in m["parties"].items():
            entry = parties.setdefault(
                firm,
                {
                    "role": role,
                    "type": getattr(cfg.contractor(firm), "kind", "unlisted"),
                    "first_seen": m["published"],
                    "last_seen": m["published"],
                    "evidence": [],
                },
            )
            if _ROLE_RANK[role] > _ROLE_RANK[entry["role"]]:
                entry["role"] = role
            entry["last_seen"] = max(entry["last_seen"], m["published"])
            entry["evidence"].append(m["id"])

    news = [m for m in members if m["kind"] != "job"]
    best = max(news or members, key=lambda s: (s["score"], s["published"]))
    score = best["score"] + min(10, 2 * (len(news) - 1)) if news else best["score"]
    return {
        "id": key,
        "name": name or best["title"],
        "filed": bool(name),
        "client": client,
        "stage": stage,
        "also": sorted(also.values(), key=lambda a: STAGES.index(a["stage"])),
        "outlook": any(m.get("outlook") for m in members),
        "contract_type": contract_type,
        "value_usd": statistics.median_low(values) if values else None,
        "sectors": sorted({tag for m in members for tag in m["sectors"]}),
        "parties": parties,
        "deadline": next((m["deadline"] for m in reversed(members) if m.get("deadline")), ""),
        "notes": [m["note"] for m in members if m.get("note")],
        "headline": best["title"],
        "first_published": members[0]["published"],
        "last_published": latest,
        "first_found": min(m["found"] for m in members),
        "last_found": max(m["found"] for m in members),
        "score": score,
        "priority": _priority(score),
        "status": "dormant" if days_between(latest, today) > DORMANT_AFTER_DAYS else "active",
        "signal_ids": [m["id"] for m in members],
    }


def build(signals: list[dict], cfg: Config, today: str) -> tuple[list[dict], list[dict]]:
    """Return (opportunities, loose job signals that name no tracked project)."""
    ordered = sorted(signals, key=lambda s: (s["published"], s["id"]))
    # Pass 1: signals that name a watchlist project go straight to it.
    filed: dict[str, dict] = {}
    for signal in ordered:
        if signal["project"]:
            home = filed.setdefault(signal["project"], {"name": signal["project"], "client": signal["client"], "last": signal["published"], "members": []})
            home["members"].append(signal)
            home["last"] = max(home["last"], signal["published"])
    # Pass 2: the rest join a project or an earlier story that tells the same news, or start a new story.
    stories: list[dict] = []
    loose_jobs: list[dict] = []
    for signal in ordered:
        if signal["project"]:
            continue
        if signal["kind"] == "job":
            loose_jobs.append(signal)
            continue
        home = next((c for c in list(filed.values()) + stories if _same_story(c, signal)), None)
        if home is None:
            home = {"name": "", "client": signal["client"], "last": signal["published"], "members": []}
            stories.append(home)
        home["members"].append(signal)
        home["last"] = max(home["last"], signal["published"])
        if home["client"] in ("", GENERIC_CLIENT) and signal["client"]:
            home["client"] = signal["client"]

    opportunities = [_summarise("p-" + slug(name), name, home["members"], cfg, today) for name, home in filed.items()]
    for story in stories:
        first = min(story["members"], key=lambda s: (s["published"], s["id"]))
        opportunities.append(_summarise("s-" + short_hash(first["id"]), "", story["members"], cfg, today))
    opportunities.sort(key=lambda o: (-o["score"], o["name"]))
    return opportunities, loose_jobs


def changes(previous: list[dict], current: list[dict]) -> dict:
    """What moved since the last register: new opportunities, stage changes, newly named firms."""
    owner = {sid: opp for opp in previous for sid in opp["signal_ids"]}
    result = {"new": [], "stage": [], "parties": [], "updated": []}
    for opp in current:
        matches = Counter(owner[sid]["id"] for sid in opp["signal_ids"] if sid in owner)
        if not matches:
            result["new"].append(opp["id"])
            continue
        before = next(o for o in previous if o["id"] == matches.most_common(1)[0][0])
        if before["stage"] != opp["stage"] and opp["stage"]:
            result["stage"].append({"id": opp["id"], "from": before["stage"], "to": opp["stage"]})
        added = sorted(set(opp["parties"]) - set(before["parties"]))
        if added:
            result["parties"].append({"id": opp["id"], "added": added})
        if set(opp["signal_ids"]) - set(before["signal_ids"]):
            result["updated"].append(opp["id"])
    return result
