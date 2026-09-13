-- Phase 1 of the factory for contributors: anyone with a GitHub identity
-- registers a package and runs a worker for it; results land in a staging
-- bucket, in the contributor's workspace, never in the pool. Workers hold
-- their own revocable token (the shared FACTORY_TOKEN of project workers
-- was retired later: a NULL token_hash can no longer authenticate).

CREATE TABLE contributors (
    login       TEXT PRIMARY KEY,                    -- GitHub login, verified against api.github.com/user
    name        TEXT,
    avatar_url  TEXT,
    token_hash  TEXT NOT NULL UNIQUE,               -- sha256 of the contributor token (shown once)
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The registry: a package someone wants in Omarchy. No build, no token
-- spent, nobody asked — the registrant owns the name.
CREATE TABLE factory_packages (
    name          TEXT PRIMARY KEY,                  -- pacman name; refused when an upstream source ships it
    owner         TEXT NOT NULL REFERENCES contributors (login),
    url           TEXT NOT NULL,                     -- the project (GitHub)
    "group"       TEXT NOT NULL DEFAULT 'community', -- who reviews (maintainers by area)
    arches        TEXT NOT NULL DEFAULT '["x86_64","aarch64"]',
    release       TEXT,                              -- tag to build (latest when NULL)
    pkgbuild_path TEXT,                              -- PKGBUILD in the project's repository; drafted when NULL
    detected      TEXT,                              -- JSON: build system, language, license, latest tag, assets
    status        TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered', 'waiting', 'building', 'staged', 'approved', 'rejected', 'unmaintained')),
    detail        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_factory_packages_owner ON factory_packages (owner);

-- Workers: who runs them, what they may claim, and their own token.
ALTER TABLE build_workers ADD COLUMN owner TEXT;                      -- contributor login; NULL = project worker
ALTER TABLE build_workers ADD COLUMN token_hash TEXT;                 -- NULL = authenticates with FACTORY_TOKEN
ALTER TABLE build_workers ADD COLUMN mode TEXT NOT NULL DEFAULT 'project';  -- project | shared | dedicated
ALTER TABLE build_workers ADD COLUMN packages TEXT;                   -- JSON names a dedicated worker builds
ALTER TABLE build_workers ADD COLUMN revoked_at TEXT;
CREATE UNIQUE INDEX idx_build_workers_token ON build_workers (token_hash);

-- Tasks: whose build it is and where the result goes. trust = 'project'
-- results are signed and published by the worker (today's flow); 'community'
-- results are uploaded to staging and wait for a maintainer.
CREATE TABLE build_tasks_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    "group"          TEXT    NOT NULL,
    arch             TEXT    NOT NULL CHECK (arch IN ('x86_64', 'aarch64')),
    version          TEXT,
    pkgbuild_ref     TEXT    NOT NULL,                -- <commit> in omarchy-pool · <url>@<tag>[:<path>] · draft
    reason           TEXT    NOT NULL,
    priority         INTEGER NOT NULL DEFAULT 100,
    status           TEXT    NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'leased', 'done', 'staged', 'failed', 'cancelled')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    lease_owner      TEXT,
    lease_expires_at TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    result_sha256    TEXT,
    result_filename  TEXT,
    result_version   TEXT,
    duration_ms      INTEGER,
    log_tail         TEXT,
    error            TEXT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    publish          INTEGER NOT NULL DEFAULT 1,
    trust            TEXT    NOT NULL DEFAULT 'project' CHECK (trust IN ('project', 'community')),
    owner            TEXT,                            -- contributor login for community tasks
    staged_prefix    TEXT                             -- staging/<owner>/<name>/<task>/ once uploaded
);
INSERT INTO build_tasks_new (id, name, "group", arch, version, pkgbuild_ref, reason, priority, status, attempts, max_attempts, lease_owner, lease_expires_at,
                             started_at, finished_at, result_sha256, result_filename, result_version, duration_ms, log_tail, error, created_at, publish)
    SELECT id, name, "group", arch, version, pkgbuild_ref, reason, priority, status, attempts, max_attempts, lease_owner, lease_expires_at,
           started_at, finished_at, result_sha256, result_filename, result_version, duration_ms, log_tail, error, created_at, publish FROM build_tasks;
DROP TABLE build_tasks;
ALTER TABLE build_tasks_new RENAME TO build_tasks;
CREATE INDEX idx_build_tasks_queue ON build_tasks (status, arch, priority, id);
CREATE INDEX idx_build_tasks_name ON build_tasks (name, arch, id);
CREATE INDEX idx_build_tasks_lease ON build_tasks (status, lease_expires_at);
CREATE INDEX idx_build_tasks_owner ON build_tasks (owner, id);

-- Every object a worker put in staging: the quota and the evidence list.
CREATE TABLE staging_objects (
    key         TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    task_id     INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_staging_objects_owner ON staging_objects (owner);
CREATE INDEX idx_staging_objects_task ON staging_objects (task_id);
