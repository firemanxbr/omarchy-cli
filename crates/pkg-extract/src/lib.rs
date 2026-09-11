//! Out-of-band ABI extraction for Arch packages.
//!
//! Packages produced by `makepkg` are **never modified**. This crate reads a
//! `.pkg.tar.zst` and produces a [`PackageManifest`] by merging:
//!
//! 1. the declarative metadata in `.PKGINFO`;
//! 2. the ELF facts (`DT_SONAME`, `DT_NEEDED`, `.gnu.version_r`) of every shared
//!    object and executable in the archive.
//!
//! It is used both by the CI publisher (`pkg-extract` binary) and by the local
//! client when installing a package built from the AUR.

pub mod elf;
pub mod pkginfo;

use std::path::Path;

use pkg_manifest::PackageManifest;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("archive does not contain .PKGINFO")]
    MissingPkgInfo,
    #[error("invalid .PKGINFO: {0}")]
    PkgInfo(#[from] pkginfo::PkgInfoError),
    #[error("ELF parse error in {path}: {source}")]
    Elf {
        path: String,
        source: goblin::error::Error,
    },
}

/// Reads a package archive and produces its manifest.
///
/// # Phase 1 deliverable
/// Implementation lands with the first milestone; see `docs/ARCHITECTURE.md`.
pub fn extract_manifest(_archive: &Path) -> Result<PackageManifest, ExtractError> {
    todo!("phase 1: stream the zstd tarball, parse .PKGINFO, inspect ELF entries, merge into a manifest")
}
