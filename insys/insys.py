#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""InSys - Internal Systems work tracker.

A single-file server that uses only the Python standard library, so it runs on
Windows (and macOS / Linux) with nothing to install besides Python itself.

    python insys.py              start for this computer only
    python insys.py --online     also publish a secure internet address
    python insys.py --help       all options

Data lives in the "data" folder next to this file (SQLite database, backups).

It can also be packaged as a single Windows program, InSys.exe, which carries
its own copy of Python (see README.md and the packaging folder). In that form
the data lives in an "InSys-data" folder next to InSys.exe.
"""

import argparse
import atexit
import base64
import datetime
import hashlib
import hmac
import ipaddress
import json
import math
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import ssl
except ImportError:   # a Python built without OpenSSL: choice 2 will refuse to start
    ssl = None

VERSION = "1.2.6"

# The database layout this version reads and writes. Version 1 is InSys 1.0.0;
# version 2 (InSys 1.1.x) adds the subcontractor directory; version 3 (InSys
# 1.2.0) adds the deleted-items archive, subcontractor capabilities and
# per-subcontractor follow-up tracking. An older database is upgraded in place
# on start-up, after a backup copy has been made. Upgrades only ever add tables
# and columns; nothing existing is altered or removed. Version 4 (InSys 1.2.1)
# adds the updates feed behind the notification banners and bell. Version 5
# (InSys 1.2.4) adds the user's own tracking number to records.
SCHEMA_VERSION = 5

MAX_UPLOAD = 300 * 1024 * 1024  # a transferred database file
MIN_PYTHON = (3, 9)

# PACKAGED is true when InSys runs as the single-file program, InSys.exe. Its
# launcher (packaging/launcher) unpacks a private copy of Python and of these
# files, then starts this script with INSYS_HOME set to the folder InSys.exe is
# in. BUNDLE_DIR holds the program files; APP_DIR is where things that must
# persist are kept.
BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGED = os.environ.get("INSYS_PACKAGED") == "1" and bool(os.environ.get("INSYS_HOME"))
APP_DIR = os.path.abspath(os.environ["INSYS_HOME"]) if PACKAGED else BUNDLE_DIR
WEB_DIR = os.path.join(BUNDLE_DIR, "web")
DATA_DIR_NAME = "InSys-data" if PACKAGED else "data"
MENU_SECONDS = 15

DEFAULT_PORT = 8080
MAX_BODY = 1024 * 1024  # 1 MB per request is plenty for a tracker

SESSION_COOKIE = "insys_session"
# The cookie used on the encrypted local network. The "__Host-" beginning makes
# a browser refuse to set it, or send it, over anything but HTTPS.
SECURE_SESSION_COOKIE = "__Host-insys_session"
TLS_HANDSHAKE_SECONDS = 20
CERTIFICATE_PATH = "/InSys-certificate.crt"
SESSION_IDLE_SECONDS = 12 * 3600
SESSION_MAX_SECONDS = 7 * 24 * 3600
SESSION_TOUCH_SECONDS = 60

PBKDF2_ITERATIONS = 600000  # fixed in the program; not adjustable from outside
MIN_PASSWORD_LENGTH = 10

BACKUP_KEEP = 20
BACKUP_EVERY_SECONDS = 24 * 3600

# ---------------------------------------------------------------------------
# What the tracker tracks
# ---------------------------------------------------------------------------
# Each status carries a "tone" used for display and to decide whether a record
# is still open: new / active / waiting are open, done / dead are closed.

MODULES = {
    "project": {
        "label": "Projects",
        "singular": "Project",
        "prefix": "PRJ",
        "team": None,
        "statuses": [
            ["Planning", "new"],
            ["In Progress", "active"],
            ["On Hold", "waiting"],
            ["Completed", "done"],
            ["Cancelled", "dead"],
        ],
        "category_label": "Type",
        "categories": ["Client delivery", "Internal", "Research & development",
                       "Maintenance & support", "Other"],
        "org_label": "Client / organisation",
        "start_label": "Start date",
        "due_label": "Target completion",
        "amount_label": "Project value",
        "numbered": True,
        "number_label": "Project number",
    },
    "enquiry": {
        "label": "Enquiries",
        "singular": "Enquiry",
        "prefix": "ENQ",
        "team": None,
        "statuses": [
            ["New", "new"],
            ["In Review", "active"],
            ["Responded", "active"],
            ["Awaiting Reply", "waiting"],
            ["Converted", "done"],
            ["Closed", "dead"],
        ],
        "category_label": "Source",
        "categories": ["Email", "Phone", "Website", "Referral", "Walk-in",
                       "Event", "Other"],
        "org_label": "Enquirer / organisation",
        "start_label": "Date received",
        "due_label": "Respond by",
        "amount_label": "Estimated value",
        "numbered": True,
        "number_label": "Enquiry number",
    },
    "eoi": {
        "label": "Expressions of Interest",
        "singular": "Expression of Interest",
        "prefix": "EOI",
        "team": None,
        "statuses": [
            ["Identified", "new"],
            ["Preparing", "active"],
            ["Submitted", "waiting"],
            ["Shortlisted", "active"],
            ["Successful", "done"],
            ["Unsuccessful", "dead"],
            ["Withdrawn", "dead"],
        ],
        "category_label": "Type",
        "categories": ["Tender / RFP", "Grant / funding", "Partnership",
                       "Supplier panel", "Other"],
        "org_label": "Issuing organisation",
        "start_label": "Date issued",
        "due_label": "Submission deadline",
        "amount_label": "Estimated value",
        "numbered": True,
        "number_label": "EOI number",
    },
    "finance": {
        "label": "Finance",
        "singular": "Finance item",
        "prefix": "FIN",
        "team": "finance",
        "statuses": [
            ["Draft", "new"],
            ["Pending Approval", "waiting"],
            ["Approved", "active"],
            ["Issued", "active"],
            ["Part Paid", "active"],
            ["Disputed", "waiting"],
            ["Paid", "done"],
            ["Cancelled", "dead"],
        ],
        "category_label": "Type",
        "categories": ["Invoice (receivable)", "Bill (payable)", "Purchase order",
                       "Expense claim", "Budget", "Payroll", "Tax & compliance",
                       "Other"],
        "org_label": "Customer / supplier",
        "start_label": "Document date",
        "due_label": "Payment due",
        "amount_label": "Amount",
        "numbered": False,
        "number_label": "",
    },
    "office": {
        "label": "Office Admin",
        "singular": "Office item",
        "prefix": "OFF",
        "team": "office",
        "statuses": [
            ["Open", "new"],
            ["In Progress", "active"],
            ["Waiting", "waiting"],
            ["Completed", "done"],
            ["Cancelled", "dead"],
        ],
        "category_label": "Type",
        "categories": ["Supplies", "Facilities", "IT & equipment", "Travel",
                       "HR & onboarding", "Documents & compliance",
                       "Meetings & events", "Other"],
        "org_label": "Requested by / supplier",
        "start_label": "Date raised",
        "due_label": "Needed by",
        "amount_label": "Cost",
        "numbered": False,
        "number_label": "",
    },
}

# Who sees what. "staff" is the role key InSys 1.0 and 1.1 used for people who
# see the technical sections only; it is now presented as Engineering.
ROLES = {
    "admin": "Administrator",
    "administration": "Administration",
    "staff": "Engineering",
    "finance": "Finance",
    "office": "Office Administrator",
}
ROLE_ACCESS = {
    "admin": "Everything, including the Admin area (logins, backups, database transfer).",
    "administration": "Every section, including Finance and Office Admin. No Admin area.",
    "staff": "Projects, Enquiries, Expressions of Interest and Subcontractors. "
             "No Finance or Office Admin.",
    "finance": "The same as Engineering, plus Finance.",
    "office": "The same as Engineering, plus Office Admin.",
}
# Roles that can open every section, whichever team it belongs to.
ALL_SECTION_ROLES = ("admin", "administration")

# Sections whose records can have subcontractors assigned.
SUBCON_MODULES = ("project", "enquiry", "eoi")

PRIORITIES = ["Low", "Normal", "High", "Urgent"]
TASK_STATUSES = ["To Do", "In Progress", "Done"]

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Robots-Tag", "noindex, nofollow"),
    ("Permissions-Policy", "geolocation=(), microphone=(), camera=()"),
    ("Content-Security-Policy",
     "default-src 'none'; script-src 'self'; style-src 'self'; "
     "img-src 'self' data:; connect-src 'self'; form-action 'self'; "
     "base-uri 'none'; frame-ancestors 'none'"),
]

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    "/robots.txt": ("robots.txt", "text/plain; charset=utf-8"),
    "/connect": ("connect.html", "text/html; charset=utf-8"),
    "/connect.js": ("connect.js", "text/javascript; charset=utf-8"),
}
# What a browser that arrived without encryption may fetch: the set-up page and its parts.
CONNECT_FILES = ("/connect", "/connect.js", "/styles.css", "/favicon.svg", "/robots.txt")
CONNECT_POLICY = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                  "connect-src 'self' %s; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")


# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

class Runtime:
    """Process-wide state. One instance, RT, created at import time."""

    def __init__(self):
        self.data_dir = os.path.join(APP_DIR, DATA_DIR_NAME)
        self.pause_on_exit = PACKAGED
        self.instance = secrets.token_hex(8)
        self.boot = secrets.token_hex(4)
        self.counter = 0
        self.counter_lock = threading.Lock()
        self.db_lock = threading.RLock()
        self.port = None
        self.online_requested = False
        self.public_url = None
        self.tunnel_status = "off"
        self.lan = False
        self.kept_awake = False
        self.upgraded_from = None
        self.upgrade_backup = None
        # True only while the internet tunnel of choice 3 is running. Everything
        # that lets the internet in, or goes out to it, is conditional on this.
        self.tunnel_active = False
        self.local_names = set()   # names this computer answers to on the local network
        # Encryption for the local network (an Encryption object) while InSys is
        # running in choice 2; None in choices 1 and 3, where nothing InSys
        # serves itself crosses a network.
        self.tls = None
        self.lan_ips = []          # this computer's local network addresses, found at start

    @property
    def db_path(self):
        return os.path.join(self.data_dir, "insys.db")

    @property
    def backup_dir(self):
        return os.path.join(self.data_dir, "backups")

    @property
    def tools_dir(self):
        """Where a downloaded cloudflared lives."""
        if PACKAGED:
            return os.path.join(self.data_dir, "tools")
        return os.path.join(APP_DIR, "tools")

    @property
    def first_login_file(self):
        return os.path.join(self.data_dir, "ADMIN-FIRST-LOGIN.txt")

    def version(self):
        return "%s-%d" % (self.boot, self.counter)

    def bump(self):
        with self.counter_lock:
            self.counter += 1


RT = Runtime()


def log_error(text):
    """Append to data/insys.log; never raises."""
    try:
        with open(os.path.join(RT.data_dir, "insys.log"), "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (now_iso(), text))
    except Exception:
        pass


def say(text=""):
    """Console output that cannot crash on a legacy Windows code page."""
    try:
        print(text, flush=True)
    except Exception:
        try:
            print(text.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today_iso():
    return datetime.date.today().isoformat()


class ApiError(Exception):
    def __init__(self, status, message, code=None):
        Exception.__init__(self, message)
        self.status = status
        self.message = message
        self.code = code


def text_field(body, key, label, maxlen, required=False, multiline=False):
    value = body.get(key)
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, "%s must be text." % label)
    value = value.replace("\x00", "")
    if multiline:
        value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    else:
        value = " ".join(value.split())
    if required and not value:
        raise ApiError(400, "%s is required." % label)
    if len(value) > maxlen:
        raise ApiError(400, "%s is too long (maximum %d characters)." % (label, maxlen))
    return value


def date_field(body, key, label, required=False):
    value = body.get(key)
    if value is None or value == "":
        if required:
            raise ApiError(400, "%s is required." % label)
        return None
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ApiError(400, "%s must be a valid date." % label)
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, "%s must be a valid date." % label)
    return value


def amount_field(body, key, label):
    value = body.get(key)
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ApiError(400, "%s must be a number." % label)
    if isinstance(value, str):
        try:
            value = float(value.replace(",", "").strip())
        except ValueError:
            raise ApiError(400, "%s must be a number." % label)
    if not isinstance(value, (int, float)):
        raise ApiError(400, "%s must be a number." % label)
    value = float(value)
    if math.isnan(value) or math.isinf(value) or value < 0 or value > 1e15:
        raise ApiError(400, "%s must be a positive number." % label)
    return round(value, 2)


def int_field(body, key, label, required=False):
    value = body.get(key)
    if value is None or value == "":
        if required:
            raise ApiError(400, "%s is required." % label)
        return None
    if isinstance(value, bool):
        raise ApiError(400, "%s is not valid." % label)
    if isinstance(value, str) and re.match(r"^\d{1,12}$", value):
        value = int(value)
    if not isinstance(value, int) or value < 0:
        raise ApiError(400, "%s is not valid." % label)
    return value


def choice_field(body, key, label, choices, default=None, allow_blank=False):
    value = body.get(key)
    if value is None or value == "":
        if allow_blank:
            return ""
        if default is not None:
            return default
        raise ApiError(400, "%s is required." % label)
    if value not in choices:
        raise ApiError(400, "%s is not a valid choice." % label)
    return value


def fmt_amount(value):
    if value is None:
        return "-"
    return "{:,.2f}".format(value)


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------

def hash_password(password, iterations=None):
    iterations = iterations or PBKDF2_ITERATIONS
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256$%d$%s$%s" % (iterations, salt.hex(), digest.hex())


def verify_password(password, stored):
    try:
        scheme, iterations, salt_hex, digest_hex = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


# Verified against when the username does not exist, so that a wrong username
# and a wrong password take the same time to reject.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))

_PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_password(groups=3):
    """A random password that is easy to read out and type: abcd-efgh-jkmn."""
    while True:
        parts = ["".join(secrets.choice(_PW_ALPHABET) for _ in range(4))
                 for _ in range(groups)]
        candidate = "-".join(parts)
        if any(c.isdigit() for c in candidate) and any(c.isalpha() for c in candidate):
            return candidate


def check_password_policy(password, username):
    if not isinstance(password, str):
        raise ApiError(400, "Password is required.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ApiError(400, "Password must be at least %d characters long." % MIN_PASSWORD_LENGTH)
    if len(password) > 200:
        raise ApiError(400, "Password is too long.")
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        raise ApiError(400, "Password must contain at least one letter and one number.")
    if username and username.lower() in password.lower():
        raise ApiError(400, "Password must not contain your username.")


# ---------------------------------------------------------------------------
# Sign-in throttling
# ---------------------------------------------------------------------------

class Limiter:
    def __init__(self, limit, window):
        self.limit = limit
        self.window = window
        self.hits = {}
        self.lock = threading.Lock()

    def _fresh(self, key, now):
        items = [t for t in self.hits.get(key, []) if now - t < self.window]
        if items:
            self.hits[key] = items
        else:
            self.hits.pop(key, None)
        return items

    def wait_seconds(self, key):
        now = time.time()
        with self.lock:
            items = self._fresh(key, now)
            if len(items) >= self.limit:
                return int(self.window - (now - items[0])) + 1
            return 0

    def fail(self, key):
        now = time.time()
        with self.lock:
            items = self._fresh(key, now)
            items.append(now)
            self.hits[key] = items
            if len(self.hits) > 20000:  # bound memory under abuse
                self.hits.clear()

    def clear(self, key):
        with self.lock:
            self.hits.pop(key, None)


LIMIT_PAIR = Limiter(8, 900)    # same person, same place
LIMIT_USER = Limiter(60, 900)   # one account from many places
LIMIT_IP = Limiter(30, 900)     # one place, many accounts


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    organisation TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    contact_info TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'Normal',
    owner_id INTEGER REFERENCES users(id),
    amount REAL,
    start_date TEXT,
    due_date TEXT,
    description TEXT NOT NULL DEFAULT '',
    last_action TEXT NOT NULL DEFAULT '',
    last_action_date TEXT,
    last_action_by INTEGER REFERENCES users(id),
    next_action TEXT NOT NULL DEFAULT '',
    next_action_date TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    deleted_by INTEGER,
    number TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_records_module ON records(module);
CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    action_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_record ON activity(record_id);
CREATE TABLE IF NOT EXISTS links (
    a_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    b_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (a_id, b_id),
    CHECK (a_id < b_id)
);
CREATE TABLE IF NOT EXISTS xrefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    system TEXT NOT NULL,
    ref TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xrefs_record ON xrefs(record_id);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,
    assignee_id INTEGER NOT NULL REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'Normal',
    status TEXT NOT NULL DEFAULT 'To Do',
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    deleted_by INTEGER
);
CREATE TABLE IF NOT EXISTS subcons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    discipline TEXT NOT NULL DEFAULT '',
    services TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    registration TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS record_subcons (
    record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    subcon_id INTEGER NOT NULL REFERENCES subcons(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT '',
    added_by INTEGER REFERENCES users(id),
    added_at TEXT NOT NULL,
    last_update TEXT NOT NULL DEFAULT '',
    last_update_date TEXT,
    next_action TEXT NOT NULL DEFAULT '',
    next_action_date TEXT,
    updated_by INTEGER,
    updated_at TEXT,
    PRIMARY KEY (record_id, subcon_id)
);
CREATE INDEX IF NOT EXISTS idx_record_subcons_subcon ON record_subcons(subcon_id);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_id INTEGER,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    record_id INTEGER,
    task_id INTEGER,
    subcon_id INTEGER
);
CREATE TABLE IF NOT EXISTS event_seen (
    user_id INTEGER PRIMARY KEY,
    last_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
"""


# Columns introduced after a table first shipped. A database made by an older
# version gets them added on upgrade; in a new database they already exist.
ADDED_COLUMNS = [
    ("records", "deleted_at", "TEXT"),
    ("records", "deleted_by", "INTEGER"),
    ("records", "number", "TEXT NOT NULL DEFAULT ''"),
    ("tasks", "deleted_at", "TEXT"),
    ("tasks", "deleted_by", "INTEGER"),
    ("subcons", "capabilities", "TEXT NOT NULL DEFAULT ''"),
    ("record_subcons", "last_update", "TEXT NOT NULL DEFAULT ''"),
    ("record_subcons", "last_update_date", "TEXT"),
    ("record_subcons", "next_action", "TEXT NOT NULL DEFAULT ''"),
    ("record_subcons", "next_action_date", "TEXT"),
    ("record_subcons", "updated_by", "INTEGER"),
    ("record_subcons", "updated_at", "TEXT"),
]


def connect():
    conn = sqlite3.connect(RT.db_path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


class read_db:
    """Short-lived read connection."""

    def __enter__(self):
        self.conn = connect()
        return self.conn

    def __exit__(self, *exc):
        self.conn.close()
        return False


class write_db:
    """One serialized write transaction; commits on success, rolls back on error."""

    def __init__(self, bump=True):
        self.bump = bump

    def __enter__(self):
        RT.db_lock.acquire()
        try:
            self.conn = connect()
            self.conn.execute("BEGIN IMMEDIATE")
        except Exception:
            RT.db_lock.release()
            raise
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.execute("COMMIT")
                if self.bump:
                    RT.bump()
            else:
                try:
                    self.conn.execute("ROLLBACK")
                except Exception:
                    pass
        finally:
            self.conn.close()
            RT.db_lock.release()
        return False


def meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_set(conn, key, value):
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))


def audit(conn, event, detail="", user=None, username="", ip=""):
    conn.execute(
        "INSERT INTO audit (at, user_id, username, ip, event, detail) VALUES (?,?,?,?,?,?)",
        (now_iso(), user["id"] if user else None,
         user["username"] if user else username, ip or "", event, detail[:500]))


class DatabaseTooNew(Exception):
    """The database was last written by a newer InSys than this one."""


