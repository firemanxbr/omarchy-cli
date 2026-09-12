-- Flat pool layout (dbs beside packages), provenance per package, and an
-- append-only event log for the dashboard.

ALTER TABLE packages ADD COLUMN source TEXT NOT NULL DEFAULT 'packages';  -- core | extra | multilib | packages (OPR)
ALTER TABLE packages ADD COLUMN r2_key TEXT;                             -- x86_64/<filename>
CREATE INDEX idx_packages_source ON packages (source);

-- Things that happened: syncs, promotions, renders, health checks, gc.
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,          -- sync | publish | promote | rollback | render | health | gc | check
    ring        TEXT,
    source      TEXT,
    status      TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'warn', 'error')),
    summary     TEXT    NOT NULL,
    payload     TEXT,                      -- JSON details
    duration_ms INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_events_created ON events (created_at DESC);
CREATE INDEX idx_events_kind ON events (kind, created_at DESC);
