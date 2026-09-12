//! Local state and transactional installation.
//!
//! State lives in a single redb file (`/var/lib/omarchy-cli/state.redb`) with the
//! following tables:
//!
//! | table                    | key          | value                                    |
//! |--------------------------|--------------|------------------------------------------|
//! | `installed_packages`     | name         | [`InstalledPackage`] (JSON)              |
//! | `installed_capabilities` | capability   | provider package name (multimap)         |
//! | `tracked_files`          | path         | [`TrackedFile`] (JSON)                   |
//! | `transactions`           | tx id        | [`journal::TransactionRecord`] (JSON)    |
//! | `meta`                   | key          | counters                                 |
//!
//! Every mutation runs inside a redb write transaction, so a `SIGKILL` or power
//! loss leaves the database at the previous consistent state. Filesystem changes
//! are journaled in `transactions` **before** being applied, which lets
//! [`Store::open`] roll back a half-applied transaction on the next run.

pub mod journal;
pub mod transaction;

mod fsops;
mod tables;

use std::path::{Path, PathBuf};

use pkg_manifest::{DependencyRule, PackageManifest};
use redb::{Database, ReadableTable};
use serde::{Deserialize, Serialize};

use crate::journal::{TransactionRecord, TransactionState};
use crate::tables::{CAPABILITIES, FILES, META, PACKAGES, TRANSACTIONS};

pub use crate::transaction::{Transaction, TransactionReport};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] Box<redb::Error>),
    #[error("I/O error{}: {source}", path.as_ref().map(|p| format!(" at {}", p.display())).unwrap_or_default())]
    Io {
        source: std::io::Error,
        path: Option<PathBuf>,
    },
    #[error("corrupt record in table `{table}`: {source}")]
    Corrupt {
        table: &'static str,
        source: serde_json::Error,
    },
    #[error("file collision: `{path}` is owned by `{owner}`")]
    Collision { path: String, owner: String },
    #[error("package `{0}` is not installed")]
    NotInstalled(String),
    #[error("transaction {tx} failed and was rolled back: {source}")]
    RolledBack {
        tx: u64,
        #[source]
        source: Box<StoreError>,
    },
    #[error("transaction {tx} failed and rollback also failed ({rollback_error}); original error: {source}")]
    RollbackFailed {
        tx: u64,
        #[source]
        source: Box<StoreError>,
        rollback_error: Box<StoreError>,
    },
    #[error("simulated crash after {0} operations")]
    SimulatedCrash(usize),
}

impl From<std::io::Error> for StoreError {
    fn from(source: std::io::Error) -> Self {
        Self::Io { source, path: None }
    }
}

macro_rules! from_redb {
    ($($t:ty),*) => {$(
        impl From<$t> for StoreError {
            fn from(e: $t) -> Self { Self::Db(Box::new(redb::Error::from(e))) }
        }
    )*};
}
from_redb!(
    redb::DatabaseError,
    redb::TransactionError,
    redb::TableError,
    redb::StorageError,
    redb::CommitError
);

pub type Result<T> = std::result::Result<T, StoreError>;

/// A package recorded in the store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    pub sha256: String,
    /// Unix timestamp (seconds) of the transaction that installed this version.
    pub installed_at: u64,
    pub manifest: PackageManifest,
}

/// A file (or directory, or symlink) placed on disk by a package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedFile {
    pub owner: String,
    pub mode: u32,
    /// Hex SHA-256 of the content for regular files; `None` for directories and
    /// symlinks.
    pub sha256: Option<String>,
}

/// Handle to the local state database and the filesystem root it manages.
pub struct Store {
    db: Database,
    root: PathBuf,
    staging_root: PathBuf,
}

impl Store {
    /// Opens (or creates) the state database at `db_path`. `root` is the
    /// filesystem root packages are installed into (`/` in production, a temp dir
    /// in tests). Any transaction left half-applied by a previous crash is rolled
    /// back (or, if it had already committed, its cleanup is finished) before
    /// this returns.
    pub fn open(db_path: &Path, root: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            fsops::create_dir_all(parent)?;
        }
        let db = Database::create(db_path)?;
        let staging_root = root.join("var/lib/omarchy-cli/staging");
        let store = Self {
            db,
            root: root.to_path_buf(),
            staging_root,
        };
        store.init_tables()?;
        store.recover()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn init_tables(&self) -> Result<()> {
        let txn = self.db.begin_write()?;
        {
            txn.open_table(PACKAGES)?;
            txn.open_multimap_table(CAPABILITIES)?;
            txn.open_table(FILES)?;
            txn.open_table(TRANSACTIONS)?;
            txn.open_table(META)?;
        }
        txn.commit()?;
        Ok(())
    }