def stored_schema_version():
    """Layout version of the existing database; None if there is no database yet."""
    if not os.path.exists(RT.db_path):
        return None
    conn = connect()
    try:
        has_meta = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").fetchone()
        if not has_meta:
            return None
        value = meta_get(conn, "schema_version")
    finally:
        conn.close()
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def backup_before_upgrade(from_version):
    """A copy of the database exactly as the older version left it. These files
    are never deleted automatically."""
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(RT.backup_dir, "before-upgrade-from-v%d-%s.db" % (from_version, stamp))
    tmp = dest + ".tmp"
    make_backup(tmp)
    os.replace(tmp, dest)
    return dest


def apply_schema(conn, existing):
    """Bring the open database to the current layout. Every table is created
    only if it is missing and every column added only if it is missing, so this
    both builds a new database and upgrades an older one. Nothing that already
    exists is altered or removed."""
    for statement in SCHEMA.split(";"):
        if statement.strip():
            conn.execute(statement)
    for table, column, declaration in ADDED_COLUMNS:
        present = [row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)]
        if column not in present:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, declaration))
    if meta_get(conn, "schema_version") is None:
        meta_set(conn, "schema_version", SCHEMA_VERSION)
        if meta_get(conn, "org_name") is None:
            meta_set(conn, "org_name", "")
        if meta_get(conn, "currency") is None:
            meta_set(conn, "currency", "")
    elif existing is not None and existing < SCHEMA_VERSION:
        meta_set(conn, "schema_version", SCHEMA_VERSION)
    if existing is not None and existing < 4 and \
            conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"] == 0:
        # Data from before the updates feed existed: start the feed with the most
        # recent history so the bell is not empty. Nobody is shown these as new.
        recent = conn.execute("SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 59").fetchone()
        conn.execute("INSERT INTO events (at, actor_id, scope, kind, text, record_id) "
                     "SELECT at, user_id, 'record', kind, text, record_id FROM activity "
                     "WHERE id >= ? ORDER BY id", (recent["id"] if recent else 0,))


def init_db():
    """Create the schema, upgrade an older database, and on the very first run
    create the administrator account.

    Returns the administrator's initial password if one was just created.
    Sets RT.upgraded_from / RT.upgrade_backup when an older database was upgraded.
    """
    os.makedirs(RT.data_dir, exist_ok=True)
    os.makedirs(RT.backup_dir, exist_ok=True)
    existing = stored_schema_version()
    if existing is not None and existing > SCHEMA_VERSION:
        raise DatabaseTooNew(existing)
    if existing is not None and existing < SCHEMA_VERSION:
        RT.upgrade_backup = backup_before_upgrade(existing)
        RT.upgraded_from = existing
    created_password = None
    with write_db(bump=False) as conn:
        apply_schema(conn, existing)
        if existing is not None and existing < SCHEMA_VERSION:
            audit(conn, "upgraded", "Data upgraded from layout v%d to v%d by InSys %s; "
                                    "a copy from before the upgrade was kept in the backups folder"
                  % (existing, SCHEMA_VERSION, VERSION))
        if conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0:
            created_password = generate_password(groups=4)
            conn.execute(
                "INSERT INTO users (username, full_name, role, pw_hash, must_change, active, created_at) "
                "VALUES (?,?,?,?,1,1,?)",
                ("admin", "Administrator", "admin", hash_password(created_password), now_iso()))
            audit(conn, "setup", "Administrator account created on first run")
    if created_password:
        write_first_login_file("admin", created_password)
    return created_password


