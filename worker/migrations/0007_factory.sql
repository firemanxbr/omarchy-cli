-- The factory: package requests, build tasks, and the workers that pull them.
-- Cloudflare is the source of truth; workers are ephemeral and anywhere.

CREATE TABLE build_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,                     -- package name
    "group"      TEXT    NOT NULL DEFAULT 'community', -- factory/pkgbuilds/<group>/<name>; CODEOWNERS decide who approves
    arches       TEXT    NOT NULL DEFAULT '["x86_64","aarch64"]',  -- JSON array
    requested_by TEXT,                                 -- free text: who asked (GitHub login, e-mail)
    reason       TEXT,
    status       TEXT    NOT NULL DEFAULT 'requested'  -- requested | approved | rejected
                 CHECK (status IN ('requested', 'approved', 'rejected')),
    pkgbuild_ref TEXT,                                 -- git commit of factory/pkgbuilds/<group>/<name> once approved
    approved_by  TEXT,
    approved_at  TEXT,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (name)
);

CREATE TABLE build_tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    "group"          TEXT    NOT NULL,
    arch             TEXT    NOT NULL CHECK (arch IN ('x86_64', 'aarch64')),
    version          TEXT,                            -- expected [epoch:]pkgver-pkgrel, when known
    pkgbuild_ref     TEXT    NOT NULL,                -- git commit to build from
    reason           TEXT    NOT NULL,                -- approved | pkgbuild-changed | new-upstream-version | requested-by:<who> | retry
    priority         INTEGER NOT NULL DEFAULT 100,    -- lower first
    status           TEXT    NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    lease_owner      TEXT,                            -- worker id holding it
    lease_expires_at TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    result_sha256    TEXT,                            -- the pool object the build produced
    result_filename  TEXT,
    result_version   TEXT,
    duration_ms      INTEGER,
    log_tail         TEXT,                            -- last lines of the build log
    error            TEXT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_build_tasks_queue ON build_tasks (status, arch, priority, id);
CREATE INDEX idx_build_tasks_name ON build_tasks (name, arch, id);
CREATE INDEX idx_build_tasks_lease ON build_tasks (status, lease_expires_at);

CREATE TABLE build_workers (
    id           TEXT PRIMARY KEY,                    -- worker-chosen: host-arch-random
    arch         TEXT NOT NULL,
    hostname     TEXT,
    labels       TEXT,                                -- JSON: where it runs, capabilities
    version      TEXT,                                -- pkg-repo / worker script version
    first_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    current_task INTEGER,
    builds_done  INTEGER NOT NULL DEFAULT 0,
    builds_failed INTEGER NOT NULL DEFAULT 0
);
