-- Jobs: the pool's own work — sync, promote, render, health, security,
-- metrics, gc — becomes tasks in the same queue as builds, created by the
-- Cloudflare cron and pulled by workers the project trusts. GitHub stops
-- being the place where the pool runs.
ALTER TABLE build_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'build';   -- build | sync | promote | render | health | security | metrics | gc
ALTER TABLE build_tasks ADD COLUMN params TEXT;                           -- JSON, per kind (source, arch, ring, from, to, …)
ALTER TABLE build_tasks ADD COLUMN result TEXT;                           -- JSON the executor reports (counts, release ids, verdicts)
CREATE INDEX idx_build_tasks_kind ON build_tasks (kind, status, id);

-- A worker's trust decides which kinds it may claim: community (its own or
-- shared builds) or project (everything, including what writes to rings).
-- Promotion to project is a maintainer's recorded action.
ALTER TABLE build_workers ADD COLUMN trust TEXT NOT NULL DEFAULT 'community';  -- community | project
ALTER TABLE build_workers ADD COLUMN trusted_by TEXT;
ALTER TABLE build_workers ADD COLUMN trusted_at TEXT;

-- People: a contributor may also be a maintainer of areas (groups).
ALTER TABLE contributors ADD COLUMN role TEXT NOT NULL DEFAULT 'contributor';  -- contributor | maintainer
ALTER TABLE contributors ADD COLUMN areas TEXT;                                 -- JSON groups a maintainer reviews
