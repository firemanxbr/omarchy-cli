//! Out-of-band ABI extraction for Arch packages.
//!
//! Packages produced by `makepkg` are **never modified**. This crate reads a
//! `.pkg.tar.zst` and produces a [`PackageManifest`] by merging:
//!
//! 1. the declarative metadata in `.PKGINFO`;
//! 2. the ELF facts (`DT_SONAME`, `DT_NEEDED`, `.gnu.version_r`) of every shared
//!    object and executable in the archive.
//!
//! It is used both by the CI publisher (`pkg-extract` binary) and by the local
//! client when installing a package built from the AUR.

pub mod elf;
pub mod pkginfo;

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use pkg_manifest::{DependencyRule, PackageManifest, PkgInfoFields, MANIFEST_SCHEMA_VERSION};
use sha2::{Digest, Sha256};
use tar::EntryType;

use crate::elf::ElfFacts;
use crate::pkginfo::PkgInfo;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("archive does not contain .PKGINFO")]
    MissingPkgInfo,
    #[error("invalid .PKGINFO: {0}")]
    PkgInfo(#[from] pkginfo::PkgInfoError),
}

/// Entries larger than this are listed but not inspected: buffering a multi-GB
/// shared object (CUDA, some games) is not worth the memory, and such objects
/// are never the ones whose sonames decide an upgrade.
const MAX_INSPECT_BYTES: u64 = 512 * 1024 * 1024;

/// Metadata entries makepkg stores at the archive root; never part of `files`.
const METADATA_ENTRIES: [&str; 5] = [".PKGINFO", ".BUILDINFO", ".MTREE", ".INSTALL", ".CHANGELOG"];

/// Everything learned from one pass over the archive, before merging.
#[derive(Debug, Default)]
struct ArchiveScan {
    pkginfo: Option<PkgInfo>,
    files: BTreeSet<String>,
    elf: Vec<(String, ElfFacts)>,
}

/// Reads a package archive and produces its manifest.
pub fn extract_manifest(archive: &Path) -> Result<PackageManifest, ExtractError> {
    let (sha256, size_download) = hash_file(archive)?;
    let scan = scan_archive(archive)?;
    let pkginfo = scan.pkginfo.as_ref().ok_or(ExtractError::MissingPkgInfo)?;
    let filename = archive
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(merge(pkginfo, &scan, sha256, size_download, filename)?)
}

/// First pass: SHA-256 and byte length of the archive as stored.
fn hash_file(path: &Path) -> Result<(String, u64), ExtractError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// Opens a package archive for streaming, whatever makepkg compressed it with
/// (`.pkg.tar.zst` on Arch, `.pkg.tar.xz` on Arch Linux ARM, plain tar).
pub fn open_archive(path: &Path) -> std::io::Result<Box<dyn Read>> {
    let mut file = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 6];
    let n = read_prefix(&mut file, &mut magic)?;
    let file = {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(0))?;
        file
    };
    Ok(match &magic[..n] {
        [0x28, 0xb5, 0x2f, 0xfd, ..] => Box::new(zstd::Decoder::new(file)?),
        [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] => Box::new(xz2::read::XzDecoder::new(file)),
        _ => Box::new(file),
    })
}

/// Second pass: stream the archive → tar, collecting `.PKGINFO`, the file list
/// and the ELF facts of every regular file that starts with the ELF magic.
fn scan_archive(path: &Path) -> Result<ArchiveScan, ExtractError> {
    let decoder = open_archive(path)?;
    let mut archive = tar::Archive::new(decoder);
    let mut scan = ArchiveScan::default();

    for entry in archive.entries()? {
        let mut entry = entry?;
        let raw_path = entry.path()?.to_string_lossy().into_owned();
        let name = raw_path.trim_start_matches("./").to_owned();

        if name == ".PKGINFO" {
            let mut text = String::new();
            entry.read_to_string(&mut text)?;
            scan.pkginfo = Some(PkgInfo::parse(&text)?);
            continue;
        }
        if METADATA_ENTRIES.contains(&name.as_str()) || name.is_empty() {
            continue;
        }

        let kind = entry.header().entry_type();
        let path = match kind {
            EntryType::Directory => format!("/{}/", name.trim_end_matches('/')),
            _ => format!("/{name}"),
        };
        scan.files.insert(path.clone());

        if kind != EntryType::Regular || entry.header().size().unwrap_or(0) > MAX_INSPECT_BYTES {
            continue;
        }

        // Peek the magic so scripts and data files are never buffered in full.
        let mut prefix = [0u8; 4];
        let read = read_prefix(&mut entry, &mut prefix)?;
        if !elf::is_elf(&prefix[..read]) {
            continue;
        }
        let mut bytes = prefix[..read].to_vec();
        entry.read_to_end(&mut bytes)?;
        match elf::inspect(&bytes) {
            Ok(Some(facts)) => scan.elf.push((path, facts)),
            Ok(None) => {}
            // ELF magic but not a loadable object (payload templates, test
            // fixtures, truncated stubs): nothing can link against it, so it
            // contributes no facts. Not an error for the package.
            Err(error) => tracing::warn!(path, %error, "unparseable ELF entry skipped"),
        }
    }
    Ok(scan)
}

