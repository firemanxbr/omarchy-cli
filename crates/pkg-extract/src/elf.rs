//! ELF inspection: sonames provided and needed by a binary.

use goblin::elf::Elf;
use pkg_manifest::DependencyRule;

const ELF_MAGIC: &[u8; 4] = b"\x7fELF";

/// ABI facts extracted from a single ELF object.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ElfFacts {
    /// `DT_SONAME`, if the object is a shared library.
    pub soname: Option<String>,
    /// Whether the object is 64-bit; drives the `-64`/`-32` suffix in Arch-style
    /// soname provides (`libz.so=1-64`).
    pub is_64: bool,
    /// `DT_NEEDED` entries, e.g. `libc.so.6`.
    pub needed: Vec<String>,
    /// Version needs from `.gnu.version_r`, e.g. `libc.so.6(GLIBC_2.38)`.
    pub version_needs: Vec<DependencyRule>,
}

/// Cheap check on the first bytes of a file, so callers can avoid buffering
/// non-ELF entries of a large archive.
pub fn is_elf(prefix: &[u8]) -> bool {
    prefix.len() >= ELF_MAGIC.len() && &prefix[..ELF_MAGIC.len()] == ELF_MAGIC
}

/// Parses ELF bytes and extracts sonames and version needs.
///
/// Returns `Ok(None)` when the bytes are not an ELF object (scripts, data files),
/// so callers can iterate a whole archive without pre-filtering by extension.
pub fn inspect(bytes: &[u8]) -> Result<Option<ElfFacts>, goblin::error::Error> {
    if !is_elf(bytes) {
        return Ok(None);
    }
    let elf = Elf::parse(bytes)?;

    let mut version_needs = Vec::new();
    if let Some(verneed) = &elf.verneed {
        for need in verneed {
            let Some(file) = elf.dynstrtab.get_at(need.vn_file) else {
                continue;
            };
            for aux in &need {
                if let Some(version) = elf.dynstrtab.get_at(aux.vna_name) {
                    version_needs.push(DependencyRule {
                        name: file.to_owned(),
                        constraint: None,
                        symbol_version: Some(version.to_owned()),
                    });
                }
            }
        }
    }

    Ok(Some(ElfFacts {
        soname: elf.soname.map(str::to_owned),
        is_64: elf.is_64,
        needed: elf.libraries.iter().map(|s| (*s).to_owned()).collect(),
        version_needs,
    }))
}

/// Converts a raw soname into Arch's `provides` convention:
/// `libz.so.1` on a 64-bit object → `libz.so=1-64`.
///
/// Returns `None` when the soname has no numeric suffix (`libfoo.so`), matching
/// makepkg's `find_libprovides`, which only emits versioned entries.
pub fn arch_soname_provide(soname: &str, is_64: bool) -> Option<DependencyRule> {
    let (name, version) = soname.rsplit_once(".so.")?;
    if version.is_empty() || !version.bytes().next()?.is_ascii_digit() {
        return None;
    }
    let bits = if is_64 { "64" } else { "32" };
    Some(DependencyRule::with_constraint(
        format!("{name}.so"),
        pkg_manifest::VersionOp::Eq,
        format!("{version}-{bits}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_elf_is_none() {
        assert_eq!(inspect(b"#!/bin/sh\necho hi\n").unwrap(), None);
        assert_eq!(inspect(b"").unwrap(), None);
        assert!(!is_elf(b"\x7fEL"));
        assert!(is_elf(b"\x7fELF\x02"));
    }

    #[test]
    fn soname_to_arch_provide() {
        assert_eq!(
            arch_soname_provide("libz.so.1", true).unwrap().to_string(),
            "libz.so=1-64"
        );
        assert_eq!(
            arch_soname_provide("liblzma.so.5", false)
                .unwrap()
                .to_string(),
            "liblzma.so=5-32"
        );
        assert_eq!(
            arch_soname_provide("libssl.so.3", true)
                .unwrap()
                .to_string(),
            "libssl.so=3-64"
        );
        assert_eq!(arch_soname_provide("libfoo.so", true), None);
        assert_eq!(arch_soname_provide("libfoo.so.", true), None);
        assert_eq!(arch_soname_provide("notalib", true), None);
    }
}
