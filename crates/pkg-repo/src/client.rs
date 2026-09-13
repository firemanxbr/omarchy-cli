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

/// Manifests per request when reading a release (the worker caps at 1000).
const RELEASE_PAGE: u64 = 500;

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
    /// Promote or roll back this architecture only; the other keeps what the ring serves.
    pub arch: Option<&'a str>,
    pub note: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseCreated {
    pub release: Release,
    pub package_count: u64,
    pub size_download: u64,
    /// Architectures this release serves exactly as its parent did: their
    /// databases are already rendered, the pool carried the artifact rows
    /// over, nothing to render for them.
    #[serde(default)]
    pub unchanged_arches: Vec<String>,
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

/// One dashboard event (`GET /api/v1/events`).
#[derive(Debug, Clone, Deserialize)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub ring: Option<String>,
    pub source: Option<String>,
    pub status: String,
    pub summary: String,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    pub duration_ms: Option<u64>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct EventsView {
    events: Vec<Event>,
}

/// The GitHub Actions run this process belongs to, if any.
fn ci_context() -> Option<serde_json::Value> {
    let run_id = std::env::var("GITHUB_RUN_ID").ok()?;
    let server = std::env::var("GITHUB_SERVER_URL").unwrap_or_else(|_| "https://github.com".into());
    let repo = std::env::var("GITHUB_REPOSITORY").unwrap_or_default();
    Some(serde_json::json!({
        "run_id": run_id,
        "run_url": format!("{server}/{repo}/actions/runs/{run_id}"),
        "workflow": std::env::var("GITHUB_WORKFLOW").ok(),
        "job": std::env::var("GITHUB_JOB").ok(),
        "runner_arch": std::env::var("RUNNER_ARCH").ok(),
    }))
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
    /// The file list, gzip + base64, as `include=files` returns it (inflating
    /// 500 of them per page was too much for the worker); `release()` moves
    /// it into `manifest.files`.
    #[serde(default)]
    pub files_gz: Option<String>,
    #[serde(flatten)]
    pub manifest: PackageManifest,
}

impl IndexedManifest {
    /// Inflates `files_gz` into `manifest.files`.
    fn inflate_files(&mut self) -> Result<(), RepoError> {
        use base64::Engine;
        use std::io::Read;
        let Some(gz) = self.files_gz.take() else {
            return Ok(());
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(gz)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut json = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut json)?;
        self.manifest.files = serde_json::from_str(&json)?;
        Ok(())
    }
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
        Ok(self.known_with_filenames(shas, &[], arch)?.0)
    }

    /// Which sha256s are indexed for `arch`, and which of `filenames` already
    /// have an object under `<arch>/<filename>` (filename → its sha256).
    pub fn known_with_filenames(
        &self,
        shas: &[String],
        filenames: &[String],
        arch: &str,
    ) -> Result<(Vec<String>, std::collections::HashMap<String, String>), RepoError> {
        #[derive(Deserialize)]
        struct Known {
            known: Vec<String>,
            #[serde(default)]
            by_filename: std::collections::HashMap<String, String>,
        }
        let mut out = Vec::new();
        let mut by_filename = std::collections::HashMap::new();
        let mut i = 0;
        while i < shas.len().max(filenames.len()) {
            let sha_chunk = shas.get(i..(i + 2000).min(shas.len())).unwrap_or(&[]);
            let name_chunk = filenames
                .get(i..(i + 2000).min(filenames.len()))
                .unwrap_or(&[]);
            let k: Known = with_retry("known", || {
                let resp = self
                    .http
                    .post(self.url("/packages/known"))
                    .json(&serde_json::json!({ "sha256": sha_chunk, "filenames": name_chunk, "arch": arch }))
                    .send()?;
                Ok(Self::check(resp)?.json()?)
            })?;
            out.extend(k.known);
            by_filename.extend(k.by_filename);
            i += 2000;
        }
        Ok((out, by_filename))
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

    /// Whether the pool signs its own objects (`/status.signing`): when it
    /// does, publishers ask for signatures instead of uploading their own.
    pub fn signing(&self) -> Result<bool, RepoError> {
        let status = self.get_json("/status")?;
        Ok(status["signing"].as_bool().unwrap_or(false))
    }

    /// Asks the pool to sign a package object it stores with its own key.
    pub fn sign_pool(&self, sha256: &str, filename: &str, arch: &str) -> Result<(), RepoError> {
        with_retry("sign_pool", || {
            let resp = self
                .http
                .post(self.url(&format!("/pool/{sha256}/sign")))
                .query(&[("filename", filename), ("arch", arch)])
                .bearer_auth(&self.token)
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
            "arch": req.arch,
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

    /// Newest events of one kind (`limit` ≤ 200).
    pub fn events(&self, kind: &str, limit: u32) -> Result<Vec<Event>, RepoError> {
        with_retry("events", || {
            let resp = self
                .http
                .get(self.url("/events"))
                .query(&[("kind", kind), ("limit", &limit.to_string())])
                .send()?;
            Ok(Self::check(resp)?.json::<EventsView>()?.events)
        })
    }

    /// Release view of one architecture with file lists (needed for
    /// `<repo>.files`), fetched in pages of `RELEASE_PAGE` manifests and pinned
    /// to the release the first page returned, so a ring that moves on
    /// mid-render cannot mix two selections.
    pub fn release(&self, ring: &str, arch: &str) -> Result<ReleaseView, RepoError> {
        let mut view: Option<ReleaseView> = None;
        let mut offset = 0u64;
        // The first page always exists (an empty ring is a 404 from the API).
        loop {
            let mut query = vec![
                ("include", "files".to_owned()),
                ("arch", arch.to_owned()),
                ("limit", RELEASE_PAGE.to_string()),
                ("offset", offset.to_string()),
            ];
            if let Some(v) = &view {
                query.push(("release_id", v.release.id.to_string()));
            }
            let page: ReleaseView = with_retry("release", || {
                let resp = self
                    .http
                    .get(self.url(&format!("/releases/{ring}")))
                    .query(&query)
                    .send()?;
                Ok(Self::check(resp)?.json()?)
            })?;
            let got = page.packages.len() as u64;
            let mut page = page;
            for p in &mut page.packages {
                p.inflate_files()?;
            }
            match &mut view {
                None => view = Some(page),
                Some(v) => v.packages.extend(page.packages),
            }
            offset += got;
            if got < RELEASE_PAGE {
                break;
            }
        }
        view.ok_or_else(|| RepoError::Api {
            status: 0,
            body: "no page returned".into(),
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

    /// `GET` any JSON endpoint, retrying on 5xx.
    pub fn get_json(&self, path: &str) -> Result<serde_json::Value, RepoError> {
        with_retry("get_json", || {
            let resp = self.http.get(self.url(path)).send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `GET` a JSON document from any URL (a public feed), retrying on 5xx.
    pub fn get_external_json(&self, url: &str) -> Result<serde_json::Value, RepoError> {
        with_retry("get_external_json", || {
            let resp = self.http.get(url).send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` JSON to any URL (a public API), retrying on 5xx.
    pub fn post_external_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("post_external_json", || {
            let resp = self.http.post(url).json(body).send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `PUT` raw bytes to an authenticated endpoint (a staging artifact), retrying on 5xx.
    pub fn put_bytes(&self, path: &str, bytes: &[u8]) -> Result<(), RepoError> {
        with_retry("put_bytes", || {
            let resp = self
                .http
                .put(self.url(path))
                .bearer_auth(&self.token)
                .body(bytes.to_vec())
                .send()?;
            Self::check(resp).map(|_| ())
        })
    }

    /// `PUT` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn put_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("put_json", || {
            let resp = self
                .http
                .put(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `PATCH` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn patch_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("patch_json", || {
            let resp = self
                .http
                .patch(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` a JSON body to an authenticated endpoint, retrying on 5xx.
    pub fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, RepoError> {
        with_retry("post_json", || {
            let resp = self
                .http
                .post(self.url(path))
                .bearer_auth(&self.token)
                .json(body)
                .send()?;
            Ok(Self::check(resp)?.json()?)
        })
    }

    /// `POST` with a bearer token of the caller's choosing (a worker token to
    /// claim, a job token for everything else); `None` on 204.
    pub fn post_json_as(
        &self,
        token: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, RepoError> {
        with_retry("post_json_as", || {
            let resp = self
                .http
                .post(self.url(path))
                .bearer_auth(token)
                .json(body)
                .send()?;
            let resp = Self::check(resp)?;
            if resp.status().as_u16() == 204 {
                return Ok(None);
            }
            Ok(Some(resp.json()?))
        })
    }

    /// Records a dashboard event. Under GitHub Actions the payload gains a
    /// `ci` object (run id and URL, job, runner architecture) so the dashboard
    /// can link every line of activity to the run that produced it.
    pub fn post_event(&self, event: &serde_json::Value) -> Result<(), RepoError> {
        let mut event = event.clone();
        if let Some(ci) = ci_context() {
            let payload = event
                .as_object_mut()
                .map(|o| o.entry("payload").or_insert_with(|| serde_json::json!({})));
            if let Some(serde_json::Value::Object(p)) = payload {
                p.insert("ci".into(), ci);
            } else if let Some(p) = payload {
                if p.is_null() {
                    *p = serde_json::json!({ "ci": ci });
                }
            }
        }
        with_retry("post_event", || {
            let resp = self
                .http
                .post(self.url("/events"))
                .bearer_auth(&self.token)
                .json(&event)
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
