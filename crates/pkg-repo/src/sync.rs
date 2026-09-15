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
    /// Sources whose packages win over this one: an upstream package whose
    /// name the ring already serves from one of them is neither imported nor
    /// pinned (chaotic-aur defers to Arch and the OPR).
    pub defer_to: Vec<String>,
    /// Leave the release to the caller: the report carries what to pin and
    /// what to drop, so one release can cover several sources (a release
    /// copies the ring's whole selection; D1 bills every row written).
    pub defer_release: bool,
}

#[derive(Debug, Default)]
pub struct SyncReport {
    pub upstream_total: usize,
    pub already_indexed: usize,
    pub uploaded: usize,
    pub failed: Vec<Failed>,
    pub removed: usize,
    pub bytes_uploaded: u64,
    /// `None` when the ring's selection of this source did not change.
    pub release: Option<(u64, u64)>,
    /// Architectures the release left as its parent (nothing to render there).
    pub unchanged_arches: Vec<String>,
    pub deferred: usize,
    /// Upstream packages left to the sources in `defer_to`.
    pub yielded: usize,
    /// `(filename, upstream sha256)` of packages whose filename already holds a
    /// different object in the pool; the existing object was pinned instead.
    pub collisions: Vec<(String, String)>,
    /// With `defer_release`: the sha256s to pin and the names to drop for
    /// the ring to serve this source's current upstream (empty when unchanged).
    pub pending_add: Vec<String>,
    pub pending_remove: Vec<String>,
}

/// A repository published as GitHub releases, one per snapshot, is named by
/// a prefix: `github-release://owner/repo/asahi-packages-stable-` is the
/// newest published (not draft, not pre-release) release whose tag starts
/// with `asahi-packages-stable-`, served from its `releases/download/<tag>`.
/// Any other base is returned as it is. `GITHUB_TOKEN`, when set, lifts the
/// API's 60 requests an hour per address.
pub fn resolve_base(api: &Api, base: &str) -> Result<String, RepoError> {
    let Some(spec) = base.strip_prefix("github-release://") else {
        return Ok(base.to_owned());
    };
    let (owner, rest) = spec
        .split_once('/')
        .ok_or_else(|| RepoError::Source(format!("github-release: no repository in {base}")))?;
    let (repo, prefix) = rest
        .split_once('/')
        .ok_or_else(|| RepoError::Source(format!("github-release: no tag prefix in {base}")))?;
    let token = std::env::var("GITHUB_TOKEN").ok();
    let releases = api.get_external_json_as(
        &format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=50"),
        token.as_deref(),
    )?;
    let tag = newest_release_tag(&releases, prefix).ok_or_else(|| {
        RepoError::Source(format!(
            "github-release: no published release of {owner}/{repo} tagged {prefix}*"
        ))
    })?;
    Ok(format!(
        "https://github.com/{owner}/{repo}/releases/download/{tag}"
    ))
}

/// The newest published release (by `published_at`; drafts and pre-releases
/// are candidates, not releases) whose tag starts with the prefix.
fn newest_release_tag(releases: &serde_json::Value, prefix: &str) -> Option<String> {
    releases
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            !r["draft"].as_bool().unwrap_or(false) && !r["prerelease"].as_bool().unwrap_or(false)
        })
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            tag.starts_with(prefix).then(|| {
                (
                    r["published_at"].as_str().unwrap_or("").to_owned(),
                    tag.to_owned(),
                )
            })
        })
        .max()
        .map(|(_, t)| t)
}

#[allow(clippy::too_many_lines)]
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
    let base = resolve_base(api, base.trim_end_matches('/'))?;
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

    let head = api.release_summary(&opts.ring)?;
    let upstream = yield_to_other_sources(upstream, head.as_ref(), opts, &mut report);

    // 2. what the index already has, by content and by filename
    let Classified {
        known,
        reuse,
        mut missing,
    } = classify_upstream(api, &upstream, opts, &mut report)?;
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
    // A colliding filename pins the stored object (`reuse`), never the
    // upstream sha the pool does not hold — even when the index knows it.
    let colliding: HashSet<&str> = report.collisions.iter().map(|(f, _)| f.as_str()).collect();
    let mut add: Vec<String> = upstream
        .iter()
        .filter(|p| now_known.contains(&p.sha256) && !colliding.contains(p.filename.as_str()))
        .map(|p| p.sha256.clone())
        .collect();
    add.extend(reuse);
    let upstream_names: BTreeSet<&str> = upstream.iter().map(|p| p.name.as_str()).collect();
    let current: Vec<&crate::client::PackageSummary> = head
        .as_ref()
        .map(|v| {
            v.packages
                .iter()
                .filter(|p| p.source == opts.source && p.repo_arch == opts.arch)
                .collect()
        })
        .unwrap_or_default();
    let remove: Vec<String> = current
        .iter()
        .filter(|p| !upstream_names.contains(p.name.as_str()))
        .map(|p| p.name.clone())
        .collect();
    report.removed = remove.len();

    // Nothing to pin when the ring already serves exactly this selection: a
    // release per hourly run per source would be noise.
    let current_shas: BTreeSet<&str> = current.iter().map(|p| p.sha256.as_str()).collect();
    let add_shas: BTreeSet<&str> = add.iter().map(String::as_str).collect();
    if remove.is_empty() && current_shas == add_shas {
        tracing::info!(source = %opts.source, arch = %opts.arch, "selection unchanged; no release");
        post_sync_event(api, opts, &report, &base, started)?;
        return Ok(report);
    }

    if opts.defer_release {
        report.pending_add = add;
        report.pending_remove = remove;
        post_sync_event(api, opts, &report, &base, started)?;
        return Ok(report);
    }
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
    report.unchanged_arches = created.unchanged_arches;

    // 5. event
    post_sync_event(api, opts, &report, &base, started)?;
    Ok(report)
}

