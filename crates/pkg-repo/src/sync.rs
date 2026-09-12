//! Mirror sync: bring one upstream repository (`core`, `extra`, `multilib`) into
//! the pool and pin the result as a new `edge` release.
//!
//! 1. read the upstream `<source>.db`;
//! 2. ask the index which archives it already has (by sha256);
//! 3. for each missing one, in parallel: download, verify against the upstream
//!    sha256, extract the manifest, upload archive + signature, index it;
//! 4. create the ring release: base = current head, `add` = every upstream
//!    package of this source, `remove` = packages of this source that upstream
//!    dropped;
//! 5. post a `sync` event with the numbers.
//!
//! Package bytes are uploaded exactly once; re-running is a no-op.

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use crate::client::{Api, ReleaseRequest};
use crate::syncdb::{parse_sync_db, UpstreamPackage};
use crate::RepoError;

/// `(sha256, bytes)` of an imported package.
type Imported = (String, u64);
/// `(filename, error)` of a failed import.
type Failed = (String, String);

pub struct SyncOptions {
    pub source: String,
    pub upstream: String,
    /// Directory holding the database and the packages; overrides the Arch
    /// layout `<upstream>/<source>/os/<arch>` (Arch Linux ARM uses
    /// `<upstream>/<arch>/<source>`, the OPR `<upstream>/<ring>/<arch>`).
    pub base_url: Option<String>,
    /// Database file name without `.db`; defaults to `source`.
    pub db_name: Option<String>,
    /// Architecture of the upstream repository; also the pool directory.
    pub arch: String,
    pub ring: String,
    /// Stop after this many new packages (0 = no limit); the rest wait for the
    /// next run, which keeps a first import inside one job.
    pub limit: usize,
    pub concurrency: usize,
    pub work_dir: PathBuf,
    pub dry_run: bool,
    /// GPG keyring file the upstream `.sig` of every package must verify
    /// against; packages without a valid signature are not imported.
    pub keyring: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub upstream_total: usize,
    pub already_indexed: usize,
    pub uploaded: usize,
    pub failed: Vec<Failed>,
    pub removed: usize,
    pub bytes_uploaded: u64,
    pub release: Option<(u64, u64)>,
    pub deferred: usize,
}

