use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use pkg_manifest::{PackageManifest, RepoIndex};
use pkg_repo::client::Api;
use pkg_repo::{build_database, sign, Flavor};

/// Renders and publishes pacman databases for Omarchy releases.
#[derive(Parser)]
#[command(name = "pkg-repo", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Remote {
    /// Base URL of the edge API, e.g. `https://pkgs.omarchy.org`.
    #[arg(long, env = "OMARCHY_API")]
    api: String,
    /// Publish token (bearer).
    #[arg(long, env = "OMARCHY_PUBLISH_TOKEN", hide_env_values = true)]
    token: String,
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
        #[arg(long)]
        note: Option<String>,
        /// `.pkg.tar.zst` files; a sibling `.sig` is uploaded when present.
        #[arg(required = true)]
        archives: Vec<PathBuf>,
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
    /// Renders, signs and uploads the pacman databases of a ring's current release.
    Render {
        #[command(flatten)]
        remote: Remote,
        #[arg(long)]
        ring: String,
        #[arg(long, default_value = "omarchy")]
        repo: String,
        #[arg(long, default_value = "x86_64")]
        arch: String,
        /// GPG key id; omit to upload unsigned databases.
        #[arg(long)]
        sign: Option<String>,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
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
            note,
            archives,
        } => publish(&remote, &ring, note.as_deref(), &archives),
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
        Command::Render {
            remote,
            ring,
            repo,
            arch,
            sign,
        } => render(&remote, &ring, &repo, &arch, sign.as_deref()),
    }
}

fn rollback(remote: &Remote, ring: &str, to: u64, note: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let started = std::time::Instant::now();
    let created = api.create_release(ring, None, Some(to), &[], &[], note)?;
    println!(
        "{ring} now serves the selection of release {to} as {}#{} (id {}) — {} packages, {:?}, zero bytes copied",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        started.elapsed()
    );
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

fn publish(remote: &Remote, ring: &str, note: Option<&str>, archives: &[PathBuf]) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let mut added = Vec::new();
    for archive in archives {
        let manifest = pkg_extract::extract_manifest(archive)
            .with_context(|| format!("inspecting {}", archive.display()))?;
        let sha = manifest.sha256.clone();
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
            api.upload_pool(&sha, archive)?;
            let sig = PathBuf::from(format!("{}.sig", archive.display()));
            if sig.exists() {
                api.upload_pool_signature(&sha, &sig)?;
            }
            api.index_manifest(&manifest)?;
        }
        added.push(sha);
    }
    let created = api.create_release(ring, None, None, &added, &[], note)?;
    println!(
        "release {}#{} (id {}) — {} packages, {} bytes in pool",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.package_count,
        created.size_download
    );
    Ok(())
}

fn promote(remote: &Remote, from: &str, to: &str, note: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let started = std::time::Instant::now();
    let created = api.create_release(to, Some(from), None, &[], &[], note)?;
    println!(
        "promoted {from} → {}#{} (id {}, from release {:?}) — {} packages, {} bytes, {:?}, zero bytes copied",
        created.release.ring,
        created.release.seq,
        created.release.id,
        created.release.source_id,
        created.package_count,
        created.size_download,
        started.elapsed()
    );
    Ok(())
}

fn render(remote: &Remote, ring: &str, repo: &str, arch: &str, key: Option<&str>) -> Result<()> {
    let api = Api::new(&remote.api, &remote.token)?;
    let view = api.release(ring)?;
    let packages = sorted(
        view.packages
            .into_iter()
            .filter(|p| p.arch == arch || p.arch == "any")
            .collect(),
    );
    let tmp = tempfile_dir()?;
    for flavor in [Flavor::Db, Flavor::Files] {
        let bytes = build_database(&packages, flavor)?;
        let kind = match flavor {
            Flavor::Db => "db",
            Flavor::Files => "files",
        };
        api.upload_artifact(view.release.id, kind, repo, arch, bytes.clone())?;
        eprintln!(
            "uploaded {kind} ({} packages, {} bytes)",
            packages.len(),
            bytes.len()
        );
        if let Some(key) = key {
            let file = tmp.join(flavor.archive_name(repo));
            std::fs::write(&file, &bytes)?;
            let sig = sign::detach_sign(&file, key)?;
            api.upload_artifact(
                view.release.id,
                &format!("{kind}.sig"),
                repo,
                arch,
                std::fs::read(&sig)?,
            )?;
            eprintln!("uploaded {kind}.sig");
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    println!(
        "rendered {ring}#{} (id {}) for [{repo}] {arch}",
        view.release.seq, view.release.id
    );
    Ok(())
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("pkg-repo-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
