use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// `/etc/omarchy-cli/config.toml`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Base URL of the index API.
    pub api: String,
    /// Static origin for packages and databases (the R2 bucket's custom domain).
    pub pool: String,
    /// Ring this machine follows.
    pub ring: String,
    /// Repository name as configured in pacman.conf (`[omarchy]`).
    pub repo: String,
    /// Architecture this machine installs (`x86_64` | `aarch64`); defaults to the
    /// architecture the binary runs on.
    pub arch: String,
    /// Filesystem root. Only change for testing against an exported rootfs.
    pub root: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            // The POC staging repository; production will move this to omarchy.org.
            api: "https://pkgs.firemanxbr.org".into(),
            pool: "https://pool.firemanxbr.org".into(),
            ring: "stable".into(),
            repo: "omarchy".into(),
            arch: std::env::consts::ARCH.into(),
            root: "/".into(),
        }
    }
}

impl Config {
    /// Loads the config file, falling back to defaults when it does not exist.
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Where pacman fetches a package file: beside the ring databases in the pool.
    pub fn package_url(&self, filename: &str) -> String {
        format!(
            "{}/{}/{}",
            self.pool.trim_end_matches('/'),
            self.arch,
            filename
        )
    }
}
