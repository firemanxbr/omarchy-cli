//! The operations behind the CLI commands — and behind `pkg-repo work`, the
//! worker that pulls the same operations as jobs from the pool. Each takes an
//! `Api` (whose bearer token is the publish token on the command line, or a
//! per-job token on a worker) and reports to the journal.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use pkg_manifest::PackageManifest;

use crate::client::{Api, ReleaseRequest};
use crate::sync::SyncOptions;
use crate::{build_database, sign, sync, Flavor};

pub fn record_event(api: &Api, event: &serde_json::Value, payload: Option<&str>) -> Result<()> {
    let mut event = event.clone();
    let payload: Option<serde_json::Value> = payload
        .map(serde_json::from_str)
        .transpose()
        .context("--payload must be JSON")?;
    event["payload"] = payload.unwrap_or(serde_json::Value::Null);
    api.post_event(&event)?;
    Ok(())
}

/// The release a ring serves now, if any.
pub fn head(api: &Api, ring: &str) -> Result<Option<u64>> {
    Ok(api
        .history(ring)?
        .releases
        .iter()
        .find(|r| r.is_head != 0)
        .map(|r| r.id))
}

/// The sync with the pipeline's failure rule applied; the report for callers that render after it.
pub fn run_sync_report(api: &Api, opts: &SyncOptions) -> Result<sync::SyncReport> {
    let report = sync::run(api, opts)?;
    if !report.failed.is_empty() && report.uploaded == 0 && report.already_indexed == 0 {
        anyhow::bail!(
            "{} package(s) failed to import and none of this source is indexed",
            report.failed.len()
        );
    }
    Ok(report)
}

pub fn run_sync(api: &Api, opts: &SyncOptions) -> Result<()> {
    let report = sync::run(api, opts)?;
    println!(
        "upstream {} · already indexed {} · uploaded {} ({}) · failed {} · removed {} · deferred {}",
        report.upstream_total,
        report.already_indexed,
        report.uploaded,
        sync::human(report.bytes_uploaded),
        report.failed.len(),
        report.removed,
        report.deferred
    );
    if report.yielded > 0 {
        println!(
            "yielded {} package(s) to {}",
            report.yielded,
            opts.defer_to.join(", ")
        );
    }
    if let Some((id, seq)) = report.release {
        println!("release id {id} (#{seq})");
    }
    for (file, err) in &report.failed {
        eprintln!("FAILED {file}: {err}");
    }
    // A package upstream serves broken (bad signature, missing file) is left
    // out and reported as a warning in the journal; it must not fail the run
    // — the release without it is still correct, and a promotion that aligns
    // the OPR channel must not be undone because one package was refused.
    // Only a sync where nothing at all is served — every import failed and
    // the index had none of the upstream before — is an error; an unchanged
    // selection with one refused package is the normal hourly case.
    if !report.failed.is_empty() && report.uploaded == 0 && report.already_indexed == 0 {
        anyhow::bail!(
            "{} package(s) failed to import and none of this source is indexed",
            report.failed.len()
        );
    }
    if !report.failed.is_empty() {
        eprintln!(
            "warning: {} package(s) left out (see the journal); the release is without them",
            report.failed.len()
        );
    }
    Ok(())
}