def write_first_login_file(username, password):
    text = (
        "InSys - Internal Systems\r\n"
        "========================\r\n\r\n"
        "Administrator sign-in for first use\r\n\r\n"
        "    Username: %s\r\n"
        "    Password: %s\r\n\r\n"
        "You will be asked to choose your own password the first time you sign in.\r\n"
        "This file is deleted automatically once you have done that.\r\n"
        "Keep it private until then.\r\n" % (username, password))
    try:
        with open(RT.first_login_file, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    except OSError as exc:
        log_error("Could not write first-login file: %s" % exc)


def read_first_login():
    """(username, password) from the first-login file, or None."""
    try:
        with open(RT.first_login_file, "r", encoding="utf-8") as fh:
            content = fh.read()
    except OSError:
        return None
    user = re.search(r"Username:\s*(\S+)", content)
    pw = re.search(r"Password:\s*(\S+)", content)
    if user and pw:
        return user.group(1), pw.group(1)
    return None


def remove_first_login_file():
    try:
        os.remove(RT.first_login_file)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------

def make_backup(dest_path):
    """Consistent copy of the live database, with sign-in sessions removed."""
    src = connect()
    try:
        dst = sqlite3.connect(dest_path)
        try:
            src.backup(dst)
            dst.execute("DELETE FROM sessions")
            dst.commit()
            dst.execute("VACUUM")
        finally:
            dst.close()
    finally:
        src.close()


def latest_backup_age():
    try:
        files = [os.path.join(RT.backup_dir, f) for f in os.listdir(RT.backup_dir)
                 if f.startswith("insys-") and f.endswith(".db")]
    except OSError:
        return None
    if not files:
        return None
    return time.time() - max(os.path.getmtime(f) for f in files)


def auto_backup(force=False):
    """Keep a rolling set of automatic backups in data/backups."""
    try:
        if not os.path.exists(RT.db_path):
            return None
        age = latest_backup_age()
        if not force and age is not None and age < BACKUP_EVERY_SECONDS:
            return None
        os.makedirs(RT.backup_dir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(RT.backup_dir, "insys-%s.db" % stamp)
        tmp = dest + ".tmp"
        make_backup(tmp)
        os.replace(tmp, dest)
        files = sorted(f for f in os.listdir(RT.backup_dir)
                       if f.startswith("insys-") and f.endswith(".db"))
        for old in files[:-BACKUP_KEEP]:
            try:
                os.remove(os.path.join(RT.backup_dir, old))
            except OSError:
                pass
        return dest
    except Exception:
        log_error("Automatic backup failed:\n" + traceback.format_exc())
        return None


def backup_loop():
    while True:
        time.sleep(3600)
        auto_backup()


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

def can_view(user, module):
    team = MODULES[module]["team"]
    return team is None or user["role"] in ALL_SECTION_ROLES or user["role"] == team


def visible_modules(user):
    return [m for m in MODULES if can_view(user, m)]


def user_json(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "full_name": row["full_name"],
        "role": row["role"],
        "active": bool(row["active"]),
        "must_change": bool(row["must_change"]),
    }


def get_record(conn, record_id, user, deleted=False):
    """Fetch a record the user may see, or raise 404 (never reveals restricted rows).
    Deleted records are only found when asked for with deleted=True."""
    row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if row is None or not can_view(user, row["module"]) or bool(row["deleted_at"]) != deleted:
        raise ApiError(404, "That record no longer exists or you do not have access to it.")
    return row


def check_version(body, row, what="record"):
    version = body.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise ApiError(400, "Missing version.")
    if version != row["version"]:
        raise ApiError(409, "Someone else changed this %s while you had it open. Close this "
                            "window, check the latest details, and make your change again."
                       % what, code="conflict")


EVENTS_KEPT = 5000


def add_event(conn, user, scope, kind, text, record_id=None, task_id=None, subcon_id=None):
    """Add to the updates feed that drives other people's banners and bell.
    scope says who may see it: 'record' (people who can open that record's
    section, plus the people a task on it belongs to), 'task' (the people the
    task belongs to), 'subcons' (everyone) or 'admin' (administrators)."""
    cur = conn.execute(
        "INSERT INTO events (at, actor_id, scope, kind, text, record_id, task_id, subcon_id) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (now_iso(), user["id"] if user else None, scope, kind, text[:500], record_id, task_id, subcon_id))
    if cur.lastrowid % 500 == 0:
        conn.execute("DELETE FROM events WHERE id <= ?", (cur.lastrowid - EVENTS_KEPT,))


def add_activity(conn, record_id, user, kind, text, action_date=None, task_id=None):
    """Write to a record's history, and tell other people about it."""
    conn.execute(
        "INSERT INTO activity (record_id, user_id, at, kind, text, action_date) VALUES (?,?,?,?,?,?)",
        (record_id, user["id"], now_iso(), kind, text, action_date))
    add_event(conn, user, "record", kind, text, record_id=record_id, task_id=task_id)


def user_name(conn, user_id):
    if user_id is None:
        return "Unassigned"
    row = conn.execute("SELECT full_name FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["full_name"] if row else "Unknown"


def next_ref(conn, module):
    key = "seq_" + module
    number = int(meta_get(conn, key, "0")) + 1
    meta_set(conn, key, number)
    return "%s-%04d" % (MODULES[module]["prefix"], number)


# ---------------------------------------------------------------------------
# Record field handling
# ---------------------------------------------------------------------------

RECORD_FIELDS = ["number", "title", "organisation", "contact_name", "contact_info", "category",
                 "status", "priority", "owner_id", "amount", "start_date", "due_date",
                 "description", "next_action", "next_action_date"]


def check_number_free(conn, module, number, own_id=None):
    """A tracking number may be used by only one live item in its section."""
    row = conn.execute(
        "SELECT id, ref, title FROM records WHERE module = ? AND deleted_at IS NULL "
        "AND number = ? COLLATE NOCASE AND id != ?", (module, number, own_id or 0)).fetchone()
    if row is not None:
        raise ApiError(400, "%s '%s' is already used by %s (%s)."
                       % (MODULES[module]["number_label"], number, row["ref"], row["title"]))


def parse_record_fields(conn, body, module, existing=None):
    """Validate the record fields present in body. Returns {column: value}."""
    cfg = MODULES[module]
    statuses = [s[0] for s in cfg["statuses"]]
    creating = existing is None
    out = {}

    def present(key):
        return creating or key in body

    if cfg["numbered"] and present("number"):
        # The user's own tracking number, shown in place of the system reference.
        # Optional; where given it must identify one item in its section.
        number = text_field(body, "number", cfg["number_label"], 60)
        if number:
            check_number_free(conn, module, number, existing["id"] if existing is not None else None)
        out["number"] = number
    if present("title"):
        out["title"] = text_field(body, "title", "Title", 200, required=True)
    if present("organisation"):
        out["organisation"] = text_field(body, "organisation", cfg["org_label"], 200)
    if present("contact_name"):
        out["contact_name"] = text_field(body, "contact_name", "Contact name", 200)
    if present("contact_info"):
        out["contact_info"] = text_field(body, "contact_info", "Contact details", 200)
    if present("category"):
        category = text_field(body, "category", cfg["category_label"], 80)
        if category and category not in cfg["categories"] and \
                not (existing is not None and existing["category"] == category):
            raise ApiError(400, "%s is not a valid choice." % cfg["category_label"])
        out["category"] = category
    if present("status"):
        out["status"] = choice_field(body, "status", "Status", statuses, default=statuses[0])
    if present("priority"):
        out["priority"] = choice_field(body, "priority", "Priority", PRIORITIES, default="Normal")
    if present("owner_id"):
        owner_id = int_field(body, "owner_id", "Owner")
        if owner_id is not None and not (existing is not None and existing["owner_id"] == owner_id):
            owner = conn.execute("SELECT * FROM users WHERE id = ?", (owner_id,)).fetchone()
            if owner is None or not owner["active"]:
                raise ApiError(400, "The selected owner is not an active user.")
            if not can_view(owner, module):
                raise ApiError(400, "%s does not have access to %s, so cannot own this item."
                               % (owner["full_name"], cfg["label"]))
        out["owner_id"] = owner_id
    if present("amount"):
        out["amount"] = amount_field(body, "amount", cfg["amount_label"])
    if present("start_date"):
        out["start_date"] = date_field(body, "start_date", cfg["start_label"])
    if present("due_date"):
        out["due_date"] = date_field(body, "due_date", cfg["due_label"])
    if present("description"):
        out["description"] = text_field(body, "description", "Description", 10000, multiline=True)
    if present("next_action"):
        out["next_action"] = text_field(body, "next_action", "Next action", 500)
    if present("next_action_date"):
        out["next_action_date"] = date_field(body, "next_action_date", "Next action due date")
    return out


def describe_changes(conn, module, old, new):
    cfg = MODULES[module]
    labels = {
        "number": cfg["number_label"] or "Number",
        "title": "Title", "organisation": cfg["org_label"], "contact_name": "Contact name",
        "contact_info": "Contact details", "category": cfg["category_label"],
        "status": "Status", "priority": "Priority", "owner_id": "Owner",
        "amount": cfg["amount_label"], "start_date": cfg["start_label"],
        "due_date": cfg["due_label"], "description": "Description",
        "next_action": "Next action", "next_action_date": "Next action due",
    }
    parts = []
    for key in RECORD_FIELDS:
        if key not in new or new[key] == old[key]:
            continue
        if key == "description":
            parts.append("Description updated")
            continue
        if key == "owner_id":
            before, after = user_name(conn, old[key]), user_name(conn, new[key])
        elif key == "amount":
            before, after = fmt_amount(old[key]), fmt_amount(new[key])
        else:
            before, after = old[key] or "-", new[key] or "-"
        parts.append("%s: %s \u2192 %s" % (labels[key], before, after))
    return parts


# ---------------------------------------------------------------------------
# API handlers. Each takes a Ctx and returns a JSON-serialisable dict.
# ---------------------------------------------------------------------------

class Ctx:
    def __init__(self, handler, user, session, body, query, match):
        self.handler = handler
        self.user = user
        self.session = session
        self.body = body
        self.query = query
        self.match = match
        self.ip = handler.client_ip()

    def arg(self, index=1):
        return int(self.match.group(index))


def module_meta():
    out = {}
    for key, cfg in MODULES.items():
        out[key] = dict(cfg)
        out[key]["key"] = key
    return out


def h_ping(ctx):
    return {"app": "insys", "instance": RT.instance, "version": VERSION}


def h_login(ctx):
    username = text_field(ctx.body, "username", "Username", 64, required=True).lower()
    password = ctx.body.get("password")
    if not isinstance(password, str) or not password or len(password) > 500:
        raise ApiError(400, "Password is required.")
    ip = ctx.ip
    pair = username + "|" + ip
    wait = max(LIMIT_PAIR.wait_seconds(pair), LIMIT_USER.wait_seconds(username),
               LIMIT_IP.wait_seconds(ip))
    if wait:
        raise ApiError(429, "Too many sign-in attempts. Please wait %d minute(s) and try again."
                       % max(1, (wait + 59) // 60))
    with read_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    password_ok = verify_password(password, row["pw_hash"] if row else DUMMY_HASH)
    if not (row and password_ok and row["active"]):
        LIMIT_PAIR.fail(pair)
        LIMIT_USER.fail(username)
        LIMIT_IP.fail(ip)
        reason = "unknown user" if not row else ("wrong password" if not password_ok
                                                 else "account deactivated")
        with write_db(bump=False) as conn:
            audit(conn, "login_failed", reason, username=username, ip=ip)
        raise ApiError(401, "Incorrect username or password.")
    LIMIT_PAIR.clear(pair)
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    now = time.time()
    with write_db(bump=False) as conn:
        conn.execute("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?",
                     (now - SESSION_IDLE_SECONDS, now - SESSION_MAX_SECONDS))
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen) VALUES (?,?,?,?,?)",
            (session_hash(token, ctx.handler.channel()), row["id"], csrf, now, now))
        conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_iso(), row["id"]))
        audit(conn, "login_ok", "", user=row, ip=ip)
    ctx.handler.set_session_cookie(token)
    return {"user": user_json(row), "csrf": csrf}


def h_logout(ctx):
    if ctx.session is not None:
        with write_db(bump=False) as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (ctx.session["token_hash"],))
    ctx.handler.clear_session_cookie()
    return {"ok": True}


def h_me(ctx):
    return {"user": user_json(ctx.user), "csrf": ctx.session["csrf"]}


def h_change_password(ctx):
    current = ctx.body.get("current")
    new = ctx.body.get("new")
    if not isinstance(current, str) or not verify_password(current, ctx.user["pw_hash"]):
        raise ApiError(400, "Your current password is not correct.")
    check_password_policy(new, ctx.user["username"])
    if new == current:
        raise ApiError(400, "Your new password must be different from the current one.")
    with write_db() as conn:
        conn.execute("UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?",
                     (hash_password(new), ctx.user["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                     (ctx.user["id"], ctx.session["token_hash"]))
        audit(conn, "password_changed", "", user=ctx.user, ip=ctx.ip)
    first = read_first_login()
    if first and first[0].lower() == ctx.user["username"].lower():
        remove_first_login_file()
    return {"ok": True}


def h_version(ctx):
    return {"version": RT.version()}


def h_state(ctx):
    user = ctx.user
    version = RT.version()
    mods = visible_modules(user)
    with read_db() as conn:
        users = [{"id": r["id"], "username": r["username"], "full_name": r["full_name"],
                  "role": r["role"], "active": bool(r["active"])}
                 for r in conn.execute("SELECT * FROM users ORDER BY full_name COLLATE NOCASE")]
        all_refs = {r["id"]: (r["ref"], r["module"])
                    for r in conn.execute("SELECT id, ref, module FROM records WHERE deleted_at IS NULL")}
        marks = ",".join("?" * len(mods))
        records = [dict(r) for r in conn.execute(
            "SELECT * FROM records WHERE module IN (%s) AND deleted_at IS NULL ORDER BY id" % marks, mods)]
        visible_ids = set(r["id"] for r in records)
        xrefs = {}
        for x in conn.execute("SELECT id, record_id, system, ref, url FROM xrefs ORDER BY id"):
            if x["record_id"] in visible_ids:
                xrefs.setdefault(x["record_id"], []).append(
                    {"id": x["id"], "system": x["system"], "ref": x["ref"], "url": x["url"]})
        for r in records:
            r["xrefs"] = xrefs.get(r["id"], [])
        stubs = {}

        def stub(record_id):
            if record_id not in visible_ids and record_id in all_refs:
                ref, module = all_refs[record_id]
                stubs[str(record_id)] = {"id": record_id, "ref": ref, "module": module}

        links = []
        for link in conn.execute("SELECT a_id, b_id FROM links ORDER BY a_id, b_id"):
            a, b = link["a_id"], link["b_id"]
            if (a in visible_ids or b in visible_ids) and a in all_refs and b in all_refs:
                links.append([a, b])
                stub(a)
                stub(b)
        tasks = []
        for t in conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY id"):
            mine = t["assignee_id"] == user["id"] or t["created_by"] == user["id"]
            on_visible = t["record_id"] is not None and t["record_id"] in visible_ids
            if user["role"] == "admin" or mine or on_visible:
                task = dict(t)
                if task["record_id"] is not None and task["record_id"] not in all_refs:
                    task["record_id"] = None  # its record has been deleted
                tasks.append(task)
                if task["record_id"] is not None:
                    stub(task["record_id"])
        subcons = [subcon_json(r) for r in
                   conn.execute("SELECT * FROM subcons ORDER BY name COLLATE NOCASE")]
        record_subcons = [{"record_id": r["record_id"], "subcon_id": r["subcon_id"], "scope": r["scope"],
                           "last_update": r["last_update"], "last_update_date": r["last_update_date"],
                           "next_action": r["next_action"], "next_action_date": r["next_action_date"]}
                          for r in conn.execute("SELECT * FROM record_subcons "
                                                "ORDER BY rowid")  # the order they were added in
                          if r["record_id"] in visible_ids]
        org_name = meta_get(conn, "org_name", "")
        currency = meta_get(conn, "currency", "")
    return {
        "version": version,
        "me": user_json(user),
        "users": users,
        "records": records,
        "links": links,
        "restricted": stubs,
        "tasks": tasks,
        "subcons": subcons,
        "record_subcons": record_subcons,
        "meta": {
            "app_version": VERSION,
            "modules": module_meta(),
            "visible_modules": mods,
            "roles": ROLES,
            "role_access": ROLE_ACCESS,
            "all_section_roles": list(ALL_SECTION_ROLES),
            "priorities": PRIORITIES,
            "task_statuses": TASK_STATUSES,
            "subcon_modules": list(SUBCON_MODULES),
            "org_name": org_name,
            "currency": currency,
            "min_password_length": MIN_PASSWORD_LENGTH,
        },
    }


def h_activity(ctx):
    mods = visible_modules(ctx.user)
    marks = ",".join("?" * len(mods))
    with read_db() as conn:
        rows = conn.execute(
            "SELECT a.id, a.at, a.user_id, a.kind, a.text, a.action_date, "
            "r.id AS record_id, r.ref, r.number, r.title, r.module "
            "FROM activity a JOIN records r ON r.id = a.record_id "
            "WHERE r.module IN (%s) AND r.deleted_at IS NULL ORDER BY a.id DESC LIMIT 40" % marks,
            mods).fetchall()
    return {"activity": [dict(r) for r in rows]}


EVENT_WINDOW = 400   # how far back the feed looks
EVENT_LIST = 50      # how many updates the bell shows


def visible_events(conn, user):
    """Recent updates this user is allowed to know about, newest first. Each is
    (row, show_record): show_record is False when the user may know about a
    task but not about the record it is attached to."""
    rows = conn.execute(
        "SELECT e.*, r.ref AS r_ref, r.number AS r_number, r.title AS r_title, r.module AS r_module, "
        "r.deleted_at AS r_deleted, "
        "t.assignee_id AS t_assignee, t.created_by AS t_creator, s.ref AS s_ref, s.name AS s_name "
        "FROM events e LEFT JOIN records r ON r.id = e.record_id LEFT JOIN tasks t ON t.id = e.task_id "
        "LEFT JOIN subcons s ON s.id = e.subcon_id ORDER BY e.id DESC LIMIT ?", (EVENT_WINDOW,)).fetchall()
    out = []
    for e in rows:
        own_task = e["task_id"] is not None and user["id"] in (e["t_assignee"], e["t_creator"])
        if e["scope"] == "admin":
            if user["role"] == "admin":
                out.append((e, False))
        elif e["scope"] == "subcons":
            out.append((e, False))
        elif e["scope"] == "task":
            if user["role"] == "admin" or own_task:
                out.append((e, False))
        elif e["scope"] == "record" and e["r_module"] in MODULES:
            if can_view(user, e["r_module"]):
                out.append((e, True))
            elif own_task:
                out.append((e, False))
    return out


def seen_event_id(conn, user):
    row = conn.execute("SELECT last_id FROM event_seen WHERE user_id = ?", (user["id"],)).fetchone()
    return row["last_id"] if row else None


def h_events(ctx):
    """Updates made by other people, for the banners and the bell."""
    user = ctx.user
    with read_db() as conn:
        last_id = conn.execute("SELECT COALESCE(MAX(id), 0) AS n FROM events").fetchone()["n"]
        seen = seen_event_id(conn, user)
        visible = [(e, show) for e, show in visible_events(conn, user) if e["actor_id"] != user["id"]]
    if seen is None:
        # First look: nothing that happened before now counts as unread.
        seen = last_id
        with write_db(bump=False) as conn:
            conn.execute("INSERT OR IGNORE INTO event_seen (user_id, last_id) VALUES (?, ?)",
                         (user["id"], last_id))
    events = []
    for e, show_record in visible[:EVENT_LIST]:
        item = {"id": e["id"], "at": e["at"], "actor_id": e["actor_id"], "scope": e["scope"],
                "kind": e["kind"], "text": e["text"], "unread": e["id"] > seen,
                "record": None, "subcon": None, "task": e["task_id"] is not None}
        if show_record:
            item["record"] = {"id": e["record_id"], "ref": e["r_ref"], "number": e["r_number"],
                              "title": e["r_title"], "module": e["r_module"], "deleted": bool(e["r_deleted"])}
        if e["scope"] == "subcons" and e["s_ref"]:
            item["subcon"] = {"ref": e["s_ref"], "name": e["s_name"]}
        events.append(item)
    return {"events": events, "last_id": last_id,
            "unread": len([1 for e, _ in visible if e["id"] > seen])}


def h_events_seen(ctx):
    """The bell has been opened: everything up to last_id has been seen."""
    last_id = int_field(ctx.body, "last_id", "Last update", required=True)
    with write_db(bump=False) as conn:
        newest = conn.execute("SELECT COALESCE(MAX(id), 0) AS n FROM events").fetchone()["n"]
        last_id = min(last_id, newest)
        conn.execute("INSERT INTO event_seen (user_id, last_id) VALUES (?, ?) "
                     "ON CONFLICT(user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)",
                     (ctx.user["id"], last_id))
    return {"ok": True}


LOG_LIMIT = 500
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def h_log(ctx):
    """The activity log: everything that has been done, catalogued by month,
    including work on items that have since been completed or deleted."""
    def param(name, default):
        return (ctx.query.get(name, [default])[0] or default).strip()

    q = param("q", "").lower()[:200]
    kind = param("kind", "actions")
    scope = param("scope", "all")
    month = param("month", "")
    if kind not in ("actions", "tasks", "all") or scope not in ("all", "open", "closed", "deleted") \
            or not (month in ("", "all") or MONTH_RE.match(month)):
        raise ApiError(400, "That filter is not valid.")
    user = ctx.user
    mods = visible_modules(user)
    closed = {key: set(s[0] for s in cfg["statuses"] if s[1] in ("done", "dead"))
              for key, cfg in MODULES.items()}
    marks = ",".join("?" * len(mods))
    with read_db() as conn:
        names = {r["id"]: r["full_name"] for r in conn.execute("SELECT id, full_name FROM users")}
        rows = conn.execute(
            "SELECT a.id, a.at, a.user_id, a.kind, a.text, a.action_date, r.id AS record_id, r.ref, "
            "r.number, r.title, r.module, r.status, r.deleted_at FROM activity a JOIN records r "
            "ON r.id = a.record_id WHERE r.module IN (%s)" % marks, mods).fetchall()
        loose_tasks = conn.execute(
            "SELECT * FROM tasks WHERE record_id IS NULL "
            "AND (completed_at IS NOT NULL OR deleted_at IS NOT NULL)").fetchall()

    entries = []
    for r in rows:
        state = "deleted" if r["deleted_at"] else ("closed" if r["status"] in closed[r["module"]] else "open")
        day = r["action_date"] if (r["kind"] == "action" and r["action_date"]) else r["at"][:10]
        entries.append({
            "id": "a%d" % r["id"], "day": day, "at": r["at"], "user_id": r["user_id"], "kind": r["kind"],
            "text": r["text"], "state": state,
            "record": {"id": r["record_id"], "ref": r["ref"], "number": r["number"], "title": r["title"],
                       "module": r["module"], "status": r["status"]}})
    # Tasks that are not attached to a record have no record history to appear in.
    for t in loose_tasks:
        if not (user["role"] == "admin" or user["id"] in (t["assignee_id"], t["created_by"])):
            continue
        state = "deleted" if t["deleted_at"] else "closed"
        if t["completed_at"]:
            entries.append({"id": "t%dc" % t["id"], "day": t["completed_at"][:10], "at": t["completed_at"],
                            "user_id": t["assignee_id"], "kind": "task", "state": state, "record": None,
                            "text": "Task completed: %s" % t["title"]})
        if t["deleted_at"]:
            entries.append({"id": "t%dd" % t["id"], "day": t["deleted_at"][:10], "at": t["deleted_at"],
                            "user_id": t["deleted_by"], "kind": "task", "state": state, "record": None,
                            "text": "Task deleted: %s" % t["title"]})

    def wanted(entry):
        if kind == "actions" and entry["kind"] != "action":
            return False
        if kind == "tasks" and entry["kind"] != "task":
            return False
        if scope != "all" and entry["state"] != scope:
            return False
        if q:
            record = entry["record"]
            hay = " ".join([entry["text"], names.get(entry["user_id"], ""),
                            record["ref"] if record else "", record["number"] if record else "",
                            record["title"] if record else "",
                            MODULES[record["module"]]["singular"] if record else "Task"]).lower()
            if q not in hay:
                return False
        return True

    entries = [e for e in entries if wanted(e)]
    counts = {}
    for entry in entries:
        counts[entry["day"][:7]] = counts.get(entry["day"][:7], 0) + 1
    months = [{"month": m, "count": counts[m]} for m in sorted(counts, reverse=True)]
    if month == "":
        month = "all" if (q or not months) else months[0]["month"]
    if month != "all":
        entries = [e for e in entries if e["day"][:7] == month]
    entries.sort(key=lambda e: (e["day"], e["at"], e["id"]), reverse=True)
    return {"months": months, "month": month, "total": len(entries),
            "truncated": len(entries) > LOG_LIMIT, "entries": entries[:LOG_LIMIT]}


def h_record_create(ctx):
    module = ctx.body.get("module")
    if module not in MODULES or not can_view(ctx.user, module):
        raise ApiError(403, "You do not have access to that section.")
    last_action = text_field(ctx.body, "last_action", "Last action", 500)
    last_action_date = date_field(ctx.body, "last_action_date", "Last action date")
    if last_action and not last_action_date:
        raise ApiError(400, "Please give the date of the last action.")
    if not last_action:
        last_action_date = None
    with write_db() as conn:
        fields = parse_record_fields(conn, ctx.body, module)
        ref = next_ref(conn, module)
        now = now_iso()
        columns = ["module", "ref", "last_action", "last_action_date", "last_action_by",
                   "created_by", "created_at", "updated_by", "updated_at"] + list(fields)
        values = [module, ref, last_action, last_action_date,
                  ctx.user["id"] if last_action else None,
                  ctx.user["id"], now, ctx.user["id"], now] + list(fields.values())
        cur = conn.execute("INSERT INTO records (%s) VALUES (%s)"
                           % (",".join(columns), ",".join("?" * len(columns))), values)
        record_id = cur.lastrowid
        add_activity(conn, record_id, ctx.user, "created",
                     "%s created with status %s" % (MODULES[module]["singular"], fields["status"]))
        if last_action:
            add_activity(conn, record_id, ctx.user, "action", last_action, last_action_date)
        row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
        return {"record": dict(row)}


def h_record_update(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        check_version(ctx.body, row)
        fields = parse_record_fields(conn, ctx.body, row["module"], existing=row)
        changes = describe_changes(conn, row["module"], row, fields)
        if changes:
            sets = ", ".join("%s = ?" % k for k in fields)
            conn.execute(
                "UPDATE records SET %s, updated_by = ?, updated_at = ?, version = version + 1 "
                "WHERE id = ?" % sets,
                list(fields.values()) + [ctx.user["id"], now_iso(), row["id"]])
            add_activity(conn, row["id"], ctx.user, "updated", "; ".join(changes))
        row = conn.execute("SELECT * FROM records WHERE id = ?", (row["id"],)).fetchone()
        return {"record": dict(row), "changed": bool(changes)}


def h_record_delete(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        # The record leaves every list but is kept, with its whole history, so it
        # can be looked up in the activity log and restored if it was a mistake.
        conn.execute("UPDATE records SET deleted_at = ?, deleted_by = ? WHERE id = ?",
                     (now_iso(), ctx.user["id"], row["id"]))
        add_activity(conn, row["id"], ctx.user, "deleted",
                     "%s deleted (status was %s)" % (MODULES[row["module"]]["singular"], row["status"]))
        audit(conn, "record_deleted", "%s %s" % (row["ref"], row["title"]),
              user=ctx.user, ip=ctx.ip)
    return {"ok": True}


def h_record_restore(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user, deleted=True)
        if row["number"]:
            # Its number may have been given to another item while it was deleted.
            check_number_free(conn, row["module"], row["number"], row["id"])
        conn.execute("UPDATE records SET deleted_at = NULL, deleted_by = NULL, version = version + 1 "
                     "WHERE id = ?", (row["id"],))
        add_activity(conn, row["id"], ctx.user, "restored",
                     "%s restored from the deleted items" % MODULES[row["module"]]["singular"])
        audit(conn, "record_restored", "%s %s" % (row["ref"], row["title"]), user=ctx.user, ip=ctx.ip)
    return {"ok": True, "ref": row["ref"], "module": row["module"]}


def h_record_action(ctx):
    """Log an action taken: becomes the record's last known action."""
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        check_version(ctx.body, row)
        cfg = MODULES[row["module"]]
        text = text_field(ctx.body, "text", "Action taken", 500, required=True)
        action_date = date_field(ctx.body, "date", "Date", required=True)
        sets, values, notes = [], [], []
        if not row["last_action_date"] or action_date >= row["last_action_date"]:
            sets += ["last_action = ?", "last_action_date = ?", "last_action_by = ?"]
            values += [text, action_date, ctx.user["id"]]
        if ctx.body.get("status"):
            status = choice_field(ctx.body, "status", "Status", [s[0] for s in cfg["statuses"]])
            if status != row["status"]:
                sets.append("status = ?")
                values.append(status)
                notes.append("Status: %s \u2192 %s" % (row["status"], status))
        if "next_action" in ctx.body:
            next_action = text_field(ctx.body, "next_action", "Next action", 500)
            if next_action != row["next_action"]:
                sets.append("next_action = ?")
                values.append(next_action)
                notes.append("Next action: %s" % (next_action or "-"))
        if "next_action_date" in ctx.body:
            next_date = date_field(ctx.body, "next_action_date", "Next action due date")
            if next_date != row["next_action_date"]:
                sets.append("next_action_date = ?")
                values.append(next_date)
                notes.append("Next action due: %s" % (next_date or "-"))
        sets += ["updated_by = ?", "updated_at = ?", "version = version + 1"]
        values += [ctx.user["id"], now_iso(), row["id"]]
        conn.execute("UPDATE records SET %s WHERE id = ?" % ", ".join(sets), values)
        full_text = text if not notes else "%s  [%s]" % (text, "; ".join(notes))
        add_activity(conn, row["id"], ctx.user, "action", full_text, action_date)
        row = conn.execute("SELECT * FROM records WHERE id = ?", (row["id"],)).fetchone()
        return {"record": dict(row)}


def h_record_note(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        text = text_field(ctx.body, "text", "Note", 4000, required=True, multiline=True)
        add_activity(conn, row["id"], ctx.user, "note", text)
    return {"ok": True}


def h_record_history(ctx):
    with read_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        rows = conn.execute(
            "SELECT id, at, user_id, kind, text, action_date FROM activity "
            "WHERE record_id = ? ORDER BY id DESC LIMIT 500", (row["id"],)).fetchall()
    return {"history": [dict(r) for r in rows]}


def h_link_create(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        target_id = int_field(ctx.body, "target_id", "Record to link", required=True)
        target = get_record(conn, target_id, ctx.user)
        if target["id"] == row["id"]:
            raise ApiError(400, "A record cannot be linked to itself.")
        a, b = sorted((row["id"], target["id"]))
        if conn.execute("SELECT 1 FROM links WHERE a_id = ? AND b_id = ?", (a, b)).fetchone():
            raise ApiError(400, "%s and %s are already linked." % (row["ref"], target["ref"]))
        conn.execute("INSERT INTO links (a_id, b_id, created_by, created_at) VALUES (?,?,?,?)",
                     (a, b, ctx.user["id"], now_iso()))
        add_activity(conn, row["id"], ctx.user, "link", "Linked to %s" % target["ref"])
        add_activity(conn, target["id"], ctx.user, "link", "Linked to %s" % row["ref"])
    return {"ok": True}


def h_link_delete(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(1), ctx.user)
        target = get_record(conn, ctx.arg(2), ctx.user)
        a, b = sorted((row["id"], target["id"]))
        cur = conn.execute("DELETE FROM links WHERE a_id = ? AND b_id = ?", (a, b))
        if cur.rowcount:
            add_activity(conn, row["id"], ctx.user, "link", "Link to %s removed" % target["ref"])
            add_activity(conn, target["id"], ctx.user, "link", "Link to %s removed" % row["ref"])
    return {"ok": True}


def h_xref_create(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(), ctx.user)
        system = text_field(ctx.body, "system", "System name", 60, required=True)
        ref = text_field(ctx.body, "ref", "Reference", 120, required=True)
        url = text_field(ctx.body, "url", "Link", 500)
        if url and not re.match(r"^https?://[^\s]+$", url, re.I):
            raise ApiError(400, "Link must start with http:// or https://")
        conn.execute(
            "INSERT INTO xrefs (record_id, system, ref, url, created_by, created_at) VALUES (?,?,?,?,?,?)",
            (row["id"], system, ref, url, ctx.user["id"], now_iso()))
        add_activity(conn, row["id"], ctx.user, "xref",
                     "External reference added: %s %s" % (system, ref))
    return {"ok": True}


def h_xref_delete(ctx):
    with write_db() as conn:
        row = get_record(conn, ctx.arg(1), ctx.user)
        xref = conn.execute("SELECT * FROM xrefs WHERE id = ? AND record_id = ?",
                            (ctx.arg(2), row["id"])).fetchone()
        if xref:
            conn.execute("DELETE FROM xrefs WHERE id = ?", (xref["id"],))
            add_activity(conn, row["id"], ctx.user, "xref",
                         "External reference removed: %s %s" % (xref["system"], xref["ref"]))
    return {"ok": True}


# ---- Subcontractors ----------------------------------------------------------

SUBCON_FIELDS = ["name", "discipline", "capabilities", "services", "contact_name", "email", "phone",
                 "address", "website", "registration", "notes", "active"]


def parse_subcon_fields(body, existing=None):
    creating = existing is None
    out = {}

    def present(key):
        return creating or key in body

    if present("name"):
        out["name"] = text_field(body, "name", "Subcontractor name", 150, required=True)
    if present("discipline"):
        out["discipline"] = text_field(body, "discipline", "Discipline", 100)
    if present("capabilities"):
        # Kept as a tidy comma-separated list: "Seismic assessment, HAZOP, Wind study".
        raw = text_field(body, "capabilities", "Capabilities", 1500, multiline=True)
        seen, items = set(), []
        for part in re.split(r"[,;\n]+", raw):
            item = " ".join(part.split())
            if item and item.lower() not in seen:
                seen.add(item.lower())
                items.append(item)
        out["capabilities"] = ", ".join(items)
    if present("services"):
        out["services"] = text_field(body, "services", "Services", 2000, multiline=True)
    if present("contact_name"):
        out["contact_name"] = text_field(body, "contact_name", "Contact person", 150)
    if present("email"):
        email = text_field(body, "email", "Email", 200)
        if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            raise ApiError(400, "Email does not look like an email address.")
        out["email"] = email
    if present("phone"):
        out["phone"] = text_field(body, "phone", "Phone", 60)
    if present("address"):
        out["address"] = text_field(body, "address", "Address", 500, multiline=True)
    if present("website"):
        website = text_field(body, "website", "Website", 300)
        if website and not re.match(r"^https?://", website, re.I):
            website = "https://" + website
        if website and not re.match(r"^https?://[^\s/]+\.[^\s]+$", website, re.I):
            raise ApiError(400, "Website does not look like a web address.")
        out["website"] = website
    if present("registration"):
        out["registration"] = text_field(body, "registration", "Registration / licence number", 100)
    if present("notes"):
        out["notes"] = text_field(body, "notes", "Notes", 5000, multiline=True)
    if present("active"):
        active = body.get("active", True)
        if not isinstance(active, bool):
            raise ApiError(400, "Status must be active or inactive.")
        out["active"] = 1 if active else 0
    return out


def check_subcon_name_free(conn, name, own_id=None):
    row = conn.execute("SELECT id, ref FROM subcons WHERE name = ?", (name,)).fetchone()
    if row is not None and row["id"] != own_id:
        raise ApiError(400, "'%s' is already in the directory as %s." % (name, row["ref"]))


def get_subcon(conn, subcon_id):
    row = conn.execute("SELECT * FROM subcons WHERE id = ?", (subcon_id,)).fetchone()
    if row is None:
        raise ApiError(404, "That subcontractor is no longer in the directory.")
    return row


def subcon_json(row):
    data = dict(row)
    data["active"] = bool(data["active"])
    return data


def h_subcon_create(ctx):
    with write_db() as conn:
        fields = parse_subcon_fields(ctx.body)
        check_subcon_name_free(conn, fields["name"])
        number = int(meta_get(conn, "seq_subcon", "0")) + 1
        meta_set(conn, "seq_subcon", number)
        now = now_iso()
        fields.update({"ref": "SUB-%04d" % number, "created_by": ctx.user["id"], "created_at": now,
                       "updated_by": ctx.user["id"], "updated_at": now})
        cur = conn.execute("INSERT INTO subcons (%s) VALUES (%s)"
                           % (",".join(fields), ",".join("?" * len(fields))), list(fields.values()))
        add_event(conn, ctx.user, "subcons", "subcon",
                  "Subcontractor added to the directory: %s" % fields["name"], subcon_id=cur.lastrowid)
        return {"subcon": subcon_json(get_subcon(conn, cur.lastrowid))}


def h_subcon_update(ctx):
    with write_db() as conn:
        row = get_subcon(conn, ctx.arg())
        check_version(ctx.body, row, what="subcontractor")
        fields = parse_subcon_fields(ctx.body, existing=row)
        changed = {k: v for k, v in fields.items() if v != row[k]}
        if "name" in changed:
            check_subcon_name_free(conn, changed["name"], own_id=row["id"])
        if changed:
            sets = ", ".join("%s = ?" % k for k in changed)
            conn.execute("UPDATE subcons SET %s, updated_by = ?, updated_at = ?, version = version + 1 "
                         "WHERE id = ?" % sets, list(changed.values()) + [ctx.user["id"], now_iso(), row["id"]])
            if list(changed) == ["active"]:
                note = "Subcontractor marked %s: %s" % ("active" if changed["active"] else "inactive", row["name"])
            else:
                note = "Subcontractor details updated: %s" % changed.get("name", row["name"])
            add_event(conn, ctx.user, "subcons", "subcon", note, subcon_id=row["id"])
        return {"subcon": subcon_json(get_subcon(conn, row["id"])), "changed": bool(changed)}


def h_subcon_delete(ctx):
    with write_db() as conn:
        row = get_subcon(conn, ctx.arg())
        used = conn.execute("SELECT record_id FROM record_subcons WHERE subcon_id = ?", (row["id"],)).fetchall()
        for link in used:
            add_activity(conn, link["record_id"], ctx.user, "subcon",
                         "Subcontractor removed (deleted from the directory): %s" % row["name"])
        conn.execute("DELETE FROM subcons WHERE id = ?", (row["id"],))
        add_event(conn, ctx.user, "subcons", "subcon",
                  "Subcontractor deleted from the directory: %s" % row["name"])
        audit(conn, "subcon_deleted", "%s %s (was on %d record(s))" % (row["ref"], row["name"], len(used)),
              user=ctx.user, ip=ctx.ip)
    return {"ok": True}


def subcon_record(conn, ctx):
    """The record in the URL, which must be in a section that uses subcontractors."""
    row = get_record(conn, ctx.arg(1), ctx.user)
    if row["module"] not in SUBCON_MODULES:
        raise ApiError(400, "Subcontractors can be added to projects, enquiries and "
                            "expressions of interest only.")
    return row


def h_record_subcon_add(ctx):
    with write_db() as conn:
        row = subcon_record(conn, ctx)
        subcon = get_subcon(conn, int_field(ctx.body, "subcon_id", "Subcontractor", required=True))
        scope = text_field(ctx.body, "scope", "Scope of work", 300)
        if not subcon["active"]:
            raise ApiError(400, "%s is marked inactive in the directory, so cannot be added to new work."
                           % subcon["name"])
        if conn.execute("SELECT 1 FROM record_subcons WHERE record_id = ? AND subcon_id = ?",
                        (row["id"], subcon["id"])).fetchone():
            raise ApiError(400, "%s is already on %s." % (subcon["name"], row["ref"]))
        conn.execute("INSERT INTO record_subcons (record_id, subcon_id, scope, added_by, added_at) "
                     "VALUES (?,?,?,?,?)", (row["id"], subcon["id"], scope, ctx.user["id"], now_iso()))
        add_activity(conn, row["id"], ctx.user, "subcon", "Subcontractor added: %s%s"
                     % (subcon["name"], " (%s)" % scope if scope else ""))
    return {"ok": True}


def h_record_subcon_update(ctx):
    with write_db() as conn:
        row = subcon_record(conn, ctx)
        subcon = get_subcon(conn, ctx.arg(2))
        link = conn.execute("SELECT * FROM record_subcons WHERE record_id = ? AND subcon_id = ?",
                            (row["id"], subcon["id"])).fetchone()
        if link is None:
            raise ApiError(404, "%s is not on %s." % (subcon["name"], row["ref"]))
        changed, notes = {}, []
        if "scope" in ctx.body:
            scope = text_field(ctx.body, "scope", "Scope of work", 300)
            if scope != link["scope"]:
                changed["scope"] = scope
                notes.append("Scope: %s" % (scope or "-"))
        # Each subcontractor on a record has its own last known update and next
        # follow-up, separate from the record's own last and next action.
        if "last_update" in ctx.body:
            last_update = text_field(ctx.body, "last_update", "Last known update", 500)
            last_date = date_field(ctx.body, "last_update_date", "Date of last update")
            if last_update and not last_date:
                raise ApiError(400, "Please give the date of the last known update.")
            if not last_update:
                last_date = None
            if last_update != link["last_update"] or last_date != link["last_update_date"]:
                changed["last_update"] = last_update
                changed["last_update_date"] = last_date
                notes.append("Last update%s: %s" % (" (%s)" % last_date if last_date else "",
                                                    last_update or "-"))
        if "next_action" in ctx.body:
            next_action = text_field(ctx.body, "next_action", "Next follow-up", 500)
            if next_action != link["next_action"]:
                changed["next_action"] = next_action
                notes.append("Next follow-up: %s" % (next_action or "-"))
        if "next_action_date" in ctx.body:
            next_date = date_field(ctx.body, "next_action_date", "Expected date")
            if next_date != link["next_action_date"]:
                changed["next_action_date"] = next_date
                notes.append("Follow-up expected: %s" % (next_date or "-"))
        if changed:
            changed["updated_by"] = ctx.user["id"]
            changed["updated_at"] = now_iso()
            conn.execute("UPDATE record_subcons SET %s WHERE record_id = ? AND subcon_id = ?"
                         % ", ".join("%s = ?" % k for k in changed),
                         list(changed.values()) + [row["id"], subcon["id"]])
            add_activity(conn, row["id"], ctx.user, "subcon", "Subcontractor %s - %s"
                         % (subcon["name"], "; ".join(notes)))
    return {"ok": True}


def h_record_subcon_remove(ctx):
    with write_db() as conn:
        row = subcon_record(conn, ctx)
        subcon = get_subcon(conn, ctx.arg(2))
        cur = conn.execute("DELETE FROM record_subcons WHERE record_id = ? AND subcon_id = ?",
                           (row["id"], subcon["id"]))
        if cur.rowcount:
            add_activity(conn, row["id"], ctx.user, "subcon", "Subcontractor removed: %s" % subcon["name"])
    return {"ok": True}


def parse_task_fields(conn, body, user, existing=None):
    creating = existing is None
    out = {}

    def present(key):
        return creating or key in body

    if present("title"):
        out["title"] = text_field(body, "title", "Task", 200, required=True)
    if present("details"):
        out["details"] = text_field(body, "details", "Details", 4000, multiline=True)
    if present("assignee_id"):
        assignee_id = int_field(body, "assignee_id", "Assigned to", required=True)
        if not (existing is not None and existing["assignee_id"] == assignee_id):
            assignee = conn.execute("SELECT * FROM users WHERE id = ?", (assignee_id,)).fetchone()
            if assignee is None or not assignee["active"]:
                raise ApiError(400, "Tasks can only be assigned to active users.")
        out["assignee_id"] = assignee_id
    if present("due_date"):
        out["due_date"] = date_field(body, "due_date", "Due date")
    if present("priority"):
        out["priority"] = choice_field(body, "priority", "Priority", PRIORITIES, default="Normal")
    if present("status"):
        out["status"] = choice_field(body, "status", "Status", TASK_STATUSES, default="To Do")
    if present("record_id"):
        record_id = int_field(body, "record_id", "Linked record")
        if record_id is not None and not (existing is not None and existing["record_id"] == record_id):
            get_record(conn, record_id, user)
        out["record_id"] = record_id
    return out


def can_edit_task(user, task):
    return user["role"] == "admin" or user["id"] in (task["assignee_id"], task["created_by"])


def h_task_create(ctx):
    with write_db() as conn:
        fields = parse_task_fields(conn, ctx.body, ctx.user)
        now = now_iso()
        fields["created_by"] = ctx.user["id"]
        fields["created_at"] = now
        fields["updated_at"] = now
        fields["completed_at"] = now if fields["status"] == "Done" else None
        cur = conn.execute("INSERT INTO tasks (%s) VALUES (%s)"
                           % (",".join(fields), ",".join("?" * len(fields))),
                           list(fields.values()))
        added = "Task added: %s (assigned to %s)" % (fields["title"], user_name(conn, fields["assignee_id"]))
        if fields["record_id"] is not None:
            add_activity(conn, fields["record_id"], ctx.user, "task", added, task_id=cur.lastrowid)
        else:
            add_event(conn, ctx.user, "task", "task", added, task_id=cur.lastrowid)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
        return {"task": dict(row)}


def h_task_update(ctx):
    with write_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL",
                            (ctx.arg(),)).fetchone()
        if task is None:
            raise ApiError(404, "That task no longer exists.")
        if not can_edit_task(ctx.user, task):
            raise ApiError(403, "Only the person a task is assigned to, the person who created "
                                "it, or an administrator can change it.")
        check_version(ctx.body, task, what="task")
        fields = parse_task_fields(conn, ctx.body, ctx.user, existing=task)
        changed = {k: v for k, v in fields.items() if v != task[k]}
        if changed:
            if "status" in changed:
                changed["completed_at"] = now_iso() if changed["status"] == "Done" else None
            changed["updated_at"] = now_iso()
            sets = ", ".join("%s = ?" % k for k in changed)
            conn.execute("UPDATE tasks SET %s, version = version + 1 WHERE id = ?" % sets,
                         list(changed.values()) + [task["id"]])
            record_id = changed.get("record_id", task["record_id"])
            title = changed.get("title", task["title"])
            notes = []
            if changed.get("status") == "Done":
                notes.append("Task completed: %s" % title)
            elif "status" in changed and task["status"] == "Done":
                notes.append("Task reopened: %s" % title)
            if "assignee_id" in changed:
                notes.append("Task reassigned: %s (now with %s)"
                             % (title, user_name(conn, changed["assignee_id"])))
            for note in notes:
                if record_id is not None:
                    add_activity(conn, record_id, ctx.user, "task", note, task_id=task["id"])
                else:
                    add_event(conn, ctx.user, "task", "task", note, task_id=task["id"])
            if not notes:
                # Other edits (wording, due date, priority) are not part of a record's
                # history, but the people the task belongs to are still told.
                add_event(conn, ctx.user, "record" if record_id is not None else "task", "task",
                          "Task updated: %s" % title, record_id=record_id, task_id=task["id"])
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task["id"],)).fetchone()
        return {"task": dict(row)}


def h_task_delete(ctx):
    with write_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL",
                            (ctx.arg(),)).fetchone()
        if task is None:
            return {"ok": True}
        if not (ctx.user["role"] == "admin" or ctx.user["id"] == task["created_by"]):
            raise ApiError(403, "Only the person who created a task, or an administrator, "
                                "can delete it.")
        # Kept for the activity log; it no longer appears in any task list.
        conn.execute("UPDATE tasks SET deleted_at = ?, deleted_by = ? WHERE id = ?",
                     (now_iso(), ctx.user["id"], task["id"]))
        if task["record_id"] is not None:
            add_activity(conn, task["record_id"], ctx.user, "task",
                         "Task deleted: %s" % task["title"], task_id=task["id"])
        else:
            add_event(conn, ctx.user, "task", "task", "Task deleted: %s" % task["title"], task_id=task["id"])
    return {"ok": True}


# ---- Administration -------------------------------------------------------

def admin_user_json(row):
    data = user_json(row)
    data["created_at"] = row["created_at"]
    data["last_login"] = row["last_login"]
    return data


def h_admin_users(ctx):
    with read_db() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY full_name COLLATE NOCASE").fetchall()
    return {"users": [admin_user_json(r) for r in rows]}


def active_admin_count(conn, excluding=None):
    rows = conn.execute("SELECT id FROM users WHERE role = 'admin' AND active = 1").fetchall()
    return len([r for r in rows if r["id"] != excluding])


def h_admin_user_create(ctx):
    username = text_field(ctx.body, "username", "Username", 32, required=True).lower()
    if not USERNAME_RE.match(username):
        raise ApiError(400, "Username must be 2-32 characters: lowercase letters, numbers, "
                            "dots, dashes or underscores, starting with a letter or number.")
    full_name = text_field(ctx.body, "full_name", "Full name", 100, required=True)
    role = choice_field(ctx.body, "role", "Role", list(ROLES))
    password = generate_password()
    with write_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise ApiError(400, "The username '%s' is already in use." % username)
        cur = conn.execute(
            "INSERT INTO users (username, full_name, role, pw_hash, must_change, active, created_at) "
            "VALUES (?,?,?,?,1,1,?)",
            (username, full_name, role, hash_password(password), now_iso()))
        audit(conn, "user_created", "%s (%s)" % (username, ROLES[role]), user=ctx.user, ip=ctx.ip)
        add_event(conn, ctx.user, "admin", "admin", "Login created: %s (%s)" % (full_name, ROLES[role]))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"user": admin_user_json(row), "temp_password": password}


def h_admin_user_update(ctx):
    with write_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (ctx.arg(),)).fetchone()
        if row is None:
            raise ApiError(404, "That user no longer exists.")
        full_name = row["full_name"]
        role = row["role"]
        active = bool(row["active"])
        if "full_name" in ctx.body:
            full_name = text_field(ctx.body, "full_name", "Full name", 100, required=True)
        if "role" in ctx.body:
            role = choice_field(ctx.body, "role", "Role", list(ROLES))
        if "active" in ctx.body:
            if not isinstance(ctx.body["active"], bool):
                raise ApiError(400, "Active must be true or false.")
            active = ctx.body["active"]
        losing_admin = row["role"] == "admin" and row["active"] and (role != "admin" or not active)
        if losing_admin and row["id"] == ctx.user["id"]:
            raise ApiError(400, "You cannot remove your own administrator access. "
                                "Ask another administrator to do it.")
        if losing_admin and active_admin_count(conn, excluding=row["id"]) == 0:
            raise ApiError(400, "There must always be at least one active administrator.")
        conn.execute("UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?",
                     (full_name, role, 1 if active else 0, row["id"]))
        if not active:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        details = []
        if full_name != row["full_name"]:
            details.append("name: %s" % full_name)
        if role != row["role"]:
            details.append("role: %s -> %s" % (ROLES.get(row["role"], row["role"]), ROLES[role]))
        if active != bool(row["active"]):
            details.append("reactivated" if active else "deactivated")
        if details:
            audit(conn, "user_updated", "%s - %s" % (row["username"], ", ".join(details)),
                  user=ctx.user, ip=ctx.ip)
            add_event(conn, ctx.user, "admin", "admin",
                      "Login changed: %s - %s" % (row["full_name"], ", ".join(details)))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    return {"user": admin_user_json(row)}


def h_admin_user_reset(ctx):
    password = generate_password()
    with write_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (ctx.arg(),)).fetchone()
        if row is None:
            raise ApiError(404, "That user no longer exists.")
        if row["id"] == ctx.user["id"]:
            raise ApiError(400, "Use 'Change password' to change your own password.")
        conn.execute("UPDATE users SET pw_hash = ?, must_change = 1 WHERE id = ?",
                     (hash_password(password), row["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        audit(conn, "password_reset", row["username"], user=ctx.user, ip=ctx.ip)
        add_event(conn, ctx.user, "admin", "admin", "Password reset for %s" % row["full_name"])
    return {"temp_password": password, "user": admin_user_json(row)}


def h_admin_audit(ctx):
    with read_db() as conn:
        rows = conn.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 300").fetchall()
    return {"audit": [dict(r) for r in rows]}


def h_admin_system(ctx):
    age = latest_backup_age()
    return {
        "app_version": VERSION,
        "local_url": "http://localhost:%s" % RT.port,
        "online_requested": RT.online_requested,
        "tunnel_status": RT.tunnel_status,
        "public_url": RT.public_url,
        "data_dir": RT.data_dir,
        "last_backup_hours": None if age is None else round(age / 3600.0, 1),
        "python": platform.python_version(),
        "platform": platform.system(),
        "packaged": PACKAGED,
        "mode": "online" if RT.tunnel_active else ("lan" if RT.lan else "local"),
        "encryption": encryption_status(),
    }


def encryption_status():
    """For Admin, System: whether the local network is encrypted, the addresses
    to give people, and the certificate each device installs once."""
    data = stored_certificate()
    status = {"on": RT.tls is not None and not RT.tunnel_active,
              "certificate": describe_certificate(data) if data else None,
              "certificate_url": CERTIFICATE_PATH, "addresses": [], "setup_addresses": []}
    if status["on"]:
        shown = [a for a in RT.lan_ips if a in RT.tls.covered]
        shown += [a for a in RT.tls.addresses if a not in shown and not is_loopback(a)]
        for address in shown:
            where = "[%s]:%d" % (address, RT.port) if ":" in address else "%s:%d" % (address, RT.port)
            status["addresses"].append("https://" + where)
            status["setup_addresses"].append("http://" + where)
        status["addresses"] += ["https://%s:%d" % (name, RT.port) for name in RT.tls.names
                                if name != "localhost"][:1]
    return status


def h_admin_settings(ctx):
    org_name = text_field(ctx.body, "org_name", "Organisation name", 100)
    currency = text_field(ctx.body, "currency", "Currency", 6)
    with write_db() as conn:
        meta_set(conn, "org_name", org_name)
        meta_set(conn, "currency", currency)
        audit(conn, "settings_changed", "", user=ctx.user, ip=ctx.ip)
        add_event(conn, ctx.user, "admin", "admin", "Organisation settings changed")
    return {"ok": True}


def h_admin_backup(ctx):
    """Streams a database backup; handled specially by the request handler."""
    os.makedirs(RT.backup_dir, exist_ok=True)
    tmp = os.path.join(RT.backup_dir, "download-%s.tmp" % secrets.token_hex(6))
    try:
        make_backup(tmp)
        with open(tmp, "rb") as fh:
            data = fh.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    with write_db(bump=False) as conn:
        audit(conn, "backup_downloaded", "", user=ctx.user, ip=ctx.ip)
    name = "insys-database-%s.db" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return RawResponse(data, "application/octet-stream",
                       [("Content-Disposition", 'attachment; filename="%s"' % name)])


def inspect_database_file(path):
    """Check that an uploaded file is an InSys database this version can host.
    Returns a short description of what it holds; raises ApiError if it is not usable."""
    try:
        with open(path, "rb") as fh:
            header = fh.read(16)
    except OSError:
        raise ApiError(400, "The file could not be read.")
    if header != b"SQLite format 3\x00":
        raise ApiError(400, "That is not an InSys database file. Use a file made with "
                            "'Download database' in another InSys.")
    conn = None
    try:
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ApiError(400, "The file is damaged (it may not have copied completely). "
                                "Download it again and retry.")
        tables = set(r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
        if not set(["meta", "users", "records", "activity", "tasks", "audit"]).issubset(tables):
            raise ApiError(400, "That is not an InSys database file.")
        try:
            layout = int(meta_get(conn, "schema_version", "0"))
        except ValueError:
            layout = 0
        if layout < 1:
            raise ApiError(400, "That is not an InSys database file.")
        if layout > SCHEMA_VERSION:
            raise ApiError(400, "That file comes from a newer version of InSys than this one (%s). "
                                "Update this InSys first, then load the file." % VERSION)
        if not conn.execute("SELECT 1 FROM users WHERE role = 'admin' AND active = 1").fetchone():
            raise ApiError(400, "That file has no active administrator, so nobody could sign in "
                                "after loading it.")
        return {"layout": layout,
                "records": conn.execute("SELECT COUNT(*) AS n FROM records").fetchone()["n"],
                "users": conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]}
    except sqlite3.Error:
        raise ApiError(400, "That is not an InSys database file.")
    finally:
        if conn is not None:
            conn.close()


def h_admin_restore(ctx, path):
    """Replace this InSys's data with a database file transferred from another
    InSys. A copy of the current data is kept first."""
    info = inspect_database_file(path)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    kept = os.path.join(RT.backup_dir, "before-loading-transfer-%s.db" % stamp)
    with RT.db_lock:
        os.makedirs(RT.backup_dir, exist_ok=True)
        make_backup(kept + ".tmp")
        os.replace(kept + ".tmp", kept)
        source = sqlite3.connect(path)
        target = connect()
        try:
            source.backup(target)
        finally:
            source.close()
            target.close()
        with write_db() as conn:
            apply_schema(conn, info["layout"])
            conn.execute("DELETE FROM sessions")  # everyone signs in again, with the new logins
            audit(conn, "database_loaded",
                  "Transferred database loaded (%d records, %d logins) by %s of the previous data; "
                  "the previous data was kept as %s"
                  % (info["records"], info["users"], ctx.user["username"], os.path.basename(kept)),
                  ip=ctx.ip)
            add_event(conn, None, "admin", "admin",
                      "A transferred database was loaded (%d records, %d logins)"
                      % (info["records"], info["users"]))
    remove_first_login_file()
    ctx.handler.clear_session_cookie()
    return {"ok": True, "records": info["records"], "users": info["users"],
            "kept": os.path.basename(kept)}


class RawResponse:
    def __init__(self, data, content_type, headers=None):
        self.data = data
        self.content_type = content_type
        self.headers = headers or []


# Access levels:
#   public - no sign-in needed
#   auth   - signed in (allowed even while a password change is pending)
#   user   - signed in with password change completed
#   admin  - administrators only
ROUTES = [
    ("GET", r"/api/ping", h_ping, "public"),
    ("POST", r"/api/login", h_login, "public"),
    ("POST", r"/api/logout", h_logout, "public"),
    ("GET", r"/api/me", h_me, "auth"),
    ("POST", r"/api/change-password", h_change_password, "auth"),
    ("GET", r"/api/version", h_version, "user"),
    ("GET", r"/api/state", h_state, "user"),
    ("GET", r"/api/activity", h_activity, "user"),
    ("GET", r"/api/log", h_log, "user"),
    ("GET", r"/api/events", h_events, "user"),
    ("POST", r"/api/events/seen", h_events_seen, "user"),
    ("POST", r"/api/records", h_record_create, "user"),
    ("PUT", r"/api/records/(\d{1,12})", h_record_update, "user"),
    ("DELETE", r"/api/records/(\d{1,12})", h_record_delete, "admin"),
    ("POST", r"/api/records/(\d{1,12})/restore", h_record_restore, "admin"),
    ("POST", r"/api/records/(\d{1,12})/actions", h_record_action, "user"),
    ("POST", r"/api/records/(\d{1,12})/notes", h_record_note, "user"),
    ("GET", r"/api/records/(\d{1,12})/history", h_record_history, "user"),
    ("POST", r"/api/records/(\d{1,12})/links", h_link_create, "user"),
    ("DELETE", r"/api/records/(\d{1,12})/links/(\d{1,12})", h_link_delete, "user"),
    ("POST", r"/api/records/(\d{1,12})/xrefs", h_xref_create, "user"),
    ("DELETE", r"/api/records/(\d{1,12})/xrefs/(\d{1,12})", h_xref_delete, "user"),
    ("POST", r"/api/subcons", h_subcon_create, "user"),
    ("PUT", r"/api/subcons/(\d{1,12})", h_subcon_update, "user"),
    ("DELETE", r"/api/subcons/(\d{1,12})", h_subcon_delete, "admin"),
    ("POST", r"/api/records/(\d{1,12})/subcons", h_record_subcon_add, "user"),
    ("PUT", r"/api/records/(\d{1,12})/subcons/(\d{1,12})", h_record_subcon_update, "user"),
    ("DELETE", r"/api/records/(\d{1,12})/subcons/(\d{1,12})", h_record_subcon_remove, "user"),
    ("POST", r"/api/tasks", h_task_create, "user"),
    ("PUT", r"/api/tasks/(\d{1,12})", h_task_update, "user"),
    ("DELETE", r"/api/tasks/(\d{1,12})", h_task_delete, "user"),
    ("GET", r"/api/admin/users", h_admin_users, "admin"),
    ("POST", r"/api/admin/users", h_admin_user_create, "admin"),
    ("PUT", r"/api/admin/users/(\d{1,12})", h_admin_user_update, "admin"),
    ("POST", r"/api/admin/users/(\d{1,12})/reset-password", h_admin_user_reset, "admin"),
    ("GET", r"/api/admin/audit", h_admin_audit, "admin"),
    ("GET", r"/api/admin/system", h_admin_system, "admin"),
    ("PUT", r"/api/admin/settings", h_admin_settings, "admin"),
    ("GET", r"/api/admin/backup", h_admin_backup, "admin"),
    # POST /api/admin/restore takes a file, not JSON; see Handler.handle_upload.
]
ROUTES = [(m, re.compile(p), fn, access) for (m, p, fn, access) in ROUTES]

# Version polls must not keep an otherwise idle session alive.
NO_TOUCH_PATHS = ("/api/version",)


# ---------------------------------------------------------------------------
# Encryption on the local network
# ---------------------------------------------------------------------------
# In choice 2 everything that crosses the network is carried over HTTPS (TLS),
# done by the OpenSSL library that ships with Python. A local network has no
# public authority to vouch for this computer, so InSys keeps its own:
#
#   * a "local certificate" (a certificate authority), made once and kept in
#     the data folder. This is the file each device installs, once. It is
#     marked so that it can vouch only for addresses on private networks and
#     for local names - never for a public website;
#   * a server certificate signed by it, replaced automatically when it nears
#     its end or when this computer's address changes, so that a device never
#     has to install anything a second time.
#
# Python's standard library can use certificates but cannot create them, so
# the arithmetic needed to create and sign one (ECDSA on the P-256 curve, with
# the nonce of RFC 6979) is written out below. It runs only at the moment a
# certificate is made, on this computer, never in answer to a request. The
# encryption of the connections themselves is entirely OpenSSL's.

EC_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
EC_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
EC_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
EC_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
        0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def ec_on_curve(point):
    x, y = point
    return 0 <= x < EC_P and 0 <= y < EC_P and (y * y - (x * x * x - 3 * x + EC_B)) % EC_P == 0


def _ec_double(point):
    if point is None:
        return None
    x, y, z = point
    if y == 0:
        return None
    delta = z * z % EC_P
    gamma = y * y % EC_P
    beta = x * gamma % EC_P
    alpha = 3 * (x - delta) * (x + delta) % EC_P
    x3 = (alpha * alpha - 8 * beta) % EC_P
    z3 = ((y + z) * (y + z) - gamma - delta) % EC_P
    y3 = (alpha * (4 * beta - x3) - 8 * gamma * gamma) % EC_P
    return x3, y3, z3


def _ec_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1 = z1 * z1 % EC_P
    z2z2 = z2 * z2 % EC_P
    u1 = x1 * z2z2 % EC_P
    u2 = x2 * z1z1 % EC_P
    s1 = y1 * z2 * z2z2 % EC_P
    s2 = y2 * z1 * z1z1 % EC_P
    if u1 == u2:
        return _ec_double(p1) if s1 == s2 else None
    h = (u2 - u1) % EC_P
    r = (s2 - s1) % EC_P
    h2 = h * h % EC_P
    h3 = h * h2 % EC_P
    v = u1 * h2 % EC_P
    x3 = (r * r - h3 - 2 * v) % EC_P
    y3 = (r * (v - x3) - s1 * h3) % EC_P
    z3 = h * z1 * z2 % EC_P
    return x3, y3, z3


def _ec_affine(point):
    if point is None:
        return None
    x, y, z = point
    inverse = pow(z, -1, EC_P)
    square = inverse * inverse % EC_P
    return x * square % EC_P, y * square * inverse % EC_P


def _ec_combine(k1, point1, k2=0, point2=None):
    """k1*point1 + k2*point2, the points given as (x, y)."""
    result = None
    first = (point1[0], point1[1], 1)
    second = (point2[0], point2[1], 1) if point2 is not None else None
    for bit in range(max(k1.bit_length(), k2.bit_length()) - 1, -1, -1):
        result = _ec_double(result)
        if (k1 >> bit) & 1:
            result = _ec_add(result, first)
        if second is not None and (k2 >> bit) & 1:
            result = _ec_add(result, second)
    return _ec_affine(result)


def ec_new_key():
    return secrets.randbelow(EC_N - 1) + 1


def ec_public(private):
    point = _ec_combine(private, EC_G)
    if point is None or not ec_on_curve(point):
        raise ValueError("key arithmetic failed")
    return point


def ec_point_bytes(point):
    return b"\x04" + point[0].to_bytes(32, "big") + point[1].to_bytes(32, "big")


def ec_point_from_bytes(data):
    if len(data) != 65 or data[0] != 4:
        raise ValueError("not a P-256 public key")
    point = (int.from_bytes(data[1:33], "big"), int.from_bytes(data[33:], "big"))
    if not ec_on_curve(point):
        raise ValueError("not a P-256 public key")
    return point


def _rfc6979_nonces(private, digest):
    """The deterministic nonces of RFC 6979 for P-256 with SHA-256."""
    def mac(key, data):
        return hmac.new(key, data, hashlib.sha256).digest()
    secret = private.to_bytes(32, "big")
    reduced = (int.from_bytes(digest, "big") % EC_N).to_bytes(32, "big")
    v = b"\x01" * 32
    k = mac(b"\x00" * 32, v + b"\x00" + secret + reduced)
    v = mac(k, v)
    k = mac(k, v + b"\x01" + secret + reduced)
    v = mac(k, v)
    while True:
        v = mac(k, v)
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < EC_N:
            yield candidate
        k = mac(k, v + b"\x00")
        v = mac(k, v)


def ecdsa_sign(private, message):
    digest = hashlib.sha256(message).digest()
    e = int.from_bytes(digest, "big")
    for nonce in _rfc6979_nonces(private, digest):
        point = _ec_combine(nonce, EC_G)
        r = point[0] % EC_N
        s = pow(nonce, -1, EC_N) * (e + r * private) % EC_N
        if r and s:
            return r, s


def ecdsa_verify(public, message, signature):
    r, s = signature
    if not (1 <= r < EC_N and 1 <= s < EC_N and ec_on_curve(public)):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, EC_N)
    point = _ec_combine(e * w % EC_N, EC_G, r * w % EC_N, public)
    return point is not None and point[0] % EC_N == r


# ---- DER, the encoding certificates are written in --------------------------

def der(tag, content):
    size = len(content)
    if size < 128:
        return bytes([tag, size]) + content
    length = size.to_bytes((size.bit_length() + 7) // 8, "big")
    return bytes([tag, 0x80 | len(length)]) + length + content


def der_seq(*parts):
    return der(0x30, b"".join(parts))


def der_int(value):
    return der(0x02, value.to_bytes(value.bit_length() // 8 + 1, "big"))


def der_oid(dotted):
    numbers = [int(part) for part in dotted.split(".")]
    out = bytearray([numbers[0] * 40 + numbers[1]])
    for number in numbers[2:]:
        chunk = [number & 0x7F]
        number >>= 7
        while number:
            chunk.append(0x80 | (number & 0x7F))
            number >>= 7
        out.extend(reversed(chunk))
    return der(0x06, bytes(out))


def der_time(moment):
    if 1950 <= moment.year < 2050:
        return der(0x17, moment.strftime("%y%m%d%H%M%SZ").encode("ascii"))
    return der(0x18, moment.strftime("%Y%m%d%H%M%SZ").encode("ascii"))


def der_items(data):
    """The items in a run of DER values, each as (tag, content, whole item)."""
    items = []
    pos = 0
    while pos < len(data):
        if pos + 2 > len(data):
            raise ValueError("truncated")
        tag = data[pos]
        size = data[pos + 1]
        start = pos + 2
        if size & 0x80:
            count = size & 0x7F
            if count == 0 or count > 4 or start + count > len(data):
                raise ValueError("bad length")
            size = int.from_bytes(data[start:start + count], "big")
            start += count
        end = start + size
        if end > len(data):
            raise ValueError("truncated")
        items.append((tag, data[start:end], data[pos:end]))
        pos = end
    return items


def pem_encode(label, data):
    text = base64.b64encode(data).decode("ascii")
    lines = [text[i:i + 64] for i in range(0, len(text), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (label, "\n".join(lines), label)


def pem_decode(label, text):
    match = re.search(r"-----BEGIN %s-----(.*?)-----END %s-----" % (label, label), text, re.S)
    if not match:
        raise ValueError("no %s found" % label)
    return base64.b64decode("".join(match.group(1).split()), validate=True)


OID_EC_KEY = der_oid("1.2.840.10045.2.1")
OID_P256 = der_oid("1.2.840.10045.3.1.7")
OID_ECDSA_SHA256 = der_oid("1.2.840.10045.4.3.2")
OID_COMMON_NAME = der_oid("2.5.4.3")
OID_ORGANISATION = der_oid("2.5.4.10")
OID_SUBJECT_KEY_ID = der_oid("2.5.29.14")
OID_KEY_USAGE = der_oid("2.5.29.15")
OID_ALT_NAME = der_oid("2.5.29.17")
OID_BASIC_CONSTRAINTS = der_oid("2.5.29.19")
OID_NAME_CONSTRAINTS = der_oid("2.5.29.30")
OID_AUTHORITY_KEY_ID = der_oid("2.5.29.35")
OID_EXT_KEY_USAGE = der_oid("2.5.29.37")
OID_SERVER_AUTH = der_oid("1.3.6.1.5.5.7.3.1")
SIGNATURE_ALGORITHM = der_seq(OID_ECDSA_SHA256)


def x509_name(common_name):
    return der_seq(
        der(0x31, der_seq(OID_ORGANISATION, der(0x0C, b"InSys"))),
        der(0x31, der_seq(OID_COMMON_NAME, der(0x0C, common_name.encode("utf-8")))))


def x509_extension(oid, value, critical=False):
    return der_seq(oid, der(0x01, b"\xff") if critical else b"", der(0x04, value))


def general_name(value):
    """A DNS name or an IP address (or, for a constraint, a network) as X.509 writes it."""
    if isinstance(value, (ipaddress.IPv4Network, ipaddress.IPv6Network)):
        return der(0x87, value.network_address.packed + value.netmask.packed)
    if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return der(0x87, value.packed)
    return der(0x82, value.encode("ascii"))


def key_identifier(public):
    return hashlib.sha1(ec_point_bytes(public)).digest()


def build_certificate(signing_key, issuer, subject, public, not_before, not_after, extensions):
    tbs = der_seq(
        der(0xA0, der_int(2)),                                    # version 3
        der_int(int.from_bytes(secrets.token_bytes(16), "big") >> 1 | 1),   # serial number
        SIGNATURE_ALGORITHM, issuer,
        der_seq(der_time(not_before), der_time(not_after)),
        subject,
        der_seq(der_seq(OID_EC_KEY, OID_P256), der(0x03, b"\x00" + ec_point_bytes(public))),
        der(0xA3, der_seq(*extensions)))
    r, s = ecdsa_sign(signing_key, tbs)
    return der_seq(tbs, SIGNATURE_ALGORITHM, der(0x03, b"\x00" + der_seq(der_int(r), der_int(s))))


def read_certificate(data):
    """The parts of a certificate InSys needs to read back. Raises ValueError."""
    try:
        (tag, body, _), = der_items(data)
        tbs, _, signature = der_items(body)
        fields = der_items(tbs[1])
        if tag != 0x30 or fields[0][0] != 0xA0:
            raise ValueError("unexpected layout")
        _, serial, _, issuer, validity, subject, key = fields[:7]
        moments = []
        for kind, text, _ in der_items(validity[1]):
            text = text.decode("ascii")
            moments.append(datetime.datetime.strptime(
                text, "%y%m%d%H%M%SZ" if kind == 0x17 else "%Y%m%d%H%M%SZ"))
        extensions = {}
        for field in fields[7:]:
            if field[0] == 0xA3:
                for _, extension, _ in der_items(der_items(field[1])[0][1]):
                    parts = der_items(extension)
                    extensions[parts[0][2]] = parts[-1][1]
        r, s = (int.from_bytes(item[1], "big") for item in der_items(der_items(signature[1][1:])[0][1]))
        return {"tbs": tbs[2], "issuer": issuer[2], "subject": subject[2],
                "not_before": moments[0], "not_after": moments[1],
                "public": ec_point_from_bytes(der_items(key[1])[1][1][1:]),
                "extensions": extensions, "signature": (r, s)}
    except (IndexError, KeyError, UnicodeDecodeError) as exc:
        raise ValueError("unreadable certificate: %s" % exc)


def read_names(value):
    """DNS names and IP addresses out of a list of general names."""
    names, addresses = [], []
    for tag, content, _ in der_items(value):
        if tag == 0x82:
            names.append(content.decode("ascii"))
        elif tag == 0x87 and len(content) in (4, 16):
            addresses.append(ipaddress.ip_address(content))
        elif tag == 0x87 and len(content) in (8, 32):
            half = len(content) // 2
            prefix = bin(int.from_bytes(content[half:], "big")).count("1")
            addresses.append(ipaddress.ip_network((content[:half], prefix)))
    return names, addresses


def common_name_of(name):
    for _, rdn, _ in der_items(der_items(name)[0][1]):
        for _, pair, _ in der_items(rdn):
            parts = der_items(pair)
            if parts[0][2] == OID_COMMON_NAME:
                return parts[1][1].decode("utf-8", "replace")
    return ""


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)


def dns_label_ok(name):
    return bool(name) and len(name) <= 253 and all(
        re.match(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", label) for label in name.split("."))


class EncryptionError(Exception):
    """Encryption for the local network could not be set up."""


class Encryption:
    """HTTPS for the local network: the local certificate each device installs
    once, and the server certificate InSys presents, kept in the data folder."""

    AUTHORITY_YEARS = 10
    SERVER_DAYS = 396        # browsers refuse server certificates that last much over a year
    RENEW_DAYS = 45          # a new one is made this long before the old one ends
    MAX_ADDRESSES = 24
    CERTIFICATE_FILE = "InSys-certificate.crt"

    def __init__(self, folder):
        self.folder = folder
        self.lock = threading.RLock()
        self.authority_key = None
        self.authority_der = None
        self.authority = None
        self.context = None
        self.covered = set()          # IP addresses the server certificate names, as text
        self.addresses = []           # the same, most recently needed first
        self.names = []               # DNS names it names
        self.server_until = None
        self.created = False          # a local certificate was made during this start
        self.replaced = None          # why an earlier one could not be used, if so

    def path(self, name):
        return os.path.join(self.folder, name)

    def _write(self, name, data, private=False):
        os.makedirs(self.folder, exist_ok=True)
        tmp = self.path(name + ".tmp")
        with open(tmp, "wb") as fh:
            fh.write(data)
        if private:
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
        for attempt in range(6):
            try:
                os.replace(tmp, self.path(name))
                return
            except PermissionError:
                # On Windows a virus scanner may hold a new file open for a moment.
                if attempt == 5:
                    raise
                time.sleep(0.25)

    # -- the local certificate (installed once on each device) ---------------

    def load_authority(self):
        """Read the local certificate made earlier. Returns a reason if there is
        one on file that cannot be used, None otherwise (whether or not there is one)."""
        key_path, cert_path = self.path("local-certificate-key.pem"), self.path(self.CERTIFICATE_FILE)
        if not os.path.exists(key_path) and not os.path.exists(cert_path):
            return None
        try:
            with open(cert_path, "rb") as fh:
                cert_der = fh.read()
            with open(key_path, "r", encoding="ascii") as fh:
                key = read_private_key(fh.read())
            info = read_certificate(cert_der)
            if info["public"] != ec_public(key):
                return "its key does not belong to it"
            if info["issuer"] != info["subject"] or not ecdsa_verify(info["public"], info["tbs"], info["signature"]):
                return "it has been altered or damaged"
            if info["not_after"] - utc_now() < datetime.timedelta(days=30):
                return "it has reached the end of its life"
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            return "its files could not be read (%s)" % exc
        self.authority_key, self.authority_der, self.authority = key, cert_der, info
        return None

    def create_authority(self, host_label, names):
        """Make a new local certificate. It may vouch only for private network
        addresses, local-only names and the names given here."""
        for name in ("local-certificate-key.pem", self.CERTIFICATE_FILE, "server-key.pem", "server.pem"):
            if os.path.exists(self.path(name)):
                stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                try:
                    os.replace(self.path(name), self.path("replaced-%s-%s" % (stamp, name)))
                except OSError:
                    pass
        key = ec_new_key()
        public = ec_public(key)
        label = re.sub(r"[^A-Za-z0-9 ._-]", "", host_label or "")[:24] or "host"
        name = x509_name("InSys local certificate - %s - %s" % (label, secrets.token_hex(2).upper()))
        permitted = ["localhost"] + [suffix.lstrip(".") for suffix in LOCAL_NAME_SUFFIXES if suffix != ".localhost"]
        permitted += [n for n in names if dns_label_ok(n) and n not in permitted]
        subtrees = [der_seq(general_name(n)) for n in permitted] + [der_seq(general_name(n)) for n in LOCAL_NETWORKS]
        now = utc_now()
        cert_der = build_certificate(key, name, name, public,
                                     now - datetime.timedelta(days=1),
                                     now + datetime.timedelta(days=365 * self.AUTHORITY_YEARS + 2), [
            x509_extension(OID_BASIC_CONSTRAINTS, der_seq(der(0x01, b"\xff"), der_int(0)), critical=True),
            x509_extension(OID_KEY_USAGE, der(0x03, b"\x01\x06"), critical=True),      # sign certificates
            x509_extension(OID_EXT_KEY_USAGE, der_seq(OID_SERVER_AUTH)),              # for web servers only
            x509_extension(OID_SUBJECT_KEY_ID, der(0x04, key_identifier(public))),
            x509_extension(OID_NAME_CONSTRAINTS, der_seq(der(0xA0, b"".join(subtrees))), critical=True),
        ])
        self._write("local-certificate-key.pem", write_private_key(key, public).encode("ascii"), private=True)
        self._write(self.CERTIFICATE_FILE, cert_der)
        self._write("READ-ME.txt", ENCRYPTION_READ_ME.encode("utf-8"))
        self.authority_key, self.authority_der, self.authority = key, cert_der, read_certificate(cert_der)
        self.created = True

    def permitted(self):
        """(names, networks) the local certificate is allowed to vouch for."""
        value = self.authority["extensions"].get(OID_NAME_CONSTRAINTS)
        if not value:
            return [], []
        names, networks = [], []
        for tag, content, _ in der_items(der_items(value)[0][1]):
            if tag == 0xA0:
                for _, subtree, _ in der_items(content):
                    found = read_names(subtree)
                    names += found[0]
                    networks += found[1]
        return names, networks

    def permits_name(self, name):
        return dns_label_ok(name) and any(
            name == base or name.endswith("." + base) for base in self.permitted()[0])

    def permits_address(self, address):
        ip = parse_ip(address)
        return ip is not None and any(
            ip.version == net.version and ip in net for net in self.permitted()[1])

    # -- the server certificate (made and replaced automatically) ------------

    def load_server(self):
        """Use the server certificate on file if it is still good. Returns True if so."""
        try:
            with open(self.path("server.pem"), "r", encoding="ascii") as fh:
                info = read_certificate(pem_decode("CERTIFICATE", fh.read()))
            if info["issuer"] != self.authority["subject"]:
                return False
            if not ecdsa_verify(self.authority["public"], info["tbs"], info["signature"]):
                return False
            if info["not_after"] - utc_now() < datetime.timedelta(days=self.RENEW_DAYS):
                return False
            names, addresses = read_names(der_items(info["extensions"][OID_ALT_NAME])[0][1])
            context = self._context()
        except (OSError, ValueError, KeyError, IndexError, UnicodeDecodeError, ssl.SSLError):
            return False
        self.context, self.names = context, names
        self.addresses = [str(a) for a in addresses]
        self.covered = set(self.addresses)
        self.server_until = info["not_after"]
        return True

    def previous_addresses(self):
        try:
            with open(self.path("server.pem"), "r", encoding="ascii") as fh:
                info = read_certificate(pem_decode("CERTIFICATE", fh.read()))
            return [str(a) for a in read_names(der_items(info["extensions"][OID_ALT_NAME])[0][1])[1]]
        except (OSError, ValueError, KeyError, IndexError, UnicodeDecodeError):
            return []

    def issue_server(self, names, addresses):
        """Make a server certificate for these names and addresses (those the
        local certificate may vouch for), and start using it."""
        names = [n for n in dict.fromkeys(names) if self.permits_name(n)]
        wanted = []
        for address in list(addresses) + self.previous_addresses():
            ip = parse_ip(address)
            if ip is not None and str(ip) not in wanted and self.permits_address(str(ip)):
                wanted.append(str(ip))
        wanted = wanted[:self.MAX_ADDRESSES]
        key = ec_new_key()
        public = ec_public(key)
        now = utc_now()
        until = min(now + datetime.timedelta(days=self.SERVER_DAYS), self.authority["not_after"])
        alt_names = [general_name(n) for n in names] + [general_name(ipaddress.ip_address(a)) for a in wanted]
        cert_der = build_certificate(
            self.authority_key, self.authority["subject"], x509_name("InSys on the local network"), public,
            now - datetime.timedelta(days=1), until, [
                x509_extension(OID_BASIC_CONSTRAINTS, der_seq(), critical=True),
                x509_extension(OID_KEY_USAGE, der(0x03, b"\x07\x80"), critical=True),    # digital signature
                x509_extension(OID_EXT_KEY_USAGE, der_seq(OID_SERVER_AUTH)),
                x509_extension(OID_ALT_NAME, der_seq(*alt_names)),
                x509_extension(OID_SUBJECT_KEY_ID, der(0x04, key_identifier(public))),
                x509_extension(OID_AUTHORITY_KEY_ID,
                               der_seq(der(0x80, key_identifier(self.authority["public"])))),
            ])
        self._write("server-key.pem", write_private_key(key, public).encode("ascii"), private=True)
        self._write("server.pem", pem_encode("CERTIFICATE", cert_der).encode("ascii"))
        context = self._context()
        self.self_test(context, wanted[0] if wanted else "localhost")
        self.context, self.names, self.server_until = context, names, until
        self.addresses, self.covered = wanted, set(wanted)

    def _context(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        try:
            context.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20")   # (for TLS 1.2; TLS 1.3 has only strong ones)
        except ssl.SSLError:
            pass
        context.load_cert_chain(self.path("server.pem"), self.path("server-key.pem"))
        return context

    def self_test(self, context, address):
        """Prove, without touching the network, that a device which has installed
        the local certificate will accept this server as genuine at `address`."""
        client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_context.load_verify_locations(cadata=pem_encode("CERTIFICATE", self.authority_der))
        to_server, to_client = ssl.MemoryBIO(), ssl.MemoryBIO()
        client = client_context.wrap_bio(to_client, to_server, server_hostname=address)
        server = context.wrap_bio(to_server, to_client, server_side=True)
        finished = set()
        for _ in range(12):
            for side in (client, server):
                if side in finished:
                    continue
                try:
                    side.do_handshake()
                    finished.add(side)
                except ssl.SSLWantReadError:
                    pass
            if len(finished) == 2:
                return
        raise EncryptionError("the certificate check did not complete")

    # -- used by the server ---------------------------------------------------

    def start(self, host_name, allowed, names, addresses):
        """Get everything ready before the first connection: `allowed` are the
        names a new local certificate may vouch for besides the local-only
        endings, `names` and `addresses` what the server certificate should
        cover. Raises EncryptionError."""
        if ssl is None:
            raise EncryptionError("this Python has no encryption library (the 'ssl' module is missing)")
        with self.lock:
            try:
                self.replaced = self.load_authority()
                if self.authority is None:
                    self.create_authority(host_name, allowed)
                wanted_names = [n for n in names if self.permits_name(n)]
                wanted = [str(parse_ip(a)) for a in addresses if self.permits_address(a)]
                if not (self.load_server() and set(wanted_names) <= set(self.names)
                        and set(wanted) <= self.covered):
                    self.issue_server(wanted_names, wanted)
            except EncryptionError:
                raise
            except (OSError, ValueError, ssl.SSLError) as exc:
                raise EncryptionError(str(exc) or exc.__class__.__name__)

    def context_for(self, address):
        """The certificate to present on a connection that arrived at `address`
        (one of this computer's own). A new address - the network handed this
        computer a different one - is added to the certificate on the spot."""
        ip = parse_ip(address)
        text = str(ip) if ip is not None else ""
        soon = utc_now() + datetime.timedelta(days=self.RENEW_DAYS)
        if text in self.covered and self.server_until > soon:
            return self.context
        with self.lock:
            if (text not in self.covered and self.permits_address(text)) or self.server_until <= soon:
                try:
                    self.issue_server(self.names, [text] + self.addresses)
                except (OSError, ValueError, ssl.SSLError, EncryptionError) as exc:
                    log_error("The server certificate could not be renewed: %s" % exc)
            return self.context



def write_private_key(private, public):
    return pem_encode("EC PRIVATE KEY", der_seq(
        der_int(1), der(0x04, private.to_bytes(32, "big")),
        der(0xA0, OID_P256), der(0xA1, der(0x03, b"\x00" + ec_point_bytes(public)))))


def read_private_key(text):
    parts = der_items(der_items(pem_decode("EC PRIVATE KEY", text))[0][1])
    value = int.from_bytes(parts[1][1], "big")
    if not (parts[1][0] == 0x04 and 1 <= value < EC_N):
        raise ValueError("unreadable key")
    return value


ENCRYPTION_READ_ME = """InSys - encryption on the local network
========================================

The files in this folder let InSys encrypt everything it sends to other
devices on your network (choice 2).

  InSys-certificate.crt
      The InSys local certificate. Each device installs this once; after
      that its browser shows InSys as a secure site. It is not secret. It is
      the same file as "Download certificate" under Admin, System in InSys.

  local-certificate-key.pem, server-key.pem
      Private keys. NEVER copy, email or share these. Anyone who has them
      could pretend to be this InSys to the devices on your network.

  server.pem
      The certificate InSys presents. InSys replaces it by itself.

If these files are lost or deleted InSys makes new ones, and every device
has to install the new certificate once more. They are not part of the
database backup or of "Download database", on purpose: another office that
hosts a copy of the data makes its own.
"""


def encryption_folder():
    return os.path.join(RT.data_dir, "encryption")


def stored_certificate():
    """The local certificate file (what a device installs), or None if none has been made."""
    try:
        with open(os.path.join(encryption_folder(), Encryption.CERTIFICATE_FILE), "rb") as fh:
            data = fh.read()
        read_certificate(data)
        return data
    except (OSError, ValueError):
        return None


def describe_certificate(data):
    """What an administrator needs to recognise the local certificate."""
    info = read_certificate(data)

    def prints(algorithm):
        digest = hashlib.new(algorithm, data).hexdigest().upper()
        return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))
    return {"name": common_name_of(info["subject"]),
            "valid_until": info["not_after"].strftime("%Y-%m-%d"),
            "sha256": prints("sha256"), "sha1": prints("sha1")}


def constraint_safe(name):
    """Whether the local certificate may be allowed to vouch for `name`. Such
    a permission also covers every name ending in '.name', so a one-word name
    is accepted only if it could never be a public ending such as 'dev' or
    'app': those are letters only, so it must contain a digit or a hyphen."""
    if not dns_label_ok(name) or name.startswith("xn--"):
        return False
    return "." in name or bool(re.search(r"[0-9-]", name))


def certificate_names(own, extra):
    """(names the local certificate should be allowed to vouch for,
    names to put on the server certificate) for this computer."""
    short = own.split(".")[0] if own else ""
    allowed = [n for n in dict.fromkeys([own, short] + sorted(extra)) if n and constraint_safe(n)]
    names = ["localhost"] + allowed
    if dns_label_ok(short):
        names += [short + suffix for suffix in LOCAL_NAME_SUFFIXES if suffix != ".localhost"]
    return allowed, list(dict.fromkeys(names))


def session_hash(token, channel):
    """How a sign-in is kept in the database: never the token itself, and tied
    to the kind of connection it was issued on ('tls' for the encrypted local
    network, 'local' for this computer and the internet tunnel). A token is
    therefore of no use on any other kind of connection - and a token issued
    by an InSys older than 1.2.6, when the local network was not encrypted,
    is of no use at all."""
    return hashlib.sha256(("%s:%s" % (channel, token)).encode("utf-8", "replace")).hexdigest()


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def is_loopback(address):
    return address in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


# ---- Keeping choices 1 and 2 off the internet --------------------------------
# Choice 1 listens on this computer only, which the operating system enforces.
# Choice 2 has to listen on the network, so InSys itself checks every connection
# and every request: a connection must come from a local address, and a request
# must show no sign of having been relayed from, or addressed through, the
# internet. Only choice 3 (the tunnel) switches these checks off.

# Address ranges that are never routed on the public internet.
LOCAL_NETWORKS = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8",        # this computer
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",   # private networks
    "169.254.0.0/16",     # link-local (no router involved)
    "::1/128", "fc00::/7", "fe80::/10")]               # the IPv6 equivalents

# Names that only exist on a local network.
LOCAL_NAME_SUFFIXES = (".localhost", ".local", ".lan", ".home", ".internal", ".intranet",
                       ".corp", ".localdomain", ".home.arpa")

# Headers added by services that carry requests in from the internet
# (Cloudflare, ngrok, cloud load balancers and the like). A browser on the
# local network never sends these.
RELAY_HEADER_PREFIXES = ("cf-", "cdn-loop", "true-client-ip", "fastly-", "fly-", "ngrok-", "x-ngrok",
                         "x-vercel-", "x-amz-cf-", "x-amzn-", "x-azure-", "akamai-", "x-akamai")
# Headers in which a proxy names the address a request originally came from.
FORWARD_IP_HEADERS = ("x-forwarded-for", "x-real-ip", "x-client-ip", "x-cluster-client-ip", "forwarded")

LOCAL_ONLY_PAGE = (
    "InSys is running for local use only (choice 1 or 2) and does not answer requests\r\n"
    "that come from, or by way of, the internet.\r\n\r\n"
    "On the host computer use http://localhost and the port shown in the InSys window;\r\n"
    "on the office network use the 'On your network' address shown there.\r\n").encode("ascii")


def parse_ip(text):
    """An IP address out of '1.2.3.4', '1.2.3.4:80', '[::1]:80' and similar; else None."""
    text = (text or "").strip().strip('"')
    if text.startswith("["):
        text = text[1:].split("]")[0]
    elif text.count(":") == 1:
        text = text.split(":")[0]
    try:
        ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return None
    return getattr(ip, "ipv4_mapped", None) or ip


def is_local_address(address):
    """True only for an address that cannot be on the public internet."""
    ip = parse_ip(address)
    return ip is not None and any(ip.version == net.version and ip in net for net in LOCAL_NETWORKS)


def is_local_host_name(value, arrived_on=None):
    """Whether the address a browser asked for is a local one: a local IP address,
    the very address the connection arrived on, 'localhost', a one-word name, this
    computer's own name, or a name with a local-only ending. A public name such
    as a tunnel's or a company's website address is not."""
    host = (value or "").strip().lower()
    if host.startswith("["):
        host = host[1:].split("]")[0]
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    host = host.rstrip(".")
    if not host:
        return False
    ip = parse_ip(host)
    if ip is not None:
        return is_local_address(str(ip)) or (arrived_on is not None and str(ip) == arrived_on)
    if not re.match(r"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$", host):
        return False
    return (host == "localhost" or "." not in host or host in RT.local_names
            or host.endswith(LOCAL_NAME_SUFFIXES))


_blocked_seen = {}
_blocked_lock = threading.Lock()


def note_blocked(address, detail):
    """Record a refused connection or request in the security log, without
    letting a flood of them fill it: once per address per ten minutes, and never
    more than one entry every five seconds."""
    now = time.time()
    with _blocked_lock:
        if now - _blocked_seen.get(address, 0) < 600 or now - _blocked_seen.get("", 0) < 5:
            return
        if len(_blocked_seen) > 2000:
            _blocked_seen.clear()
        _blocked_seen[address] = _blocked_seen[""] = now
    log_error("Refused: %s" % detail)
    try:
        with write_db(bump=False) as conn:
            audit(conn, "blocked", detail, ip=str(address)[:64])
    except Exception:
        pass


def require_internet_mode(what):
    """Interlock: code that reaches the internet runs only in choice 3."""
    if not RT.online_requested:
        raise RuntimeError("%s is only done when InSys is started Online (choice 3)." % what)


TLS_ERRORS = (ssl.SSLError,) if ssl is not None else ()


class Handler(BaseHTTPRequestHandler):
    server_version = "InSys"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 60

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def version_string(self):
        return "InSys"

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    # -- request helpers ----------------------------------------------------

    def forwarded(self, name):
        """A proxy header, believed only while the internet tunnel is running and
        only from the tunnel itself, which connects from this computer. In
        choices 1 and 2 these headers are never believed (and a request that
        carries them is refused: see internet_trace)."""
        if RT.tunnel_active and is_loopback(self.client_address[0]):
            return self.headers.get(name)
        return None

    def internet_trace(self):
        """Why this request looks as if it came from, or through, the internet;
        None if it shows no such sign. Used to refuse it in choices 1 and 2."""
        for name in self.headers.keys():
            if name.lower().startswith(RELAY_HEADER_PREFIXES):
                return "it was relayed by an internet service (it carried the header %s)" % name[:40]
        for name in FORWARD_IP_HEADERS:
            for value in self.headers.get_all(name) or []:
                for token in re.split(r"[,;\s]+", value):
                    ip = parse_ip(token.split("=", 1)[-1])
                    if ip is not None and not is_local_address(str(ip)):
                        return "it was passed on from the public address %s" % ip
        try:
            arrived_on = self.connection.getsockname()[0]
        except OSError:
            arrived_on = None
        host = self.headers.get("Host")
        if not host:
            return "it did not say which address it was meant for"
        for value in (host, self.headers.get("X-Forwarded-Host")):
            if value and not is_local_host_name(value, arrived_on):
                return "it was addressed to '%s', which is not a local address" % value[:80]
        return None

    def client_ip(self):
        value = self.forwarded("CF-Connecting-IP")
        if not value:
            chain = self.forwarded("X-Forwarded-For")
            if chain:
                value = chain.split(",")[0]
        if value:
            value = re.sub(r"[^0-9A-Fa-f:.]", "", value)[:64]
        return value or self.client_address[0]

    def is_https(self):
        return (self.forwarded("X-Forwarded-Proto") or "").lower() == "https"

    def is_tls(self):
        """True when this request arrived over InSys's own encrypted connection."""
        return ssl is not None and isinstance(self.connection, ssl.SSLSocket)

    def channel(self):
        """The kind of connection, which a sign-in is tied to: see session_hash."""
        return "tls" if self.is_tls() else "local"

    def must_use_encryption(self):
        """True for a request that crossed the network without encryption while
        InSys is serving the network. Such a request is never given any data."""
        return RT.tls is not None and not self.is_tls() and not is_loopback(self.client_address[0])

    def cookies(self):
        found = {}
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if value:
                found.setdefault(name, value)
        return found

    def cookie_token(self):
        return self.cookies().get(SECURE_SESSION_COOKIE if self.is_tls() else SESSION_COOKIE)

    def set_session_cookie(self, token):
        cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
            SECURE_SESSION_COOKIE if self.is_tls() else SESSION_COOKIE, token, SESSION_MAX_SECONDS)
        if self.is_tls() or self.is_https():
            cookie += "; Secure"
        self.extra_headers.append(("Set-Cookie", cookie))

    def clear_session_cookie(self):
        if self.is_tls():
            cookie = "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure" % SECURE_SESSION_COOKIE
        else:
            cookie = "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % SESSION_COOKIE
        self.extra_headers.append(("Set-Cookie", cookie))

    def load_session(self, touch):
        """Returns (user_row, session_row) or (None, None)."""
        token = self.cookie_token()
        if not token:
            return None, None
        token_hash = session_hash(token, self.channel())
        now = time.time()
        with read_db() as conn:
            session = conn.execute("SELECT * FROM sessions WHERE token_hash = ?",
                                   (token_hash,)).fetchone()
            if session is None:
                return None, None
            user = conn.execute("SELECT * FROM users WHERE id = ?",
                                (session["user_id"],)).fetchone()
        expired = (now - session["last_seen"] > SESSION_IDLE_SECONDS or
                   now - session["created_at"] > SESSION_MAX_SECONDS)
        if expired or user is None or not user["active"]:
            with write_db(bump=False) as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            return None, None
        if touch and now - session["last_seen"] > SESSION_TOUCH_SECONDS:
            with write_db(bump=False) as conn:
                conn.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
                             (now, token_hash))
        return user, session

    def read_body(self, method):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise ApiError(400, "Unsupported request encoding.")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return {}
        try:
            length = int(raw_length)
        except ValueError:
            self.close_connection = True
            raise ApiError(400, "Bad request.")
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "That request is too large.")
        raw = self.rfile.read(length) if length else b""
        if method == "GET" or not raw:
            return {}
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(415, "Requests must be sent as JSON.")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "The request could not be read.")
        if not isinstance(body, dict):
            raise ApiError(400, "The request could not be read.")
        return body

    # -- responses ----------------------------------------------------------

    def send_bytes(self, status, data, content_type, headers=None, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        for name, value in SECURITY_HEADERS:
            if name == "Content-Security-Policy" and self.content_policy:
                value = self.content_policy
            self.send_header(name, value)
        for name, value in (headers or []):
            self.send_header(name, value)
        for name, value in self.extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_bytes(status, data, "application/json; charset=utf-8")

    # -- dispatch -----------------------------------------------------------

    def dispatch(self, method):
        self.extra_headers = []
        self.content_policy = None
        try:
            self.handle_request(method)
        except ApiError as exc:
            self.try_send_error(exc.status, exc.message, exc.code)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
            self.close_connection = True
        except TLS_ERRORS:
            self.close_connection = True
        except sqlite3.OperationalError:
            log_error("Database error on %s %s:\n%s" % (method, self.path, traceback.format_exc()))
            self.try_send_error(503, "The database is busy. Please try again in a moment.")
        except Exception:
            log_error("Unhandled error on %s %s:\n%s" % (method, self.path, traceback.format_exc()))
            self.try_send_error(500, "Something went wrong on the server. The problem has "
                                     "been written to the InSys log.")

    def try_send_error(self, status, message, code=None):
        try:
            payload = {"error": message}
            if code:
                payload["code"] = code
            self.send_json(status, payload)
        except Exception:
            self.close_connection = True

    def handle_request(self, method):
        if not RT.tunnel_active:
            reason = self.internet_trace()
            if reason:
                self.close_connection = True
                note_blocked(self.client_address[0], "A request from %s was refused because %s."
                             % (self.client_address[0], reason))
                return self.send_bytes(403, LOCAL_ONLY_PAGE, "text/plain; charset=utf-8")
        parsed = urlparse(self.path)
        path = parsed.path
        if self.must_use_encryption():
            return self.answer_unencrypted(method, path)
        if not path.startswith("/api/"):
            self.read_body("GET")  # drain anything sent, keeps the connection in sync
            return self.serve_static(method, path)
        if path == "/api/admin/restore":
            return self.handle_upload(method)
        body = self.read_body(method)
        allowed = False
        for route_method, pattern, func, access in ROUTES:
            match = pattern.fullmatch(path)
            if not match:
                continue
            allowed = True
            if route_method != method:
                continue
            user, session = (None, None)
            if access != "public" or path == "/api/logout":
                user, session = self.load_session(touch=path not in NO_TOUCH_PATHS)
            if access != "public":
                if user is None:
                    raise ApiError(401, "Please sign in.", code="signed_out")
                if access != "auth" and user["must_change"]:
                    raise ApiError(403, "Please choose a new password first.",
                                   code="password_change_required")
                if access == "admin" and user["role"] != "admin":
                    raise ApiError(403, "Only administrators can do that.")
            if method != "GET" and session is not None:
                sent = self.headers.get("X-CSRF-Token") or ""
                if not hmac.compare_digest(sent.encode("utf-8", "replace"),
                                           session["csrf"].encode()):
                    raise ApiError(403, "Your session could not be verified. "
                                        "Please reload the page and try again.", code="csrf")
            ctx = Ctx(self, user, session, body, parse_qs(parsed.query), match)
            result = func(ctx)
            if isinstance(result, RawResponse):
                return self.send_bytes(200, result.data, result.content_type, result.headers)
            return self.send_json(200, result)
        if allowed:
            raise ApiError(405, "Method not allowed.")
        raise ApiError(404, "Not found.")

    def handle_upload(self, method):
        """Receive a transferred database file. Administrators only; the caller is
        checked before a single byte of the file is read."""
        self.close_connection = True  # never reuse a connection that carried an upload
        if method != "POST":
            raise ApiError(405, "Method not allowed.")
        user, session = self.load_session(touch=True)
        if user is None:
            raise ApiError(401, "Please sign in.", code="signed_out")
        if user["must_change"]:
            raise ApiError(403, "Please choose a new password first.", code="password_change_required")
        if user["role"] != "admin":
            raise ApiError(403, "Only administrators can do that.")
        sent = self.headers.get("X-CSRF-Token") or ""
        if not hmac.compare_digest(sent.encode("utf-8", "replace"), session["csrf"].encode()):
            raise ApiError(403, "Your session could not be verified. "
                                "Please reload the page and try again.", code="csrf")
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            raise ApiError(400, "Bad request.")
        if length <= 0:
            raise ApiError(400, "No file was sent.")
        if length > MAX_UPLOAD:
            raise ApiError(413, "That file is too large (the limit is %d MB)." % (MAX_UPLOAD // 1048576))
        path = os.path.join(RT.data_dir, "upload-%s.tmp" % secrets.token_hex(6))
        try:
            remaining = length
            with open(path, "wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1048576, remaining))
                    if not chunk:
                        raise ApiError(400, "The upload was interrupted. Please try again.")
                    out.write(chunk)
                    remaining -= len(chunk)
            ctx = Ctx(self, user, session, {}, {}, None)
            result = h_admin_restore(ctx, path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        self.send_json(200, result)

    def answer_unencrypted(self, method, path):
        """A request that came over the network without encryption gets no data
        and cannot sign in. It is shown the page that explains the one-time
        set-up and moves the browser to the encrypted address; that page, the
        files it needs and the (public) certificate are all it can have."""
        self.end_exposed_session()
        if method != "GET" or path.startswith("/api/"):
            self.close_connection = True
            return self.send_json(403, {
                "error": "InSys only answers on its encrypted address. Open this same address "
                         "starting with https:// instead of http://.",
                "code": "encrypted_only"})
        self.read_body("GET")
        if path == CERTIFICATE_PATH or (path in CONNECT_FILES and path != "/connect"):
            return self.serve_static(method, path)
        host = self.headers.get("Host") or ""
        if re.match(r"^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$", host):
            # Lets the page test whether this device already trusts the encrypted address.
            self.content_policy = CONNECT_POLICY % ("https://" + host)
        self.serve_static(method, "/connect")

    def end_exposed_session(self):
        """A sign-in cookie that has just crossed the network unencrypted may
        have been read on the way, so the sign-in it belongs to is ended."""
        values = [value for name, value in self.cookies().items()
                  if name in (SESSION_COOKIE, SECURE_SESSION_COOKIE)]
        if not values:
            return
        hashes = []
        for value in values:
            hashes += [session_hash(value, "tls"), session_hash(value, "local"),
                       hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()]
        marks = ",".join("?" * len(hashes))
        with read_db() as conn:
            found = conn.execute("SELECT 1 FROM sessions WHERE token_hash IN (%s)" % marks, hashes).fetchone()
        if found:
            with write_db(bump=False) as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash IN (%s)" % marks, hashes)
                audit(conn, "session_exposed",
                      "A sign-in was ended because its cookie was sent without encryption",
                      ip=self.client_address[0])

    def serve_static(self, method, path):
        if method != "GET":
            raise ApiError(405, "Method not allowed.")
        if path == CERTIFICATE_PATH:
            data = stored_certificate()
            if data is None:
                raise ApiError(404, "No certificate has been made yet. Start InSys with choice 2 once.")
            return self.send_bytes(200, data, "application/x-x509-ca-cert")
        entry = STATIC_FILES.get(path)
        if entry is None:
            raise ApiError(404, "Not found.")
        filename, content_type = entry
        try:
            with open(os.path.join(WEB_DIR, filename), "rb") as fh:
                data = fh.read()
        except OSError:
            raise ApiError(404, "Not found.")
        self.send_bytes(200, data, content_type, cache="no-cache")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    # On Windows SO_REUSEADDR would let a second copy bind the same port and
    # steal requests, so it is only enabled elsewhere.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # Deliberately not http.server.HTTPServer.server_bind: that looks this
        # computer's name up in DNS (socket.getfqdn) just to fill in a field
        # InSys never uses, and a DNS lookup is a message onto the network.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def verify_request(self, request, client_address):
        """Decide, before anything is read from it, whether a connection may be
        served at all. Always: this computer itself. In choice 2 as well: other
        computers on a local network address. Never: anything else."""
        peer = client_address[0]
        if is_loopback(peer):
            return True
        if RT.lan and not RT.tunnel_active:
            if is_local_address(peer):
                return True
            try:
                if peer == request.getsockname()[0]:
                    return True   # this computer, reaching itself by its own network address
            except OSError:
                pass
        note_blocked(peer, "A connection from %s was refused: it is not a local network address." % peer)
        return False

    def finish_request(self, request, client_address):
        """While InSys serves the network, a connection that opens with a TLS
        handshake is answered over TLS. Any other gets the ordinary handler,
        which gives this computer itself the full service and anything else
        only the page that explains how to connect securely."""
        encryption = RT.tls
        if encryption is None:
            return ThreadingHTTPServer.finish_request(self, request, client_address)
        try:
            request.settimeout(TLS_HANDSHAKE_SECONDS)
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if not first:
            return
        if first != b"\x16":     # not the first byte of a TLS handshake
            return ThreadingHTTPServer.finish_request(self, request, client_address)
        try:
            context = encryption.context_for(request.getsockname()[0])
            secure = context.wrap_socket(request, server_side=True)
        except (OSError, ValueError):
            return    # the handshake failed, for instance a device that does not trust the certificate yet
        try:
            self.RequestHandlerClass(secure, client_address, self)
        finally:
            try:
                secure.close()
            except OSError:
                pass

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, socket.timeout, TimeoutError) + TLS_ERRORS):
            return
        log_error("Connection error from %s:\n%s" % (client_address, traceback.format_exc()))


# ---------------------------------------------------------------------------
# Internet access (Cloudflare quick tunnel)
# ---------------------------------------------------------------------------

TUNNEL_URL_RE = re.compile(r"https://(?!api\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com")
CLOUDFLARED_RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/"


def cloudflared_asset():
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Windows":
        return "cloudflared-windows-386.exe" if machine in ("x86", "i386", "i686") \
            else "cloudflared-windows-amd64.exe"
    if system == "Linux":
        if machine in ("aarch64", "arm64"):
            return "cloudflared-linux-arm64"
        if machine in ("x86_64", "amd64"):
            return "cloudflared-linux-amd64"
    return None


def find_cloudflared():
    exe = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    local = os.path.join(RT.tools_dir, exe)
    if os.path.isfile(local):
        return local
    return shutil.which("cloudflared")


def download_file(url, dest):
    """Download to dest atomically. Tries Python first, then curl (built into
    Windows 10 and later), which copes with unusual proxy / certificate set-ups."""
    require_internet_mode("Downloading")
    tmp = dest + ".part"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "InSys"})
        with urllib.request.urlopen(request, timeout=60) as response, open(tmp, "wb") as fh:
            shutil.copyfileobj(response, fh)
    except Exception as exc:
        log_error("Download with Python failed (%s); trying curl" % exc)
        curl = shutil.which("curl")
        if not curl:
            raise
        subprocess.run([curl, "-L", "--fail", "--silent", "--show-error", "-o", tmp, url],
                       check=True, timeout=300)
    if os.path.getsize(tmp) < 1000000:
        os.remove(tmp)
        raise RuntimeError("The download was incomplete.")
    os.replace(tmp, dest)
    if os.name != "nt":
        os.chmod(dest, 0o755)


def ensure_cloudflared(interactive=True):
    """Path to cloudflared, downloading it into tools/ if necessary."""
    require_internet_mode("Fetching the online access tool")
    path = find_cloudflared()
    if path:
        return path
    asset = cloudflared_asset()
    if asset is None:
        say("  Online access needs the free 'cloudflared' tool, which is not installed.")
        say("  Install it (for example: brew install cloudflared) and start InSys again.")
        return None
    say("")
    say("  Online access uses Cloudflare's free tunnel tool (cloudflared).")
    say("  It is not on this computer yet, so InSys will download it once")
    say("  (about 60 MB, needs an internet connection) from Cloudflare's")
    say("  official GitHub page:")
    say("    " + CLOUDFLARED_RELEASE + asset)
    if interactive and sys.stdin is not None and sys.stdin.isatty():
        try:
            answer = input("  Download it now? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer not in ("", "y", "yes"):
            say("  Skipped. InSys will run on this computer only.")
            return None
    os.makedirs(RT.tools_dir, exist_ok=True)
    dest = os.path.join(RT.tools_dir, "cloudflared.exe" if os.name == "nt" else "cloudflared")
    say("  Downloading... this can take a minute.")
    try:
        download_file(CLOUDFLARED_RELEASE + asset, dest)
    except Exception as exc:
        log_error("cloudflared download failed: %s" % exc)
        say("  The download failed (%s)." % exc)
        say("  Check the internet connection and start InSys again, or see README.md")
        say("  ('Online access') for how to install cloudflared yourself.")
        return None
    say("  Download complete.")
    return dest


class Tunnel(threading.Thread):
    """Runs cloudflared and keeps it running; publishes the public URL."""

    def __init__(self, exe, port):
        threading.Thread.__init__(self, daemon=True)
        self.exe = exe
        self.port = port
        self.proc = None
        self.stopping = False

    def run(self):
        delay = 5
        while not self.stopping:
            started = time.time()
            was_online = self.run_once()
            time.sleep(0.7)  # lets a Ctrl+C reach the main thread before we report
            if self.stopping:
                break
            RT.public_url = None
            RT.tunnel_status = "reconnecting"
            self.write_url_file()
            say("")
            if was_online:
                say("  Online access was interrupted. Reconnecting in %d seconds..." % delay)
            else:
                say("  Online access could not be set up (is the internet connected?).")
                say("  Details are in %s" % os.path.join(RT.data_dir, "tunnel.log"))
                say("  InSys still works on this computer. Trying again in %d seconds..." % delay)
            time.sleep(delay)
            delay = 5 if time.time() - started > 300 else min(delay * 2, 120)

    def run_once(self):
        require_internet_mode("Opening the internet tunnel")
        RT.tunnel_status = "starting"
        command = [self.exe, "tunnel", "--no-autoupdate", "--url",
                   "http://127.0.0.1:%d" % self.port]
        log_path = os.path.join(RT.data_dir, "tunnel.log")
        try:
            self.proc = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, cwd=RT.data_dir)
        except OSError as exc:
            log_error("Could not start cloudflared: %s" % exc)
            say("  Could not start the online access tool: %s" % exc)
            return False
        write_tunnel_pid(self.proc.pid)
        was_online = False
        try:
            with open(log_path, "w", encoding="utf-8", errors="replace") as log:
                for raw in self.proc.stdout:
                    line = raw.decode("utf-8", "replace").rstrip()
                    log.write(line + "\n")
                    log.flush()
                    found = TUNNEL_URL_RE.search(line)
                    if found and RT.public_url != found.group(0):
                        RT.public_url = found.group(0)
                        RT.tunnel_status = "online"
                        was_online = True
                        self.write_url_file()
                        self.announce()
        except Exception:
            log_error("Tunnel reader failed:\n" + traceback.format_exc())
        finally:
            try:
                self.proc.wait(timeout=10)
                clear_tunnel_pid()
            except Exception:
                pass
        return was_online

    def announce(self):
        say("")
        say("  " + "=" * 66)
        say("  ONLINE ACCESS IS READY")
        say("  Your team can sign in from anywhere at:")
        say("")
        say("      " + RT.public_url)
        say("")
        say("  The address stays the same until InSys is restarted, when a new one")
        say("  is issued. It is always shown inside InSys under Admin > System.")
        say("  " + "=" * 66)

    def write_url_file(self):
        path = os.path.join(RT.data_dir, "public-url.txt")
        try:
            if RT.public_url:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(RT.public_url + "\n")
            elif os.path.exists(path):
                os.remove(path)
        except OSError:
            pass

    def stop(self):
        self.stopping = True
        proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        RT.public_url = None
        RT.tunnel_active = False
        clear_tunnel_pid()
        self.write_url_file()


# A tunnel must never outlive the InSys session that opened it. Normally it is
# closed with InSys; if InSys was ended abruptly it can be left running, still
# offering the old public address. Its process number is kept on file so that
# the next start, in any mode, can find it and close it.

def tunnel_pid_path():
    return os.path.join(RT.data_dir, "tunnel.pid")


def write_tunnel_pid(pid):
    try:
        with open(tunnel_pid_path(), "w", encoding="ascii") as fh:
            fh.write(str(pid))
    except OSError:
        pass


def clear_tunnel_pid():
    try:
        os.remove(tunnel_pid_path())
    except OSError:
        pass


def is_tunnel_process(pid):
    """Whether process `pid` is running and is the tunnel tool (so that an
    unrelated program that happens to have been given the same number is never touched)."""
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=20).stdout
            return "cloudflared" in out.lower()
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as fh:
                return b"cloudflared" in fh.read()
        except OSError:
            out = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                 capture_output=True, text=True, timeout=20).stdout
            return "cloudflared" in out
    except Exception:
        return False


def stop_leftover_tunnel():
    """Close a tunnel left running by an earlier session. Returns True if one was closed."""
    try:
        with open(tunnel_pid_path(), "r", encoding="ascii") as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return False
    closed = False
    if pid > 0 and is_tunnel_process(pid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20)
            else:
                os.kill(pid, signal.SIGTERM)
                for _ in range(20):
                    time.sleep(0.1)
                    if not is_tunnel_process(pid):
                        break
                else:
                    os.kill(pid, signal.SIGKILL)
            closed = True
        except Exception as exc:
            log_error("Could not close a leftover tunnel (process %d): %s" % (pid, exc))
    clear_tunnel_pid()
    try:
        os.remove(os.path.join(RT.data_dir, "public-url.txt"))
    except OSError:
        pass
    return closed


# ---------------------------------------------------------------------------
# Start-up
# ---------------------------------------------------------------------------

def dir_writable(path):
    try:
        fd, name = tempfile.mkstemp(prefix="insys-write-test-", dir=path)
        os.close(fd)
        os.remove(name)
        return True
    except OSError:
        return False


def default_data_dir():
    """The data folder: beside the program, unless that place is read-only."""
    beside = os.path.join(APP_DIR, DATA_DIR_NAME)
    if not PACKAGED or os.path.isdir(beside) or dir_writable(APP_DIR):
        return beside
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "InSys", DATA_DIR_NAME)


