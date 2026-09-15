-- A ring holds one row per (source, name, repo_arch): two sources' builds of
-- one name are two rows, each rendered into its own database, and the order
-- of the pacman include decides between them (routes/releases.ts). The
-- release views walk the selection in that order, keyset-paged on the same
-- key; the (name, repo_arch) index was that walk's until the source joined
-- the key, and this one serves every lookup it served.
CREATE INDEX idx_packages_name_repo_arch_source ON packages (name, repo_arch, source);
DROP INDEX idx_packages_name_repo_arch;
