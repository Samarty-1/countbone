"""Database schema, as numbered migrations.

A deployed database is upgraded in place on start: each migration runs once,
in order, and PRAGMA user_version records how far it has got. Never edit a
migration that has shipped; add the next one.

Version 1 is the original schema (runs, counts, reviews, audit). Version 2
adds the platform: people and access, locations, the product catalog, the
durable job queue, resumable uploads, recount tasks, reconciliation,
receiving, evidence claims, service operations and integrations.
"""

from __future__ import annotations

V1 = """
CREATE TABLE IF NOT EXISTS runs (
    run_id             TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    started_at         REAL NOT NULL,
    finished_at        REAL,
    duration_s         REAL,
    frames_read        INTEGER DEFAULT 0,
    frames_used        INTEGER DEFAULT 0,
    frames_dropped     INTEGER DEFAULT 0,
    detections         INTEGER DEFAULT 0,
    tracks             INTEGER DEFAULT 0,
    total              INTEGER DEFAULT 0,
    overall_confidence REAL DEFAULT 0,
    needs_review       INTEGER DEFAULT 0,
    config_fingerprint TEXT,
    meta               TEXT
);

CREATE TABLE IF NOT EXISTS sku_counts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    sku        TEXT NOT NULL,
    label      TEXT,
    count      INTEGER NOT NULL,
    expected   INTEGER,
    variance   INTEGER,
    confidence REAL,
    evidence   TEXT,
    counted_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sku_counts_sku ON sku_counts(sku, counted_at);
CREATE INDEX IF NOT EXISTS idx_sku_counts_run ON sku_counts(run_id);

CREATE TABLE IF NOT EXISTS reviews (
    review_id    TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    sku          TEXT NOT NULL,
    reason       TEXT,
    confidence   REAL,
    frame_index  INTEGER,
    bbox         TEXT,
    crop_path    TEXT,
    status       TEXT DEFAULT 'pending',
    resolved_sku TEXT,
    resolved_by  TEXT,
    resolved_at  REAL,
    created_at   REAL NOT NULL,
    meta         TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);

CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit(run_id, created_at);
"""

