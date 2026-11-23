"""Collectors. Each returns raw signals: dicts with id, kind, source, publisher, title, url, published, text.

Every collector reads public pages without signing in, waits between requests, and gives up
on a refusal instead of working around it. Failures are reported through `health`, never raised.
"""

from __future__ import annotations

import json
import re
import shutil
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

from . import net
from .config import Config
from .textutil import clean, norm_title, short_hash, strip_html, to_iso_date, today

# ---------------------------------------------------------------------------
# News aggregators
# ---------------------------------------------------------------------------


def google_news_url(query: str, days: int) -> str:
    q = urllib.parse.quote_plus(f"{query} when:{days}d")
    return f"https://news.google.com/rss/search?q={q}&hl=en&gl=AE&ceid=AE:en"


def bing_news_url(query: str, days: int) -> str:
    # interval 7 = past 24 hours, 8 = past week, 9 = past month
    interval = "7" if days <= 1 else "8" if days <= 7 else "9"
    q = urllib.parse.quote_plus(query)
    return f"https://www.bing.com/news/search?q={q}&format=rss&qft=interval%3d%22{interval}%22"


def parse_google_news(xml_text: str) -> list[dict]:
    items = []
    for item in ET.fromstring(xml_text).iter("item"):
        title = clean(item.findtext("title") or "")
        publisher = clean(item.findtext("source") or "")
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].strip()
        if not title:
            continue
        items.append(
            {
                "id": "n-" + short_hash(norm_title(title)),
                "kind": "news",
                "source": "google-news",
                "publisher": publisher,
                "title": title,
                "url": (item.findtext("link") or "").strip(),
                "published": to_iso_date(item.findtext("pubDate") or ""),
                "text": "",
            }
        )
    return items


def parse_bing_news(xml_text: str) -> list[dict]:
    items = []
    for item in ET.fromstring(xml_text).iter("item"):
        title = clean(item.findtext("title") or "")
        if not title:
            continue
        link = (item.findtext("link") or "").strip()
        target = urllib.parse.parse_qs(urllib.parse.urlparse(link).query).get("url")
        publisher = ""
        for child in item:
            if child.tag.endswith("}Source"):
                publisher = clean(child.text or "")
        items.append(
            {
                "id": "n-" + short_hash(norm_title(title)),
                "kind": "news",
                "source": "bing-news",
                "publisher": publisher,
                "title": title,
                "url": target[0] if target else link,
                "published": to_iso_date(item.findtext("pubDate") or ""),
                "text": clean(strip_html(item.findtext("description") or "")),
            }
        )
    return items


def collect_news(cfg: Config, days: int, health: dict, sleep=time.sleep) -> list[dict]:
    settings = cfg.sources.get("news", {})
    if not settings.get("enabled", True):
        return []
    delay = settings.get("delay_seconds", 2)
    plan = [("google-news", q, google_news_url(q, days), parse_google_news) for q in settings.get("google_queries", [])]
    plan += [("bing-news", q, bing_news_url(q, days), parse_bing_news) for q in settings.get("bing_queries", [])]
    found: dict[str, dict] = {}
    for source, query, url, parser in plan:
        stats = health.setdefault(source, {"requests": 0, "ok": 0, "items": 0, "errors": []})
        stats["requests"] += 1
        try:
            items = parser(net.get(url, retry_waits=(15,)))
        except (net.FetchError, ET.ParseError) as error:
            stats["errors"].append(f"{query}: {error}"[:200])
            continue
        finally:
            sleep(delay)
        stats["ok"] += 1
        stats["items"] += len(items)
        for item in items:
            kept = found.get(item["id"])
            # Prefer the copy with a summary (Bing) over the bare headline (Google).
            if kept is None or (item["text"] and not kept["text"]):
                if kept is not None and not item["publisher"]:
                    item["publisher"] = kept["publisher"]
                found[item["id"]] = item
    return list(found.values())


# ---------------------------------------------------------------------------
# LinkedIn public job search
# ---------------------------------------------------------------------------

_LI_SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
_LI_DETAIL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/"


