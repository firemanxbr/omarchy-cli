use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// `/etc/omarchy-cli/config.toml`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Base URL of the edge API.
    pub repository: String,
    /// Release channel served by the repository.
    pub channel: String,
    /// Filesystem root packages are installed into. Only change for testing.
    pub root: PathBuf,
    /// Location of the redb state database.
    pub state_db: PathBuf,
    /// pacman local database, read for the installed-state view.
    pub pacman_db: PathBuf,
    /// Directories scanned for libalpm-compatible hooks, in precedence order.
    pub hook_dirs: Vec<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            repository: "https://pkgs.omarchy.org".into(),
            channel: "stable".into(),
            root: "/".into(),
            state_db: "/var/lib/omarchy-cli/state.redb".into(),
            pacman_db: "/var/lib/pacman/local".into(),
            hook_dirs: vec![
                "/etc/pacman.d/hooks".into(),
                "/usr/share/libalpm/hooks".into(),
            ],
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
}
