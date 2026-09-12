//! Publisher-side client for the edge API, with retries.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use pkg_manifest::PackageManifest;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::RepoError;

/// Bodies above this go through the multipart endpoints (Workers caps a
/// single request body; parts stay well under it).
pub const SINGLE_PUT_MAX: u64 = 90 * 1024 * 1024;
pub const PART_SIZE: u64 = 64 * 1024 * 1024;
const ATTEMPTS: u32 = 4;

#[derive(Clone)]
pub struct Api {
    base: String,
    token: String,
    http: Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub id: u64,
    pub ring: String,
    pub seq: u64,
    pub parent_id: Option<u64>,
    pub source_id: Option<u64>,
    pub note: Option<String>,
    pub created_at: String,
}

/// What `POST /api/v1/releases` accepts.
#[derive(Debug, Default, Clone)]
pub struct ReleaseRequest<'a> {
    pub ring: &'a str,
    /// Promote: copy the head selection of this ring.
    pub from_ring: Option<&'a str>,
    /// Roll back / pin: copy this exact release's selection.
    pub from_release_id: Option<u64>,
    pub add: &'a [String],
    pub remove: &'a [String],
    /// Scope `add` lookups and `remove` to one repository architecture.
    pub remove_arch: Option<&'a str>,
    pub note: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseCreated {
    pub release: Release,
    pub package_count: u64,
    pub size_download: u64,
}

#[derive(Debug, Deserialize)]
pub struct HistoryEntry {
    pub id: u64,
    pub seq: u64,
    pub parent_id: Option<u64>,
    pub source_id: Option<u64>,
    pub note: Option<String>,
    pub created_at: String,
    pub package_count: u64,
    pub is_head: u8,
}

#[derive(Debug, Deserialize)]
pub struct History {
    pub ring: String,
    pub releases: Vec<HistoryEntry>,
}

/// A manifest as the index returns it (with the provenance it recorded).
#[derive(Debug, Clone, Deserialize)]
pub struct IndexedManifest {
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_arch")]
    pub repo_arch: String,
    #[serde(flatten)]
    pub manifest: PackageManifest,
}

fn default_source() -> String {
    "packages".into()
}

fn default_arch() -> String {
    "x86_64".into()
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<IndexedManifest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub filename: String,
    pub sha256: String,
    pub size_download: u64,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_arch")]
    pub repo_arch: String,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSummaryView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<PackageSummary>,
}

#[derive(Debug, Deserialize)]
struct MultipartCreated {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    uploads: Vec<MultipartUpload>,
}

#[derive(Debug, Deserialize)]
struct MultipartUpload {
    key: String,
    #[serde(rename = "uploadId")]
    upload_id: String,
}

#[derive(Debug, Deserialize)]
struct PartDone {
    #[serde(rename = "partNumber")]
    part_number: u32,
    etag: String,
}

