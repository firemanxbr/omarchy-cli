//! Transaction lifecycle:
//!
//! 1. stage: extract each archive into `<root>/usr/.omarchy-staging/<tx>/`
//!    (kept on the same filesystem as `/usr` so hardlinks/renames are cheap);
//! 2. check collisions against `tracked_files`;
//! 3. apply: per-file `rename(2)`, journaling each op;
//! 4. commit: write the new package state to redb in one write transaction;
//! 5. cleanup staging.
//!
//! Any failure between 1 and 4 replays the journal in reverse and leaves the
//! system untouched.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionState {
    Staging,
    Applying,
    Committed,
    RolledBack,
}
