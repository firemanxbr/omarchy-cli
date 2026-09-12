use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use pkg_manifest::{PackageManifest, RepoIndex, MANIFEST_SCHEMA_VERSION};

/// Inspects Arch packages and emits ABI manifests for the Omarchy repository.
#[derive(Parser)]
#[command(name = "pkg-extract", version = pkg_manifest::BUILD_VERSION, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Extracts the manifest of a single package and prints it as JSON.
    Inspect {
        /// Path to a `.pkg.tar.zst` archive.
        archive: PathBuf,
    },
    /// Builds a local repository index from every `.pkg.tar.zst` in a directory.
    Index {
        /// Directory containing package archives.
        dir: PathBuf,
        /// Where to write the index (default: `<dir>/index.json`).
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Prints the JSON Schema for `PackageManifest` (used to sync the worker).
    Schema,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { archive } => {
            let manifest = pkg_extract::extract_manifest(&archive)
                .with_context(|| format!("inspecting {}", archive.display()))?;
            println!("{}", serde_json::to_string_pretty(&manifest)?);
        }
        Command::Index { dir, output } => {
            let output = output.unwrap_or_else(|| dir.join("index.json"));
            let index = build_index(&dir)?;
            std::fs::write(&output, serde_json::to_vec_pretty(&index)?)
                .with_context(|| format!("writing {}", output.display()))?;
            eprintln!(
                "wrote {} packages to {}",
                index.packages.len(),
                output.display()
            );
        }
        Command::Schema => {
            println!(
                "{}",
                serde_json::to_string_pretty(&PackageManifest::json_schema())?
            );
        }
    }
    Ok(())
}

fn build_index(dir: &PathBuf) -> Result<RepoIndex> {
    let mut archives: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".pkg.tar.zst"))
        .collect();
    archives.sort();

    let mut packages = Vec::with_capacity(archives.len());
    for archive in &archives {
        tracing::info!(archive = %archive.display(), "inspecting");
        packages.push(
            pkg_extract::extract_manifest(archive)
                .with_context(|| format!("inspecting {}", archive.display()))?,
        );
    }
    Ok(RepoIndex {
        schema_version: MANIFEST_SCHEMA_VERSION,
        packages,
    })
}
