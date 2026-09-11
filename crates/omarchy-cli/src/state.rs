//! `<root>/var/lib/omarchy-cli/release.json`: the release this machine was last
//! synchronised to. Lets `status` tell "you are on stable#4, stable#5 is out".

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pinned {
    pub ring: String,
    pub release_id: u64,
    pub seq: u64,
    pub at: String,
}

fn path(root: &Path) -> PathBuf {
    root.join("var/lib/omarchy-cli/release.json")
}

pub fn load(root: &Path) -> Result<Option<Pinned>> {
    match std::fs::read_to_string(path(root)) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).context("parsing release.json")?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save(root: &Path, pinned: &Pinned) -> Result<()> {
    let p = path(root);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&p, serde_json::to_vec_pretty(pinned)?)
        .with_context(|| format!("writing {}", p.display()))
}
