use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use pkg_manifest::{PackageManifest, RepoIndex};
use pkg_repo::{build_database, sign, Flavor};

/// Renders and publishes pacman databases for Omarchy releases.
#[derive(Parser)]
#[command(name = "pkg-repo", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Renders `<repo>.db` and `<repo>.files` (plus `.tar.gz` twins) from an index.
    Build {
        /// `index.json` produced by `pkg-extract index`.
        #[arg(long)]
        index: PathBuf,
        /// Repository name pacman will use (`[omarchy]`).
        #[arg(long, default_value = "omarchy")]
        repo: String,
        /// Output directory.
        #[arg(long)]
        out: PathBuf,
        /// GPG key id to sign with; omit to skip signing.
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
    }
}

fn build(index: &Path, repo: &str, out: &Path, key: Option<&str>) -> Result<()> {
    let text =
        std::fs::read_to_string(index).with_context(|| format!("reading {}", index.display()))?;
    let index: RepoIndex = serde_json::from_str(&text).context("parsing index")?;
    let mut packages: Vec<PackageManifest> = index.packages;
    packages.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.version.cmp(&b.version)));
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
