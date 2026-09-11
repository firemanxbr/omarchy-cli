//! Shared data model for the Omarchy package pipeline.
//!
//! This crate is the contract between the three layers of the system:
//!
//! * the **build/extraction pipeline** (`pkg-extract`) produces a [`PackageManifest`]
//!   for every built `.pkg.tar.zst`;
//! * the **edge repository** (Cloudflare Worker + D1 + R2) stores and serves it;
//! * the **local client** (`omarchy-cli`) consumes it to resolve and install.
//!
//! Anything that crosses a process or network boundary must be defined here so that
//! the JSON Schema generated from these types stays the single source of truth.

pub mod dependency;
pub mod manifest;
pub mod vercmp;

pub use dependency::{DependencyRule, VersionConstraint, VersionOp};
pub use manifest::{PackageManifest, PkgInfoFields, RepoIndex, MANIFEST_SCHEMA_VERSION};
pub use vercmp::{vercmp, Version};
