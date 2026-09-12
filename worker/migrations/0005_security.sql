-- Vulnerability data: advisories from public trackers matched to the package
-- objects the rings serve, plus per-CVE enrichment (exploited in the wild,
-- exploit probability). Exposure through dependencies is derived at query
-- time from package_requires / package_provides.

CREATE TABLE advisories (
    id         TEXT PRIMARY KEY,              -- 'arch:AVG-2843' | 'debian:CVE-2024-1234:openssl'
    source     TEXT NOT NULL,                 -- arch | debian
    package    TEXT NOT NULL,                 -- package name the advisory is about
    cves       TEXT NOT NULL,                 -- JSON array of CVE ids
    severity   TEXT NOT NULL,                 -- critical | high | medium | low | unknown
    status     TEXT NOT NULL,                 -- vulnerable | fixed | not-affected | unknown (the advisory's own status)
    affected   TEXT,                          -- version the tracker lists as affected
    fixed      TEXT,                          -- version the tracker lists as fixed
    summary    TEXT,
    url        TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_advisories_package ON advisories (package);
CREATE INDEX idx_advisories_updated ON advisories (updated_at);

CREATE TABLE cve_meta (
    cve             TEXT PRIMARY KEY,
    kev             INTEGER NOT NULL DEFAULT 0,  -- in CISA's Known Exploited Vulnerabilities
    kev_added       TEXT,
    epss            REAL,                        -- FIRST EPSS probability of exploitation (0..1)
    epss_percentile REAL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE package_advisories (
    package_id  INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    advisory_id TEXT    NOT NULL REFERENCES advisories (id) ON DELETE CASCADE,
    match       TEXT    NOT NULL,             -- exact (tracker knows this distribution's version) | name-version | name-only
    status      TEXT    NOT NULL,             -- vulnerable | fixed | not-affected, for this object's version
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (package_id, advisory_id)
);
CREATE INDEX idx_pkgadv_advisory ON package_advisories (advisory_id);
CREATE INDEX idx_pkgadv_status ON package_advisories (status, package_id);