def inside_temp_folder(path):
    """True when path is in the system temporary folder - which is where Windows
    puts a program that is run straight out of a ZIP file. Data kept there would
    be thrown away, so InSys refuses to create a new database in such a place."""
    try:
        here = os.path.normcase(os.path.realpath(path))
        temp = os.path.normcase(os.path.realpath(tempfile.gettempdir()))
    except OSError:
        return False
    return here == temp or here.startswith(temp.rstrip("\\/") + os.sep)


def read_key(valid, default, seconds):
    """Wait up to `seconds` for one of the characters in `valid`.
    Enter, or running out of time, gives `default`."""
    if os.name == "nt":
        import msvcrt
        deadline = time.time() + seconds
        while time.time() < deadline:
            if msvcrt.kbhit():
                key = msvcrt.getwch()
                if key in ("\x00", "\xe0"):   # arrow / function key: swallow its second half
                    msvcrt.getwch()
                elif key == "\x03":
                    raise KeyboardInterrupt
                elif key in ("\r", "\n"):
                    return default
                elif len(key) == 1 and key in valid:
                    return key
            else:
                time.sleep(0.05)
        return default
    import select
    ready, _, _ = select.select([sys.stdin], [], [], seconds)
    if not ready:
        return default
    answer = sys.stdin.readline().strip()[:1]
    return answer if len(answer) == 1 and answer in valid else default