V2 = """
-- What a run was for. `location` is a bay/shelf code; `kind` is count,
-- receive or recount; the *_id columns link it to what asked for it.
ALTER TABLE runs ADD COLUMN location TEXT;
ALTER TABLE runs ADD COLUMN kind TEXT DEFAULT 'count';
ALTER TABLE runs ADD COLUMN created_by TEXT;
ALTER TABLE runs ADD COLUMN walk_id TEXT;
ALTER TABLE runs ADD COLUMN receipt_id TEXT;
ALTER TABLE runs ADD COLUMN task_id TEXT;
ALTER TABLE runs ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_location ON runs(location, started_at);

-- The audit table becomes the trail for everything, not just runs: `run_id`
-- is read as "subject" (a run, task, adjustment, claim ...). Rows are hash
-- chained, so an edited or deleted row breaks every hash after it.
ALTER TABLE audit ADD COLUMN actor TEXT;
ALTER TABLE audit ADD COLUMN prev_hash TEXT;
ALTER TABLE audit ADD COLUMN row_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit(kind, created_at);

-- People and access ------------------------------------------------------
CREATE TABLE users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    role          TEXT NOT NULL,            -- admin | manager | counter
    pw_hash       TEXT NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    created_by    TEXT,
    last_login_at REAL
);

CREATE TABLE auth_sessions (
    token_hash   TEXT PRIMARY KEY,         -- the token itself is never stored
    user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    last_seen_at REAL,
    client       TEXT
);

CREATE TABLE api_keys (
    key_id       TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    role         TEXT NOT NULL,
    created_by   TEXT,
    created_at   REAL NOT NULL,
    last_used_at REAL,
    revoked      INTEGER NOT NULL DEFAULT 0
);

-- Where stock lives ------------------------------------------------------
CREATE TABLE sites (
    site_id    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    customer   TEXT,
    address    TEXT,
    timezone   TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE locations (
    code       TEXT PRIMARY KEY,           -- printed on the bay's QR label
    name       TEXT,
    site_id    TEXT,
    zone       TEXT,
    created_at REAL NOT NULL,
    created_by TEXT,
    archived   INTEGER NOT NULL DEFAULT 0
);

-- The book quantity: what the customer's system says is at a location.
CREATE TABLE expected_stock (
    location   TEXT NOT NULL,
    sku        TEXT NOT NULL,
    qty        INTEGER NOT NULL,
    source     TEXT,                       -- manual | csv | shopify | netsuite | sap ...
    updated_at REAL NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (location, sku)
);

CREATE TABLE planograms (
    location   TEXT PRIMARY KEY,
    rows       TEXT NOT NULL,              -- JSON: [[sku, sku, ...], ...] top row first
    updated_at REAL NOT NULL,
    updated_by TEXT
);

-- Product catalog made in Catalog Studio ---------------------------------
CREATE TABLE skus (
    sku            TEXT PRIMARY KEY,
    label          TEXT,
    unit_value     REAL DEFAULT 0,
    hue            TEXT,                   -- JSON [lo, hi] or null
    achromatic     INTEGER DEFAULT 0,
    min_saturation INTEGER DEFAULT 60,
    barcodes       TEXT,                   -- JSON list
    created_at     REAL NOT NULL,
    created_by     TEXT,
    archived       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sku_photos (
    photo_id   TEXT PRIMARY KEY,
    sku        TEXT NOT NULL,
    path       TEXT NOT NULL,
    source     TEXT NOT NULL,              -- upload | review (a reviewer's correction)
    run_id     TEXT,
    review_id  TEXT,
    created_at REAL NOT NULL,
    created_by TEXT
);
CREATE INDEX idx_sku_photos_sku ON sku_photos(sku);

CREATE TABLE sku_vectors (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id TEXT NOT NULL REFERENCES sku_photos(photo_id) ON DELETE CASCADE,
    sku      TEXT NOT NULL,
    kind     TEXT NOT NULL,                -- train | probe
    version  INTEGER NOT NULL,
    vector   BLOB NOT NULL
);
CREATE INDEX idx_sku_vectors_sku ON sku_vectors(sku);

-- Work that must survive a restart ---------------------------------------
CREATE TABLE jobs (
    run_id     TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    params     TEXT,                       -- JSON: expected, context
    status     TEXT NOT NULL,              -- queued | running | done | failed
    attempts   INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    filename   TEXT,
    created_by TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);

CREATE TABLE uploads (
    upload_id  TEXT PRIMARY KEY,
    client_id  TEXT UNIQUE,                -- the phone's own id: retries are idempotent
    filename   TEXT,
    size       INTEGER NOT NULL,
    received   INTEGER NOT NULL DEFAULT 0,
    sha256     TEXT,
    params     TEXT,
    path       TEXT NOT NULL,
    status     TEXT NOT NULL,              -- open | complete
    run_id     TEXT,
    created_by TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Several videos of one place, merged without double counting ------------
CREATE TABLE walks (
    walk_id    TEXT PRIMARY KEY,
    location   TEXT,
    name       TEXT,
    status     TEXT NOT NULL DEFAULT 'open',  -- open | closed
    created_by TEXT,
    created_at REAL NOT NULL,
    closed_at  REAL
);

-- Recount tasks ----------------------------------------------------------
CREATE TABLE tasks (
    task_id       TEXT PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'recount',
    status        TEXT NOT NULL,            -- open | done | escalated | cancelled
    location      TEXT,
    sku           TEXT,
    run_id        TEXT,
    reason        TEXT,
    expected      INTEGER,
    counted       INTEGER,
    variance      INTEGER,
    value_at_risk REAL,
    assignee      TEXT,                     -- user_id
    due_at        REAL,
    result        TEXT,                     -- JSON: recount, run, note
    created_at    REAL NOT NULL,
    created_by    TEXT,
    updated_at    REAL NOT NULL,
    closed_at     REAL,
    closed_by     TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status, assignee);

-- Reconcile: proposed changes to the book, and who signed them off -------
CREATE TABLE adjustments (
    adjustment_id TEXT PRIMARY KEY,
    location      TEXT,
    sku           TEXT NOT NULL,
    system_qty    INTEGER,
    counted_qty   INTEGER NOT NULL,
    delta         INTEGER NOT NULL,
    unit_value    REAL DEFAULT 0,
    value         REAL DEFAULT 0,
    run_id        TEXT,
    task_id       TEXT,
    status        TEXT NOT NULL,            -- blocked | proposed | approved | rejected | posted | failed | superseded
    rule          TEXT,
    decided_by    TEXT,
    decided_at    REAL,
    note          TEXT,
    integration   TEXT,
    external_ref  TEXT,
    post_error    TEXT,
    posted_at     REAL,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
);
CREATE INDEX idx_adjustments_status ON adjustments(status, created_at);

-- Receive ---------------------------------------------------------------
CREATE TABLE receipts (
    receipt_id  TEXT PRIMARY KEY,
    po_number   TEXT NOT NULL,
    supplier    TEXT,
    dock        TEXT,
    status      TEXT NOT NULL,              -- open | counted | discrepancy | closed
    source      TEXT,                       -- manual | csv | shopify | netsuite | sap
    note        TEXT,
    created_by  TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    closed_at   REAL,
    closed_by   TEXT
);

CREATE TABLE receipt_lines (
    receipt_id   TEXT NOT NULL REFERENCES receipts(receipt_id) ON DELETE CASCADE,
    sku          TEXT NOT NULL,
    expected_qty INTEGER NOT NULL,
    received_qty INTEGER,
    unit_cost    REAL DEFAULT 0,
    PRIMARY KEY (receipt_id, sku)
);

-- Evidence --------------------------------------------------------------
CREATE TABLE claims (
    claim_id         TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,         -- supplier_shortage | count_variance | damage | insurance | audit
    counterparty     TEXT,
    status           TEXT NOT NULL,         -- draft | sent | accepted | rejected | recovered
    receipt_id       TEXT,
    run_ids          TEXT,                  -- JSON list
    amount           REAL DEFAULT 0,
    recovered_amount REAL DEFAULT 0,
    currency         TEXT DEFAULT 'USD',
    note             TEXT,
    pack_path        TEXT,
    pack_sha256      TEXT,
    created_by       TEXT,
    created_at       REAL NOT NULL,
    updated_at       REAL NOT NULL
);

-- Count-as-a-Service ----------------------------------------------------
CREATE TABLE service_jobs (
    job_id        TEXT PRIMARY KEY,
    site_id       TEXT,
    title         TEXT,
    scheduled_for REAL,
    crew          TEXT,                     -- JSON list of user_ids
    locations     TEXT,                     -- JSON list of location codes
    status        TEXT NOT NULL,            -- planned | in_progress | done | cancelled
    data_consent  INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    created_by    TEXT,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    completed_at  REAL
);

-- Integrations and settings ---------------------------------------------
CREATE TABLE integrations (
    name        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    settings    TEXT,                       -- JSON, non-secret
    secrets     BLOB,                       -- encrypted JSON
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  REAL NOT NULL,
    updated_by  TEXT,
    last_sync_at REAL,
    last_error  TEXT
);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at REAL NOT NULL,
    updated_by TEXT
);
"""

MIGRATIONS: list[str] = [V1, V2]
