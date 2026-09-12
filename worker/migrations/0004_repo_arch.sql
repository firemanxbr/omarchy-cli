-- Which architecture's repository a package came from. `any` packages are
-- per-upstream builds (Arch x86_64 vs Arch Linux ARM ship different ones), so
-- the replacement key in a ring and the pool directory are (name, repo_arch),
-- not (name, arch).
ALTER TABLE packages ADD COLUMN repo_arch TEXT NOT NULL DEFAULT 'x86_64';
CREATE INDEX idx_packages_name_repo_arch ON packages (name, repo_arch);
