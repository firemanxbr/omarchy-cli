//! Publisher-side client for the edge API.

use std::path::Path;

use pkg_manifest::PackageManifest;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::RepoError;

pub struct Api {
    base: String,
    token: String,
    http: Client,
}

#[derive(Debug, Deserialize)]
pub struct Release {
    pub id: u64,
    pub ring: String,
    pub seq: u64,
    pub parent_id: Option<u64>,
    pub source_id: Option<u64>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseCreated {
    pub release: Release,
    pub package_count: u64,
    pub size_download: u64,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<PackageManifest>,
}

impl Api {
    pub fn new(base: &str, token: &str) -> Result<Self, RepoError> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http: Client::builder()
                .user_agent(concat!("pkg-repo/", env!("CARGO_PKG_VERSION")))
                .build()?,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.base)
    }

    fn check(resp: Response) -> Result<Response, RepoError> {
        let status = resp.status();
        if status.is_success() {
            Ok(resp)
        } else {
            let body = resp.text().unwrap_or_default();
            Err(RepoError::Api {
                status: status.as_u16(),
                body,
            })
        }
    }

    /// Whether the index already knows this archive.
    pub fn is_indexed(&self, sha256: &str) -> Result<bool, RepoError> {
        let resp = self
            .http
            .get(self.url(&format!("/packages/{sha256}")))
            .send()?;
        match resp.status() {
            StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            _ => Self::check(resp).map(|_| false),
        }
    }

    pub fn upload_pool(&self, sha256: &str, archive: &Path) -> Result<(), RepoError> {
        let file = std::fs::File::open(archive)?;
        let len = file.metadata()?.len();
        let resp = self
            .http
            .put(self.url(&format!("/pool/{sha256}")))
            .bearer_auth(&self.token)
            .header("content-length", len)
            .body(reqwest::blocking::Body::sized(file, len))
            .send()?;
        Self::check(resp).map(|_| ())
    }

    pub fn upload_pool_signature(&self, sha256: &str, sig: &Path) -> Result<(), RepoError> {
        let bytes = std::fs::read(sig)?;
        let resp = self
            .http
            .put(self.url(&format!("/pool/{sha256}/sig")))
            .bearer_auth(&self.token)
            .body(bytes)
            .send()?;
        Self::check(resp).map(|_| ())
    }

    pub fn index_manifest(&self, manifest: &PackageManifest) -> Result<(), RepoError> {
        let resp = self
            .http
            .post(self.url("/packages"))
            .bearer_auth(&self.token)
            .json(manifest)
            .send()?;
        Self::check(resp).map(|_| ())
    }

    pub fn create_release(
        &self,
        ring: &str,
        from_ring: Option<&str>,
        add: &[String],
        remove: &[String],
        note: Option<&str>,
    ) -> Result<ReleaseCreated, RepoError> {
        let body = serde_json::json!({
            "ring": ring,
            "from_ring": from_ring,
            "add": add,
            "remove": remove,
            "note": note,
        });
        let resp = self
            .http
            .post(self.url("/releases"))
            .bearer_auth(&self.token)
            .json(&body)
            .send()?;
        Ok(Self::check(resp)?.json()?)
    }

    pub fn release(&self, ring: &str) -> Result<ReleaseView, RepoError> {
        let resp = self
            .http
            .get(self.url(&format!("/releases/{ring}")))
            .send()?;
        Ok(Self::check(resp)?.json()?)
    }

    pub fn upload_artifact(
        &self,
        release_id: u64,
        kind: &str,
        repo: &str,
        arch: &str,
        bytes: Vec<u8>,
    ) -> Result<(), RepoError> {
        let resp = self
            .http
            .put(self.url(&format!(
                "/releases/{release_id}/artifacts/{kind}?repo={repo}&arch={arch}"
            )))
            .bearer_auth(&self.token)
            .body(bytes)
            .send()?;
        Self::check(resp).map(|_| ())
    }
}