pub fn publish(
    api: &Api,
    ring: &str,
    source: &str,
    arch: &str,
    note: Option<&str>,
    archives: &[PathBuf],
) -> Result<()> {
    let started = Instant::now();
    // The pool's own key signs what it stores when it has one; a local .sig
    // is the transition path for publishers running against an older pool.
    let pool_signs = api.signing()?;
    let mut added = Vec::new();
    let mut bytes = 0u64;
    for archive in archives {
        let manifest = pkg_extract::extract_manifest(archive)
            .with_context(|| format!("inspecting {}", archive.display()))?;
        let sha = manifest.sha256.clone();
        // The pool keeps the first object stored under a filename (the same
        // rule the sync applies to upstream rebuilds): a rebuild of the same
        // version pins what is already there instead of failing on the
        // size/sha mismatch.
        let (_, by_filename) =
            api.known_with_filenames(&[], std::slice::from_ref(&manifest.filename), arch)?;
        let sha = match by_filename.get(&manifest.filename) {
            Some(stored) if *stored != sha => {
                eprintln!(
                    "{} {} already in pool under {} with different content; pinning the stored object",
                    manifest.name, manifest.version, manifest.filename
                );
                stored.clone()
            }
            _ => sha,
        };
        if api.is_indexed(&sha)? {
            eprintln!(
                "{} {} already in pool, skipping upload",
                manifest.name, manifest.version
            );
        } else {
            eprintln!(
                "uploading {} {} ({} bytes)",
                manifest.name, manifest.version, manifest.size_download
            );
            api.upload_pool(&sha, &manifest.filename, arch, archive)?;
            let sig = PathBuf::from(format!("{}.sig", archive.display()));
            if pool_signs {
                api.sign_pool(&sha, &manifest.filename, arch)?;
            } else if sig.exists() {
                api.upload_pool_signature(&sha, &manifest.filename, arch, &sig)?;
            }
            api.index_manifest(&manifest, source, arch)?;
            bytes += manifest.size_download;
        }
        added.push(sha);
    }
    let created = api.create_release(&ReleaseRequest {
        ring,
        add: &added,
        remove_arch: Some(arch),
        note,
        ..ReleaseRequest::default()
    })?;
    println!(
        "release {}#{} (id {}) — {} packages, {} bytes in pool",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        created.size_download
    );
    api.post_event(&serde_json::json!({
        "kind": "publish", "ring": ring, "source": source, "status": "ok",
        "summary": format!("{} archive(s) published ({}) → {}#{}", archives.len(), sync::human(bytes), ring, created.release.seq),
        "duration_ms": millis(started.elapsed()),
        "payload": { "release_id": created.release.id, "sha256": added },
    }))?;
    Ok(())
}

pub fn promote(api: &Api, from: &str, to: &str, note: Option<&str>) -> Result<u64> {
    let started = Instant::now();
    let created = api.create_release(&ReleaseRequest {
        ring: to,
        from_ring: Some(from),
        note,
        ..ReleaseRequest::default()
    })?;
    let took = started.elapsed();
    println!(
        "promoted {from} → {}#{} (id {}, from release {:?}) — {} packages, {} bytes, {:?}, zero bytes copied",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.release.source_id,
        created.package_count,
        created.size_download,
        took
    );
    api.post_event(&serde_json::json!({
        "kind": "promote", "ring": to, "status": "ok",
        "summary": format!("{from} → {to}#{}: {} packages ({}), zero bytes copied", created.release.seq, created.package_count, sync::human(created.size_download)),
        "duration_ms": millis(took),
        "payload": { "release_id": created.release.id, "from_release_id": created.release.source_id, "note": note },
    }))?;
    Ok(created.release.id)
}

pub fn rollback(api: &Api, ring: &str, to: u64, note: Option<&str>) -> Result<u64> {
    let started = Instant::now();
    let created = api.create_release(&ReleaseRequest {
        ring,
        from_release_id: Some(to),
        note,
        ..ReleaseRequest::default()
    })?;
    let took = started.elapsed();
    println!(
        "{ring} now serves the selection of release {to} as {}#{} (id {}) — {} packages, {:?}, zero bytes copied",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        took
    );
    api.post_event(&serde_json::json!({
        "kind": "rollback", "ring": ring, "status": "warn",
        "summary": format!("{ring} rolled back to release {to} as #{} ({} packages)", created.release.seq, created.package_count),
        "duration_ms": millis(took),
        "payload": { "release_id": created.release.id, "to_release_id": to, "note": note },
    }))?;
    Ok(created.release.id)
}

pub fn releases(api: &Api, ring: &str) -> Result<()> {
    let history = api.history(ring)?;
    println!(
        "{:<6} {:<5} {:<9} {:<8} {:<7} {:<26} note",
        "id", "seq", "packages", "source", "head", "created"
    );
    for r in &history.releases {
        println!(
            "{:<6} {:<5} {:<9} {:<8} {:<7} {:<26} {}",
            r.id,
            r.seq,
            r.package_count,
            r.source_id.map_or("-".to_owned(), |s| s.to_string()),
            if r.is_head == 1 { "*" } else { "" },
            r.created_at,
            r.note.as_deref().unwrap_or("")
        );
    }
    Ok(())
}