def parse_linkedin_cards(html_text: str) -> list[dict]:
    cards = []
    for chunk in re.split(r"<li>", html_text)[1:]:
        job_id = re.search(r"jobPosting:(\d+)", chunk)
        title = re.search(r'base-search-card__title">(.*?)</h3>', chunk, re.S)
        if not job_id or not title:
            continue
        employer = re.search(r'base-search-card__subtitle">(.*?)</h4>', chunk, re.S)
        location = re.search(r'job-search-card__location">(.*?)</span>', chunk, re.S)
        posted = re.search(r'<time[^>]*datetime="([^"]+)"', chunk)
        cards.append(
            {
                "job_id": job_id.group(1),
                "title": clean(strip_html(title.group(1))),
                "employer": clean(strip_html(employer.group(1))) if employer else "",
                "location": clean(strip_html(location.group(1))) if location else "",
                "published": posted.group(1) if posted else "",
            }
        )
    return cards


def parse_linkedin_detail(html_text: str) -> str:
    body = re.search(r'show-more-less-html__markup[^>]*>(.*?)</div>', html_text, re.S)
    return clean(strip_html(body.group(1))) if body else ""


def excerpt(text: str, pattern: re.Pattern, width: int = 320, limit: int = 1200) -> str:
    """The parts of a long advert around each match, so the register keeps evidence, not the whole advert."""
    spans = []
    for match in pattern.finditer(text):
        start, end = max(0, match.start() - width), min(len(text), match.end() + width)
        if spans and start <= spans[-1][1]:
            spans[-1][1] = end
        else:
            spans.append([start, end])
    parts, total = [], 0
    for start, end in spans:
        piece = text[start:end].strip()
        if total + len(piece) > limit:
            piece = piece[: max(0, limit - total)]
        if piece:
            parts.append(piece)
            total += len(piece)
        if total >= limit:
            break
    return " … ".join(parts)


def collect_linkedin(cfg: Config, seen: dict, health: dict, sleep=time.sleep) -> list[dict]:
    settings = cfg.sources.get("linkedin", {})
    if not settings.get("enabled", True):
        return []
    stats = health.setdefault(
        "linkedin-jobs", {"requests": 0, "ok": 0, "items": 0, "errors": [], "adverts_listed": 0, "adverts_read": 0}
    )
    delay = settings.get("delay_seconds", 5)
    waits = tuple(settings.get("retry_waits", [30, 60, 120]))
    skip = [name.lower() for name in settings.get("skip_employers", [])]
    mention = re.compile(
        "|".join(e.pattern.pattern for e in cfg.clients + cfg.projects), re.I
    )

    deadline = time.monotonic() + 60 * settings.get("max_minutes", 8)
    cards: dict[str, dict] = {}
    blocked = False
    for query in settings.get("queries", []):
        for page in range(settings.get("pages_per_query", 1)):
            params = urllib.parse.urlencode(
                {
                    "keywords": query,
                    "location": settings.get("location", "United Arab Emirates"),
                    "f_TPR": settings.get("posted_within", "r604800"),
                    "start": page * 10,
                }
            )
            stats["requests"] += 1
            try:
                page_cards = parse_linkedin_cards(net.get(f"{_LI_SEARCH}?{params}", retry_waits=waits))
            except net.FetchError as error:
                stats["errors"].append(f"search '{query}': {error.status} {error.reason}"[:200])
                blocked = error.status in net.RETRY_STATUSES
                break
            finally:
                sleep(delay)
            stats["ok"] += 1
            for card in page_cards:
                cards.setdefault(card["job_id"], card)
            if len(page_cards) < 10:
                break
        if blocked:
            break
    stats["adverts_listed"] = len(cards)

    signals = []
    fresh = [c for c in cards.values() if f"li-{c['job_id']}" not in seen]
    fresh.sort(key=lambda c: c["published"], reverse=True)
    budget = settings.get("max_details_per_run", 30)
    for card in fresh:
        signal_id = f"li-{card['job_id']}"
        if any(name in card["employer"].lower() for name in skip):
            seen[signal_id] = today()
            continue
        if blocked or budget <= 0 or time.monotonic() > deadline:
            stats["left_for_next_run"] = stats.get("left_for_next_run", 0) + 1
            continue  # left unseen: the next run picks it up
        budget -= 1
        stats["requests"] += 1
        try:
            description = parse_linkedin_detail(net.get(_LI_DETAIL + card["job_id"], retry_waits=waits))
        except net.FetchError as error:
            stats["errors"].append(f"advert {card['job_id']}: {error.status} {error.reason}"[:200])
            if error.status in net.RETRY_STATUSES:
                blocked = True
            continue
        finally:
            sleep(delay)
        stats["ok"] += 1
        stats["adverts_read"] += 1
        seen[signal_id] = today()
        if not mention.search(f"{card['title']} {description}"):
            continue
        signals.append(
            {
                "id": signal_id,
                "kind": "job",
                "source": "linkedin-jobs",
                "publisher": card["employer"],
                "title": card["title"],
                "url": f"https://www.linkedin.com/jobs/view/{card['job_id']}",
                "published": to_iso_date(card["published"]),
                "location": card["location"],
                "text": excerpt(description, mention),
            }
        )
    stats["items"] = len(signals)
    if stats.get("left_for_next_run"):
        why = "LinkedIn asked us to slow down" if blocked else "the daily limit on adverts or minutes was reached"
        stats["errors"].append(f"{stats['left_for_next_run']} adverts left for the next run: {why}")
    return signals


