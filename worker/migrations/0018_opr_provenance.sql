-- Where an OPR package's recipe comes from (omacom/omarchy-pkgs, read once a
-- day): whether the PKGBUILD is Omarchy's own or synced from the AUR, the
-- upstream AUR commit it tracks, the commit that last changed it. What the
-- dashboard counts down: packages in stable still built from an AUR recipe.
CREATE TABLE opr_packages (
    name                 TEXT PRIMARY KEY,
    source               TEXT NOT NULL,                -- local | aur (.omarchy/package.json "source")
    upstream_commit      TEXT,                         -- the AUR commit an aur package tracks
    release_ring         TEXT,                         -- "fast": built for every channel natively
    channels             TEXT,                         -- JSON list when the metadata pins them
    pinned               INTEGER NOT NULL DEFAULT 0,   -- the release pair, versioned per release
    pkgbuild_blob        TEXT NOT NULL,                -- git blob sha of the PKGBUILD as of the scan
    pkgbuild_commit      TEXT,                         -- last commit that touched pkgbuilds/<name>/
    pkgbuild_committed_at TEXT,
    meta                 TEXT NOT NULL,                -- the whole .omarchy/package.json
    scanned_commit       TEXT NOT NULL,                -- omarchy-pkgs master at the scan
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
