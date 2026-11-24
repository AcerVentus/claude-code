#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""InSys - Internal Systems work tracker.

A single-file server that uses only the Python standard library, so it runs on
Windows (and macOS / Linux) with nothing to install besides Python itself.

    python insys.py              start for this computer only
    python insys.py --online     also publish a secure internet address
    python insys.py --help       all options

Data lives in the "data" folder next to this file (SQLite database, backups).
"""

import argparse
import atexit
import datetime
import hashlib
import hmac
import json
import math
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "1.0.0"
MIN_PYTHON = (3, 9)

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")
TOOLS_DIR = os.path.join(APP_DIR, "tools")

DEFAULT_PORT = 8080
MAX_BODY = 1024 * 1024  # 1 MB per request is plenty for a tracker

SESSION_COOKIE = "insys_session"
SESSION_IDLE_SECONDS = 12 * 3600
SESSION_MAX_SECONDS = 7 * 24 * 3600
SESSION_TOUCH_SECONDS = 60

PBKDF2_ITERATIONS = int(os.environ.get("INSYS_PBKDF2_ITERATIONS", "600000"))
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
    },
}

ROLES = {
    "admin": "Administrator",
    "finance": "Finance",
    "office": "Office Administrator",
    "staff": "Staff",
}

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
}


# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

class Runtime:
    """Process-wide state. One instance, RT, created at import time."""

    def __init__(self):
        self.data_dir = os.path.join(APP_DIR, "data")
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

    @property
    def db_path(self):
        return os.path.join(self.data_dir, "insys.db")

    @property
    def backup_dir(self):
        return os.path.join(self.data_dir, "backups")

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
    version INTEGER NOT NULL DEFAULT 1
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
    version INTEGER NOT NULL DEFAULT 1
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


def init_db():
    """Create the schema and, on the very first run, the administrator account.

    Returns the administrator's initial password if one was just created.
    """
    os.makedirs(RT.data_dir, exist_ok=True)
    os.makedirs(RT.backup_dir, exist_ok=True)
    created_password = None
    with write_db(bump=False) as conn:
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        if meta_get(conn, "schema_version") is None:
            meta_set(conn, "schema_version", "1")
            meta_set(conn, "org_name", "")
            meta_set(conn, "currency", "")
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
    return team is None or user["role"] == "admin" or user["role"] == team


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


def get_record(conn, record_id, user):
    """Fetch a record the user may see, or raise 404 (never reveals restricted rows)."""
    row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if row is None or not can_view(user, row["module"]):
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


def add_activity(conn, record_id, user, kind, text, action_date=None):
    conn.execute(
        "INSERT INTO activity (record_id, user_id, at, kind, text, action_date) VALUES (?,?,?,?,?,?)",
        (record_id, user["id"], now_iso(), kind, text, action_date))


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

RECORD_FIELDS = ["title", "organisation", "contact_name", "contact_info", "category",
                 "status", "priority", "owner_id", "amount", "start_date", "due_date",
                 "description", "next_action", "next_action_date"]


def parse_record_fields(conn, body, module, existing=None):
    """Validate the record fields present in body. Returns {column: value}."""
    cfg = MODULES[module]
    statuses = [s[0] for s in cfg["statuses"]]
    creating = existing is None
    out = {}

    def present(key):
        return creating or key in body

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
            (hashlib.sha256(token.encode()).hexdigest(), row["id"], csrf, now, now))
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
                    for r in conn.execute("SELECT id, ref, module FROM records")}
        marks = ",".join("?" * len(mods))
        records = [dict(r) for r in conn.execute(
            "SELECT * FROM records WHERE module IN (%s) ORDER BY id" % marks, mods)]
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
            if a in visible_ids or b in visible_ids:
                links.append([a, b])
                stub(a)
                stub(b)
        tasks = []
        for t in conn.execute("SELECT * FROM tasks ORDER BY id"):
            mine = t["assignee_id"] == user["id"] or t["created_by"] == user["id"]
            on_visible = t["record_id"] is not None and t["record_id"] in visible_ids
            if user["role"] == "admin" or mine or on_visible:
                tasks.append(dict(t))
                if t["record_id"] is not None:
                    stub(t["record_id"])
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
        "meta": {
            "app_version": VERSION,
            "modules": module_meta(),
            "visible_modules": mods,
            "roles": ROLES,
            "priorities": PRIORITIES,
            "task_statuses": TASK_STATUSES,
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
            "r.id AS record_id, r.ref, r.title, r.module "
            "FROM activity a JOIN records r ON r.id = a.record_id "
            "WHERE r.module IN (%s) ORDER BY a.id DESC LIMIT 40" % marks, mods).fetchall()
    return {"activity": [dict(r) for r in rows]}


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
        conn.execute("DELETE FROM records WHERE id = ?", (row["id"],))
        audit(conn, "record_deleted", "%s %s" % (row["ref"], row["title"]),
              user=ctx.user, ip=ctx.ip)
    return {"ok": True}


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
        if fields["record_id"] is not None:
            add_activity(conn, fields["record_id"], ctx.user, "task",
                         "Task added: %s (assigned to %s)"
                         % (fields["title"], user_name(conn, fields["assignee_id"])))
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
        return {"task": dict(row)}


def h_task_update(ctx):
    with write_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", (ctx.arg(),)).fetchone()
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
            if record_id is not None:
                if changed.get("status") == "Done":
                    add_activity(conn, record_id, ctx.user, "task", "Task completed: %s" % title)
                elif "status" in changed and task["status"] == "Done":
                    add_activity(conn, record_id, ctx.user, "task", "Task reopened: %s" % title)
                if "assignee_id" in changed:
                    add_activity(conn, record_id, ctx.user, "task",
                                 "Task reassigned: %s (now with %s)"
                                 % (title, user_name(conn, changed["assignee_id"])))
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task["id"],)).fetchone()
        return {"task": dict(row)}


def h_task_delete(ctx):
    with write_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", (ctx.arg(),)).fetchone()
        if task is None:
            return {"ok": True}
        if not (ctx.user["role"] == "admin" or ctx.user["id"] == task["created_by"]):
            raise ApiError(403, "Only the person who created a task, or an administrator, "
                                "can delete it.")
        conn.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
        if task["record_id"] is not None:
            add_activity(conn, task["record_id"], ctx.user, "task",
                         "Task deleted: %s" % task["title"])
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
    }


def h_admin_settings(ctx):
    org_name = text_field(ctx.body, "org_name", "Organisation name", 100)
    currency = text_field(ctx.body, "currency", "Currency", 6)
    with write_db() as conn:
        meta_set(conn, "org_name", org_name)
        meta_set(conn, "currency", currency)
        audit(conn, "settings_changed", "", user=ctx.user, ip=ctx.ip)
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
    name = "insys-backup-%s.db" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return RawResponse(data, "application/octet-stream",
                       [("Content-Disposition", 'attachment; filename="%s"' % name)])


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
    ("POST", r"/api/records", h_record_create, "user"),
    ("PUT", r"/api/records/(\d{1,12})", h_record_update, "user"),
    ("DELETE", r"/api/records/(\d{1,12})", h_record_delete, "admin"),
    ("POST", r"/api/records/(\d{1,12})/actions", h_record_action, "user"),
    ("POST", r"/api/records/(\d{1,12})/notes", h_record_note, "user"),
    ("GET", r"/api/records/(\d{1,12})/history", h_record_history, "user"),
    ("POST", r"/api/records/(\d{1,12})/links", h_link_create, "user"),
    ("DELETE", r"/api/records/(\d{1,12})/links/(\d{1,12})", h_link_delete, "user"),
    ("POST", r"/api/records/(\d{1,12})/xrefs", h_xref_create, "user"),
    ("DELETE", r"/api/records/(\d{1,12})/xrefs/(\d{1,12})", h_xref_delete, "user"),
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
]
ROUTES = [(m, re.compile(p), fn, access) for (m, p, fn, access) in ROUTES]

# Version polls must not keep an otherwise idle session alive.
NO_TOUCH_PATHS = ("/api/version",)


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def is_loopback(address):
    return address in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


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
        """A proxy header, trusted only when the request came from this machine
        (i.e. from the secure tunnel, which runs locally)."""
        if is_loopback(self.client_address[0]):
            return self.headers.get(name)
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

    def cookie_token(self):
        header = self.headers.get("Cookie") or ""
        for part in header.split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE and value:
                return value
        return None

    def set_session_cookie(self, token):
        cookie = "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
            SESSION_COOKIE, token, SESSION_MAX_SECONDS)
        if self.is_https():
            cookie += "; Secure"
        self.extra_headers.append(("Set-Cookie", cookie))

    def clear_session_cookie(self):
        self.extra_headers.append(
            ("Set-Cookie", "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % SESSION_COOKIE))

    def load_session(self, touch):
        """Returns (user_row, session_row) or (None, None)."""
        token = self.cookie_token()
        if not token:
            return None, None
        token_hash = hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()
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
        try:
            self.handle_request(method)
        except ApiError as exc:
            self.try_send_error(exc.status, exc.message, exc.code)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
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
        parsed = urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self.read_body("GET")  # drain anything sent, keeps the connection in sync
            return self.serve_static(method, path)
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

    def serve_static(self, method, path):
        if method != "GET":
            raise ApiError(405, "Method not allowed.")
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
        ThreadingHTTPServer.server_bind(self)

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, socket.timeout, TimeoutError)):
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
    local = os.path.join(TOOLS_DIR, exe)
    if os.path.isfile(local):
        return local
    return shutil.which("cloudflared")


def download_file(url, dest):
    """Download to dest atomically. Tries Python first, then curl (built into
    Windows 10 and later), which copes with unusual proxy / certificate set-ups."""
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
    say("  (about 60 MB) from Cloudflare's official GitHub page:")
    say("    " + CLOUDFLARED_RELEASE + asset)
    if interactive and sys.stdin is not None and sys.stdin.isatty():
        try:
            answer = input("  Download it now? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer not in ("", "y", "yes"):
            say("  Skipped. InSys will run on this computer only.")
            return None
    os.makedirs(TOOLS_DIR, exist_ok=True)
    dest = os.path.join(TOOLS_DIR, "cloudflared.exe" if os.name == "nt" else "cloudflared")
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
        self.write_url_file()


# ---------------------------------------------------------------------------
# Start-up
# ---------------------------------------------------------------------------

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
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("10.255.255.255", 1))
            found.append(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    return [a for a in found if not a.startswith("127.")]


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
    if RT.lan:
        for address in lan_addresses():
            say("      On your network  :  http://%s:%d" % (address, RT.port))
    if RT.online_requested:
        say("      Over the internet:  (being set up - the address appears below)")
    else:
        say("      Over the internet:  off  (use Start-InSys-Online.bat to switch on)")
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
    say("")
    say("  Keep this window open while InSys is in use.")
    say("  To stop InSys, close this window or press Ctrl+C.")
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
    parser.add_argument("--reset-admin", action="store_true",
                        help="give the administrator a new temporary password, then exit")
    parser.add_argument("--user", default="admin",
                        help="account for --reset-admin (default: admin)")
    parser.add_argument("--version", action="version", version="InSys " + VERSION)
    return parser.parse_args(argv)


def main(argv=None):
    if sys.version_info < MIN_PYTHON:
        say("InSys needs Python %d.%d or newer. This is Python %s."
            % (MIN_PYTHON[0], MIN_PYTHON[1], platform.python_version()))
        return 1
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    args = parse_args(argv)
    if args.data_dir:
        RT.data_dir = os.path.abspath(args.data_dir)
    elif os.environ.get("INSYS_DATA_DIR"):
        RT.data_dir = os.path.abspath(os.environ["INSYS_DATA_DIR"])
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

    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        say("The 'web' folder is missing next to insys.py. Please extract the complete")
        say("InSys folder again and start it from there.")
        return 1

    try:
        first_password = init_db()
    except sqlite3.Error as exc:
        say("InSys could not open its database (%s): %s" % (RT.db_path, exc))
        return 1
    auto_backup()

    RT.lan = args.lan
    RT.online_requested = args.online
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
    banner(first_password)

    tunnel = None
    if args.online:
        exe = ensure_cloudflared()
        if exe:
            say("")
            say("  Setting up online access...")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