    /// Finishes whatever a previous process left behind in `transactions`.
    fn recover(&self) -> Result<()> {
        let pending: Vec<(u64, TransactionRecord)> = {
            let read = self.db.begin_read()?;
            let table = read.open_table(TRANSACTIONS)?;
            let mut out = Vec::new();
            for item in table.iter()? {
                let (k, v) = item?;
                out.push((k.value(), tables::decode("transactions", v.value())?));
            }
            out
        };
        for (id, record) in pending {
            match record.state {
                TransactionState::Staging => {
                    tracing::warn!(tx = id, "removing staging of interrupted transaction");
                    fsops::remove_dir_all_if_exists(&record.staging_dir)?;
                }
                TransactionState::Applying => {
                    tracing::warn!(tx = id, "rolling back interrupted transaction");
                    journal::rollback(&self.root, &record)?;
                }
                TransactionState::Committed => {
                    tracing::warn!(tx = id, "finishing cleanup of committed transaction");
                    journal::cleanup(&self.root, &record);
                }
            }
            self.delete_record(id)?;
        }
        Ok(())
    }

    pub(crate) fn delete_record(&self, id: u64) -> Result<()> {
        let txn = self.db.begin_write()?;
        {
            txn.open_table(TRANSACTIONS)?.remove(id)?;
        }
        txn.commit()?;
        Ok(())
    }

    /// Starts building a transaction. Nothing touches the disk until
    /// [`Transaction::commit`].
    pub fn transaction(&self) -> Transaction<'_> {
        Transaction::new(self)
    }

    // ----- queries ---------------------------------------------------------

    pub fn installed(&self) -> Result<Vec<InstalledPackage>> {
        let read = self.db.begin_read()?;
        let table = read.open_table(PACKAGES)?;
        let mut out = Vec::new();
        for item in table.iter()? {
            let (_, v) = item?;
            out.push(tables::decode("installed_packages", v.value())?);
        }
        Ok(out)
    }

    pub fn package(&self, name: &str) -> Result<Option<InstalledPackage>> {
        let read = self.db.begin_read()?;
        let table = read.open_table(PACKAGES)?;
        table
            .get(name)?
            .map(|v| tables::decode("installed_packages", v.value()))
            .transpose()
    }

    /// Looks up the package that owns an absolute path.
    pub fn owner_of(&self, path: &str) -> Result<Option<TrackedFile>> {
        let read = self.db.begin_read()?;
        let table = read.open_table(FILES)?;
        table
            .get(path)?
            .map(|v| tables::decode("tracked_files", v.value()))
            .transpose()
    }

    /// Every tracked path owned by `name`, sorted.
    pub fn files_of(&self, name: &str) -> Result<Vec<String>> {
        let read = self.db.begin_read()?;
        let table = read.open_table(FILES)?;
        let mut out = Vec::new();
        for item in table.iter()? {
            let (k, v) = item?;
            let tracked: TrackedFile = tables::decode("tracked_files", v.value())?;
            if tracked.owner == name {
                out.push(k.value().to_owned());
            }
        }
        Ok(out)
    }

    /// Names of installed packages providing `capability` (a bare name such as
    /// `libz.so` or `openssl`; version constraints are checked by the resolver
    /// against each provider's manifest).
    pub fn providers_of(&self, capability: &str) -> Result<Vec<String>> {
        let read = self.db.begin_read()?;
        let table = read.open_multimap_table(CAPABILITIES)?;
        let mut out = Vec::new();
        for item in table.get(capability)? {
            out.push(item?.value().to_owned());
        }
        out.sort();
        Ok(out)
    }

    /// All `provides` rules of every installed package, for seeding the resolver.
    pub fn provided_capabilities(&self) -> Result<Vec<(String, DependencyRule)>> {
        let mut out = Vec::new();
        for pkg in self.installed()? {
            for rule in &pkg.manifest.provides {
                out.push((pkg.name.clone(), rule.clone()));
            }
        }
        Ok(out)
    }

    pub(crate) fn db(&self) -> &Database {
        &self.db
    }

    pub(crate) fn staging_root(&self) -> &Path {
        &self.staging_root
    }
}