/// Reads up to `buf.len()` bytes, returning how many were actually read (short
/// files are legal).
fn read_prefix(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Merges `.PKGINFO` and ELF facts into the final manifest.
fn merge(
    info: &PkgInfo,
    scan: &ArchiveScan,
    sha256: String,
    size_download: u64,
    filename: String,
) -> Result<PackageManifest, pkginfo::PkgInfoError> {
    let name = info.required("pkgname")?.to_owned();
    let version = info.required("pkgver")?.to_owned();
    let arch = info.required("arch")?.to_owned();
    let pkginfo = PkgInfoFields {
        base: info.first("pkgbase").unwrap_or(&name).to_owned(),
        builddate: info
            .first("builddate")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        packager: info.first("packager").unwrap_or_default().to_owned(),
        groups: info.all("group").to_vec(),
        depends: info.all("depend").to_vec(),
        makedepends: info.all("makedepend").to_vec(),
        checkdepends: info.all("checkdepend").to_vec(),
        optdepends: info.all("optdepend").to_vec(),
        provides: info.all("provides").to_vec(),
        conflicts: info.all("conflict").to_vec(),
        replaces: info.all("replaces").to_vec(),
    };

    let mut provides = RuleSet::default();
    provides.push(DependencyRule::with_constraint(
        name.clone(),
        pkg_manifest::VersionOp::Eq,
        version.clone(),
    ));
    provides.extend_parsed(info.all("provides"));

    // Sonames shipped by this package: both the raw soname (what DT_NEEDED asks
    // for) and Arch's `libfoo.so=N-64` form (what PKGBUILDs declare).
    let mut own_sonames = BTreeSet::new();
    for (_, facts) in &scan.elf {
        if let Some(soname) = &facts.soname {
            own_sonames.insert(soname.clone());
            provides.push(DependencyRule::unversioned(soname.clone()));
            if let Some(rule) = elf::arch_soname_provide(soname, facts.is_64) {
                provides.push(rule);
            }
        }
    }

    let mut requires = RuleSet::default();
    requires.extend_parsed(info.all("depend"));
    let mut version_needs = Vec::new();
    for (_, facts) in &scan.elf {
        for needed in &facts.needed {
            if !own_sonames.contains(needed) {
                requires.push(DependencyRule::unversioned(needed.clone()));
            }
        }
        version_needs.extend(
            facts
                .version_needs
                .iter()
                .filter(|need| !own_sonames.contains(&need.name))
                .cloned(),
        );
    }
    for need in collapse_version_needs(version_needs) {
        requires.push(need);
    }

    let mut optional = RuleSet::default();
    // `optdepend = name: why it is useful` — keep only the rule.
    optional.extend_parsed(
        info.all("optdepend")
            .iter()
            .map(|s| {
                s.split_once(':')
                    .map_or(s.as_str(), |(n, _)| n)
                    .trim()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .as_slice(),
    );
    let mut conflicts = RuleSet::default();
    conflicts.extend_parsed(info.all("conflict"));
    let mut replaces = RuleSet::default();
    replaces.extend_parsed(info.all("replaces"));

    Ok(PackageManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        name,
        version,
        arch,
        description: info.first("pkgdesc").map(str::to_owned),
        url: info.first("url").map(str::to_owned),
        licenses: info.all("license").to_vec(),
        size_installed: info.first("size").and_then(|s| s.parse().ok()).unwrap_or(0),
        size_download,
        sha256,
        filename,
        pkginfo,
        provides: provides.into_vec(),
        requires: requires.into_vec(),
        optional: optional.into_vec(),
        conflicts: conflicts.into_vec(),
        replaces: replaces.into_vec(),
        files: scan.files.iter().cloned().collect(),
        backup: info.all("backup").iter().map(|p| format!("/{p}")).collect(),
    })
}

/// Keeps only the highest symbol version per `(soname, namespace)`.
///
/// Symbol version namespaces are monotonic: an object exporting `GLIBC_2.34` also
/// exports every earlier `GLIBC_2.x`, so `libc.so.6(GLIBC_2.34)` subsumes
/// `libc.so.6(GLIBC_2.14)`. Namespaces without a numeric part
/// (`GLIBC_ABI_DT_RELR`) are kept verbatim.
fn collapse_version_needs(needs: Vec<DependencyRule>) -> Vec<DependencyRule> {
    use std::collections::BTreeMap;

    let mut best: BTreeMap<(String, String), DependencyRule> = BTreeMap::new();
    for need in needs {
        let Some(sym) = need.symbol_version.as_deref() else {
            continue;
        };
        let (namespace, version) = split_symbol_version(sym);
        let key = (need.name.clone(), namespace.to_owned());
        match best.get(&key) {
            Some(current) if version.is_some() => {
                let cur_ver = current
                    .symbol_version
                    .as_deref()
                    .and_then(|s| split_symbol_version(s).1)
                    .unwrap_or("");
                if pkg_manifest::vercmp(version.unwrap_or(""), cur_ver).is_gt() {
                    best.insert(key, need);
                }
            }
            Some(_) => {}
            None => {
                best.insert(key, need);
            }
        }
    }
    best.into_values().collect()
}

/// `GLIBC_2.34` → `("GLIBC", Some("2.34"))`; `GLIBC_ABI_DT_RELR` → `(.., None)`.
fn split_symbol_version(sym: &str) -> (&str, Option<&str>) {
    match sym.rsplit_once('_') {
        Some((ns, ver)) if ver.bytes().next().is_some_and(|b| b.is_ascii_digit()) => {
            (ns, Some(ver))
        }
        _ => (sym, None),
    }
}

/// Insertion-ordered, de-duplicated list of rules.
#[derive(Default)]
struct RuleSet {
    seen: BTreeSet<String>,
    rules: Vec<DependencyRule>,
}

impl RuleSet {
    fn push(&mut self, rule: DependencyRule) {
        if self.seen.insert(rule.to_string()) {
            self.rules.push(rule);
        }
    }

    /// Parses each string as a rule; entries makepkg wrote that we cannot parse are
    /// skipped with a warning rather than failing the whole package.
    fn extend_parsed(&mut self, raw: &[String]) {
        for s in raw {
            match s.parse::<DependencyRule>() {
                Ok(rule) => self.push(rule),
                Err(e) => {
                    tracing::warn!(rule = %s, error = %e, "skipping unparsable dependency rule");
                }
            }
        }
    }

    fn into_vec(self) -> Vec<DependencyRule> {
        self.rules
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(s: &str) -> DependencyRule {
        s.parse().unwrap()
    }

    #[test]
    fn collapses_to_highest_symbol_version_per_namespace() {
        let out = collapse_version_needs(vec![
            rule("libc.so.6(GLIBC_2.14)"),
            rule("libc.so.6(GLIBC_2.34)"),
            rule("libc.so.6(GLIBC_2.2.5)"),
            rule("libc.so.6(GLIBC_ABI_DT_RELR)"),
            rule("libstdc++.so.6(GLIBCXX_3.4.32)"),
            rule("libstdc++.so.6(GLIBCXX_3.4.9)"),
            rule("libstdc++.so.6(CXXABI_1.3)"),
        ]);
        let mut out: Vec<String> = out.iter().map(ToString::to_string).collect();
        out.sort();
        assert_eq!(
            out,
            [
                "libc.so.6(GLIBC_2.34)",
                "libc.so.6(GLIBC_ABI_DT_RELR)",
                "libstdc++.so.6(CXXABI_1.3)",
                "libstdc++.so.6(GLIBCXX_3.4.32)",
            ]
        );
    }

    #[test]
    fn splits_symbol_versions() {
        assert_eq!(split_symbol_version("GLIBC_2.34"), ("GLIBC", Some("2.34")));
        assert_eq!(
            split_symbol_version("GLIBCXX_3.4.32"),
            ("GLIBCXX", Some("3.4.32"))
        );
        assert_eq!(
            split_symbol_version("GLIBC_ABI_DT_RELR"),
            ("GLIBC_ABI_DT_RELR", None)
        );
        assert_eq!(split_symbol_version("NOUNDERSCORE"), ("NOUNDERSCORE", None));
    }
}
