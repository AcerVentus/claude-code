"""Turn a raw signal into a classified one: client, project, stage, contract type, parties, value, score.

Everything here is a transparent rule. To change what the tracker recognises, edit the
tables below or config/watchlist.toml, then run `python3 -m rfp_tracker rebuild`.
"""

from __future__ import annotations

import re

from .config import Config
from .textutil import clean

# Pipeline stages, in order. A project moves down this list over time.
STAGES = ["planned", "tender", "bid_evaluation", "awarded", "execution"]
STAGE_LABEL = {
    "planned": "Planned / early",
    "tender": "Out to tender",
    "bid_evaluation": "Bids in / evaluation",
    "awarded": "Awarded",
    "execution": "In execution",
    "": "Unclear",
}

# Checked top to bottom; the first match wins.
_STAGE_RULES = [
    (
        "bid_evaluation",
        r"(submit(s|ted)?|receiv(es|ed)|open(s|ed)|evaluat(es|ing)|review(s|ing)) (the )?(technical |commercial |final |revised |priced )*(bids|offers|proposals|prices)"
        r"|(technical|commercial) bids|low(est)? bidder|front-?runners?|bid evaluation|short-?list|best and final|\bBAFO\b"
        r"|preferred bidder|(close to|near(s|ing)?|set to|poised to|expected to|about to|to|will) (award|pick|select|choose)"
        r"|in talks (to|with)|negotiat(es|ing|ions)|bids (are )?in\b",
    ),
    (
        "awarded",
        r"\b(wins?|won|awarded|awards|secures?|secured|bags?|bagged|clinch(es|ed)?|lands?|landed|scoops?|picks?|picked|selects?|selected|taps|tapped|chooses|chosen)\b"
        r"|\bhires?\b(?! (new|a new|former|ex-))|sign(s|ed)? .{0,70}(contract|EPC|FEED|agreement)|inks? .{0,70}(contract|EPC|FEED|agreement|deal)"
        r"|letter of (award|intent)|\bLoA\b|\bLOI\b|(gets?|receives?|received) .{0,60}(contract|order|award)|contract award",
    ),
    (
        "tender",
        r"tender|invit(es|ed|ation|ing)|\bITT\b|\bRFP\b|\bRFQ\b|\bITB\b|request for (proposals?|quotations?)|expressions? of interest|\bEOI\b"
        r"|pre-?qualif|bid (deadline|due|submission|date)|deadline|extra time|extend(s|ed)?|bidding|bids due|bidders|seeks? (bids|contractors|offers|proposals)"
        r"|solicit|floats?|enquir(y|ies)|inquir(y|ies)|out to (bid|tender)|\bbid(s|ding)?\b|\bvie(s|ing)?\b|compet(e|es|ing|ition) (for|heats)",
    ),
    (
        "execution",
        r"breaks? ground|ground-?breaking|construction (begins|starts|started|under way|underway|progress)|first (oil|gas|steel|production)"
        r"|commission(s|ed|ing)|complet(es|ed|ion)|start-?up|starts up|milestone|sail-?away|load-?out|install(s|ed|ation)|on ?stream|deliver(s|ed|y)|inaugurat|order for\b",
    ),
    (
        "planned",
        r"\bplans?\b|planned|to (build|develop|expand|invest|boost|launch|double|upgrade)|\bFID\b|final investment decision|approv(es|ed|al)|budget|capex"
        r"|mulls?|eyes|considers?|stud(y|ies|ying)|feasibility|masterplan|sanction|green-?light|upcoming|expected to (tender|issue|launch)|pipeline of projects",
    ),
]
STAGE_RULES = [(stage, re.compile(pattern, re.I)) for stage, pattern in _STAGE_RULES]

