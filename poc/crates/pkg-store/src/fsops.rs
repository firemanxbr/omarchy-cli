//! Low-level filesystem helpers. Every operation here is designed to be either
//! atomic (`rename`) or safely repeatable, because the journal may replay it.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{Result, StoreError};

pub const OLD_SUFFIX: &str = ".omarchy-old";
pub const NEW_SUFFIX: &str = ".omarchy-new";

pub fn io(path: &Path) -> impl FnOnce(std::io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        source,
        path: Some(path.to_path_buf()),
    }
}

pub fn create_dir_all(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(io(path))
}

pub fn remove_dir_all_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(path)(e)),
    }
}

pub fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(path)(e)),
    }
}

/// `rename` that treats a missing source as already done.
pub fn rename_if_exists(from: &Path, to: &Path) -> Result<bool> {
    match fs::rename(from, to) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io(from)(e)),
    }
}

pub fn exists_no_follow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

pub fn is_root() -> bool {
    rustix::process::geteuid().is_root()
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(io(path))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(io(path))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Places the staged entry at `dest` atomically: the content is first
/// materialised as `dest.omarchy-new` (hardlink, or copy when the staging area
/// lives on another filesystem; a fresh symlink for symlinks), then renamed over
/// `dest`. A crash in between leaves at most a stray `.omarchy-new` file, which
/// the journal cleans up.
pub fn place(staged: &Path, dest: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(staged).map_err(io(staged))?;
    let tmp = sibling(dest, NEW_SUFFIX);
    remove_file_if_exists(&tmp)?;

    if meta.file_type().is_symlink() {
        let target = fs::read_link(staged).map_err(io(staged))?;
        std::os::unix::fs::symlink(&target, &tmp).map_err(io(&tmp))?;
    } else {
        match fs::hard_link(staged, &tmp) {
            Ok(()) => {}
            Err(e) if e.raw_os_error() == Some(rustix::io::Errno::XDEV.raw_os_error()) => {
                copy_with_metadata(staged, &tmp, &meta)?;
            }
            Err(e) => return Err(io(staged)(e)),
        }
    }
    fs::rename(&tmp, dest).map_err(io(dest))
}

fn copy_with_metadata(from: &Path, to: &Path, meta: &fs::Metadata) -> Result<()> {
    fs::copy(from, to).map_err(io(from))?;
    fs::set_permissions(to, fs::Permissions::from_mode(meta.mode())).map_err(io(to))?;
    if is_root() {
        std::os::unix::fs::chown(to, Some(meta.uid()), Some(meta.gid())).map_err(io(to))?;
    }
    Ok(())
}

/// Removes empty directories bottom-up, stopping at the first non-empty one.
/// Only directories listed in `dirs` are considered; errors are ignored because
/// a leftover directory is harmless.
pub fn prune_empty_dirs(root: &Path, dirs: &[String]) {
    let mut sorted: Vec<&String> = dirs.iter().collect();
    sorted.sort_by_key(|d| std::cmp::Reverse(d.len()));
    for dir in sorted {
        let abs = join_abs(root, dir);
        let _ = fs::remove_dir(&abs);
    }
}

/// Joins an absolute package path (`/usr/bin/xz`) under `root`.
pub fn join_abs(root: &Path, abs: &str) -> PathBuf {
    root.join(abs.trim_start_matches('/'))
}
