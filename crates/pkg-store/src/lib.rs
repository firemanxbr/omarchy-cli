//! Local state and transactional installation.
//!
//! State lives in a single redb file (`/var/lib/omarchy-cli/state.redb`) with the
//! following tables:
//!
//! | table                    | key          | value                                   |
//! |--------------------------|--------------|-----------------------------------------|
//! | `installed_packages`     | name         | version, sha256, `install_date`, manifest |
//! | `installed_capabilities` | capability   | package name, version                   |
//! | `tracked_files`          | path         | owner package, mode, sha256             |
//! | `transactions`           | tx id        | journal of applied filesystem ops       |
//!
//! Every mutation runs inside a redb write transaction, so a `SIGKILL` or power
//! loss leaves the database at the previous consistent state. Filesystem changes
//! are journaled in `transactions` **before** being applied, which lets the next
//! run roll back a half-applied transaction.

pub mod journal;
pub mod transaction;

use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] Box<redb::Error>),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("file collision: `{path}` is owned by `{owner}`")]
    Collision { path: String, owner: String },
    #[error("transaction {0} was interrupted and needs rollback")]
    Interrupted(u64),
}

pub struct Store {
    _db: redb::Database,
    _root: PathBuf,
}

impl Store {
    /// Opens (or creates) the state database at `path`. `root` is the filesystem
    /// root packages are installed into (`/` in production, a temp dir in tests).
    pub fn open(_path: &Path, _root: &Path) -> Result<Self, StoreError> {
        todo!("phase 2: open redb, define tables, run pending rollback if any")
    }
}
