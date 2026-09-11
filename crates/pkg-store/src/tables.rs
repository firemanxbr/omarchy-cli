//! redb table definitions and JSON (de)serialization helpers.

use redb::{MultimapTableDefinition, TableDefinition};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{Result, StoreError};

/// name → `InstalledPackage`
pub const PACKAGES: TableDefinition<&str, &[u8]> = TableDefinition::new("installed_packages");
/// capability name → provider package name
pub const CAPABILITIES: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("installed_capabilities");
/// absolute path → `TrackedFile`
pub const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("tracked_files");
/// tx id → `TransactionRecord`
pub const TRANSACTIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("transactions");
/// misc counters
pub const META: TableDefinition<&str, u64> = TableDefinition::new("meta");

pub const META_NEXT_TX: &str = "next_tx_id";

pub fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    // Serializing our own plain data types cannot fail.
    serde_json::to_vec(value).expect("store types are always serializable")
}

pub fn decode<T: DeserializeOwned>(table: &'static str, bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|source| StoreError::Corrupt { table, source })
}
