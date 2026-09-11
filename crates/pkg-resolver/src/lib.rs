//! Dependency resolution.
//!
//! The solver is fed by two candidate sources:
//!
//! * **Installed state** — packages already on the system, read from the pacman
//!   local database (`/var/lib/pacman/local`, read-only) plus the packages managed
//!   by `omarchy-cli` in its own store. These are *locked*: the solver may only
//!   change them when a hard soname requirement of a target cannot otherwise be met.
//! * **Remote candidates** — the dependency subgraph returned by the edge API for
//!   the requested targets.
//!
//! The output is a [`Plan`]: the minimal set of packages to download and install.

use pkg_manifest::{DependencyRule, PackageManifest};

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no candidate satisfies `{0}`")]
    Unsatisfiable(DependencyRule),
    #[error("conflict: {0}")]
    Conflict(String),
}

/// A package that is already installed and therefore preferred by the solver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    pub provides: Vec<DependencyRule>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    pub install: Vec<PackageManifest>,
    pub upgrade: Vec<PackageManifest>,
    pub remove: Vec<String>,
}

/// Resolves `targets` against the given installed state and remote candidates.
///
/// # Phase 3 deliverable
pub fn resolve(
    _targets: &[DependencyRule],
    _installed: &[InstalledPackage],
    _candidates: &[PackageManifest],
) -> Result<Plan, ResolveError> {
    todo!("phase 3: implement resolvo::DependencyProvider over installed + candidates")
}
