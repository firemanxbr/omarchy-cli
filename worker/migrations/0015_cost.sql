-- D1 bills rows read and rows written. Two habits were expensive: the
-- overview recomputed pool-wide aggregates from release_packages on every
-- call (a full scan of millions of rows, thousands of times a day), and
-- every release copied its whole selection with a secondary index that
-- nothing needs. Releases are immutable, so what a release holds is
-- computed once, when it is created, and stored on the row; a package
-- remembers whether any release ever pinned it; the package_id index goes.

ALTER TABLE releases ADD COLUMN package_count INTEGER;
ALTER TABLE releases ADD COLUMN bytes INTEGER;
ALTER TABLE releases ADD COLUMN sources TEXT;              -- JSON [{source, arch, packages, bytes}], filled on first read when NULL
UPDATE releases SET
  package_count = (SELECT COUNT(*) FROM release_packages rp WHERE rp.release_id = releases.id),
  bytes = (SELECT COALESCE(SUM(p.size_download), 0) FROM release_packages rp JOIN packages p ON p.id = rp.package_id WHERE rp.release_id = releases.id);

ALTER TABLE packages ADD COLUMN released INTEGER NOT NULL DEFAULT 0;   -- 1 once any release pinned it
UPDATE packages SET released = 1 WHERE id IN (SELECT DISTINCT package_id FROM release_packages);

DROP INDEX IF EXISTS idx_release_packages_package;
