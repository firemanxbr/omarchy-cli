-- Governance from the repository: factory/MAINTAINERS.toml names the groups
-- and their maintainers; the pool reads main and applies it. Roles are
-- contributor or maintainer, nothing else; nobody is above the file.

CREATE TABLE factory_groups (
    name        TEXT PRIMARY KEY,                    -- factory/pkgbuilds/<name>/, the package's "group"
    description TEXT NOT NULL DEFAULT '',
    maintainers TEXT NOT NULL DEFAULT '[]',          -- JSON list of GitHub logins
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Small key/value state of the brain (the governance file's hash, …).
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A browser session is not the CLI token: signing in on the dashboard no
-- longer replaces the token a contributor's worker uses.
ALTER TABLE contributors ADD COLUMN session_hash TEXT;
CREATE UNIQUE INDEX idx_contributors_session ON contributors (session_hash);

UPDATE contributors SET role = 'maintainer' WHERE role NOT IN ('contributor', 'maintainer');
