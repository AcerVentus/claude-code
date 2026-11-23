"""Who to approach, and why, for each opportunity.

The advice follows how ADNOC work reaches an engineering consultancy:
  - FEED, PMC and study packages are bid direct to the ADNOC company (you are the prime);
  - EPC packages are bid by main contractors, who buy bid-phase and detailed engineering
    from consultancies, so the people to reach are the bidders, then the winner.
"""

from __future__ import annotations

import urllib.parse
from collections import Counter

from .config import Config
from .textutil import days_between

# Lower number = act sooner.
URGENCY_LABEL = {1: "This week", 2: "Next 2 weeks", 3: "This month", 4: "Keep warm"}


def people_search(org: str, role: str) -> str:
    """A LinkedIn people-search link for you to open while signed in. The tracker never opens it."""
    query = urllib.parse.quote(f'"{org}" {role} UAE')
    return f"https://www.linkedin.com/search/results/people/?keywords={query}"


def usual_bidders(signals: list[dict], cfg: Config) -> dict[str, list[str]]:
    """For each client, the main contractors most often seen on its work in the signal log."""
    counts: dict[str, Counter] = {}
    for signal in signals:
        if signal["kind"] == "job" or not signal["client"]:
            continue
        for firm, role in signal["parties"].items():
            entity = cfg.contractor(firm)
            if entity and entity.kind == "epc" and role in ("winner", "bidder", "contractor"):
                counts.setdefault(signal["client"], Counter())[firm] += 1
    return {client: [name for name, _ in counter.most_common(5)] for client, counter in counts.items()}


def _target(org, kind, why, offer, roles, urgency):
    return {
        "org": org,
        "kind": kind,
        "why": why,
        "offer": offer,
        "roles": roles,
        "urgency": urgency,
        "links": [{"role": role, "url": people_search(org, role)} for role in roles],
    }


def hiring_targets(loose_jobs: list[dict], cfg: Config, day: str, window_days: int = 7) -> list[dict]:
    """Approach rows for firms advertising ADNOC roles that name no tracked project, one row per firm."""
    by_firm: dict[str, list[dict]] = {}
    for job in loose_jobs:
        if job["job_phase"] in ("bidding", "engineering") and 0 <= days_between(job["found"], day) <= window_days:
            by_firm.setdefault(next(iter(job["parties"]), job["publisher"]), []).append(job)
    rows = []
    for firm, jobs in by_firm.items():
        entity = cfg.contractor(firm)
        if entity and entity.kind == "peer":
            continue
        bidding = any(j["job_phase"] == "bidding" for j in jobs)
        clients = sorted({j["client"] for j in jobs if j["client"]})
        roles = "; ".join(j["title"] for j in jobs[:3]) + (f" (+{len(jobs) - 3} more)" if len(jobs) > 3 else "")
        target = _target(
            firm,
            "hiring",
            f"Advertising {len(jobs)} role{'s' if len(jobs) > 1 else ''} naming {', '.join(clients) or 'ADNOC'}: {roles}.",
            "Proposal roles mean a live bid: offer bid-phase engineering and a detailed-engineering price they can carry."
            if bidding
            else "They are short of engineers for ADNOC work: offer seconded engineers or a work package instead of hires.",
            ["Proposals Manager", "Engineering Manager"] if bidding else ["Engineering Manager", "Resourcing Manager"],
            2 if bidding else 3,
        )
        target["fresh"] = any(j["found"] == day for j in jobs)
        target["label"] = f"Hiring for {', '.join(clients) or 'ADNOC'} work"
        target["score"] = max(j["score"] for j in jobs)
        rows.append(target)
    return rows


