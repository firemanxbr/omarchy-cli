//! The safety check against a synthetic machine: a real liblzma.so.5 (taken
//! from the xz fixture) under `usr/lib`, and a small pacman local database.

use std::io::Read;
use std::path::{Path, PathBuf};

use pkg_check::abi::SystemAbi;
use pkg_check::local::{LocalDb, LocalPackage};
use pkg_check::{check, Action, Severity};
use pkg_manifest::{PackageManifest, PkgInfoFields, MANIFEST_SCHEMA_VERSION};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pkg-extract/tests/fixtures")
        .join(name)
}

/// Builds `<root>/usr/lib/liblzma.so.5` from the xz archive.
fn system_root() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let lib_dir = tmp.path().join("usr/lib");
    std::fs::create_dir_all(&lib_dir).unwrap();
    let file = std::fs::File::open(fixture("xz-5.8.4-1-x86_64.pkg.tar.zst")).unwrap();
    let mut archive = tar::Archive::new(zstd::Decoder::new(file).unwrap());
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        if entry.path().unwrap().to_string_lossy() == "usr/lib/liblzma.so.5.8.4" {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            std::fs::write(lib_dir.join("liblzma.so.5"), bytes).unwrap();
        }
    }
    assert!(lib_dir.join("liblzma.so.5").exists());
    tmp
}

fn local_db() -> LocalDb {
    LocalDb::from_packages([
        LocalPackage {
            name: "xz".into(),
            version: "5.8.4-1".into(),
            provides: vec!["liblzma.so=5-64".parse().unwrap()],
            depends: vec![],
        },
        LocalPackage {
            name: "glibc".into(),
            version: "2.42+r34-1".into(),
            provides: vec!["libc.so=6-64".parse().unwrap()],
            depends: vec![],
        },
    ])
}

fn manifest(name: &str, version: &str, requires: &[&str], provides: &[&str]) -> PackageManifest {
    PackageManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        name: name.into(),
        version: version.into(),
        arch: "x86_64".into(),
        description: None,
        url: None,
        licenses: vec![],
        size_installed: 1,
        size_download: 1,
        sha256: "00".repeat(32),
        filename: format!("{name}-{version}-x86_64.pkg.tar.zst"),
        pkginfo: PkgInfoFields::default(),
        provides: provides.iter().map(|s| s.parse().unwrap()).collect(),
        requires: requires.iter().map(|s| s.parse().unwrap()).collect(),
        optional: vec![],
        conflicts: vec![],
        replaces: vec![],
        files: vec![],
        backup: vec![],
    }
}

fn abi(root: &Path) -> SystemAbi {
    SystemAbi::new(root)
}

#[test]
fn satisfied_sonames_and_symbol_versions_are_safe() {
    let root = system_root();
    let plan = check(
        &[manifest(
            "foo",
            "1-1",
            &["liblzma.so.5", "liblzma.so.5(XZ_5.2)", "xz>=5.8", "glibc"],
            &[],
        )],
        &local_db(),
        &abi(root.path()),
    );
    assert!(plan.is_safe(), "{:?}", plan.findings);
    assert!(plan.findings.is_empty(), "{:?}", plan.findings);
    assert_eq!(plan.packages[0].action, Action::Install);
}

#[test]
fn missing_symbol_version_blocks_with_the_newest_available() {
    let root = system_root();
    let plan = check(
        &[manifest("bar", "1-1", &["liblzma.so.5(XZ_9.9)"], &[])],
        &local_db(),
        &abi(root.path()),
    );
    assert!(!plan.is_safe());
    let f = plan.blockers().next().unwrap();
    assert_eq!(f.requirement, "liblzma.so.5(XZ_9.9)");
    assert!(f.detail.contains("does not define XZ_9.9"), "{}", f.detail);
    assert!(
        f.detail.contains("newest XZ version: XZ_5."),
        "{}",
        f.detail
    );
    assert!(f.detail.contains("release upgrade"), "{}", f.detail);
}

#[test]
fn missing_library_is_a_warning_not_a_blocker() {
    // An absent library is an optional dependency of some binary (glibc's
    // memusagestat → libgd); a hard one would be declared and pulled by pacman.
    let root = system_root();
    let plan = check(
        &[manifest(
            "baz",
            "1-1",
            &["libnope.so.1", "libnope.so.1(NOPE_1.0)"],
            &[],
        )],
        &local_db(),
        &abi(root.path()),
    );
    assert!(plan.is_safe(), "{:?}", plan.findings);
    let mut warnings: Vec<_> = plan
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Warning)
        .map(|f| f.requirement.clone())
        .collect();
    warnings.sort();
    assert_eq!(warnings, ["libnope.so.1", "libnope.so.1(NOPE_1.0)"]);
}

#[test]
fn library_known_to_pacman_but_not_on_disk_is_trusted() {
    // e.g. a library living outside the standard lib dirs; the pacman database
    // says it is there, so we do not block on it.
    let root = system_root();
    let db = LocalDb::from_packages([LocalPackage {
        name: "weird".into(),
        version: "1-1".into(),
        provides: vec!["libweird.so.3".parse().unwrap()],
        depends: vec![],
    }]);
    let plan = check(
        &[manifest("q", "1-1", &["libweird.so.3"], &[])],
        &db,
        &abi(root.path()),
    );
    assert!(plan.is_safe(), "{:?}", plan.findings);
}

#[test]
fn package_deps_outside_the_release_are_warnings_not_blockers() {
    let root = system_root();
    let plan = check(
        &[manifest("app", "1-1", &["python>=3.12", "glibc>=9"], &[])],
        &local_db(),
        &abi(root.path()),
    );
    assert!(plan.is_safe());
    let mut kinds: Vec<(String, Severity)> = plan
        .findings
        .iter()
        .map(|f| (f.requirement.clone(), f.severity))
        .collect();
    kinds.sort();
    assert_eq!(
        kinds,
        [
            ("glibc>=9".to_owned(), Severity::Warning),
            ("python>=3.12".to_owned(), Severity::Warning)
        ]
    );
}

#[test]
fn requirements_provided_by_the_transaction_itself_are_fine() {
    let root = system_root();
    let plan = check(
        &[
            manifest("libfoo", "2-1", &[], &["libfoo.so.2", "libfoo.so=2-64"]),
            manifest(
                "app",
                "1-1",
                &["libfoo.so.2", "libfoo.so.2(FOO_2.0)", "libfoo>=2"],
                &[],
            ),
        ],
        &local_db(),
        &abi(root.path()),
    );
    // libfoo.so.2(FOO_2.0): the library is not on disk yet, but the plan ships
    // libfoo.so.2, so the soname is provided by this transaction.
    assert!(plan.is_safe(), "{:?}", plan.findings);
}

#[test]
fn actions_follow_installed_versions() {
    let root = system_root();
    let plan = check(
        &[
            manifest("xz", "5.8.4-1", &[], &[]),
            manifest("glibc", "2.43-1", &[], &[]),
            manifest("new", "1-1", &[], &[]),
        ],
        &local_db(),
        &abi(root.path()),
    );
    let actions: Vec<(String, Action)> = plan
        .packages
        .iter()
        .map(|p| (p.name.clone(), p.action))
        .collect();
    assert_eq!(
        actions,
        [
            ("xz".to_owned(), Action::Keep),
            ("glibc".to_owned(), Action::Upgrade),
            ("new".to_owned(), Action::Install)
        ]
    );
    assert_eq!(plan.to_install().count(), 2);
}
