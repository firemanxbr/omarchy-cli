use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::DependencyRule;

/// Bumped whenever the on-the-wire manifest shape changes incompatibly.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Metadata extracted from a built package.
///
/// The manifest merges two sources of truth:
///
/// * declarative metadata from `.PKGINFO` (name, version, `depends=`, `provides=`, ...);
/// * ABI facts extracted from the ELF objects shipped in the package
///   (`DT_SONAME` → [`provides`](Self::provides), `DT_NEEDED` + version needs →
///   [`requires`](Self::requires)).
///
/// ELF data refines the declarative dependencies; it never replaces them, because
/// scripts, data files and `dlopen()`-loaded plugins are invisible to the ELF loader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PackageManifest {
    /// Schema version of this document. See [`MANIFEST_SCHEMA_VERSION`].
    pub schema_version: u32,
    pub name: String,
    /// Full version string in Arch format: `[epoch:]pkgver-pkgrel`.
    pub version: String,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub licenses: Vec<String>,
    pub size_installed: u64,
    pub size_download: u64,
    /// Hex-encoded SHA-256 of the `.pkg.tar.zst` archive.
    pub sha256: String,
    /// Capabilities this package satisfies. Always includes `name=version`.
    /// Example: `libssl.so=3-64`, `openssl=3.3.1-1`, `web-browser`.
    #[serde(default)]
    pub provides: Vec<DependencyRule>,
    /// Hard runtime requirements. Example: `libc.so.6`, `libc.so.6(GLIBC_2.38)`,
    /// `python>=3.12`.
    #[serde(default)]
    pub requires: Vec<DependencyRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional: Vec<DependencyRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<DependencyRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replaces: Vec<DependencyRule>,
    /// Absolute paths of every file installed by the package, used for collision
    /// detection and `owns` queries. Directories end with `/`.
    #[serde(default)]
    pub files: Vec<String>,
    /// Paths that must be preserved on upgrade/removal (`backup=` in `.PKGINFO`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backup: Vec<String>,
}

/// A flat repository index: what `pkg-extract index` writes and what the client
/// consumes in local-repository mode (development and offline testing) instead of
/// the edge API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoIndex {
    pub schema_version: u32,
    pub packages: Vec<PackageManifest>,
}

impl PackageManifest {
    /// Returns the JSON Schema for the manifest, used to keep the TypeScript worker
    /// in sync with the Rust types.
    pub fn json_schema() -> schemars::Schema {
        schemars::schema_for!(PackageManifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let m = PackageManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            name: "flea".into(),
            version: "1.2.0-1".into(),
            arch: "x86_64".into(),
            description: None,
            url: None,
            licenses: vec!["MIT".into()],
            size_installed: 10,
            size_download: 5,
            sha256: "00".repeat(32),
            provides: vec!["flea=1.2.0-1".parse().unwrap()],
            requires: vec!["libc.so.6(GLIBC_2.38)".parse().unwrap()],
            optional: vec![],
            conflicts: vec![],
            replaces: vec![],
            files: vec!["/usr/bin/flea".into()],
            backup: vec![],
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: PackageManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn schema_generation_does_not_panic() {
        let schema = PackageManifest::json_schema();
        assert!(serde_json::to_string(&schema).unwrap().contains("provides"));
    }
}
