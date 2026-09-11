//! Read-only client for the edge index.

use anyhow::{bail, Context, Result};
use pkg_manifest::PackageManifest;
use serde::Deserialize;

pub struct Api {
    base: String,
    http: reqwest::blocking::Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub id: u64,
    pub seq: u64,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub packages: Vec<PackageManifest>,
}

/// One row of `?fields=summary`: what status / list / search need.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub filename: String,
    pub sha256: String,
    pub size_download: u64,
    pub size_installed: u64,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSummaryView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<PackageSummary>,
}

#[derive(Debug, Deserialize)]
pub struct Graph {
    pub release_id: u64,
    pub packages: Vec<PackageManifest>,
    pub missing_targets: Vec<String>,
    pub truncated: bool,
}

impl Api {
    pub fn new(base: &str) -> Result<Self> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            http: reqwest::blocking::Client::builder()
                .user_agent(concat!("omarchy-cli/", env!("CARGO_PKG_VERSION")))
                .build()?,
        })
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}/api/v1{path}", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            bail!(
                "{url}: {} {}",
                resp.status(),
                resp.text().unwrap_or_default()
            );
        }
        resp.json().with_context(|| format!("decoding {url}"))
    }

    /// Full manifests (without file lists) — needed for the safety check.
    pub fn release(&self, ring: &str) -> Result<ReleaseView> {
        self.get(&format!("/releases/{ring}"))
    }

    /// Light listing for status / list / search.
    pub fn release_summary(&self, ring: &str) -> Result<ReleaseSummaryView> {
        self.get(&format!("/releases/{ring}?fields=summary"))
    }

    pub fn graph(&self, ring: &str, targets: &[String]) -> Result<Graph> {
        self.get(&format!("/graph?ring={ring}&targets={}", targets.join(",")))
    }
}
