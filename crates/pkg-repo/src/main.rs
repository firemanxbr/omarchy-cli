use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use pkg_manifest::{PackageManifest, RepoIndex};
use pkg_repo::client::{Api, ReleaseRequest};
use pkg_repo::gate::{self, GateOptions};
use pkg_repo::security::{self, FastTrackOptions, SecurityOptions};
use pkg_repo::sync::{self, SyncOptions};
use pkg_repo::{build_database, sign, Flavor};

/// Publishes packages into the pool, pins releases and renders pacman databases.
#[derive(Parser)]
#[command(name = "pkg-repo", version = pkg_manifest::BUILD_VERSION, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Remote {
    /// Base URL of the edge API, e.g. `https://pkgs.firemanxbr.org`.
    #[arg(long, env = "OMARCHY_API")]
    api: String,
    /// Publish token (bearer).
    #[arg(long, env = "OMARCHY_PUBLISH_TOKEN", hide_env_values = true)]
    token: String,
}

#[derive(Args)]
struct GateArgs {
    #[arg(long)]
    from: String,
    #[arg(long)]
    to: String,
    /// Architectures that need evidence (repeatable).
    #[arg(long = "arch", default_values_t = ["x86_64".to_owned(), "aarch64".to_owned()])]
    arches: Vec<String>,
    /// Days without a failed health check of `--from` required first.
    #[arg(long, default_value_t = 0)]
    soak_days: u32,
    /// The latest health check of `--from` must be younger than this.
    #[arg(long, default_value_t = 24)]
    max_age_hours: u32,
    /// Decide and print without recording a `gate` event.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Args)]
struct SecurityArgs {
    /// Arch Security Tracker dump (`https://security.archlinux.org/issues/all.json`).
    #[arg(long)]
    arch_tracker: PathBuf,
    /// Debian Security Tracker dump (`https://security-tracker.debian.org/tracker/data/json`).
    #[arg(long)]
    debian: Option<PathBuf>,
    /// CISA Known Exploited Vulnerabilities JSON.
    #[arg(long)]
    kev: Option<PathBuf>,
    /// FIRST EPSS scores CSV (decompressed).
    #[arg(long)]
    epss: Option<PathBuf>,
    /// Rings whose served objects are matched (repeatable).
    #[arg(long = "ring", default_values_t = ["edge".to_owned(), "rc".to_owned(), "stable".to_owned()])]
    rings: Vec<String>,
    /// Match and report without writing to the index.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Renders `<repo>.db` and `<repo>.files` from a local `index.json`.
    Build {
        #[arg(long)]
        index: PathBuf,
        #[arg(long, default_value = "omarchy")]
        repo: String,
        #[arg(long)]
        out: PathBuf,
        /// GPG key id to sign with; omit to skip signing.
        #[arg(long)]
        sign: Option<String>,
    },
    /// Uploads archives to the pool, indexes them and creates a new release on `ring`.
    Publish {
        #[command(flatten)]
        remote: Remote,
        #[arg(long, default_value = "edge")]
        ring: String,
        /// Provenance recorded in the index: core, extra, multilib or packages (OPR).
        #[arg(long, default_value = "packages")]
        source: String,
        /// Repository architecture the archives belong to (pool directory).
        #[arg(long, default_value = "x86_64")]
        arch: String,
        #[arg(long)]
        note: Option<String>,
        /// `.pkg.tar.zst` files; a sibling `.sig` is uploaded when present.
        #[arg(required = true)]
        archives: Vec<PathBuf>,
    },
    /// Imports an upstream repository (core/extra/multilib) into the pool and pins it on `ring`.
    Sync {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        source: String,
        /// Mirror base URL; `<source>/os/<arch>/` is appended.
        #[arg(
            long,
            env = "OMARCHY_UPSTREAM",
            default_value = "https://mirror.omarchy.org"
        )]
        upstream: String,
        /// Full URL of the directory holding the db and packages; overrides `--upstream`
        /// (e.g. `http://os.archlinuxarm.org/aarch64/core`, `https://pkgs.omarchy.org/edge/x86_64`).
        #[arg(long)]
        base_url: Option<String>,
        /// Database name without `.db` when it differs from the source (`omarchy` for OPR).
        #[arg(long)]
        db_name: Option<String>,
        /// Architecture of the upstream repository (also the pool directory).
        #[arg(long, default_value = "x86_64")]
        arch: String,
        #[arg(long, default_value = "edge")]
        ring: String,
        /// Import at most this many new packages per run (0 = all).
        #[arg(long, default_value_t = 0)]
        limit: usize,
        #[arg(long, default_value_t = 4)]
        concurrency: usize,
        /// Scratch directory for downloads.
        #[arg(long, default_value = "/tmp/pkg-repo-sync")]
        work_dir: PathBuf,
        /// List what would be imported and stop.
        #[arg(long)]
        dry_run: bool,
        /// GPG keyring file (`archlinux.gpg`, `archlinuxarm.gpg`, `omarchy.gpg`); every
        /// package's upstream `.sig` must verify against it or it is not imported.
        #[arg(long)]
        keyring: Option<PathBuf>,
        /// Sources that win over this one: names the ring already serves from
        /// them are skipped (repeatable).
        #[arg(long = "defer-to")]
        defer_to: Vec<String>,
    },
    /// Creates a release on `--to` pinned to the current selection of `--from`.
    Promote {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        note: Option<String>,
    },
    /// Points a ring at the selection of an earlier release (a new release is created;
    /// history stays append-only). Re-run `render` afterwards.
    Rollback {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
        /// Release id to return to (see `releases`).
        #[arg(long)]
        to: u64,
        #[arg(long)]
        note: Option<String>,
    },
    /// Lists the releases of a ring, newest first.
    Releases {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
    },
    /// Prints the id of a ring's current release (nothing, exit 1, if the ring is empty).
    Head {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
    },
    /// Decides from the recorded health evidence whether `--from` may be promoted
    /// into `--to`. Exit 0: promote; 3: nothing to promote; 1: blocked.
    Gate {
        #[command(flatten)]
        remote: Remote,
        #[command(flatten)]
        args: GateArgs,
    },
    /// Renders, signs and uploads the pacman databases of a ring's current release,
    /// one `omarchy-<source>-<ring>` repo per source.
    Render {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
        #[arg(long, default_value = "x86_64")]
        arch: String,
        /// GPG key id; omit to upload unsigned databases.
        #[arg(long)]
        sign: Option<String>,
    },
    /// Deletes pool objects no recent release references (retention).
    Gc {
        #[command(flatten)]
        remote: Remote,
        /// Protect packages referenced by the last N releases of every ring.
        #[arg(long, default_value_t = 3)]
        keep: u32,
        /// Actually delete; without it, only report.
        #[arg(long)]
        delete: bool,
    },
    /// Matches public vulnerability advisories against what the rings serve
    /// and records them in the index.
    Security {
        #[command(flatten)]
        remote: Remote,
        #[command(flatten)]
        args: SecurityArgs,
    },
    /// Pulls clean versions of packages with open advisories from `--from` into
    /// `--ring` as one release, skipping the soak (render and verify afterwards).
    FastTrack {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
        #[arg(long, default_value = "edge")]
        from: String,
        /// Lowest severity fast-tracked (exploited-in-the-wild always is).
        #[arg(long, default_value = "medium")]
        min_severity: String,
        /// Print the candidates without creating a release.
        #[arg(long)]
        dry_run: bool,
    },
    /// Records an event for the dashboard (health checks, gates, notes).
    Event {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        kind: String,
        #[arg(long)]
        ring: Option<String>,
        #[arg(long)]
        source: Option<String>,
        #[arg(long, default_value = "ok")]
        status: String,
        #[arg(long)]
        summary: String,
        #[arg(long)]
        duration_ms: Option<u64>,
        /// Extra details as a JSON object.
        #[arg(long)]
        payload: Option<String>,
    },
}

