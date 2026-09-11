//! ELF inspection: sonames provided and needed by a binary.

use pkg_manifest::DependencyRule;

/// ABI facts extracted from a single ELF object.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ElfFacts {
    /// `DT_SONAME`, if the object is a shared library.
    pub soname: Option<String>,
    /// `DT_NEEDED` entries, e.g. `libc.so.6`.
    pub needed: Vec<String>,
    /// Version needs from `.gnu.version_r`, e.g. `libc.so.6(GLIBC_2.38)`.
    pub version_needs: Vec<DependencyRule>,
}

/// Parses ELF bytes and extracts sonames and version needs.
///
/// Returns `Ok(None)` when the bytes are not an ELF object (scripts, data files),
/// so callers can iterate a whole archive without pre-filtering by extension.
pub fn inspect(_bytes: &[u8]) -> Result<Option<ElfFacts>, goblin::error::Error> {
    todo!("phase 1: parse with goblin::elf::Elf, read dynamic section + verneed")
}