# Checked in order; the first match wins.
_TYPE_RULES = [
    ("pre-FEED", r"pre-?FEED|concept(ual)? (study|design|engineering)|feasibility study"),
    ("FEED", r"\bFEED\b|front[- ]end engineering"),
    ("PMC", r"\bPMC\b|project management consult|owner'?s engineer"),
    ("EPCM", r"\bEPCM\b"),
    ("EPC", r"\bEPCI?C?\b|engineering, procurement|lump[- ]sum|turnkey|\bLSTK\b|construction (contract|tender)|main (plant|package|contract)"),
    ("engineering", r"detailed (engineering|design)|engineering (services|contract|consultan)|design (contract|consultan)|consultancy|consulting services|technical services|engineering studies"),
    ("framework", r"framework|call-?off|long-term (agreement|contract)"),
    ("supply", r"order for|supply (of|contract|agreement)|\b(pumps?|valves?|compressors?|cables?|linepipe|line pipe|OCTG|turbines?|transformers?)\b"),
    ("services", r"\brigs?\b|drilling|wireline|well services|jack-?ups?|seismic|vessel|charter|fracking|coiled tubing"),
]
TYPE_RULES = [(name, re.compile(pattern, re.I)) for name, pattern in _TYPE_RULES]

SECTOR_RULES = {
    "offshore": r"offshore|island|subsea|jackets?|topsides?|platforms?|Zakum|Umm Shaif|Ghasha|\bSARB\b|Nasr|marine",
    "onshore": r"onshore|Bab\b|Bu Hasa|Asab|Sahil|Habshan|Rumaitha|Shanayel|desert",
    "gas": r"\bgas\b|\bLNG\b|sour|sulphur|sulfur|\bNGL\b|ethane",
    "refining_petchem": r"refin|petrochem|polyolefin|polyethylene|Borouge|Ruwais|TA'ZIZ|methanol|chemicals?",
    "pipelines": r"pipelines?|trunkline|flowlines?",
    "carbon": r"\bCCS\b|\bCCUS\b|carbon capture|\bCO2\b",
    "hydrogen": r"hydrogen|ammonia",
    "power_water": r"power|electrif|substation|\bHVDC\b|seawater|desalin|\bgrid\b",
    "brownfield": r"upgrade|debottleneck|revamp|expansion|brownfield|life extension|integrity|modif",
}
SECTORS = {tag: re.compile(pattern, re.I) for tag, pattern in SECTOR_RULES.items()}

# Stories that mention ADNOC but are not about project work.
NOISE = re.compile(
    r"Pro League|football|\bcup\b|marathon|share price|\bshares\b|\bstocks?\b|dividend|\bIPO\b|\bbonds?\b|sukuk|net profit|earnings|"
    r"\bQ[1-4]\b|quarterly|crude price|oil prices?|\bOSP\b|Hormuz|\bOPEC\b|tanker|scholarship|sponsor|awards? (ceremony|night|gala)|"
    r"podcast|webinar|fuel prices?|petrol|service stations?|convenience|stake\b|acquir|takeover|merger|listing|"
    r"\bLNG (supply|sales|sale)\b|\bSPA\b|offtake|cargo(es)?|appoints?|names .{0,30}(CEO|CFO|chief)|interview|opinion|analyst|"
    r"\bjobs? (in|at|vacanc)|walk-?in|careers?|recruitment|salary|visa|"
    r"\bLNG (deal|contract|agreement|cargo)|long-term LNG|\bLPG\b|tonn(e|es)\b|collaboration|partnership|\bMoU\b|memorandum|"
    r"net income|\b[1-4]Q\b|to supply (gas|LNG|crude)|\d+-year (agreement|deal|contract)|Germany|OpenAI|\bAI\b|Trading\b|to explore|polypropylene|\bVLGC\b",
    re.I,
)

# Forward-looking procurement news: the earliest warning of enquiries to come.
OUTLOOK = re.compile(
    r"(new wave|multiple|upcoming|pipeline|slate|series|raft) of .{0,30}(tenders|contracts|projects)|multiple tenders|tenders? (for|in) 20\d\d|"
    r"what it will buy|procurement plan|(to|poised to|set to|prepares? to|plans? to|preparing to) (launch|issue|float|tender)|"
    r"prepares? .{0,40}tenders?|expected to (tender|issue|launch)|tendering (plan|schedule)",
    re.I,
)

