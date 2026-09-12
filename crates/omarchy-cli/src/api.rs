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

/// A manifest as the index returns it. The index adds provenance fields
/// (`source`, `repo_arch`) that the strict manifest type does not know; they
/// are absorbed here so the manifest itself stays exact.
#[derive(Debug, Clone, Deserialize)]
pub struct IndexedManifest {
    #[serde(default, rename = "source")]
    _source: Option<String>,
    /// Architecture of the upstream repository the package came from.
    #[serde(default)]
    pub repo_arch: Option<String>,
    #[serde(flatten)]
    pub manifest: PackageManifest,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub packages: Vec<IndexedManifest>,
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
    #[serde(default)]
    pub repo_arch: Option<String>,
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
    pub packages: Vec<IndexedManifest>,
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
    /// Full manifests of one architecture, paged (500 per request) and pinned
    /// to the release the first page returned.
    pub fn release(&self, ring: &str, arch: &str) -> Result<ReleaseView> {
        let mut view: Option<ReleaseView> = None;
        let mut offset = 0usize;
        loop {
            let pin = view
                .as_ref()
                .map(|v| format!("&release_id={}", v.release.id))
                .unwrap_or_default();
            let page: ReleaseView = self.get(&format!(
                "/releases/{ring}?arch={arch}&limit=500&offset={offset}{pin}"
            ))?;
            let got = page.packages.len();
            match &mut view {
                None => view = Some(page),
                Some(v) => v.packages.extend(page.packages),
            }
            offset += got;
            if got < 500 {
                break;
            }
        }
        view.ok_or_else(|| anyhow::anyhow!("no page returned for {ring}"))
    }

    /// Light listing for status / list / search.
    pub fn release_summary(&self, ring: &str) -> Result<ReleaseSummaryView> {
        self.get(&format!("/releases/{ring}?fields=summary"))
    }

    /// Packages the ring serves with an open advisory, for one architecture.
    pub fn security(&self, ring: &str, arch: &str) -> Result<SecurityView> {
        self.get(&format!("/security?ring={ring}&arch={arch}"))
    }

    pub fn graph(&self, ring: &str, arch: &str, targets: &[String]) -> Result<Graph> {
        self.get(&format!(
            "/graph?ring={ring}&arch={arch}&targets={}",
            targets.join(",")
        ))
    }
}

/// One package with an open advisory (`GET /api/v1/security`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct VulnerablePackage {
    pub name: String,
    pub version: String,
    pub worst: String,
    pub kev: bool,
    #[serde(default)]
    pub epss: Option<f64>,
    pub advisories: Vec<AdvisoryRef>,
    #[serde(default)]
    pub fixed_in: Vec<FixedIn>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct AdvisoryRef {
    pub id: String,
    pub tracker: String,
    pub cves: Vec<String>,
    pub severity: String,
    #[serde(rename = "match")]
    pub confidence: String,
    #[serde(default)]
    pub fixed: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct FixedIn {
    pub ring: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct SecurityView {
    pub ring: String,
    pub arch: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub vulnerable: Vec<VulnerablePackage>,
}
