-- A worker is ready for the work it declares only when what that work
-- needs answers: a build or an audit needs an agent that replies (a key
-- set is not an agent that works — no credit, no capacity, a dead
-- endpoint). The worker probes its agent (factory/bin/agent.py --probe) at
-- start and every thirty minutes and says so with every claim; the brain
-- keeps the last answer and hands out agent work only to workers whose
-- agent is ok. `kinds` is what the worker declared, so the dashboard can
-- say what "ready" means for each one.
ALTER TABLE build_workers ADD COLUMN kinds TEXT;              -- JSON, from the last claim
ALTER TABLE build_workers ADD COLUMN agent_status TEXT;       -- ok | error | NULL (no agent, or never said)
ALTER TABLE build_workers ADD COLUMN agent_error TEXT;
ALTER TABLE build_workers ADD COLUMN agent_checked_at TEXT;