MODES = {"1": "local", "2": "lan", "3": "online"}


def remembered_mode():
    try:
        with open(os.path.join(RT.data_dir, "start-mode.txt"), "r", encoding="utf-8") as fh:
            value = fh.read().strip()
    except OSError:
        return "1"
    return value if value in MODES else "1"


def remember_mode(key):
    try:
        with open(os.path.join(RT.data_dir, "start-mode.txt"), "w", encoding="utf-8") as fh:
            fh.write(key)
    except OSError:
        pass


def start_menu(ask=read_key):
    """Ask how to run. Returns 'local', 'lan', 'online' or 'reset'."""
    default = remembered_mode()
    say("")
    say("=" * 70)
    say("  InSys - Internal Systems   (version %s)" % VERSION)
    say("=" * 70)
    say("")
    say("  How would you like to run InSys?")
    say("")
    say("    1  This computer only                      - works offline")
    say("    2  This computer and the office network    - works offline, encrypted")
    say("    3  Online, from anywhere over the internet - needs internet")
    say("")
    say("    4  Reset the administrator password")
    say("")
    if default == "3":
        # Going online is never done on a timer: it has to be chosen each time.
        say("  Press 1, 2, 3 or 4.  Enter chooses [3] (Online), as last time.")
        say("  InSys will not go online by itself; it waits here until you choose.")
        key = ask("1234", default, 366 * 24 * 3600)
    else:
        say("  Press 1, 2, 3 or 4.  Enter, or waiting %d seconds, chooses [%s]."
            % (MENU_SECONDS, default))
        key = ask("1234", default, MENU_SECONDS)
    if key not in ("1", "2", "3", "4"):
        key = default
    say("  -> %s" % key)
    if key == "4":
        return "reset"
    remember_mode(key)
    return MODES[key]