#[allow(clippy::too_many_lines)] // one arm per subcommand, each a one-liner
fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    match Cli::parse().command {
        Command::Build {
            index,
            repo,
            out,
            sign,
        } => build(&index, &repo, &out, sign.as_deref()),
        Command::Publish {
            remote,
            ring,
            source,
            arch,
            note,
            archives,
        } => publish(&remote, &ring, &source, &arch, note.as_deref(), &archives),
        Command::Sync {
            remote,
            source,
            upstream,
            base_url,
            db_name,
            arch,
            ring,
            limit,
            concurrency,
            work_dir,
            dry_run,
            keyring,
            defer_to,
        } => run_sync(
            &remote,
            &SyncOptions {
                source,
                upstream,
                base_url,
                db_name,
                arch,
                ring,
                limit,
                concurrency,
                work_dir,
                dry_run,
                keyring,
                defer_to,
            },
        ),
        Command::Promote {
            remote,
            from,
            to,
            note,
        } => promote(&remote, &from, &to, note.as_deref()),
        Command::Rollback {
            remote,
            ring,
            to,
            note,
        } => rollback(&remote, &ring, to, note.as_deref()),
        Command::Releases { remote, ring } => releases(&remote, &ring),
        Command::Head { remote, ring } => head(&remote, &ring),
        Command::Gate { remote, args } => run_gate(&remote, &args),
        Command::Security { remote, args } => run_security(&remote, args),
        Command::FastTrack {
            remote,
            ring,
            from,
            min_severity,
            dry_run,
        } => {
            let api = Api::new(&remote.api, &remote.token)?;
            let report = security::fast_track(
                &api,
                &FastTrackOptions {
                    ring: &ring,
                    from: &from,
                    min_severity: &min_severity,
                    dry_run,
                },
            )?;
            // Exit 3 when there was nothing to do, so a workflow can skip the render.
            if report.fixes.is_empty() {
                std::process::exit(3);
            }
            Ok(())
        }
        Command::Render {
            remote,
            ring,
            arch,
            sign,
        } => render(&remote, &ring, &arch, sign.as_deref()),
        Command::Gc {
            remote,
            keep,
            delete,
        } => gc(&remote, keep, delete),
        Command::Event {
            remote,
            kind,
            ring,
            source,
            status,
            summary,
            duration_ms,
            payload,
        } => record_event(
            &remote,
            &serde_json::json!({
                "kind": kind, "ring": ring, "source": source, "status": status,
                "summary": summary, "duration_ms": duration_ms,
            }),
            payload.as_deref(),
        ),
    }
}

