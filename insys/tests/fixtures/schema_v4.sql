-- The database layout exactly as InSys 1.2.1 (layout version 4) created it.
-- Used by the upgrade tests; do not edit.
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
    deleted_by INTEGER
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
