-- A package request is one immutable record: what a contributor asked for,
-- written to the pool bucket as factory/<name>/<id>/request.json with the
-- pool's detached signature beside it (record.ts), and this row pointing
-- at it. The registration (factory_packages) is the package's current
-- state and now carries the request it came from. GitHub issues are no
-- longer a way in: build_requests, the table the issue sync fed, goes.
CREATE TABLE package_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    owner       TEXT NOT NULL REFERENCES contributors (login),
    project     TEXT NOT NULL,                     -- the project's home, normalised: the uniqueness key
    source      TEXT NOT NULL,                     -- the exact tarball / release artifact of the requested version
    version     TEXT NOT NULL,                     -- tag or version the source is
    description TEXT NOT NULL,
    license     TEXT NOT NULL,                     -- SPDX
    arches      TEXT NOT NULL,                     -- JSON
    checklist   TEXT NOT NULL,                     -- JSON: what the contributor confirmed
    detected    TEXT,                              -- JSON: what the pool found (GitHub metadata, build system, licence, tag)
    record      TEXT NOT NULL DEFAULT '',          -- R2 key of request.json in the pool bucket
    sha256      TEXT NOT NULL DEFAULT '',          -- of request.json
    migrated    INTEGER NOT NULL DEFAULT 0,        -- 1: written from a registration made before requests existed
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_package_requests_name ON package_requests (name, id);
CREATE INDEX idx_package_requests_project ON package_requests (project);

ALTER TABLE factory_packages ADD COLUMN request_id INTEGER REFERENCES package_requests (id);
ALTER TABLE factory_packages ADD COLUMN project TEXT;                 -- normalised project home (url stays the source repository for the drafter)
ALTER TABLE factory_packages ADD COLUMN source TEXT;
ALTER TABLE factory_packages ADD COLUMN description TEXT;
ALTER TABLE factory_packages ADD COLUMN license TEXT;
ALTER TABLE factory_packages ADD COLUMN category TEXT;                -- proposed by the agent, settled by a maintainer at review

-- A blocked contributor requests nothing, builds nothing; the decision is a maintainer's (docs/GOVERNANCE.md).
ALTER TABLE contributors ADD COLUMN blocked_at TEXT;
ALTER TABLE contributors ADD COLUMN blocked_by TEXT;
ALTER TABLE contributors ADD COLUMN blocked_reason TEXT;

DROP TABLE IF EXISTS build_requests;