def advise(opp: dict, cfg: Config, usual: dict[str, list[str]]) -> dict:
    """Return {"targets": [...], "notes": [...]} for one opportunity."""
    profile = cfg.profile
    stage, ctype, client, name = opp["stage"], opp["contract_type"], opp["client"], opp["name"]
    prime = ctype in profile.get("prime_types", [])
    targets, notes = [], []
    label = f"{ctype} package" if ctype else "package"

    by_role: dict[str, list[str]] = {}
    for firm, info in opp["parties"].items():
        by_role.setdefault(info["role"], []).append(firm)
    kind = {firm: info["type"] for firm, info in opp["parties"].items()}

    # 1. Work you can bid as prime: go to the ADNOC company.
    if prime and stage in ("planned", "tender") and client:
        targets.append(
            _target(
                client,
                "client",
                f"{client} is {'tendering' if stage == 'tender' else 'preparing'} a {label} you can bid direct.",
                "Confirm you are registered and prequalified for this category in the ADNOC Commercial Directory, "
                "ask to be on the bidders list, and request the tender schedule.",
                ["Contracts Engineer", "Category Lead Procurement", "Project Manager"],
                1 if stage == "tender" else 3,
            )
        )
    elif stage == "planned" and client and client != "ADNOC (Group)" and (opp["filed"] or opp["priority"] != "Low"):
        targets.append(
            _target(
                client,
                "client",
                f"{client} is at the planning stage. The pre-FEED / FEED enquiry comes first, and that is yours to bid.",
                "Introduce your concept and FEED credentials to the project team before the enquiry is written.",
                ["Project Manager", "Vice President Projects", "Senior Engineer Projects"],
                3,
            )
        )

    # 2. Bidders: your client is the contractor pricing the job.
    bidders = by_role.get("bidder", [])
    if stage in ("tender", "bid_evaluation"):
        for firm in bidders:
            if kind.get(firm) == "peer":
                notes.append(f"Competitor in the race: {firm}.")
                continue
            teaming = kind.get(firm) == "consultant"
            targets.append(
                _target(
                    firm,
                    "bidder",
                    f"Bidding for {name}." if stage == "tender" else f"Bid submitted for {name}; award pending.",
                    (
                        "Offer to team: specialist disciplines or local delivery under their lead."
                        if teaming
                        else "Offer bid-phase engineering now (MTOs, deliverables list, man-hour estimate) "
                        "and a detailed-engineering proposal they can carry in their price."
                        if stage == "tender"
                        else "Get your detailed-engineering offer in before award so you are the named engineering partner."
                    ),
                    ["Proposals Manager", "Tendering Manager", "Engineering Manager"],
                    1 if stage == "tender" else 2,
                )
            )
        if not bidders and not prime:
            likely = [f for f in usual.get(client, []) if f not in opp["parties"]][:4]
            hint = f" Contractors most often seen on {client} work: {', '.join(likely)}." if likely else ""
            notes.append("Bidders are not named in public sources yet. Finding the bidders list is the next step." + hint)

    # 3. Winner: detailed engineering is bought in the weeks after award.
    for firm in by_role.get("winner", []):
        if kind.get(firm) == "peer":
            notes.append(f"Won by a competitor: {firm}.")
            continue
        if kind.get(firm) == "vendor" or ctype in ("supply", "services"):
            continue
        if ctype in ("FEED", "pre-FEED", "PMC") or kind.get(firm) == "consultant":
            targets.append(
                _target(
                    firm,
                    "winner",
                    f"Won the {label} for {name}.",
                    "Offer specialist sub-consultancy and seconded engineers for the study phase.",
                    ["Project Manager", "Engineering Manager", "Resourcing Manager"],
                    2,
                )
            )
        else:
            targets.append(
                _target(
                    firm,
                    "winner",
                    f"Won {name}." if stage in ("awarded", "execution") else f"Named on {name}.",
                    "Offer detailed-engineering capacity, specialist studies (HAZOP, SIL, flow assurance, stress) "
                    "and seconded engineers while they mobilise.",
                    ["Project Director", "Engineering Manager", "Subcontracts Manager"],
                    2 if stage == "awarded" else 4,
                )
            )
    if stage == "awarded" and ctype in ("FEED", "pre-FEED"):
        notes.append("Heads-up: the EPC tender usually follows a FEED award by 9 to 15 months. Put it on the forward plan.")

    # 4. Contractors already on the job.
    if stage == "execution":
        for firm in by_role.get("contractor", []):
            if kind.get(firm) in ("epc", "unlisted"):
                targets.append(
                    _target(
                        firm,
                        "contractor",
                        f"Executing {name}.",
                        "Offer overflow detailed design, site engineering, vendor-document review and as-built work.",
                        ["Engineering Manager", "Project Manager"],
                        4,
                    )
                )

    # 5. Firms hiring for this project: they are short of engineers now.
    for firm in by_role.get("hiring", []):
        if firm in (t["org"] for t in targets) or kind.get(firm) == "peer":
            if kind.get(firm) == "peer":
                notes.append(f"Competitor hiring for this project: {firm}.")
            continue
        targets.append(
            _target(
                firm,
                "hiring",
                f"Advertising roles for {name}.",
                "Offer engineers or a work package they can hand over instead of hiring.",
                ["Engineering Manager", "Resourcing Manager"],
                3,
            )
        )

    for other in opp.get("also", []):
        if other["stage"] in ("tender", "bid_evaluation"):
            notes.append(f"Another package is live ({other['stage'].replace('_', ' ')}, {other['date']}): {other['headline']}")
    if opp.get("outlook"):
        notes.append("Forward look: this is advance notice of enquiries to come. Check which packages match your prequalification.")

    targets.sort(key=lambda t: t["urgency"])
    return {"targets": targets, "notes": notes}