/// What the index already has — by content, and by filename: the pool holds
/// one object per `<arch>/<filename>`, so an upstream rebuild of the same
/// version with different bytes (the OPR does this per channel) cannot be
/// stored; the object already there is pinned instead. Returns the known
/// sha256s, the sha256s to pin for colliding filenames, and what to import.
struct Classified<'a> {
    /// sha256s the index already has.
    known: HashSet<String>,
    /// sha256s of stored objects to pin for colliding filenames.
    reuse: Vec<String>,
    /// What still has to be imported.
    missing: Vec<&'a UpstreamPackage>,
}

fn classify_upstream<'a>(
    api: &Api,
    upstream: &'a [UpstreamPackage],
    opts: &SyncOptions,
    report: &mut SyncReport,
) -> Result<Classified<'a>, RepoError> {
    let shas: Vec<String> = upstream.iter().map(|p| p.sha256.clone()).collect();
    let filenames: Vec<String> = upstream.iter().map(|p| p.filename.clone()).collect();
    let (known, by_filename) = api.known_with_filenames(&shas, &filenames, &opts.arch)?;
    let known: HashSet<String> = known.into_iter().collect();
    report.already_indexed = known.len();
    let mut reuse = Vec::new();
    for p in upstream {
        // The object stored under this filename decides, known sha or not:
        // an index row for bytes the pool does not hold (a rebuild indexed
        // behind an earlier build, before 2026-09-12) must not be pinned.
        if let Some(existing) = by_filename.get(&p.filename) {
            if *existing != p.sha256 {
                tracing::warn!(file = %p.filename, "filename already in the pool with different content; pinning the existing object");
                report
                    .collisions
                    .push((p.filename.clone(), p.sha256.clone()));
                reuse.push(existing.clone());
            }
        }
    }
    let colliding: HashSet<&str> = report.collisions.iter().map(|(f, _)| f.as_str()).collect();
    let missing: Vec<&UpstreamPackage> = upstream
        .iter()
        .filter(|p| !known.contains(&p.sha256) && !colliding.contains(p.filename.as_str()))
        .collect();
    Ok(Classified {
        known,
        reuse,
        missing,
    })
}

/// Drops the upstream packages whose names the ring already serves from a
/// source in `defer_to` (those win), counting them in `report.yielded`.
fn yield_to_other_sources(
    upstream: Vec<UpstreamPackage>,
    head: Option<&crate::client::ReleaseSummaryView>,
    opts: &SyncOptions,
    report: &mut SyncReport,
) -> Vec<UpstreamPackage> {
    if opts.defer_to.is_empty() {
        return upstream;
    }
    let owned_elsewhere: HashSet<&str> = head
        .map(|v| {
            v.packages
                .iter()
                .filter(|p| p.repo_arch == opts.arch && opts.defer_to.contains(&p.source))
                .map(|p| p.name.as_str())
                .collect()
        })
        .unwrap_or_default();
    let before = upstream.len();
    let kept: Vec<UpstreamPackage> = upstream
        .into_iter()
        .filter(|p| !owned_elsewhere.contains(p.name.as_str()))
        .collect();
    report.yielded = before - kept.len();
    kept
}

