//! End-to-end extraction against real packages from the Arch `core` repository.

use std::path::PathBuf;

use pkg_extract::extract_manifest;
use pkg_manifest::{DependencyRule, PackageManifest};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn has(rules: &[DependencyRule], s: &str) -> bool {
    rules.iter().any(|r| r.to_string() == s)
}

fn has_prefix(rules: &[DependencyRule], prefix: &str) -> bool {
    rules.iter().any(|r| r.to_string().starts_with(prefix))
}

fn zlib() -> PackageManifest {
    extract_manifest(&fixture("zlib-1:1.3.2-3-x86_64.pkg.tar.zst")).unwrap()
}

fn xz() -> PackageManifest {
    extract_manifest(&fixture("xz-5.8.4-1-x86_64.pkg.tar.zst")).unwrap()
}

#[test]
fn zlib_identity_comes_from_pkginfo() {
    let m = zlib();
    assert_eq!(m.name, "zlib");
    assert_eq!(m.version, "1:1.3.2-3");
    assert_eq!(m.arch, "x86_64");
    assert_eq!(m.licenses, ["Zlib"]);
    assert_eq!(m.url.as_deref(), Some("https://www.zlib.net/"));
    assert_eq!(m.size_installed, 228_580);
    assert_eq!(m.size_download, 84_690);
    assert_eq!(m.sha256.len(), 64);
    assert_eq!(m.filename, "zlib-1:1.3.2-3-x86_64.pkg.tar.zst");
    assert_eq!(m.pkginfo.base, "zlib");
    assert_eq!(m.pkginfo.builddate, 1_772_984_636);
    assert_eq!(m.pkginfo.packager, "David Runge <dvzrv@archlinux.org>");
    assert_eq!(m.pkginfo.depends, ["glibc"]);
    assert_eq!(m.pkginfo.provides, ["libz.so=1-64"]);
}

#[test]
fn zlib_provides_merge_pkginfo_and_soname() {
    let p = zlib().provides;
    assert!(has(&p, "zlib=1:1.3.2-3"), "self-provide: {p:?}");
    assert!(has(&p, "libz.so=1-64"), "declared in .PKGINFO: {p:?}");
    assert!(has(&p, "libz.so.1"), "raw DT_SONAME: {p:?}");
    // Declared and ELF-derived forms coincide and must not be duplicated.
    assert_eq!(
        p.iter().filter(|r| r.to_string() == "libz.so=1-64").count(),
        1
    );
}

#[test]
fn zlib_requires_include_elf_needs_and_symbol_versions() {
    let r = zlib().requires;
    assert!(has(&r, "glibc"), "declarative depend: {r:?}");
    assert!(has(&r, "libc.so.6"), "DT_NEEDED: {r:?}");
    assert!(has_prefix(&r, "libc.so.6(GLIBC_"), "verneed: {r:?}");
    // A library must never require its own soname.
    assert!(!has(&r, "libz.so.1"));
}

#[test]
fn zlib_file_list_excludes_metadata_and_marks_directories() {
    let f = zlib().files;
    assert!(f.contains(&"/usr/lib/libz.so.1.3.2".to_owned()));
    assert!(
        f.contains(&"/usr/lib/libz.so.1".to_owned()),
        "symlinks are tracked"
    );
    assert!(
        f.contains(&"/usr/lib/".to_owned()),
        "directories end with /"
    );
    assert!(f.iter().all(|p| p.starts_with('/')));
    assert!(!f
        .iter()
        .any(|p| p.contains(".PKGINFO") || p.contains(".MTREE") || p.contains(".BUILDINFO")));
    assert!(f.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
}

#[test]
fn xz_keeps_non_elf_dependencies_and_skips_internal_sonames() {
    let m = xz();
    assert_eq!(m.name, "xz");
    assert_eq!(m.version, "5.8.4-1");
    // `sh` is invisible to the ELF loader but declared in .PKGINFO.
    assert!(has(&m.requires, "sh"), "{:?}", m.requires);
    assert!(has(&m.requires, "glibc"));
    assert!(has(&m.requires, "libc.so.6"));
    // xz binaries link liblzma.so.5, which xz itself ships.
    assert!(has(&m.provides, "liblzma.so.5"));
    assert!(has(&m.provides, "liblzma.so=5-64"));
    assert!(!has(&m.requires, "liblzma.so.5"), "{:?}", m.requires);
    // makedepend must not leak into runtime requires, but is kept verbatim.
    assert!(!has(&m.requires, "git"));
    assert_eq!(m.pkginfo.makedepends, ["git", "po4a", "doxygen"]);
    assert_eq!(m.pkginfo.depends, ["glibc", "sh"]);
    assert!(m.files.contains(&"/usr/bin/xz".to_owned()));
}

#[test]
fn manifest_round_trips_through_json() {
    let m = zlib();
    let json = serde_json::to_string(&m).unwrap();
    let back: PackageManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(m, back);
}
