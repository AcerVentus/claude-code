"""Load the three config files and compile their aliases into matchers."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
DIGEST_DIR = ROOT / "digests"
INBOX_DIR = ROOT / "inbox"


def compile_aliases(aliases: list[str]) -> re.Pattern:
    """One case-insensitive pattern for a list of aliases. See watchlist.toml for the syntax."""
    parts = []
    for alias in aliases:
        if alias.startswith("re:"):
            parts.append(f"(?:{alias[3:]})")
            continue
        case_sensitive = alias.startswith("cs:")
        text = alias[3:] if case_sensitive else alias
        literal = re.escape(text).replace(r"\ ", r"\s+").replace("'", "['’]")
        literal = rf"(?<![\w]){literal}(?![\w])"
        parts.append(f"(?-i:{literal})" if case_sensitive else f"(?:{literal})")
    return re.compile("|".join(parts), re.I)


@dataclass
class Entity:
    name: str
    pattern: re.Pattern
    kind: str = ""  # contractor type, or "" for clients and projects
    weight: int = 0
    generic: bool = False
    client: str = ""  # projects only


@dataclass
class Config:
    clients: list[Entity] = field(default_factory=list)
    projects: list[Entity] = field(default_factory=list)
    contractors: list[Entity] = field(default_factory=list)
    sources: dict = field(default_factory=dict)
    profile: dict = field(default_factory=dict)

    def contractor(self, name: str) -> Entity | None:
        return next((c for c in self.contractors if c.name == name), None)

    def client_weight(self, name: str) -> int:
        return next((c.weight for c in self.clients if c.name == name), 0)


def _read(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def load(config_dir: Path = CONFIG_DIR) -> Config:
    watch = _read(config_dir / "watchlist.toml")
    cfg = Config(sources=_read(config_dir / "sources.toml"), profile=_read(config_dir / "profile.toml"))
    for row in watch.get("client", []):
        cfg.clients.append(
            Entity(
                name=row["name"],
                pattern=compile_aliases(row["aliases"]),
                weight=row.get("weight", 0),
                generic=row.get("generic", False),
            )
        )
    for row in watch.get("project", []):
        cfg.projects.append(
            Entity(name=row["name"], pattern=compile_aliases(row["aliases"]), client=row.get("client", ""))
        )
    for row in watch.get("contractor", []):
        cfg.contractors.append(
            Entity(name=row["name"], pattern=compile_aliases(row["aliases"]), kind=row.get("type", "epc"))
        )
    return cfg
