-- What a package's statically linked binaries embed (manifest.components,
-- pkg-extract): Go modules from debug/buildinfo, crates.io crates from
-- cargo-auditable. Normalised so the security layer can ask which packages
-- ship a given module or crate at a vulnerable version — no soname ever
-- reveals a vendored library.
CREATE TABLE package_components (
    package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
    ecosystem  TEXT    NOT NULL,          -- Go | crates.io (OSV's names)
    name       TEXT    NOT NULL,          -- module path or crate name
    version    TEXT    NOT NULL,          -- as the ecosystem writes it (v0.21.0 | 0.10.64)
    PRIMARY KEY (package_id, ecosystem, name, version)
);
CREATE INDEX idx_components_name ON package_components (ecosystem, name);
