-- Phase 2: a maintainer's approval is a recorded action. Approving a staged
-- build queues a project build of the same PKGBUILD; what users get is what
-- the project built and signed, never the contributor's bytes.
CREATE TABLE approvals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER NOT NULL,                 -- the staged (community) task reviewed
    name         TEXT    NOT NULL,
    "group"      TEXT    NOT NULL,
    arch         TEXT    NOT NULL,
    version      TEXT,
    decision     TEXT    NOT NULL CHECK (decision IN ('approved', 'rejected')),
    by           TEXT    NOT NULL,                 -- maintainer login
    note         TEXT,
    rebuild_task INTEGER,                          -- the project build queued on approval
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_approvals_task ON approvals (task_id);
CREATE INDEX idx_approvals_name ON approvals (name, created_at);
