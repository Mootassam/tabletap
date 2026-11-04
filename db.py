"""SQLite storage for TableTap.

One connection per thread (sqlite3 connections are not shared across threads),
WAL journal so the kitchen screen can read while customers are ordering, and
foreign keys ON so deleting a restaurant cleans up everything below it.

Money is always stored as INTEGER minor units (cents) - never floats.
Timestamps are INTEGER unix seconds (UTC); the browser formats them locally.
"""
import json
import os
import sqlite3
import threading
import time

import app_paths

_local = threading.local()
_db_path = app_paths.DB_PATH

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS restaurants (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    tagline         TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL DEFAULT '',
    address         TEXT NOT NULL DEFAULT '',
    wifi_name       TEXT NOT NULL DEFAULT '',
    wifi_password   TEXT NOT NULL DEFAULT '',
    logo            TEXT NOT NULL DEFAULT '',
    cover           TEXT NOT NULL DEFAULT '',
    accent          TEXT NOT NULL DEFAULT '#e4572e',
    currency        TEXT NOT NULL DEFAULT 'USD',
    currency_symbol TEXT NOT NULL DEFAULT '$',
    currency_suffix INTEGER NOT NULL DEFAULT 0,   -- 1 = "25.00 MAD", 0 = "$25.00"
    decimals        INTEGER NOT NULL DEFAULT 2,
    tax_rate        INTEGER NOT NULL DEFAULT 0,   -- basis points: 1000 = 10%
    tax_inclusive   INTEGER NOT NULL DEFAULT 1,
    service_rate    INTEGER NOT NULL DEFAULT 0,   -- basis points
    language        TEXT NOT NULL DEFAULT 'en',
    timezone        TEXT NOT NULL DEFAULT '',     -- IANA name, '' = server local time
    ordering_enabled INTEGER NOT NULL DEFAULT 1,
    closed_message  TEXT NOT NULL DEFAULT '',
    require_name    INTEGER NOT NULL DEFAULT 0,
    auto_accept     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',  -- active | suspended
    plan            TEXT NOT NULL DEFAULT 'standard',
    paid_until      INTEGER,                          -- NULL = no expiry
    order_seq_day   TEXT NOT NULL DEFAULT '',
    order_seq       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL,          -- platform | manager | waiter | kitchen
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    last_login    INTEGER,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT '',
    visible       INTEGER NOT NULL DEFAULT 1,
    available_from TEXT NOT NULL DEFAULT '',   -- "HH:MM" local, '' = always
    available_to   TEXT NOT NULL DEFAULT '',
    sort          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_categories_rest ON categories(restaurant_id, sort);

CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    price         INTEGER NOT NULL DEFAULT 0,
    compare_price INTEGER NOT NULL DEFAULT 0,   -- "was" price for promos, 0 = none
    image         TEXT NOT NULL DEFAULT '',
    emoji         TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '[]',   -- json list: veg, vegan, spicy, gf, new, popular, chef
    allergens     TEXT NOT NULL DEFAULT '[]',   -- json list
    calories      INTEGER NOT NULL DEFAULT 0,
    prep_minutes  INTEGER NOT NULL DEFAULT 0,
    options       TEXT NOT NULL DEFAULT '[]',   -- json option groups (see services.normalize_options)
    available     INTEGER NOT NULL DEFAULT 1,   -- 0 = sold out today
    visible       INTEGER NOT NULL DEFAULT 1,   -- 0 = hidden from menu
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_cat ON items(category_id, sort);
CREATE INDEX IF NOT EXISTS ix_items_rest ON items(restaurant_id);

CREATE TABLE IF NOT EXISTS tables (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    label         TEXT NOT NULL,
    zone          TEXT NOT NULL DEFAULT '',
    seats         INTEGER NOT NULL DEFAULT 0,
    token         TEXT NOT NULL UNIQUE,
    active        INTEGER NOT NULL DEFAULT 1,
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tables_rest ON tables(restaurant_id, sort);

CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    table_id      INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    table_label   TEXT NOT NULL DEFAULT '',
    number        INTEGER NOT NULL,
    public_token  TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'new',   -- new | preparing | ready | served | cancelled
    customer_name TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    subtotal      INTEGER NOT NULL,
    tax           INTEGER NOT NULL DEFAULT 0,
    service       INTEGER NOT NULL DEFAULT 0,
    total         INTEGER NOT NULL,
    item_count    INTEGER NOT NULL DEFAULT 0,
    paid          INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT '',
    cancel_reason TEXT NOT NULL DEFAULT '',
    client_ip     TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    preparing_at  INTEGER,
    ready_at      INTEGER,
    served_at     INTEGER,
    paid_at       INTEGER,
    cancelled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_orders_rest_time ON orders(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_orders_rest_status ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS ix_orders_table ON orders(table_id, created_at);

CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id    INTEGER,                   -- no FK: history must survive menu edits
    name       TEXT NOT NULL,
    unit_price INTEGER NOT NULL,          -- base + option deltas
    qty        INTEGER NOT NULL,
    options    TEXT NOT NULL DEFAULT '[]',  -- json [{group, choice, price}]
    note       TEXT NOT NULL DEFAULT '',
    line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS ix_order_items_item ON order_items(item_id);

CREATE TABLE IF NOT EXISTS calls (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    table_id      INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    table_label   TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL,           -- waiter | bill
    payment_hint  TEXT NOT NULL DEFAULT '', -- cash | card (for bill requests)
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
    resolved_by   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_calls_open ON calls(restaurant_id, resolved_at);

CREATE TABLE IF NOT EXISTS audit (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER,
    user_email    TEXT NOT NULL DEFAULT '',
    action        TEXT NOT NULL,
    detail        TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_rest ON audit(restaurant_id, created_at);
"""


def now():
    return int(time.time())


def set_db_path(path):
    """Point the module at another database file (tests)."""
    global _db_path
    close()
    _db_path = path


def get_db_path():
    return _db_path


def conn():
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "path", None) != _db_path:
        c = sqlite3.connect(_db_path, timeout=15, isolation_level=None, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        c.execute("PRAGMA journal_mode = WAL")
        c.execute("PRAGMA synchronous = NORMAL")
        c.execute("PRAGMA busy_timeout = 15000")
        _local.conn = c
        _local.path = _db_path
    return c


def close():
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            c.close()
        except Exception:
            pass
        _local.conn = None


class tx:
    """`with db.tx() as c:` -> BEGIN IMMEDIATE ... COMMIT / ROLLBACK.

    IMMEDIATE takes the write lock up front, so two customers ordering at the same
    second can never read the same order number."""

    def __enter__(self):
        self.c = conn()
        self.c.execute("BEGIN IMMEDIATE")
        return self.c

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.c.execute("COMMIT")
        else:
            self.c.execute("ROLLBACK")
        return False


def init():
    c = conn()
    c.executescript(SCHEMA)
    row = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        c.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
    # Future migrations go here, keyed on int(row['value']).


# ---------------------------------------------------------------- helpers

def q(sql, args=()):
    return conn().execute(sql, args).fetchall()


def q1(sql, args=()):
    return conn().execute(sql, args).fetchone()


def run(sql, args=()):
    cur = conn().execute(sql, args)
    return cur.lastrowid


def row_dict(row, json_fields=()):
    if row is None:
        return None
    d = dict(row)
    for f in json_fields:
        if f in d:
            try:
                d[f] = json.loads(d[f] or "[]")
            except (TypeError, ValueError):
                d[f] = []
    return d


def rows_dicts(rows, json_fields=()):
    return [row_dict(r, json_fields) for r in rows]


def update_fields(table, row_id, fields, where_extra="", extra_args=()):
    """UPDATE <table> SET k=?... WHERE id=? <where_extra>. `fields` keys are trusted column names."""
    if not fields:
        return 0
    cols = ", ".join(f"{k} = ?" for k in fields)
    args = list(fields.values()) + [row_id] + list(extra_args)
    cur = conn().execute(f"UPDATE {table} SET {cols} WHERE id = ? {where_extra}", args)
    return cur.rowcount


def audit(restaurant_id, user_email, action, detail=""):
    try:
        run("INSERT INTO audit(restaurant_id, user_email, action, detail, created_at) VALUES(?,?,?,?,?)",
            (restaurant_id, user_email or "", action, str(detail)[:500], now()))
    except sqlite3.Error:
        pass


def backup(dest_dir=None, keep=14):
    """Consistent online backup (sqlite backup API) -> backups/tabletap-YYYYmmdd-HHMMSS.db.
    Keeps the newest `keep` files."""
    dest_dir = dest_dir or app_paths.BACKUP_DIR
    os.makedirs(dest_dir, exist_ok=True)
    name = time.strftime("tabletap-%Y%m%d-%H%M%S.db")
    path = os.path.join(dest_dir, name)
    dst = sqlite3.connect(path)
    try:
        conn().backup(dst)
    finally:
        dst.close()
    files = sorted(f for f in os.listdir(dest_dir) if f.startswith("tabletap-") and f.endswith(".db"))
    for old in files[:-keep]:
        try:
            os.remove(os.path.join(dest_dir, old))
        except OSError:
            pass
    return path
