-- Which provides a package *declares* (.PKGINFO), as opposed to the sonames
-- the extractor found in its ELF files. pacman resolves dependencies through
-- the declared ones only; a package bundling its own libstdc++ must not count
-- as a provider of libstdc++.so.
ALTER TABLE package_provides ADD COLUMN declared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_provides_declared ON package_provides (capability, declared);
