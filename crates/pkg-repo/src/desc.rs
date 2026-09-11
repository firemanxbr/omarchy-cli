//! The `desc` and `files` entry formats, mirroring `format_entry` in
//! pacman's `repo-add`: `%FIELD%`, one value per line, a blank line; fields
//! whose first value is empty are omitted entirely.

use std::fmt::Write;

use pkg_manifest::PackageManifest;

pub fn render_desc(pkg: &PackageManifest) -> String {
    let p = &pkg.pkginfo;
    let mut out = String::new();
    entry(&mut out, "FILENAME", std::slice::from_ref(&pkg.filename));
    entry(&mut out, "NAME", std::slice::from_ref(&pkg.name));
    entry(&mut out, "BASE", std::slice::from_ref(&p.base));
    entry(&mut out, "VERSION", std::slice::from_ref(&pkg.version));
    entry(&mut out, "DESC", pkg.description.as_slice());
    entry(&mut out, "GROUPS", &p.groups);
    entry(&mut out, "CSIZE", &[pkg.size_download.to_string()]);
    entry(&mut out, "ISIZE", &[pkg.size_installed.to_string()]);
    entry(&mut out, "SHA256SUM", std::slice::from_ref(&pkg.sha256));
    entry(&mut out, "URL", pkg.url.as_slice());
    entry(&mut out, "LICENSE", &pkg.licenses);
    entry(&mut out, "ARCH", std::slice::from_ref(&pkg.arch));
    entry(&mut out, "BUILDDATE", &[p.builddate.to_string()]);
    entry(&mut out, "PACKAGER", std::slice::from_ref(&p.packager));
    entry(&mut out, "REPLACES", &p.replaces);
    entry(&mut out, "CONFLICTS", &p.conflicts);
    entry(&mut out, "PROVIDES", &p.provides);
    entry(&mut out, "DEPENDS", &p.depends);
    entry(&mut out, "OPTDEPENDS", &p.optdepends);
    entry(&mut out, "MAKEDEPENDS", &p.makedepends);
    entry(&mut out, "CHECKDEPENDS", &p.checkdepends);
    out
}

/// `%FILES%` followed by every archive member, as `bsdtar -tf` lists them:
/// relative paths, directories with a trailing slash, root dotfiles excluded.
pub fn render_files(pkg: &PackageManifest) -> String {
    let mut out = String::from("%FILES%\n");
    let mut paths: Vec<&str> = pkg
        .files
        .iter()
        .map(|f| f.trim_start_matches('/'))
        .filter(|f| !f.starts_with('.'))
        .collect();
    paths.sort_unstable();
    for path in paths {
        out.push_str(path);
        out.push('\n');
    }
    out.push('\n');
    out
}

fn entry(out: &mut String, field: &str, values: &[String]) {
    if values.first().is_none_or(String::is_empty) {
        return;
    }
    let _ = writeln!(out, "%{field}%");
    for v in values {
        let _ = writeln!(out, "{v}");
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;
    use pkg_manifest::{PkgInfoFields, MANIFEST_SCHEMA_VERSION};

    fn sample() -> PackageManifest {
        PackageManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            name: "flea".into(),
            version: "1.2.0-1".into(),
            arch: "x86_64".into(),
            description: Some("Tiny example".into()),
            url: Some("https://example.org".into()),
            licenses: vec!["MIT".into()],
            size_installed: 2048,
            size_download: 1024,
            sha256: "ab".repeat(32),
            filename: "flea-1.2.0-1-x86_64.pkg.tar.zst".into(),
            pkginfo: PkgInfoFields {
                base: "flea".into(),
                builddate: 1_700_000_000,
                packager: "Omarchy <build@omarchy.org>".into(),
                depends: vec!["glibc".into(), "openssl>=3".into()],
                optdepends: vec!["bash: shell completions".into()],
                provides: vec!["libflea.so=1-64".into()],
                makedepends: vec!["cmake".into()],
                ..PkgInfoFields::default()
            },
            provides: vec![],
            requires: vec![],
            optional: vec![],
            conflicts: vec![],
            replaces: vec![],
            files: vec![
                "/usr/".into(),
                "/usr/bin/".into(),
                "/usr/bin/flea".into(),
                "/.BUILDINFO".into(),
            ],
            backup: vec![],
        }
    }

    #[test]
    fn desc_matches_repo_add_layout() {
        let desc = render_desc(&sample());
        let expected = "\
%FILENAME%
flea-1.2.0-1-x86_64.pkg.tar.zst

%NAME%
flea

%BASE%
flea

%VERSION%
1.2.0-1

%DESC%
Tiny example

%CSIZE%
1024

%ISIZE%
2048

%SHA256SUM%
abababababababababababababababababababababababababababababababab

%URL%
https://example.org

%LICENSE%
MIT

%ARCH%
x86_64

%BUILDDATE%
1700000000

%PACKAGER%
Omarchy <build@omarchy.org>

%PROVIDES%
libflea.so=1-64

%DEPENDS%
glibc
openssl>=3

%OPTDEPENDS%
bash: shell completions

%MAKEDEPENDS%
cmake

";
        assert_eq!(desc, expected);
    }

    #[test]
    fn files_lists_relative_sorted_paths_without_root_dotfiles() {
        assert_eq!(
            render_files(&sample()),
            "%FILES%\nusr/\nusr/bin/\nusr/bin/flea\n\n"
        );
    }
}