# ---------------------------------------------------------------------------
# Inbox: leads dropped in by hand or by the daily research pass
# ---------------------------------------------------------------------------

_URL = re.compile(r"https?://\S+")
_HEADER = re.compile(r"^(project|client|stage|type|bidders|winner|value|deadline|date|source|kind)\s*:\s*(.+)$", re.I)
# Fields a lead may state outright; they override what the classifier would infer.
STATED_FIELDS = ("project", "client", "stage", "contract_type", "bidders", "winner", "value_usd", "deadline", "note")


def _lead_from_text(path: Path) -> dict:
    lead: dict = {"text": ""}
    body = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip().lstrip("#").strip()
        header = _HEADER.match(stripped)
        if header and "title" in lead:
            key, value = header.group(1).lower(), header.group(2).strip()
            key = {"type": "contract_type", "value": "value_usd", "date": "published", "source": "publisher"}.get(key, key)
            lead[key] = [v.strip() for v in value.split(",") if v.strip()] if key == "bidders" else value
        elif stripped and "title" not in lead:
            lead["title"] = stripped
        elif stripped:
            body.append(stripped)
    lead["text"] = " ".join(body)
    url = _URL.search(path.read_text(encoding="utf-8"))
    if url and "url" not in lead:
        lead["url"] = url.group(0).rstrip(").,")
    return lead


def read_inbox(inbox_dir: Path, health: dict) -> tuple[list[dict], list[Path]]:
    """Leads waiting in the inbox, and the files they came from."""
    stats = health.setdefault("inbox", {"requests": 0, "ok": 0, "items": 0, "errors": []})
    signals, files = [], []
    if not inbox_dir.is_dir():
        return signals, files
    for path in sorted(inbox_dir.iterdir()):
        if not path.is_file() or path.name.lower() == "readme.md" or path.name.startswith("."):
            continue
        stats["requests"] += 1
        try:
            if path.suffix == ".json":
                loaded = json.loads(path.read_text(encoding="utf-8"))
                leads = loaded if isinstance(loaded, list) else [loaded]
            elif path.suffix in (".md", ".txt"):
                leads = [_lead_from_text(path)]
            else:
                continue
        except (OSError, ValueError) as error:
            stats["errors"].append(f"{path.name}: {error}"[:200])
            continue
        stats["ok"] += 1
        files.append(path)
        for lead in leads:
            if not isinstance(lead, dict) or not lead.get("title"):
                stats["errors"].append(f"{path.name}: a lead without a title was skipped")
                continue
            title = clean(str(lead["title"]))
            signal = {
                "id": "m-" + short_hash(norm_title(title), str(lead.get("url", ""))),
                "kind": lead.get("kind") if lead.get("kind") in ("manual", "research") else "manual",
                "source": "inbox",
                "publisher": clean(str(lead.get("publisher") or lead.get("source") or "Own lead")),
                "title": title,
                "url": str(lead.get("url", "")),
                "published": to_iso_date(str(lead.get("published") or lead.get("date") or "")) or today(),
                "text": clean(str(lead.get("text", ""))),
                "stated": {k: lead[k] for k in STATED_FIELDS if lead.get(k) not in (None, "", [])},
            }
            signals.append(signal)
    stats["items"] = len(signals)
    return signals, files


def archive_inbox(files: list[Path], inbox_dir: Path) -> None:
    processed = inbox_dir / "processed"
    processed.mkdir(exist_ok=True)
    for path in files:
        shutil.move(str(path), str(processed / f"{today()}-{path.name}"))