/// Retries transient failures (network errors, 429, 5xx) with backoff.
fn with_retry<T>(what: &str, mut f: impl FnMut() -> Result<T, RepoError>) -> Result<T, RepoError> {
    let mut delay = Duration::from_millis(800);
    let mut attempt = 1;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < ATTEMPTS && is_transient(&e) => {
                tracing::warn!(what, attempt, error = %e, "retrying");
                std::thread::sleep(delay);
                delay *= 2;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_transient(e: &RepoError) -> bool {
    match e {
        RepoError::Http(_) | RepoError::Io(_) => true,
        RepoError::Api { status, .. } => *status == 429 || *status >= 500,
        _ => false,
    }
}

impl Api {
    pub fn new(base: &str, token: &str) -> Result<Self, RepoError> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http: Client::builder()
                .user_agent(concat!("pkg-repo/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(600))
                .build()?,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
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
        with_retry("is_indexed", || {
            let resp = self
                .http
                .get(self.url(&format!("/packages/{sha256}")))
                .send()?;
            match resp.status() {
                StatusCode::OK => Ok(true),
                StatusCode::NOT_FOUND => Ok(false),
                _ => Self::check(resp).map(|_| false),
            }
        })
    }

    /// Subset of `shas` the index already knows for `arch`.
    pub fn known(&self, shas: &[String], arch: &str) -> Result<Vec<String>, RepoError> {
        #[derive(Deserialize)]
        struct Known {
            known: Vec<String>,
        }
        let mut out = Vec::new();
        for chunk in shas.chunks(2000) {
            let k: Known = with_retry("known", || {
                let resp = self
                    .http
                    .post(self.url("/packages/known"))
                    .json(&serde_json::json!({ "sha256": chunk, "arch": arch }))
                    .send()?;
                Ok(Self::check(resp)?.json()?)
            })?;
            out.extend(k.known);
        }
        Ok(out)
    }

    /// Uploads an archive into the pool under `<arch>/<filename>`; multipart when large.
    pub fn upload_pool(
        &self,
        sha256: &str,
        filename: &str,
        arch: &str,
        archive: &Path,
    ) -> Result<(), RepoError> {
        let len = std::fs::metadata(archive)?.len();
        if len <= SINGLE_PUT_MAX {
            return with_retry("upload_pool", || {
                let file = std::fs::File::open(archive)?;
                let resp = self
                    .http
                    .put(self.url(&format!("/pool/{sha256}")))
                    .query(&[("filename", filename), ("arch", arch)])
                    .bearer_auth(&self.token)
                    .header("content-length", len)
                    .body(reqwest::blocking::Body::sized(file, len))
                    .send()?;
                Self::check(resp).map(|_| ())
            });
        }

        let created: MultipartCreated = with_retry("multipart_create", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/{sha256}/multipart")))
                .query(&[("filename", filename), ("arch", arch)])
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })?;
        if created.status.as_deref() == Some("already-present") {
            return Ok(());
        }
        for upload in &created.uploads {
            let mut file = std::fs::File::open(archive)?;
            let mut parts = Vec::new();
            let mut part_number = 1u32;
            let mut buf = vec![
                0u8;
                usize::try_from(PART_SIZE).map_err(|_| RepoError::Api {
                    status: 0,
                    body: "part size does not fit usize".into()
                })?
            ];
            loop {
                let n = read_full(&mut file, &mut buf)?;
                if n == 0 {
                    break;
                }
                let chunk = buf[..n].to_vec();
                let done: PartDone = with_retry("multipart_part", || {
                    let resp = self
                        .http
                        .put(self.url(&format!(
                            "/pool/multipart/{}/part/{part_number}",
                            upload.upload_id
                        )))
                        .query(&[("key", upload.key.as_str())])
                        .bearer_auth(&self.token)
                        .body(chunk.clone())
                        .send()?;
                    Ok(Self::check(resp)?.json()?)
                })?;
                parts
                    .push(serde_json::json!({ "partNumber": done.part_number, "etag": done.etag }));
                part_number += 1;
            }
            with_retry("multipart_complete", || {
                let resp = self
                    .http
                    .post(self.url(&format!("/pool/multipart/{}/complete", upload.upload_id)))
                    .query(&[("key", upload.key.as_str())])
                    .bearer_auth(&self.token)
                    .json(&serde_json::json!({ "parts": parts }))
                    .send()?;
                Self::check(resp).map(|_| ())
            })?;
        }
        Ok(())
    }

    pub fn upload_pool_signature(
        &self,
        sha256: &str,
        filename: &str,
        arch: &str,
        sig: &Path,
    ) -> Result<(), RepoError> {
        let bytes = std::fs::read(sig)?;
        with_retry("upload_sig", || {
            let resp = self
                .http
                .put(self.url(&format!("/pool/{sha256}/sig")))
                .query(&[("filename", filename), ("arch", arch)])
                .bearer_auth(&self.token)
                .body(bytes.clone())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn index_manifest(
        &self,
        manifest: &PackageManifest,
        source: &str,
        arch: &str,
    ) -> Result<(), RepoError> {
        with_retry("index_manifest", || {
            let resp = self
                .http
                .post(self.url("/packages"))
                .query(&[("source", source), ("arch", arch)])
                .bearer_auth(&self.token)
                .json(manifest)
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn create_release(&self, req: &ReleaseRequest<'_>) -> Result<ReleaseCreated, RepoError> {
        let body = serde_json::json!({
            "ring": req.ring,
            "from_ring": req.from_ring,
            "from_release_id": req.from_release_id,
            "add": req.add,
            "remove": req.remove,
            "remove_arch": req.remove_arch,
            "note": req.note,
        });
        with_retry("create_release", || {
            let resp = self
                .http
                .post(self.url("/releases"))
                .bearer_auth(&self.token)
                .json(&body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn history(&self, ring: &str) -> Result<History, RepoError> {
        with_retry("history", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}/history")))
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// Release view with file lists (needed for `<repo>.files`).
    pub fn release(&self, ring: &str) -> Result<ReleaseView, RepoError> {
        with_retry("release", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}?include=files")))
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn release_summary(&self, ring: &str) -> Result<Option<ReleaseSummaryView>, RepoError> {
        with_retry("release_summary", || {
            let resp = self
                .http
                .get(self.url(&format!("/releases/{ring}?fields=summary")))
                .send()?;
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            Ok(Some(Self::check(resp)?.json()?))
        })
    }

    pub fn upload_artifact(
        &self,
        release_id: u64,
        kind: &str,
        repo: &str,
        arch: &str,
        bytes: &[u8],
    ) -> Result<(), RepoError> {
        with_retry("upload_artifact", || {
            let resp = self
                .http
                .put(self.url(&format!("/releases/{release_id}/artifacts/{kind}")))
                .query(&[("repo", repo), ("arch", arch)])
                .bearer_auth(&self.token)
                .body(bytes.to_vec())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    pub fn unreferenced(&self, keep: u32) -> Result<serde_json::Value, RepoError> {
        with_retry("unreferenced", || {
            let resp = self
                .http
                .get(self.url(&format!("/pool/unreferenced?keep={keep}")))
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn gc(&self, keep: u32, limit: u32) -> Result<serde_json::Value, RepoError> {
        with_retry("gc", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/gc?keep={keep}&limit={limit}")))
                .bearer_auth(&self.token)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    pub fn post_event(&self, event: &serde_json::Value) -> Result<(), RepoError> {
        with_retry("post_event", || {
            let resp = self
                .http
                .post(self.url("/events"))
                .bearer_auth(&self.token)
                .json(event)
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    /// Streams `url` to `dest`, returning the SHA-256 of what was written.
    pub fn download(&self, url: &str, dest: &Path) -> Result<String, RepoError> {
        use sha2::{Digest, Sha256};
        with_retry("download", || {
            let mut resp = Self::check(self.http.get(url).send()?)?;
            let mut file = std::fs::File::create(dest)?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 1024 * 1024];
            loop {
                let n = resp.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                std::io::Write::write_all(&mut file, &buf[..n])?;
            }
            Ok(hex::encode(hasher.finalize()))
        })
    }
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}