/// Renders the ring's databases for one architecture; returns the repositories written.
///
/// The pool signs the databases as it stores them when it holds the key;
/// `key` (a local `GnuPG` key id) only signs against a pool without one.
pub fn render(api: &Api, ring: &str, arch: &str, key: Option<&str>) -> Result<Vec<String>> {
    let started = Instant::now();
    let pool_signs = api.signing()?;
    let key = if pool_signs { None } else { key };
    let view = api.release(ring, arch)?;

    let mut by_source: BTreeMap<String, Vec<PackageManifest>> = BTreeMap::new();
    for p in view.packages {
        by_source.entry(p.source).or_default().push(p.manifest);
    }

    let tmp = tempfile_dir()?;
    let mut rendered = Vec::new();
    for (source, packages) in by_source {
        let packages = sorted(packages);
        let repo = format!("omarchy-{source}-{ring}");
        for flavor in [Flavor::Db, Flavor::Files] {
            let bytes = build_database(&packages, flavor)?;
            let kind = match flavor {
                Flavor::Db => "db",
                Flavor::Files => "files",
            };
            api.upload_artifact(view.release.id, kind, &repo, arch, &bytes)?;
            if let Some(key) = key {
                let file = tmp.join(format!("{repo}.{kind}"));
                std::fs::write(&file, &bytes)?;
                let sig = sign::detach_sign(&file, key)?;
                api.upload_artifact(
                    view.release.id,
                    &format!("{kind}.sig"),
                    &repo,
                    arch,
                    &std::fs::read(&sig)?,
                )?;
            }
            eprintln!(
                "uploaded {repo}.{kind} ({} packages, {} bytes)",
                packages.len(),
                bytes.len()
            );
        }
        rendered.push((repo, packages.len()));
    }
    let _ = std::fs::remove_dir_all(&tmp);

    let took = started.elapsed();
    println!(
        "rendered {ring}#{} (id {}) for {arch}: {}",
        view.release.seq,
        view.release.id,
        rendered
            .iter()
            .map(|(r, n)| format!("{r} ({n})"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    api.post_event(&serde_json::json!({
        "kind": "render", "ring": ring, "status": "ok",
        "summary": format!("{ring}#{}: {} database(s) rendered{}", view.release.seq, rendered.len(), if pool_signs || key.is_some() { ", signed" } else { "" }),
        "duration_ms": millis(took),
        "payload": { "release_id": view.release.id, "repos": rendered.iter().map(|(r, n)| serde_json::json!({"repo": r, "packages": n})).collect::<Vec<_>>() },
    }))?;
    Ok(rendered.into_iter().map(|(r, _)| r).collect())
}

pub fn gc(api: &Api, keep: u32, delete: bool) -> Result<()> {
    let started = Instant::now();
    let report = api.unreferenced(keep)?;
    let count = report["count"].as_u64().unwrap_or(0);
    let bytes = report["bytes"].as_u64().unwrap_or(0);
    println!(
        "{count} unreferenced package(s), {} (keeping the last {keep} releases per ring)",
        sync::human(bytes)
    );
    if !delete {
        return Ok(());
    }
    let mut deleted = 0u64;
    let mut freed = 0u64;
    loop {
        let r = api.gc(keep, 200)?;
        deleted += r["deleted"].as_u64().unwrap_or(0);
        freed += r["bytes"].as_u64().unwrap_or(0);
        if r["remaining"].as_u64().unwrap_or(0) == 0 || r["deleted"].as_u64().unwrap_or(0) == 0 {
            break;
        }
    }
    println!("deleted {deleted} package(s), freed {}", sync::human(freed));
    api.post_event(&serde_json::json!({
        "kind": "gc", "status": "ok",
        "summary": format!("retention: deleted {deleted} unreferenced package(s), freed {}", sync::human(freed)),
        "duration_ms": millis(started.elapsed()),
        "payload": { "keep": keep, "deleted": deleted, "bytes": freed },
    }))?;
    Ok(())
}

pub fn sorted(mut packages: Vec<PackageManifest>) -> Vec<PackageManifest> {
    packages.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.version.cmp(&b.version)));
    packages
}

pub fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

pub fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pkg-repo-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
