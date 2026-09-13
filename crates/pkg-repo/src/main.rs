use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use pkg_manifest::RepoIndex;
use pkg_repo::client::Api;
use pkg_repo::gate::{self, GateOptions};
use pkg_repo::security::{self, FastTrackOptions, SecurityOptions};
use pkg_repo::sync::SyncOptions;
use pkg_repo::{build_database, ops, sign, work, Flavor};

fn api(remote: &Remote) -> Result<Api> {
    Ok(Api::new(&remote.api, &remote.token)?)
}

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
    /// Renders and uploads the pacman databases of a ring's current release
    /// (the pool signs them as it stores them),
    /// one `omarchy-<source>-<ring>` repo per source.
    Render {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
        #[arg(long, default_value = "x86_64")]
        arch: String,
        /// Local GPG key id, only for a pool without its own signing key
        /// (the pool signs what it stores; the flag is then ignored).
        #[arg(long)]
        sign: Option<String>,
    },
    /// Works for the pool: pulls jobs (sync, render, promote, health, gc) with
    /// a registered worker token and runs each with the per-job credential
    /// the pool hands out. What the pipeline did on GitHub, on any machine.
    Work {
        #[arg(
            long,
            env = "OMARCHY_API",
            default_value = "https://pkgs.firemanxbr.org"
        )]
        api: String,
        #[arg(
            long,
            env = "OMARCHY_POOL",
            default_value = "https://pool.firemanxbr.org"
        )]
        pool: String,
        /// The worker's token (`omw_…` from `POST /factory/workers`); the registration names the worker.
        #[arg(long, env = "OMARCHY_WORKER_TOKEN", hide_env_values = true)]
        worker_token: String,
        /// Architecture to work for (default: this machine's).
        #[arg(long, default_value = std::env::consts::ARCH)]
        arch: String,
        /// Job kinds to pull (repeatable).
        #[arg(long = "kind", default_values_t = ["build".to_owned(), "sync".to_owned(), "render".to_owned(), "promote".to_owned(), "health".to_owned(), "gc".to_owned()])]
        kinds: Vec<String>,
        /// Free JSON shown on the Factory page, e.g. {"where":"droplet-1"}.
        #[arg(long, default_value = "{}")]
        labels: String,
        /// Do one task and exit.
        #[arg(long)]
        once: bool,
        /// Exit after this many seconds without work (0 = never).
        #[arg(long, default_value_t = 0)]
        idle_exit: u64,
        #[arg(
            long,
            env = "OMARCHY_WORK_DIR",
            default_value = "/var/tmp/omarchy-pool-worker"
        )]
        work_dir: PathBuf,
        /// Local GPG key id, only for a pool without its own signing key
        /// (the pool signs what it stores; the flag is then ignored).
        #[arg(long, env = "OMARCHY_GPG_KEYID")]
        sign: Option<String>,
        /// A checkout of the repository (its tests/ scripts); cloned into the work dir when absent.
        #[arg(long)]
        repo_dir: Option<PathBuf>,
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
        } => ops::publish(
            &api(&remote)?,
            &ring,
            &source,
            &arch,
            note.as_deref(),
            &archives,
        ),
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
        } => ops::run_sync(
            &api(&remote)?,
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
        } => ops::promote(&api(&remote)?, &from, &to, note.as_deref()).map(|_| ()),
        Command::Rollback {
            remote,
            ring,
            to,
            note,
        } => ops::rollback(&api(&remote)?, &ring, to, note.as_deref()).map(|_| ()),
        Command::Releases { remote, ring } => ops::releases(&api(&remote)?, &ring),
        Command::Head { remote, ring } => match ops::head(&api(&remote)?, &ring)? {
            Some(id) => {
                println!("{id}");
                Ok(())
            }
            None => std::process::exit(1),
        },
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
        } => ops::render(&api(&remote)?, &ring, &arch, sign.as_deref()).map(|_| ()),
        Command::Gc {
            remote,
            keep,
            delete,
        } => ops::gc(&api(&remote)?, keep, delete),
        Command::Work {
            api,
            pool,
            worker_token,
            arch,
            kinds,
            labels,
            once,
            idle_exit,
            work_dir,
            sign,
            repo_dir,
        } => work::run(&work::WorkOptions {
            api,
            pool,
            worker_token,
            arch: if arch == "arm64" {
                "aarch64".to_owned()
            } else {
                arch
            },
            kinds,
            labels: serde_json::from_str(&labels).context("--labels must be JSON")?,
            once,
            idle_exit,
            work_dir,
            sign,
            repo_dir,
        }),
        Command::Event {
            remote,
            kind,
            ring,
            source,
            status,
            summary,
            duration_ms,
            payload,
        } => ops::record_event(
            &api(&remote)?,
            &serde_json::json!({
                "kind": kind, "ring": ring, "source": source, "status": status,
                "summary": summary, "duration_ms": duration_ms,
            }),
            payload.as_deref(),
        ),
    }
}

/// `pkg-repo event`: records a journal entry; `payload` is a JSON object.
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

fn build(index: &Path, repo: &str, out: &Path, key: Option<&str>) -> Result<()> {
    let text =
        std::fs::read_to_string(index).with_context(|| format!("reading {}", index.display()))?;
    let index: RepoIndex = serde_json::from_str(&text).context("parsing index")?;
    let packages = ops::sorted(index.packages);
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
