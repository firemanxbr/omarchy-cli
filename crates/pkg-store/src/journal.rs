//! Rollback journal entries. Each filesystem operation is recorded here before it
//! is applied so that an interrupted transaction can be undone on next start.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum JournalEntry {
    /// A new file was placed at `path`; rollback removes it.
    Created { path: String },
    /// `path` was replaced; the previous content is kept at `backup`.
    Replaced { path: String, backup: String },
    /// `path` was removed; the previous content is kept at `backup`.
    Removed { path: String, backup: String },
}
