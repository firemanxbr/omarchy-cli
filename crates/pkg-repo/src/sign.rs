//! Detached GPG signatures, produced by the system `gpg` exactly as `repo-add
//! --sign` does. Keys never enter this process.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::RepoError;

/// Writes `<file>.sig` next to `file` and returns its path.
pub fn detach_sign(file: &Path, key: &str) -> Result<PathBuf, RepoError> {
    let sig = PathBuf::from(format!("{}.sig", file.display()));
    let status = Command::new("gpg")
        .args([
            "--batch",
            "--yes",
            "--detach-sign",
            "--no-armor",
            "--local-user",
            key,
            "--output",
        ])
        .arg(&sig)
        .arg(file)
        .output()?;
    if !status.status.success() {
        return Err(RepoError::Gpg(
            String::from_utf8_lossy(&status.stderr).into_owned(),
        ));
    }
    Ok(sig)
}

/// `gpg --verify` for tests and for the client-side check.
pub fn verify(file: &Path, sig: &Path) -> Result<(), RepoError> {
    let out = Command::new("gpg")
        .args(["--batch", "--verify"])
        .arg(sig)
        .arg(file)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(RepoError::Gpg(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }
}
