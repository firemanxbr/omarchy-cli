//! Renders a database from real packages and reads it back the way pacman would.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use pkg_repo::{build_database, Flavor};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pkg-extract/tests/fixtures")
        .join(name)
}

fn entries(bytes: &[u8]) -> BTreeMap<String, String> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes));
    let mut out = BTreeMap::new();
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        let path = entry.path().unwrap().to_string_lossy().into_owned();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        out.insert(path, content);
    }
    out
}

#[test]
fn db_contains_one_desc_per_package_and_files_adds_file_lists() {
    let packages = vec![
        pkg_extract::extract_manifest(&fixture("zlib-1:1.3.2-3-x86_64.pkg.tar.zst")).unwrap(),
        pkg_extract::extract_manifest(&fixture("xz-5.8.4-1-x86_64.pkg.tar.zst")).unwrap(),
    ];

    let db = entries(&build_database(&packages, Flavor::Db).unwrap());
    assert_eq!(
        db.keys().collect::<Vec<_>>(),
        [
            "xz-5.8.4-1/",
            "xz-5.8.4-1/desc",
            "zlib-1:1.3.2-3/",
            "zlib-1:1.3.2-3/desc"
        ]
    );
    let zlib = &db["zlib-1:1.3.2-3/desc"];
    assert!(zlib.starts_with("%FILENAME%\nzlib-1:1.3.2-3-x86_64.pkg.tar.zst\n\n%NAME%\nzlib\n\n"));
    assert!(zlib.contains("%PROVIDES%\nlibz.so=1-64\n\n"));
    assert!(zlib.contains("%DEPENDS%\nglibc\n\n"));
    assert!(zlib.contains("%CSIZE%\n84690\n\n%ISIZE%\n228580\n\n"));
    assert!(
        !zlib.contains("libz.so.1\n"),
        "ELF-derived provides must not leak into desc"
    );

    let files = entries(&build_database(&packages, Flavor::Files).unwrap());
    assert!(files.contains_key("xz-5.8.4-1/files"));
    let xz_files = &files["xz-5.8.4-1/files"];
    assert!(xz_files.starts_with("%FILES%\nusr/\nusr/bin/\n"));
    assert!(xz_files.contains("usr/bin/xz\n"));
    assert!(!xz_files.contains(".PKGINFO"));
}

#[test]
fn output_is_deterministic() {
    let packages =
        vec![pkg_extract::extract_manifest(&fixture("xz-5.8.4-1-x86_64.pkg.tar.zst")).unwrap()];
    let a = build_database(&packages, Flavor::Db).unwrap();
    let b = build_database(&packages, Flavor::Db).unwrap();
    assert_eq!(a, b);
}