def keep_awake():
    """Ask Windows not to go to sleep on idle while other people depend on this
    computer. Does not override the lid, the power button or a manual sleep."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        set_state = ctypes.windll.kernel32.SetThreadExecutionState
        set_state.argtypes = [ctypes.c_uint]
        set_state.restype = ctypes.c_uint
        return bool(set_state(ES_CONTINUOUS | ES_SYSTEM_REQUIRED))
    except Exception:
        return False


def finish(code):
    """Leave the last message readable when InSys runs in its own window."""
    if RT.pause_on_exit and sys.stdin is not None:
        try:
            if sys.stdin.isatty():
                say("")
                input("  Press Enter to close this window. ")
        except (EOFError, KeyboardInterrupt, OSError, ValueError):
            pass
    return code


def local_opener():
    """urllib opener that never routes localhost through a system proxy."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def running_instance():
    """Port of an InSys server already running on this data folder, else None."""
    lock_path = os.path.join(RT.data_dir, "insys.lock")
    try:
        with open(lock_path, "r", encoding="utf-8") as fh:
            lock = json.load(fh)
        port = int(lock["port"])
        instance = str(lock["instance"])
    except Exception:
        return None
    try:
        with local_opener().open("http://127.0.0.1:%d/api/ping" % port, timeout=2) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    if data.get("app") == "insys" and data.get("instance") == instance:
        return port
    return None


