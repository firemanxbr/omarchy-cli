-- Package graph for the Omarchy edge repository.
-- D1 is SQLite: indexes are separate statements, not inline in CREATE TABLE.

CREATE TABLE packages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    version        TEXT    NOT NULL,   -- pkgver-pkgrel, without epoch
    epoch          INTEGER NOT NULL DEFAULT 0,
    arch           TEXT    NOT NULL,
    channel        TEXT    NOT NULL DEFAULT 'stable',
    description    TEXT,
    url            TEXT,
    size_installed INTEGER NOT NULL,
    size_download  INTEGER NOT NULL,
    sha256         TEXT    NOT NULL,   -- hex; also the R2 object key prefix
    signature      TEXT,               -- base64 detached ed25519 signature
    manifest_json  TEXT    NOT NULL,   -- full PackageManifest as published
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (name, version, epoch, arch, channel),
    UNIQUE (sha256)
);
CREATE INDEX idx_packages_name_channel ON packages (name, channel);

CREATE TABLE package_provides (
    package_id         INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    capability         TEXT    NOT NULL,   -- 'libssl.so', 'openssl', 'web-browser'
    version_constraint TEXT,               -- '=3-64', '=3.3.1-1'
    symbol_version     TEXT                -- reserved for 'GLIBC_2.38'-style provides
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
