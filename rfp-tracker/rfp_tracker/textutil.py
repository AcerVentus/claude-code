"""Text helpers shared by the collectors and the classifier."""

from __future__ import annotations

import hashlib
import html
import re
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

GULF = ZoneInfo("Asia/Dubai")
_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def today() -> str:
    """Today's date in Abu Dhabi, as YYYY-MM-DD."""
    return datetime.now(GULF).date().isoformat()


def strip_html(text: str) -> str:
    return _SPACE.sub(" ", html.unescape(_TAG.sub(" ", text or ""))).strip()


def clean(text: str) -> str:
    """Collapse whitespace and straighten quotes so aliases match either spelling."""
    text = (text or "").replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", "-")
    return _SPACE.sub(" ", text).strip()


def to_iso_date(value: str) -> str:
    """Best-effort YYYY-MM-DD (Abu Dhabi time) from an RSS or ISO date. Empty if unreadable."""
    value = (value or "").strip()
    if not value:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(GULF).date().isoformat()


def days_between(earlier: str, later: str) -> int:
    try:
        return (date.fromisoformat(later) - date.fromisoformat(earlier)).days
    except ValueError:
        return 0


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def short_hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]


def slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-")