fn post_sync_event(
    api: &Api,
    opts: &SyncOptions,
    report: &SyncReport,
    base: &str,
    started: Instant,
) -> Result<(), RepoError> {
    let status = if report.failed.is_empty() && report.collisions.is_empty() {
        "ok"
    } else {
        "warn"
    };
    let target = match report.release {
        Some((_, seq)) => format!("{}#{seq}", opts.ring),
        None => format!("{} unchanged", opts.ring),
    };
    let summary = if report.failed.is_empty() {
        format!(
            "{} {}: {} new packages ({}), {} removed{} → {target}",
            opts.source,
            opts.arch,
            report.uploaded,
            human(report.bytes_uploaded),
            report.removed,
            if report.collisions.is_empty() {
                String::new()
            } else {
                format!(
                    ", {} same-filename rebuilds kept as already stored",
                    report.collisions.len()
                )
            },
        )
    } else {
        format!(
            "{} {}: {} new, {} failed, {} removed → {target}",
            opts.source,
            opts.arch,
            report.uploaded,
            report.failed.len(),
            report.removed,
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
            "yielded": report.yielded,
            "collisions": report.collisions.iter().map(|(f, sha)| serde_json::json!({"file": f, "upstream_sha256": sha})).collect::<Vec<_>>(),
            "defer_to": opts.defer_to,
            "concurrency": opts.concurrency,
            "throughput_bps": throughput(report.bytes_uploaded, started),
            "verified_against": opts.keyring.as_ref().map(|k| k.file_name().map(|f| f.to_string_lossy().into_owned())),
            "failed": report.failed.iter().map(|(f, e)| serde_json::json!({"file": f, "error": e})).collect::<Vec<_>>(),
            "release_id": report.release.map(|(id, _)| id),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_published_release_with_the_prefix_is_the_snapshot() {
        // The Asahi fork's release list as GitHub returns it: families mixed, candidates are pre-releases.
        let releases = serde_json::json!([
            { "tag_name": "aurora-packages-4439238d", "published_at": "2026-09-15T07:39:00Z", "prerelease": true, "draft": false },
            { "tag_name": "asahi-quattro-channel-32", "published_at": "2026-09-13T11:28:00Z", "prerelease": false, "draft": false },
            { "tag_name": "asahi-packages-stable-83973903", "published_at": "2026-09-13T11:27:00Z", "prerelease": false, "draft": false },
            { "tag_name": "asahi-packages-candidate-c3e98be6", "published_at": "2026-09-14T10:56:00Z", "prerelease": true, "draft": false },
            { "tag_name": "asahi-packages-stable-99999999", "published_at": "2026-09-16T00:00:00Z", "prerelease": false, "draft": true },
            { "tag_name": "asahi-packages-stable-74b8da66", "published_at": "2026-09-12T04:57:00Z", "prerelease": false, "draft": false }
        ]);
        assert_eq!(
            newest_release_tag(&releases, "asahi-packages-stable-").as_deref(),
            Some("asahi-packages-stable-83973903"),
            "the newest published stable — not the newer candidate (pre-release), not the draft"
        );
        assert_eq!(
            newest_release_tag(&releases, "asahi-quattro-channel-").as_deref(),
            Some("asahi-quattro-channel-32")
        );
        assert_eq!(newest_release_tag(&releases, "nothing-"), None);
    }
    use crate::client::{PackageSummary, Release, ReleaseSummaryView};

    fn up(name: &str) -> UpstreamPackage {
        UpstreamPackage {
            name: name.into(),
            version: "1-1".into(),
            filename: format!("{name}-1-1-x86_64.pkg.tar.zst"),
            sha256: format!("sha-{name}"),
            size_download: 1,
        }
    }

    fn served(name: &str, source: &str, arch: &str) -> PackageSummary {
        PackageSummary {
            name: name.into(),
            version: "1-1".into(),
            arch: arch.into(),
            filename: String::new(),
            sha256: format!("sha-{name}"),
            size_download: 1,
            source: source.into(),
            repo_arch: arch.into(),
        }
    }

    fn opts(defer_to: &[&str]) -> SyncOptions {
        SyncOptions {
            source: "chaotic".into(),
            upstream: String::new(),
            base_url: None,
            db_name: None,
            arch: "x86_64".into(),
            ring: "edge".into(),
            limit: 0,
            concurrency: 1,
            work_dir: PathBuf::new(),
            dry_run: true,
            keyring: None,
            defer_to: defer_to.iter().map(|s| (*s).to_owned()).collect(),
            defer_release: false,
        }
    }

    #[test]
    fn names_served_by_a_deferred_to_source_are_yielded() {
        let head = ReleaseSummaryView {
            release: Release {
                id: 1,
                ring: "edge".into(),
                seq: 1,
                parent_id: None,
                source_id: None,
                note: None,
                created_at: String::new(),
            },
            package_count: 3,
            packages: vec![
                served("dropbox", "packages", "x86_64"),
                served("hyprshade", "extra", "x86_64"),
                served("yay", "chaotic", "x86_64"),
                served("dropbox", "packages", "aarch64"), // other arch: irrelevant
            ],
        };
        let upstream = vec![up("dropbox"), up("hyprshade"), up("yay"), up("paru")];
        let mut report = SyncReport::default();
        let kept = yield_to_other_sources(
            upstream.clone(),
            Some(&head),
            &opts(&["packages", "extra"]),
            &mut report,
        );
        assert_eq!(
            kept.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["yay", "paru"]
        );
        assert_eq!(report.yielded, 2);

        let mut report = SyncReport::default();
        let kept = yield_to_other_sources(upstream, Some(&head), &opts(&[]), &mut report);
        assert_eq!(kept.len(), 4, "nothing yields without --defer-to");
        assert_eq!(report.yielded, 0);
    }
}