def write_lock():
    path = os.path.join(RT.data_dir, "insys.lock")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"port": RT.port, "instance": RT.instance, "pid": os.getpid()}, fh)


def remove_lock():
    try:
        os.remove(os.path.join(RT.data_dir, "insys.lock"))
    except OSError:
        pass


def bind_server(host, preferred_port, strict):
    ports = [preferred_port] if strict else list(range(preferred_port, preferred_port + 20))
    last_error = None
    for port in ports:
        try:
            return Server((host, port), Handler)
        except OSError as exc:
            last_error = exc
    raise last_error


def lan_addresses():
    found = []
    try:
        # Asks the operating system which of this computer's addresses faces the
        # local network. No packet is sent: "connecting" a datagram socket only
        # selects a route, and the address used is a private one in any case.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("10.255.255.255", 1))
            found.append(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    return [a for a in found if not a.startswith("127.")]


def discard_certificate():
    """Command-line: set the local certificate aside so that the next start in
    choice 2 makes a new one."""
    folder = encryption_folder()
    if stored_certificate() is None and not os.path.exists(os.path.join(folder, "local-certificate-key.pem")):
        say("")
        say("  There is no certificate yet. One is made the first time InSys is")
        say("  started for the office network (choice 2).")
        return 0
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    for name in ("local-certificate-key.pem", Encryption.CERTIFICATE_FILE, "server-key.pem", "server.pem"):
        try:
            os.replace(os.path.join(folder, name), os.path.join(folder, "replaced-%s-%s" % (stamp, name)))
        except OSError:
            pass
    if os.path.exists(RT.db_path):
        try:
            with write_db(bump=False) as conn:
                audit(conn, "certificate_discarded", "From the host computer")
        except Exception:
            pass
    say("")
    say("  The certificate has been set aside. The next time InSys is started")
    say("  for the office network (choice 2) it makes a new one, and every")
    say("  device has to install the new certificate once.")
    say("")
    say("  On each device the old one, named \"InSys local certificate ...\",")
    say("  can then be removed from the list of trusted certificates.")
    return 0


def reset_admin(username):
    """Command-line recovery: give an account a new temporary password."""
    if not os.path.exists(RT.db_path):
        say("No InSys database found in %s - start InSys once first." % RT.data_dir)
        return 1
    init_db()
    password = generate_password(groups=4)
    with write_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            say("There is no user called '%s'." % username)
            return 1
        role = "admin" if row["username"].lower() == "admin" else row["role"]
        conn.execute("UPDATE users SET pw_hash = ?, must_change = 1, active = 1, role = ? "
                     "WHERE id = ?", (hash_password(password), role, row["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        audit(conn, "password_reset", "%s (from the host computer)" % row["username"])
    write_first_login_file(row["username"], password)
    say("")
    say("  Password reset for '%s'." % row["username"])
    say("")
    say("      Username: %s" % row["username"])
    say("      Password: %s" % password)
    say("")
    say("  You will be asked to choose a new password when you sign in.")
    say("  (Also saved in %s)" % RT.first_login_file)
    say("")
    return 0


def banner(first_password):
    line = "=" * 70
    say("")
    say(line)
    say("  InSys - Internal Systems   (version %s)" % VERSION)
    say(line)
    say("")
    say("  InSys is running. Open it in a web browser:")
    say("")
    say("      On this computer :  http://localhost:%d" % RT.port)
    network = [a for a in RT.lan_ips if RT.tls is not None and a in RT.tls.covered]
    for address in network:
        say("      On your network  :  https://%s:%d" % (address, RT.port))
    if RT.online_requested:
        say("      Over the internet:  (being set up - the address appears below)")
    elif PACKAGED:
        say("      Over the internet:  off  (restart InSys and choose 3 to switch on)")
    else:
        say("      Over the internet:  off  (use Start-InSys-Online.bat to switch on)")
    if not RT.online_requested:
        say("")
        if RT.lan:
            say("  InSys is answering this computer and local network addresses only.")
        else:
            say("  InSys is answering this computer only.")
        say("  It makes no connection to the internet, and refuses any that arrives from it.")
    if RT.lan and not network:
        say("")
        say("  InSys could not tell which network address this computer has. If it")
        say("  is not connected to the office network, connect it and restart InSys.")
        say("  If it is, other devices can reach InSys at this computer's IPv4")
        say("  address (Windows shows it under Settings > Network & internet):")
        say("")
        say("      https://<that address>:%d       (encrypted)" % RT.port)
        say("      http://<that address>:%d        (first visit: the set-up steps)" % RT.port)
    elif RT.lan:
        say("")
        say("  Everything InSys sends to other devices on the network is encrypted.")
        say("  Each device needs the InSys certificate installed once. On a device")
        say("  that does not have it yet, open this address and follow the steps:")
        say("")
        say("      http://%s:%d" % (network[0], RT.port))
        say("")
        if RT.tls.created and RT.tls.replaced:
            say("  NOTE: the certificate made earlier could not be used (%s)," % RT.tls.replaced)
            say("  so a new one was made. Every device has to install the new one, once.")
            say("")
        elif RT.tls.created:
            say("  The certificate was made just now and is kept in:")
            say("      %s" % encryption_folder())
            say("")
        say("  If Windows asks whether to allow InSys on the network, choose Allow.")
    say("")
    creds = read_first_login()
    if creds:
        say("  " + "-" * 66)
        if first_password:
            say("  FIRST RUN - an administrator account has been created for you:")
        else:
            say("  Administrator sign-in (password not yet changed):")
        say("")
        say("      Username: %s" % creds[0])
        say("      Password: %s" % creds[1])
        say("")
        say("  You will be asked to choose your own password when you sign in.")
        say("  These details are also saved in:")
        say("      %s" % RT.first_login_file)
        say("  " + "-" * 66)
        say("")
    say("  Your data is stored in:  %s" % RT.data_dir)
    if RT.upgraded_from is not None:
        say("")
        say("  Your existing data has been brought forward to this version of InSys.")
        say("  Everything you entered before is still here. A copy of the data as it")
        say("  was before the upgrade has been kept in:")
        say("      %s" % RT.upgrade_backup)
    say("")
    say("  Keep this window open while InSys is in use.")
    say("  To stop InSys, close this window or press Ctrl+C.")
    if RT.kept_awake:
        say("  This computer will not go to sleep by itself while InSys is running.")
    say(line)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="insys", description="InSys - Internal Systems work tracker")
    parser.add_argument("--online", action="store_true",
                        help="publish a secure internet address (Cloudflare quick tunnel)")
    parser.add_argument("--lan", action="store_true",
                        help="also accept connections from other computers on your local network")
    parser.add_argument("--port", type=int, default=None,
                        help="port to listen on (default %d, or the next free one)" % DEFAULT_PORT)
    parser.add_argument("--data-dir", default=None,
                        help="folder for the database and backups (default: ./data)")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open the web browser automatically")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="an extra name by which this computer is reached on your own network "
                             "(for example an internal DNS name); may be given more than once")
    parser.add_argument("--menu", action="store_true",
                        help="ask how to run at start-up (the default for InSys.exe)")
    parser.add_argument("--no-menu", action="store_true",
                        help="never ask; run for this computer only unless told otherwise")
    parser.add_argument("--new-certificate", action="store_true",
                        help="discard the certificate used to encrypt the local network and make a new "
                             "one at the next start (every device must then install it again), then exit")
    parser.add_argument("--reset-admin", action="store_true",
                        help="give the administrator a new temporary password, then exit")
    parser.add_argument("--user", default="admin",
                        help="account for --reset-admin (default: admin)")
    parser.add_argument("--version", action="version", version="InSys " + VERSION)
    return parser.parse_args(argv)


def main(argv=None):
    """Run InSys; returns the process exit code."""
    try:
        return finish(run(argv))
    except KeyboardInterrupt:
        return 0
    except Exception:
        log_error("InSys stopped unexpectedly:\n" + traceback.format_exc())
        say("")
        say("  InSys stopped because of an unexpected problem:")
        say("")
        say("  " + traceback.format_exc().strip().splitlines()[-1])
        say("")
        say("  Your data has not been changed. Details were written to:")
        say("      %s" % os.path.join(RT.data_dir, "insys.log"))
        return finish(1)


def run(argv=None):
    if sys.version_info < MIN_PYTHON:
        say("InSys needs Python %d.%d or newer. This is Python %s."
            % (MIN_PYTHON[0], MIN_PYTHON[1], platform.python_version()))
        return 1
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    if PACKAGED and os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW("InSys - Internal Systems")
        except Exception:
            pass
    args = parse_args(argv)
    if args.data_dir:
        RT.data_dir = os.path.abspath(args.data_dir)
    elif os.environ.get("INSYS_DATA_DIR"):
        RT.data_dir = os.path.abspath(os.environ["INSYS_DATA_DIR"])
    else:
        RT.data_dir = default_data_dir()
        if PACKAGED and not os.path.isdir(RT.data_dir) and inside_temp_folder(APP_DIR):
            say("")
            say("  InSys is being run from a temporary folder:")
            say("      %s" % APP_DIR)
            say("")
            say("  This usually means it was opened straight from inside a ZIP file")
            say("  or an email. Anything saved here would be lost.")
            say("")
            say("  Please copy InSys.exe to a permanent folder first - for example")
            say("  C:\\InSys or your Documents folder - and start it from there.")
            return 1
    try:
        os.makedirs(RT.data_dir, exist_ok=True)
    except OSError as exc:
        say("InSys cannot create its data folder (%s): %s" % (RT.data_dir, exc))
        return 1

    if args.reset_admin:
        return reset_admin(args.user.strip().lower())

    existing = running_instance()
    if existing:
        url = "http://localhost:%d" % existing
        say("")
        say("  InSys is already running on this computer: %s" % url)
        say("  Opening it in your browser. To restart InSys (for example to switch")
        say("  online access on), close the other InSys window first.")
        say("")
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        return 0

    if stop_leftover_tunnel():
        say("")
        say("  An internet connection left open by an earlier InSys session was closed.")

    if args.new_certificate:
        return discard_certificate()

    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        say("The 'web' folder is missing next to insys.py. Please extract the complete")
        say("InSys folder again and start it from there.")
        if PACKAGED:
            say("(InSys.exe may have been damaged or partly removed by antivirus software.")
            say("Download it again, or restore it, and start it once more.)")
        return 1

    interactive = sys.stdin is not None and sys.stdin.isatty()
    wants_menu = (PACKAGED or args.menu) and not args.no_menu
    if wants_menu and interactive and not (args.online or args.lan):
        mode = start_menu()
        if mode == "reset":
            return reset_admin(args.user.strip().lower())
        args.online = mode == "online"
        args.lan = mode == "lan"

    try:
        first_password = init_db()
    except DatabaseTooNew:
        say("")
        say("  This data was last used with a newer version of InSys than this one")
        say("  (this is version %s)." % VERSION)
        say("")
        say("  Please start the newer InSys instead. Nothing has been changed.")
        say("      Data folder: %s" % RT.data_dir)
        return 1
    except sqlite3.Error as exc:
        say("InSys could not open its database (%s): %s" % (RT.db_path, exc))
        return 1
    auto_backup()

    RT.lan = args.lan
    RT.online_requested = args.online
    RT.tunnel_active = False
    RT.local_names = set(name.strip().lower().rstrip(".") for name in args.allow_host if name.strip())
    try:
        own = socket.gethostname().strip().lower().rstrip(".")   # read from this computer; no lookup is made
    except OSError:
        own = ""
    if own:
        RT.local_names.add(own)
    RT.tls = None
    RT.lan_ips = lan_addresses() if args.lan else []
    if args.lan:
        # Nothing is served to the network until encryption is ready: if it
        # cannot be set up, InSys does not start for the network at all.
        encryption = Encryption(encryption_folder())
        allowed, names = certificate_names(own, RT.local_names)
        try:
            encryption.start(own, allowed, names,
                             RT.lan_ips + ["127.0.0.1", "::1"])
        except EncryptionError as exc:
            log_error("Encryption could not be set up: %s" % exc)
            say("")
            say("  InSys could not set up encryption for the office network:")
            say("")
            say("      %s" % exc)
            say("")
            say("  It has not started, so nothing has been sent over the network.")
            say("  Your data has not been changed. You can still start InSys and")
            say("  choose 1 to use it on this computer.")
            return 1
        RT.tls = encryption
        if encryption.created:
            with write_db(bump=False) as conn:
                audit(conn, "certificate_created",
                      "%s%s" % (describe_certificate(encryption.authority_der)["name"],
                                "; the earlier one could not be used: %s" % encryption.replaced
                                if encryption.replaced else ""))
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        server = bind_server(host, args.port or DEFAULT_PORT, strict=args.port is not None)
    except OSError as exc:
        say("InSys could not start on port %d: %s" % (args.port or DEFAULT_PORT, exc))
        say("Another program may be using it. Try:  --port 8090")
        return 1
    RT.port = server.server_address[1]
    try:  # an address left over from a previous run is no longer valid
        os.remove(os.path.join(RT.data_dir, "public-url.txt"))
    except OSError:
        pass
    write_lock()
    atexit.register(remove_lock)

    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=backup_loop, daemon=True).start()
    if args.online or args.lan:
        RT.kept_awake = keep_awake()
    banner(first_password)

    tunnel = None
    if args.online:
        exe = ensure_cloudflared()
        if exe:
            say("")
            say("  Setting up online access...")
            RT.tunnel_active = True
            tunnel = Tunnel(exe, RT.port)
            tunnel.start()
            atexit.register(tunnel.stop)
        else:
            RT.tunnel_status = "unavailable"

    if not args.no_browser:
        try:
            webbrowser.open("http://localhost:%d" % RT.port)
        except Exception:
            pass

    def stop_requested(signum, frame):
        raise KeyboardInterrupt

    # Ctrl+C, Ctrl+Break and a polite "terminate" all shut InSys down cleanly.
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), stop_requested)
            except (ValueError, OSError):
                pass

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        say("")
        say("  Stopping InSys...")
    finally:
        if tunnel is not None:
            tunnel.stop()
        server.shutdown()
        server.server_close()
        remove_lock()
    say("  InSys has stopped. Your data is safe in: %s" % RT.data_dir)
    RT.pause_on_exit = False
    if PACKAGED:
        time.sleep(2)  # long enough to read the line above before the window goes
    return 0


if __name__ == "__main__":
    sys.exit(main())
