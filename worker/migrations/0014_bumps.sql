-- Bumps via contributor workers, and the policy for a package nobody builds.
--
-- A community task is its owner's first: their worker takes it right away,
-- a worker somebody else donates (--shared) only from shared_after on —
-- fourteen days for a bump the owner is expected to build, at once for a
-- request whose author has no worker. Thirty days without a build and the
-- package is unmaintained (factory_packages.status) until someone takes it.
ALTER TABLE build_tasks ADD COLUMN shared_after TEXT;
CREATE INDEX idx_build_tasks_owner_queue ON build_tasks (status, trust, owner, shared_after);
