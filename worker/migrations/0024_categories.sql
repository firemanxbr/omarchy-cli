-- Groups out, categories in (docs/GOVERNANCE.md). One list of maintainers —
-- factory/MAINTAINERS.toml names logins, not areas — and a category per
-- package: proposed by the project's agent from the evidence, settled by a
-- maintainer at review (factory_packages.category, since 0021). A task and
-- an approval carry no copy of it; the recipes on main live flat under
-- factory/pkgbuilds/<name>/.
CREATE TABLE factory_maintainers (
    login TEXT PRIMARY KEY,
    since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO factory_maintainers (login)
    SELECT DISTINCT j.value FROM factory_groups g, json_each(g.maintainers) j;
DROP TABLE factory_groups;

ALTER TABLE factory_packages DROP COLUMN "group";
ALTER TABLE build_tasks DROP COLUMN "group";
ALTER TABLE approvals DROP COLUMN "group";
UPDATE contributors SET areas = NULL;