# What a job title says about where its employer is in a project's life.
JOB_PHASES = [
    ("bidding", re.compile(r"proposal|tender|estimat|bid\b|bids\b|pre-?contract|business development", re.I)),
    ("execution", re.compile(r"commissioning|construction|site\b|supervisor|inspector|QA/?QC|technician|foreman|operator|welding|rigging|maintenance", re.I)),
    ("engineering", re.compile(r"\bFEED\b|\bPMC\b|design|process|piping|pipeline|mechanical|electrical|instrument|structural|civil|engineering manager|lead engineer|principal|technical safety|project engineer|engineer", re.I)),
]

_MONEY = re.compile(
    r"(?<![A-Za-z])(?P<cur>US\$|\$|USD\s?|AED\s?|Dh\s?|Dhs\s?)(?P<num>\d+(?:[.,]\d+)?)\s?-?(?P<unit>bn|billion|b\b|mn|million|m\b)", re.I
)
_AED_PER_USD = 3.6725

_ORG_WORD = r"[A-Z][\w&'.\-]*"
_SUBJECT = re.compile(
    rf"^(?P<org>{_ORG_WORD}(?:\s+(?:{_ORG_WORD}|of|and|de|&)){{0,4}}?)(?:'s)?\s+"
    r"(?i:wins?|won|secures?|bags?|clinch(?:es)?|lands?|scoops?|awarded|sign(?:s|ed)?|inks?|receives?|gets?|breaks? ground|selected|chosen|picked|to build|begins?|starts?)\b"
)
_OBJECT = re.compile(
    rf"\b(?i:hires?|picks?|selects?|taps|chooses|awards|contract to|awarded to)\s+(?P<org>{_ORG_WORD}(?:\s+{_ORG_WORD}){{0,3}})"
)
_NOT_ORGS = {
    "epc", "feed", "pmc", "epcm", "uae", "abu", "dhabi", "abu dhabi", "phase", "contract", "contracts", "contractors", "contractor",
    "us", "gulf", "middle east", "new", "major", "two", "three", "four", "five", "the", "a", "consortium", "firms", "bids", "gas", "oil", "letters", "three", "china", "local", "chinese", "indian", "korean", "italian",
}


def find_all(entities, text: str) -> list[str]:
    return [e.name for e in entities if e.pattern.search(text)]


def detect_stage(text: str) -> str:
    return next((stage for stage, pattern in STAGE_RULES if pattern.search(text)), "")


def detect_type(text: str) -> str:
    return next((name for name, pattern in TYPE_RULES if pattern.search(text)), "")


def detect_value_usd(text: str) -> float | None:
    """The largest money figure in the text, in US dollars."""
    best = None
    for match in _MONEY.finditer(text):
        number = float(match.group("num").replace(",", "."))
        scale = 1e9 if match.group("unit").lower() in ("bn", "billion", "b") else 1e6
        value = number * scale
        if match.group("cur").strip().lower() in ("aed", "dh", "dhs"):
            value /= _AED_PER_USD
        best = value if best is None else max(best, value)
    return best


def headline_orgs(title: str, known_names: set[str]) -> list[str]:
    """Company names a headline puts in the winner's position, for firms the watchlist does not list."""
    found = []
    for pattern in (_SUBJECT, _OBJECT):
        match = pattern.search(title)
        if not match:
            continue
        org = match.group("org").strip(" -:,")
        if org.lower() in _NOT_ORGS or len(org) < 3 or org.lower().startswith("adnoc"):
            continue
        if any(org.lower() in name.lower() or name.lower() in org.lower() for name in known_names):
            continue
        found.append(org)
    return found


