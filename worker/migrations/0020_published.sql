-- A registration ends as `published`: the project built the recipe a
-- maintainer wrote from the contributor's evidence and merged (nothing of
-- the contributor's is copied — docs/GOVERNANCE.md, 2026-09-15), and the
-- package is in edge, signed. `approved` is now the state in between:
-- decided, waiting for that recipe on main. SQLite cannot widen a CHECK in
-- place, so the table is rebuilt with the same columns and index.
CREATE TABLE factory_packages_new (
    name          TEXT PRIMARY KEY,
    owner         TEXT NOT NULL REFERENCES contributors (login),
    url           TEXT NOT NULL,
    "group"       TEXT NOT NULL DEFAULT 'community',
    arches        TEXT NOT NULL DEFAULT '["x86_64","aarch64"]',
    release       TEXT,
    pkgbuild_path TEXT,
    detected      TEXT,
    status        TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered', 'waiting', 'building', 'staged', 'approved', 'published', 'rejected', 'unmaintained')),
    detail        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO factory_packages_new (name, owner, url, "group", arches, release, pkgbuild_path, detected, status, detail, created_at, updated_at)
    SELECT name, owner, url, "group", arches, release, pkgbuild_path, detected, status, detail, created_at, updated_at FROM factory_packages;
DROP TABLE factory_packages;
ALTER TABLE factory_packages_new RENAME TO factory_packages;
CREATE INDEX idx_factory_packages_owner ON factory_packages (owner);
