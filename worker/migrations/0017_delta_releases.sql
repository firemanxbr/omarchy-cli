-- Releases as deltas. A release used to copy the ring's whole selection
-- (~32k rows, and D1 bills every row written), so a sync every hour was
-- too expensive and the pool moved to every three. Now:
--
--   ring_packages    what each ring serves right now (its head), one row
--                    per package — every read of a head goes here;
--   release_deltas   what a release changed against its parent: the
--                    packages it added and the ones it removed;
--   release_packages the full membership of a *checkpoint* release only
--                    (the first of a ring, then every 24th, and any older
--                    release materialised on demand — a pinned page, a
--                    diff, a rollback); releases.checkpoint says which.
--
-- Any release is reconstructed from the nearest checkpoint behind it plus
-- the deltas in between. Creating a release writes its delta and moves the
-- ring's rows: hundreds of rows, not thirty thousand.

CREATE TABLE ring_packages (
    ring       TEXT    NOT NULL,
    package_id INTEGER NOT NULL REFERENCES packages (id),
    PRIMARY KEY (ring, package_id)
);

CREATE TABLE release_deltas (
    release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL,
    op         TEXT    NOT NULL CHECK (op IN ('add', 'remove')),
    PRIMARY KEY (release_id, package_id)
);

ALTER TABLE releases ADD COLUMN checkpoint INTEGER NOT NULL DEFAULT 0;

-- Every release that still has its membership is a checkpoint; the heads
-- become the rings' live selections.
UPDATE releases SET checkpoint = 1 WHERE EXISTS (SELECT 1 FROM release_packages rp WHERE rp.release_id = releases.id);
INSERT INTO ring_packages (ring, package_id)
  SELECT h.ring, rp.package_id FROM ring_heads h JOIN release_packages rp ON rp.release_id = h.release_id;
