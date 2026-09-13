//! Generates pacman sync databases from manifests.
//!
//! The output is byte-compatible with what `repo-add` produces: a gzip-compressed
//! tar with one `<name>-<version>/desc` entry per package (`<repo>.db.tar.gz`), and
//! the same plus a `files` entry for `<repo>.files.tar.gz`. pacman does not care
//! who wrote the archive, which is the whole point: releases can be rendered from
//! the index without ever running `repo-add` over 275 GB of packages.

pub mod client;
pub mod desc;
pub mod gate;
pub mod ops;
pub mod osv;
pub mod reconcile;
pub mod security;
pub mod sign;
pub mod sync;
pub mod syncdb;
pub mod work;

use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use pkg_manifest::PackageManifest;
use tar::{Builder, EntryType, Header};

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("gpg failed: {0}")]
    Gpg(String),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("extraction failed: {0}")]
    Extract(#[from] pkg_extract::ExtractError),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{file}: sha256 mismatch (upstream {expected}, downloaded {actual})")]
    Integrity {
        file: String,
        expected: String,
        actual: String,
    },
    #[error("{file}: upstream signature rejected: {detail}")]
    Signature { file: String, detail: String },
}

/// Which archive to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    /// `<repo>.db.tar.gz`: `desc` only.
    Db,
    /// `<repo>.files.tar.gz`: `desc` + `files`.
    Files,
}

impl Flavor {
    pub fn archive_name(self, repo: &str) -> String {
        match self {
            Self::Db => format!("{repo}.db.tar.gz"),
            Self::Files => format!("{repo}.files.tar.gz"),
        }
    }

    /// The extension-less name pacman actually requests (`omarchy.db`).
    pub fn short_name(self, repo: &str) -> String {
        match self {
            Self::Db => format!("{repo}.db"),
            Self::Files => format!("{repo}.files"),
        }
    }
}

/// Renders a sync database for `packages`. Entries are emitted in the order
/// given; callers should sort by name for deterministic output.
pub fn build_database(packages: &[PackageManifest], flavor: Flavor) -> Result<Vec<u8>, RepoError> {
    let mut tar = Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    tar.mode(tar::HeaderMode::Deterministic);

    for pkg in packages {
        let dir = format!("{}-{}/", pkg.name, pkg.version);
        append_dir(&mut tar, &dir)?;
        append_file(
            &mut tar,
            &format!("{dir}desc"),
            desc::render_desc(pkg).as_bytes(),
        )?;
        if flavor == Flavor::Files {
            append_file(
                &mut tar,
                &format!("{dir}files"),
                desc::render_files(pkg).as_bytes(),
            )?;
        }
    }

    let gz = tar.into_inner()?;
    Ok(gz.finish()?)
}

fn append_dir<W: Write>(tar: &mut Builder<W>, path: &str) -> std::io::Result<()> {
    let mut h = Header::new_gnu();
    h.set_entry_type(EntryType::Directory);
    h.set_path(path)?;
    h.set_mode(0o755);
    h.set_size(0);
    h.set_mtime(0);
    h.set_cksum();
    tar.append(&h, std::io::empty())
}

fn append_file<W: Write>(tar: &mut Builder<W>, path: &str, content: &[u8]) -> std::io::Result<()> {
    let mut h = Header::new_gnu();
    h.set_entry_type(EntryType::Regular);
    h.set_path(path)?;
    h.set_mode(0o644);
    h.set_size(content.len() as u64);
    h.set_mtime(0);
    h.set_cksum();
    tar.append(&h, content)
}