def analyse(raw: dict, cfg: Config) -> dict:
    """Return `raw` with the classified fields added. The caller drops signals below the profile's min_score."""
    signal = dict(raw)
    stated = raw.get("stated") or {}
    title = clean(raw.get("title", ""))
    body = clean(raw.get("text", ""))
    text = f"{title}. {body}"
    is_job = raw.get("kind") == "job"

    # Client: the most specific ADNOC company named; the group itself only if nothing else matches.
    specific = [c.name for c in cfg.clients if not c.generic and c.pattern.search(text)]
    generic = [c.name for c in cfg.clients if c.generic and c.pattern.search(text)]
    projects = [p for p in cfg.projects if p.pattern.search(text)]
    client = stated.get("client") or (specific[0] if specific else "")
    if not client and projects and projects[0].client:
        client = projects[0].client
    if not client and generic:
        client = generic[0]

    project = stated.get("project") or (projects[0].name if projects else "")
    # In a job advert only the title says what the role is; the body is boilerplate about the employer.
    stage = stated.get("stage") or ("" if is_job else detect_stage(title) or detect_stage(body))
    contract_type = stated.get("contract_type") or detect_type(title) or detect_type(body)
    # A headline figure is the contract; a figure in the summary is often the whole programme.
    value = stated.get("value_usd") or detect_value_usd(title) or detect_value_usd(body)
    try:
        value = float(value) if value else None
    except (TypeError, ValueError):
        value = None

    parties: dict[str, str] = {}  # name -> role
    known = find_all(cfg.contractors, text)
    in_title = set(find_all(cfg.contractors, title))
    for name in known:
        if stage == "awarded":
            role = "winner" if name in in_title else "named"
        elif stage in ("tender", "bid_evaluation"):
            role = "bidder"
        elif stage == "execution":
            role = "contractor"
        else:
            role = "named"
        parties[name] = role
    if not is_job:
        for org in headline_orgs(title, {c.name for c in cfg.contractors} | set(known) | {c.name for c in cfg.clients}):
            if not any(c.pattern.search(org) for c in cfg.clients):
                parties.setdefault(org, "winner" if stage == "awarded" else "contractor" if stage == "execution" else "named")
    for name in stated.get("bidders") or []:
        parties[str(name)] = "bidder"
    if stated.get("winner"):
        parties[str(stated["winner"])] = "winner"

    job_phase = ""
    if is_job:
        job_phase = next((phase for phase, pattern in JOB_PHASES if pattern.search(title)), "other")
        employer = raw.get("publisher", "")
        listed = next((c.name for c in cfg.contractors if c.pattern.search(employer)), employer)
        if listed:
            parties = {listed: "hiring"}

    sectors = [tag for tag, pattern in SECTORS.items() if pattern.search(text)]
    noise = bool(NOISE.search(title)) and not is_job and not stated

    # Relevance, 0-100+. The parts are kept so the digest can show why.
    profile = cfg.profile
    parts: dict[str, int] = {}
    if client:
        parts["client"] = (35 if client in specific or stated.get("client") else 25) + cfg.client_weight(client)
    if project:
        parts["project"] = 15
    parts["stage"] = {"tender": 30, "bid_evaluation": 28, "awarded": 22, "planned": 15, "execution": 8}.get(stage, 0)
    parts["type"] = {
        "pre-FEED": 20, "FEED": 20, "PMC": 20, "engineering": 20, "EPCM": 15, "EPC": 15, "framework": 10, "supply": -8, "services": -20,
    }.get(contract_type, 0)
    if value:
        parts["value"] = 10 if value >= 1e9 else 6 if value >= 1e8 else 2
    if parties:
        parts["parties"] = 5
    if any(tag in profile.get("focus_sectors", []) for tag in sectors):
        parts["focus"] = 5
    if any(tag in profile.get("avoid_sectors", []) for tag in sectors):
        parts["avoid"] = -15
    outlook = bool(OUTLOOK.search(title)) and not is_job
    if outlook:
        parts["outlook"] = 20
    if not is_job and not stage and not contract_type and not stated:
        parts["vague"] = -20
    if noise:
        parts["noise"] = -50
    if is_job:
        parts["job"] = {"bidding": 30, "engineering": 22, "execution": 5, "other": 0}[job_phase]
    if raw.get("kind") in ("manual", "research"):
        parts["own_lead"] = 40
    score = sum(parts.values()) if client or project or raw.get("kind") in ("manual", "research") else 0

    signal.update(
        {
            "title": title,
            "client": client,
            "project": project,
            "stage": stage,
            "contract_type": contract_type,
            "value_usd": value,
            "parties": parties,
            "sectors": sectors,
            "job_phase": job_phase,
            "outlook": outlook,
            "score": score,
            "score_parts": {k: v for k, v in parts.items() if v},
        }
    )
    for key in ("deadline", "note"):
        if stated.get(key):
            signal[key] = stated[key]
    return signal