pub fn run(api: &Api, opts: &SyncOptions) -> Result<SyncReport, RepoError> {
    let started = Instant::now();
    let base = opts.base_url.clone().unwrap_or_else(|| {
        format!(
            "{}/{}/os/{}",
            opts.upstream.trim_end_matches('/'),
            opts.source,
            opts.arch
        )
    });
    let base = base.trim_end_matches('/').to_owned();
    let db_name = opts.db_name.clone().unwrap_or_else(|| opts.source.clone());
    std::fs::create_dir_all(&opts.work_dir)?;

    // 1. upstream database
    let db_path = opts.work_dir.join(format!("{db_name}-{}.db", opts.arch));
    api.download(&format!("{base}/{db_name}.db"), &db_path)?;
    let upstream = parse_sync_db(&std::fs::read(&db_path)?)?;
    let mut report = SyncReport {
        upstream_total: upstream.len(),
        ..SyncReport::default()
    };
    tracing::info!(source = %opts.source, packages = upstream.len(), "upstream database read");

    // 2. what the index already has
    let shas: Vec<String> = upstream.iter().map(|p| p.sha256.clone()).collect();
    let known: HashSet<String> = api.known(&shas, &opts.arch)?.into_iter().collect();
    report.already_indexed = known.len();
    let mut missing: Vec<&UpstreamPackage> = upstream
        .iter()
        .filter(|p| !known.contains(&p.sha256))
        .collect();
    if opts.limit > 0 && missing.len() > opts.limit {
        report.deferred = missing.len() - opts.limit;
        missing.truncate(opts.limit);
    }
    tracing::info!(
        missing = missing.len(),
        deferred = report.deferred,
        "packages to import"
    );

    if opts.dry_run {
        for p in &missing {
            println!("would import {} ({} bytes)", p.filename, p.size_download);
        }
        return Ok(report);
    }

    // 3. import in parallel
    let (done, failed) = import_all(api, &base, opts, &missing);
    report.uploaded = done.len();
    report.bytes_uploaded = done.iter().map(|(_, b)| b).sum();
    report.failed = failed;

    // 4. pin: every upstream package of this source that the index now has.
    let now_known: HashSet<String> = known
        .iter()
        .cloned()
        .chain(done.iter().map(|(s, _)| s.clone()))
        .collect();
    let add: Vec<String> = upstream
        .iter()
        .filter(|p| now_known.contains(&p.sha256))
        .map(|p| p.sha256.clone())
        .collect();
    let upstream_names: BTreeSet<&str> = upstream.iter().map(|p| p.name.as_str()).collect();
    let remove: Vec<String> = match api.release_summary(&opts.ring)? {
        Some(view) => view
            .packages
            .iter()
            .filter(|p| {
                p.source == opts.source
                    && p.repo_arch == opts.arch
                    && !upstream_names.contains(p.name.as_str())
            })
            .map(|p| p.name.clone())
            .collect(),
        None => Vec::new(),
    };
    report.removed = remove.len();

    let note = format!(
        "sync {} {}: {} new, {} removed, {} upstream",
        opts.source, opts.arch, report.uploaded, report.removed, report.upstream_total
    );
    let created = api.create_release(&ReleaseRequest {
        ring: &opts.ring,
        add: &add,
        remove: &remove,
        remove_arch: Some(&opts.arch),
        note: Some(&note),
        ..ReleaseRequest::default()
    })?;
    report.release = Some((created.release.id, created.release.seq));

    // 5. event
    post_sync_event(
        api,
        opts,
        &report,
        &base,
        created.release.seq,
        created.release.id,
        started,
    )?;
    Ok(report)
}

fn post_sync_event(
    api: &Api,
    opts: &SyncOptions,
    report: &SyncReport,
    base: &str,
    seq: u64,
    release_id: u64,
    started: Instant,
) -> Result<(), RepoError> {
    let status = if report.failed.is_empty() {
        "ok"
    } else {
        "warn"
    };
    let summary = if report.failed.is_empty() {
        format!(
            "{} {}: {} new packages ({}), {} removed → {}#{}",
            opts.source,
            opts.arch,
            report.uploaded,
            human(report.bytes_uploaded),
            report.removed,
            opts.ring,
            seq
        )
    } else {
        format!(
            "{} {}: {} new, {} failed, {} removed → {}#{}",
            opts.source,
            opts.arch,
            report.uploaded,
            report.failed.len(),
            report.removed,
            opts.ring,
            seq
        )
    };
    api.post_event(&serde_json::json!({
        "kind": "sync",
        "ring": opts.ring,
        "source": opts.source,
        "status": status,
        "summary": summary,
        "duration_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "payload": {
            "upstream": base,
            "arch": opts.arch,
            "upstream_total": report.upstream_total,
            "already_indexed": report.already_indexed,
            "uploaded": report.uploaded,
            "bytes_uploaded": report.bytes_uploaded,
            "removed": report.removed,
            "deferred": report.deferred,
            "concurrency": opts.concurrency,
            "throughput_bps": throughput(report.bytes_uploaded, started),
            "verified_against": opts.keyring.as_ref().map(|k| k.file_name().map(|f| f.to_string_lossy().into_owned())),
            "failed": report.failed.iter().map(|(f, e)| serde_json::json!({"file": f, "error": e})).collect::<Vec<_>>(),
            "release_id": release_id,
        }
    }))
}

