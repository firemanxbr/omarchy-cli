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

/// Verifies `sig` over `file` against one keyring file (`archlinux.gpg`,
/// `archlinuxarm.gpg`, `omarchy.gpg`) and nothing else.
///
/// The keyring is imported once per process into a private `GNUPGHOME` (gpg
/// only partially reads the legacy keyring format through `--keyring`, but
/// imports it fully). A good signature by any key in it passes; trust
/// warnings are irrelevant because the keyring *is* the trust decision.
pub fn verify_with_keyring(file: &Path, sig: &Path, keyring: &Path) -> Result<(), RepoError> {
    let home = keyring_home(keyring)?;
    let out = Command::new("gpg")
        .env("GNUPGHOME", &home)
        .args(["--batch", "--trust-model", "always", "--verify"])
        .arg(sig)
        .arg(file)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(RepoError::Gpg(
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .filter(|l| l.contains("BAD") || l.contains("No public key") || l.contains("error"))
                .collect::<Vec<_>>()
                .join("; "),
        ))
    }
}

/// A `GNUPGHOME` holding exactly the keys of `keyring`, created on first use.
fn keyring_home(keyring: &Path) -> Result<PathBuf, RepoError> {
    use std::sync::{Mutex, OnceLock};
    static HOMES: OnceLock<Mutex<std::collections::HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    let homes = HOMES.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut guard = homes
        .lock()
        .map_err(|_| RepoError::Gpg("keyring lock poisoned".into()))?;
    if let Some(home) = guard.get(keyring) {
        return Ok(home.clone());
    }
    let home = std::env::temp_dir().join(format!(
        "pkg-repo-keyring-{}-{}",
        std::process::id(),
        keyring
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&home)?;
    #[cfg(unix)]
    std::fs::set_permissions(&home, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    let out = Command::new("gpg")
        .env("GNUPGHOME", &home)
        .args(["--batch", "--import"])
        .arg(keyring)
        .output()?;
    // gpg exits non-zero for mere warnings (legacy keyring format); what
    // matters is that keys ended up in the home.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let imported = stderr.contains("imported:") || stderr.contains("unchanged:");
    if !out.status.success() && !imported {
        return Err(RepoError::Gpg(format!(
            "importing {}: {}",
            keyring.display(),
            stderr.trim()
        )));
    }
    guard.insert(keyring.to_path_buf(), home.clone());
    Ok(home)
}
