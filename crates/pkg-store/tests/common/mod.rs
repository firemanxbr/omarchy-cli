//! Builds small synthetic `.pkg.tar.zst` archives so tests can exercise
//! upgrades, collisions and failures without shipping large fixtures.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs::File;
use std::path::{Path, PathBuf};

use pkg_manifest::PackageManifest;
use pkg_store::Store;
use tar::{Builder, EntryType, Header};

pub enum Entry {
    File {
        path: &'static str,
        content: &'static str,
        mode: u32,
    },
    Symlink {
        path: &'static str,
        target: &'static str,
    },
}

pub fn file(path: &'static str, content: &'static str) -> Entry {
    Entry::File {
        path,
        content,
        mode: 0o644,
    }
}

pub fn exe(path: &'static str, content: &'static str) -> Entry {
    Entry::File {
        path,
        content,
        mode: 0o755,
    }
}

pub fn symlink(path: &'static str, target: &'static str) -> Entry {
    Entry::Symlink { path, target }
}

/// Writes `<dir>/<name>-<version>-x86_64.pkg.tar.zst` and returns its path.
pub fn make_pkg(
    dir: &Path,
    name: &str,
    version: &str,
    backup: &[&str],
    entries: &[Entry],
) -> PathBuf {
    let path = dir.join(format!("{name}-{version}-x86_64.pkg.tar.zst"));
    let encoder = zstd::Encoder::new(File::create(&path).unwrap(), 3).unwrap();
    let mut tar = Builder::new(encoder);

    let mut pkginfo = format!(
        "pkgname = {name}\npkgver = {version}\narch = x86_64\nsize = 1000\ndepend = glibc\n"
    );
    for b in backup {
        writeln!(pkginfo, "backup = {}", b.trim_start_matches('/')).unwrap();
    }
    append_file(&mut tar, ".PKGINFO", pkginfo.as_bytes(), 0o644);

    let mut dirs = BTreeSet::new();
    for e in entries {
        let p = match e {
            Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
        };
        let mut cur = Path::new(p.trim_start_matches('/'));
        while let Some(parent) = cur.parent() {
            if parent.as_os_str().is_empty() {
                break;
            }
            dirs.insert(format!("{}/", parent.display()));
            cur = parent;
        }
    }
    for d in dirs {
        let mut h = Header::new_gnu();
        h.set_entry_type(EntryType::Directory);
        h.set_path(&d).unwrap();
        h.set_mode(0o755);
        h.set_size(0);
        h.set_cksum();
        tar.append(&h, std::io::empty()).unwrap();
    }
    for e in entries {
        match e {
            Entry::File {
                path,
                content,
                mode,
            } => append_file(
                &mut tar,
                path.trim_start_matches('/'),
                content.as_bytes(),
                *mode,
            ),
            Entry::Symlink { path, target } => {
                let mut h = Header::new_gnu();
                h.set_entry_type(EntryType::Symlink);
                h.set_path(path.trim_start_matches('/')).unwrap();
                h.set_link_name(target).unwrap();
                h.set_mode(0o777);
                h.set_size(0);
                h.set_cksum();
                tar.append(&h, std::io::empty()).unwrap();
            }
        }
    }
    let encoder = tar.into_inner().unwrap();
    encoder.finish().unwrap();
    path
}

fn append_file<W: std::io::Write>(tar: &mut Builder<W>, path: &str, content: &[u8], mode: u32) {
    let mut h = Header::new_gnu();
    h.set_entry_type(EntryType::Regular);
    h.set_path(path).unwrap();
    h.set_mode(mode);
    h.set_size(content.len() as u64);
    h.set_cksum();
    tar.append(&h, content).unwrap();
}

pub fn manifest(archive: &Path) -> PackageManifest {
    pkg_extract::extract_manifest(archive).unwrap()
}

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pkg-extract/tests/fixtures")
        .join(name)
}

/// A store rooted in a fresh temp dir. Returns `(tempdir, store)`; keep the
/// tempdir alive for the duration of the test.
pub fn open_store() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("state.redb"), tmp.path()).unwrap();
    (tmp, store)
}

pub fn reopen(tmp: &tempfile::TempDir) -> Store {
    Store::open(&tmp.path().join("state.redb"), tmp.path()).unwrap()
}

pub fn read(root: &Path, abs: &str) -> String {
    std::fs::read_to_string(root.join(abs.trim_start_matches('/'))).unwrap()
}

pub fn exists(root: &Path, abs: &str) -> bool {
    root.join(abs.trim_start_matches('/'))
        .symlink_metadata()
        .is_ok()
}

/// No staging directory, no `.omarchy-old`/`.omarchy-new` leftovers anywhere.
pub fn assert_clean(root: &Path) {
    let staging = root.join("var/lib/omarchy-cli/staging");
    if staging.exists() {
        assert!(
            std::fs::read_dir(&staging).unwrap().next().is_none(),
            "staging not empty"
        );
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.ends_with(".omarchy-old") && !name.ends_with(".omarchy-new"),
                "leftover temp file {}",
                entry.path().display()
            );
            if entry.file_type().unwrap().is_dir() {
                stack.push(entry.path());
            }
        }
    }
}
