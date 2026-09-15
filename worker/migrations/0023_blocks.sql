-- A maintainer blocks a package: it leaves every ring, its bumps stop, its
-- project cannot be requested again until another maintainer lifts it
-- (docs/GOVERNANCE.md, *Blocking*). Contributors carry their block since
-- 0021. Both decisions are on the record (record.ts).
ALTER TABLE factory_packages ADD COLUMN blocked_at TEXT;
ALTER TABLE factory_packages ADD COLUMN blocked_by TEXT;
ALTER TABLE factory_packages ADD COLUMN blocked_reason TEXT;