/// `pkg-repo event`: records a journal entry; `payload` is a JSON object.
fn record_event(remote: &Remote, event: &serde_json::Value, payload: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let mut event = event.clone();
    let payload: Option<serde_json::Value> = payload
        .map(serde_json::from_str)
        .transpose()
        .context("--payload must be JSON")?;
    event["payload"] = payload.unwrap_or(serde_json::Value::Null);
    api.post_event(&event)?;
    Ok(())
}

fn run_security(remote: &Remote, args: SecurityArgs) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    security::run(
        &api,
        &SecurityOptions {
            arch_tracker: args.arch_tracker,
            debian: args.debian,
            kev: args.kev,
            epss: args.epss,
            rings: args.rings,
            dry_run: args.dry_run,
        },
    )?;
    Ok(())
}

fn run_gate(remote: &Remote, args: &GateArgs) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let report = gate::run(
        &api,
        &GateOptions {
            from: &args.from,
            to: &args.to,
            arches: &args.arches,
            soak_days: args.soak_days,
            max_age_hours: args.max_age_hours,
            dry_run: args.dry_run,
        },
    )?;
    std::process::exit(report.verdict.exit_code());
}

fn head(remote: &Remote, ring: &str) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    match api.history(ring)?.releases.iter().find(|r| r.is_head != 0) {
        Some(head) => {
            println!("{}", head.id);
            Ok(())
        }
        None => std::process::exit(1),
    }
}

fn run_sync(remote: &Remote, opts: &SyncOptions) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let report = sync::run(&api, opts)?;
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

fn sorted(mut packages: Vec<PackageManifest>) -> Vec<PackageManifest> {
    packages.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.version.cmp(&b.version)));
    packages
}

fn build(index: &Path, repo: &str, out: &Path, key: Option<&str>) -> Result<()> {
    let text =
        std::fs::read_to_string(index).with_context(|| format!("reading {}", index.display()))?;
    let index: RepoIndex = serde_json::from_str(&text).context("parsing index")?;
    let packages = sorted(index.packages);
    std::fs::create_dir_all(out)?;

    for flavor in [Flavor::Db, Flavor::Files] {
        let bytes = build_database(&packages, flavor)?;
        let archive = out.join(flavor.archive_name(repo));
        let short = out.join(flavor.short_name(repo));
        std::fs::write(&archive, &bytes)?;
        std::fs::write(&short, &bytes)?;
        eprintln!(
            "wrote {} ({} packages, {} bytes)",
            archive.display(),
            packages.len(),
            bytes.len()
        );
        if let Some(key) = key {
            for file in [&archive, &short] {
                let sig = sign::detach_sign(file, key)?;
                eprintln!("signed {}", sig.display());
            }
        }
    }
    Ok(())
}

fn publish(
    remote: &Remote,
    ring: &str,
    source: &str,
    arch: &str,
    note: Option<&str>,
    archives: &[PathBuf],
) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let started = Instant::now();
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
            if sig.exists() {
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

fn promote(remote: &Remote, from: &str, to: &str, note: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
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
    Ok(())
}

fn rollback(remote: &Remote, ring: &str, to: u64, note: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
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
    Ok(())
}

fn releases(remote: &Remote, ring: &str) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
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

fn render(remote: &Remote, ring: &str, arch: &str, key: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let started = Instant::now();
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
        "summary": format!("{ring}#{}: {} database(s) rendered{}", view.release.seq, rendered.len(), if key.is_some() { ", signed" } else { "" }),
        "duration_ms": millis(took),
        "payload": { "release_id": view.release.id, "repos": rendered.iter().map(|(r, n)| serde_json::json!({"repo": r, "packages": n})).collect::<Vec<_>>() },
    }))?;
    Ok(())
}

fn gc(remote: &Remote, keep: u32, delete: bool) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
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

fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pkg-repo-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
