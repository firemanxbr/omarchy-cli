-- Omarchy package index.
-- D1 is SQLite: indexes are separate statements, not inline in CREATE TABLE.

-- Immutable pool entries. One row per archive, keyed by its SHA-256; the R2
-- object lives at pool/<sha256>.pkg.tar.zst (+ .sig).
CREATE TABLE packages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256         TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL,
    version        TEXT    NOT NULL,   -- full [epoch:]pkgver-pkgrel
    arch           TEXT    NOT NULL,
    filename       TEXT    NOT NULL,
    size_download  INTEGER NOT NULL,
    size_installed INTEGER NOT NULL,
    has_signature  INTEGER NOT NULL DEFAULT 0,
    manifest_json  TEXT    NOT NULL,   -- full PackageManifest as published
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_packages_name ON packages (name, arch);
CREATE INDEX idx_packages_filename ON packages (filename);

CREATE TABLE package_provides (
    package_id         INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    capability         TEXT    NOT NULL,   -- 'libssl.so', 'libssl.so.3', 'openssl'
    version_constraint TEXT,               -- '=3-64'
    symbol_version     TEXT
);
CREATE INDEX idx_provides_capability ON package_provides (capability);
CREATE INDEX idx_provides_package ON package_provides (package_id);

CREATE TABLE package_requires (
    package_id         INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    requirement        TEXT    NOT NULL,   -- 'libc.so.6', 'python'
    version_constraint TEXT,               -- '>=3.12'
    symbol_version     TEXT,               -- 'GLIBC_2.38'
    kind               TEXT    NOT NULL DEFAULT 'depends'
                       CHECK (kind IN ('depends', 'optdepends', 'conflicts', 'replaces'))
);
CREATE INDEX idx_requires_requirement ON package_requires (requirement);
CREATE INDEX idx_requires_package ON package_requires (package_id);

CREATE TABLE package_files (
    package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    file_path  TEXT    NOT NULL
);
CREATE INDEX idx_files_path ON package_files (file_path);
CREATE INDEX idx_files_package ON package_files (package_id);

-- A release is an immutable, pinned selection of packages for one ring.
CREATE TABLE releases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ring       TEXT    NOT NULL CHECK (ring IN ('edge', 'rc', 'stable')),
    seq        INTEGER NOT NULL,          -- per-ring counter, 1-based
    parent_id  INTEGER REFERENCES releases (id),
    source_id  INTEGER REFERENCES releases (id),  -- release this one was promoted from
    note       TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (ring, seq)
);

CREATE TABLE release_packages (
    release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL REFERENCES packages (id),
    PRIMARY KEY (release_id, package_id)
);
CREATE INDEX idx_release_packages_package ON release_packages (package_id);

-- What each ring currently serves.
CREATE TABLE ring_heads (
    ring       TEXT    PRIMARY KEY,
    release_id INTEGER NOT NULL REFERENCES releases (id)
);

-- Generated pacman databases for a release, stored in R2.
CREATE TABLE release_artifacts (
    release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
    repo       TEXT    NOT NULL,          -- 'omarchy'
    arch       TEXT    NOT NULL,          -- 'x86_64'
    kind       TEXT    NOT NULL CHECK (kind IN ('db', 'db.sig', 'files', 'files.sig')),
    r2_key     TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (release_id, repo, arch, kind)
);
