//! What the thin client knows about the machine, and the decision it makes.
//!
//! * [`local::LocalDb`] — the pacman local database (`/var/lib/pacman/local`),
//!   read-only: installed packages, versions, `provides`.
//! * [`abi::SystemAbi`] — the shared libraries actually on disk and the symbol
//!   versions they define (`.gnu.version_d`), so `libc.so.6(GLIBC_2.34)` is
//!   checked against the real libc, not against a package name.
//! * [`check`] — given the packages a release would install, reports what is
//!   missing on this machine and whether the install is safe to hand to pacman.

pub mod abi;
pub mod check;
pub mod local;

pub use check::{check, Action, Finding, Plan, PlannedPackage, Severity};
