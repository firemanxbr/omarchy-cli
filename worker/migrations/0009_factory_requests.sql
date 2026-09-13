-- A package request starts from a project URL and moves through the
-- factory's stages before a maintainer ever sees a PKGBUILD:
--   requested → drafting → validating → review → approved | rejected | failed
-- SQLite cannot widen a CHECK constraint, so the table is rebuilt.
CREATE TABLE build_requests_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    "group"      TEXT    NOT NULL DEFAULT 'community',
    arches       TEXT    NOT NULL DEFAULT '["x86_64","aarch64"]',
    url          TEXT,                                  -- the project (source of the PKGBUILD draft)
    requested_by TEXT,
    reason       TEXT,
    status       TEXT    NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'drafting', 'validating', 'review', 'approved', 'rejected', 'failed')),
    issue_url    TEXT,                                  -- where it was asked (GitHub issue)
    pr_url       TEXT,                                  -- the pull request holding the draft
    detail       TEXT,                                  -- last stage note: build times, the error, who rejected and why
    pkgbuild_ref TEXT,
    approved_by  TEXT,
    approved_at  TEXT,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (name)
);
INSERT INTO build_requests_new (id, name, "group", arches, requested_by, reason, status, pkgbuild_ref, approved_by, approved_at, created_at)
    SELECT id, name, "group", arches, requested_by, reason, status, pkgbuild_ref, approved_by, approved_at, created_at FROM build_requests;
DROP TABLE build_requests;
ALTER TABLE build_requests_new RENAME TO build_requests;