/// Runs `import_one` over `missing` with `opts.concurrency` workers. Returns
/// `(imported (sha256, bytes), failed (filename, error))`.
///
/// # Panics
/// Only if a worker thread panicked while holding a lock, which would be a bug.
fn import_all(
    api: &Api,
    base: &str,
    opts: &SyncOptions,
    missing: &[&UpstreamPackage],
) -> (Vec<Imported>, Vec<Failed>) {
    let queue: Mutex<Vec<&UpstreamPackage>> = Mutex::new(missing.iter().rev().copied().collect());
    let done: Mutex<Vec<Imported>> = Mutex::new(Vec::new());
    let failed: Mutex<Vec<Failed>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for worker in 0..opts.concurrency.max(1) {
            let queue = &queue;
            let done = &done;
            let failed = &failed;
            let api = api.clone();
            let work_dir = opts.work_dir.join(format!("w{worker}"));
            let source = opts.source.clone();
            let arch = opts.arch.clone();
            let keyring = opts.keyring.clone();
            scope.spawn(move || {
                let _ = std::fs::create_dir_all(&work_dir);
                loop {
                    let next = queue.lock().expect("queue").pop();
                    let Some(pkg) = next else {
                        break;
                    };
                    match import_one(
                        &api,
                        base,
                        &source,
                        &arch,
                        pkg,
                        &work_dir,
                        keyring.as_deref(),
                    ) {
                        Ok(()) => done
                            .lock()
                            .expect("done")
                            .push((pkg.sha256.clone(), pkg.size_download)),
                        Err(e) => {
                            tracing::error!(package = %pkg.filename, error = %e, "import failed");
                            failed
                                .lock()
                                .expect("failed")
                                .push((pkg.filename.clone(), e.to_string()));
                        }
                    }
                }
            });
        }
    });
    (
        done.into_inner().expect("done"),
        failed.into_inner().expect("failed"),
    )
}

fn import_one(
    api: &Api,
    base: &str,
    source: &str,
    arch: &str,
    pkg: &UpstreamPackage,
    work_dir: &std::path::Path,
    keyring: Option<&std::path::Path>,
) -> Result<(), RepoError> {
    let archive = work_dir.join(&pkg.filename);
    let sig = work_dir.join(format!("{}.sig", pkg.filename));
    let result = (|| {
        let sha = api.download(&format!("{base}/{}", pkg.filename), &archive)?;
        if sha != pkg.sha256 {
            return Err(RepoError::Integrity {
                file: pkg.filename.clone(),
                expected: pkg.sha256.clone(),
                actual: sha,
            });
        }
        let has_sig = api
            .download(&format!("{base}/{}.sig", pkg.filename), &sig)
            .is_ok();
        if let Some(keyring) = keyring {
            if !has_sig {
                return Err(RepoError::Signature {
                    file: pkg.filename.clone(),
                    detail: "upstream ships no .sig".into(),
                });
            }
            crate::sign::verify_with_keyring(&archive, &sig, keyring).map_err(|e| {
                RepoError::Signature {
                    file: pkg.filename.clone(),
                    detail: e.to_string(),
                }
            })?;
        }
        let manifest = pkg_extract::extract_manifest(&archive)?;
        api.upload_pool(&pkg.sha256, &pkg.filename, arch, &archive)?;
        if has_sig {
            api.upload_pool_signature(&pkg.sha256, &pkg.filename, arch, &sig)?;
        }
        api.index_manifest(&manifest, source, arch)?;
        tracing::info!(package = %pkg.filename, bytes = pkg.size_download, "imported");
        Ok(())
    })();
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_file(&sig);
    result
}

/// Bytes per second over the whole run (0 when nothing was uploaded).
fn throughput(bytes: u64, started: Instant) -> u64 {
    let secs = started.elapsed().as_secs();
    if bytes == 0 || secs == 0 {
        0
    } else {
        bytes / secs
    }
}

#[allow(clippy::cast_precision_loss)] // display only
pub fn human(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}
