//! Rollback journal. Each filesystem operation is recorded here **before** it is
//! applied so that an interrupted transaction can be undone on next start.
//!
//! Every entry is idempotent in both directions: applying it twice or rolling it
//! back twice yields the same filesystem, which is what makes crash recovery
//! simple — we never need to know exactly where the previous process died.

use std::path::{Path, PathBuf};

use pkg_manifest::PackageManifest;
use serde::{Deserialize, Serialize};

use crate::fsops::{self, join_abs, OLD_SUFFIX};
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum JournalEntry {
    /// A new entry was placed at `path`; rollback removes it.
    Created { path: String },
    /// `path` was replaced; the previous entry is kept at `path.omarchy-old`.
    Replaced { path: String },
    /// `path` was removed; the previous entry is kept at `path.omarchy-old`.
    Removed { path: String },
}

impl JournalEntry {
    pub fn path(&self) -> &str {
        match self {
            Self::Created { path } | Self::Replaced { path } | Self::Removed { path } => path,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    /// Archives are being extracted into the staging directory. Nothing outside
    /// it has been touched.
    Staging,
    /// Filesystem operations are in flight. Recovery rolls them back.
    Applying,
    /// State is committed in the database; only `.omarchy-old` backups and the
    /// staging directory remain to be removed. Recovery finishes the cleanup.
    Committed,
}

/// The persisted description of a transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionRecord {
    pub id: u64,
    pub state: TransactionState,
    pub staging_dir: PathBuf,
    /// Filesystem operations, in apply order.
    pub ops: Vec<JournalEntry>,
    /// Manifests being installed or upgraded.
    pub install: Vec<PackageManifest>,
    /// Package names being removed (not counting the old versions of `install`).
    pub remove: Vec<String>,
    /// Directories that may become empty and should be pruned after commit.
    pub prune_dirs: Vec<String>,
}

/// Undoes `record.ops` in reverse order and removes the staging directory.
pub fn rollback(root: &Path, record: &TransactionRecord) -> Result<()> {
    for op in record.ops.iter().rev() {
        let abs = join_abs(root, op.path());
        match op {
            JournalEntry::Created { .. } => {
                fsops::remove_file_if_exists(&fsops::sibling(&abs, fsops::NEW_SUFFIX))?;
                remove_entry_if_exists(&abs)?;
            }
            JournalEntry::Replaced { .. } | JournalEntry::Removed { .. } => {
                fsops::remove_file_if_exists(&fsops::sibling(&abs, fsops::NEW_SUFFIX))?;
                let backup = fsops::sibling(&abs, OLD_SUFFIX);
                if fsops::exists_no_follow(&backup) {
                    // The backup exists only if the original was moved aside, so
                    // whatever sits at `abs` now is ours to discard.
                    remove_entry_if_exists(&abs)?;
                    fsops::rename_if_exists(&backup, &abs)?;
                }
            }
        }
    }
    fsops::remove_dir_all_if_exists(&record.staging_dir)
}

/// Deletes backups and the staging directory after a successful commit.
/// Failures are logged, not returned: the database is already consistent and
/// the next `Store::open` will retry.
pub fn cleanup(root: &Path, record: &TransactionRecord) {
    for op in &record.ops {
        if matches!(
            op,
            JournalEntry::Replaced { .. } | JournalEntry::Removed { .. }
        ) {
            let backup = fsops::sibling(&join_abs(root, op.path()), OLD_SUFFIX);
            if let Err(e) = remove_entry_if_exists(&backup) {
                tracing::warn!(path = %backup.display(), error = %e, "could not remove backup");
            }
        }
    }
    fsops::prune_empty_dirs(root, &record.prune_dirs);
    if let Err(e) = fsops::remove_dir_all_if_exists(&record.staging_dir) {
        tracing::warn!(error = %e, "could not remove staging directory");
    }
}

/// Removes a file or symlink; directories are left alone (they are shared with
/// other packages and pruned separately).
fn remove_entry_if_exists(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => fsops::remove_file_if_exists(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(fsops::io(path)(e)),
    }
}
