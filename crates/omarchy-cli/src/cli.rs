use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

/// Package manager for the Omarchy repository.
#[derive(Parser)]
#[command(name = "omarchy-cli", version, about)]
pub struct Cli {
    /// Path to the configuration file.
    #[arg(long, global = true, default_value = "/etc/omarchy-cli/config.toml")]
    pub config: PathBuf,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Installs packages from the repository or from local `.pkg.tar.zst` files.
    Install {
        #[arg(required = true)]
        targets: Vec<String>,
        /// Resolve and print the plan without changing the system.
        #[arg(long)]
        dry_run: bool,
    },
    /// Removes installed packages.
    Remove {
        #[arg(required = true)]
        targets: Vec<String>,
    },
    /// Upgrades all packages managed by omarchy-cli.
    Upgrade {
        #[arg(long)]
        dry_run: bool,
    },
    /// Searches the repository.
    Search { query: String },
    /// Shows details of a package.
    Info { package: String },
    /// Lists installed packages.
    List,
    /// Shows which package owns a file.
    Owns { path: PathBuf },
    /// Inspects a local package archive and prints its manifest.
    Inspect { archive: PathBuf },
}

#[allow(clippy::unused_async)] // network calls land in phase 3
pub async fn run(cli: Cli) -> Result<()> {
    let _config = crate::config::Config::load(&cli.config)?;
    match cli.command {
        Command::Inspect { archive } => {
            let manifest = pkg_extract::extract_manifest(&archive)?;
            println!("{}", serde_json::to_string_pretty(&manifest)?);
            Ok(())
        }
        _ => bail!("not implemented yet — see docs/ARCHITECTURE.md for the roadmap"),
    }
}
