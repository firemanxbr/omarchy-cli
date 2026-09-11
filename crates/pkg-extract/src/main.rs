use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

/// Inspects Arch packages and emits ABI manifests for the Omarchy repository.
#[derive(Parser)]
#[command(name = "pkg-extract", version, about)]
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
    /// Prints the JSON Schema for `PackageManifest` (used to sync the worker).
    Schema,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { archive } => {
            let manifest = pkg_extract::extract_manifest(&archive)?;
            println!("{}", serde_json::to_string_pretty(&manifest)?);
        }
        Command::Schema => {
            println!(
                "{}",
                serde_json::to_string_pretty(&pkg_manifest::PackageManifest::json_schema())?
            );
        }
    }
    Ok(())
}
