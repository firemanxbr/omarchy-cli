//! What a statically linked binary embeds: the Go modules a Go binary was
//! built with (`debug/buildinfo`, present in every Go binary) and the
//! crates a Rust binary was built with when the packager used
//! `cargo-auditable` (an ELF section `.dep-v0`, zlib-compressed JSON).
//! No soname reveals a vendored library, so this is the only way advisories
//! against a Go module or a crate reach the package that ships it.

use pkg_manifest::Component;

/// The sentinels Go writes around the module information string
/// (`runtime/debug.modinfo`), the same in every Go version since 1.12.
const MODINFO_START: &[u8; 16] =
    b"\x30\x77\xaf\x0c\x92\x74\x08\x02\x41\xe1\xc1\x07\xe6\xd6\x18\xe6";
const MODINFO_END: &[u8; 16] = b"\xf9\x32\x43\x31\x86\x18\x20\x72\x00\x82\x42\x10\x41\x16\xd8\xf2";
/// The header of the build-information blob (`debug/buildinfo`): the Go
/// version follows it, inline since Go 1.18.
const BUILDINFO_MAGIC: &[u8; 14] = b"\xff Go buildinf:";
const FLAG_INLINE_STRINGS: u8 = 0x2;

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The Go toolchain version a binary was built with (`go1.22.3`), from the
/// inline string that follows the buildinfo header (Go ≥ 1.18); `None` for
/// older layouts, where the version sits behind a pointer.
#[must_use]
pub fn go_version(bytes: &[u8]) -> Option<String> {
    let p = find(bytes, BUILDINFO_MAGIC)?;
    let flags = *bytes.get(p + 15)?;
    if flags & FLAG_INLINE_STRINGS == 0 {
        return None;
    }
    let (len, n) = uvarint(bytes.get(p + 32..)?)?;
    let start = p + 32 + n;
    let v = bytes.get(start..start + usize::try_from(len).ok()?)?;
    std::str::from_utf8(v).ok().map(str::to_owned)
}

fn uvarint(b: &[u8]) -> Option<(u64, usize)> {
    let mut x = 0u64;
    let mut s = 0u32;
    for (i, &byte) in b.iter().enumerate().take(10) {
        if byte < 0x80 {
            return Some((x | u64::from(byte) << s, i + 1));
        }
        x |= u64::from(byte & 0x7f) << s;
        s += 7;
    }
    None
}

/// The modules a Go binary embeds, from the `modinfo` string between its
/// sentinels: `dep` lines (and the replacement a `=>` line names). The main
/// module (`mod`) counts when it carries a real version.
#[must_use]
pub fn go_modules(bytes: &[u8]) -> Vec<Component> {
    let Some(start) = find(bytes, MODINFO_START) else {
        return Vec::new();
    };
    let body = &bytes[start + MODINFO_START.len()..];
    let Some(end) = find(body, MODINFO_END) else {
        return Vec::new();
    };
    let Ok(text) = std::str::from_utf8(&body[..end]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut last_dep: Option<usize> = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["mod" | "dep", path, version, ..] => {
                if version.is_empty() || *version == "(devel)" {
                    last_dep = None;
                    continue;
                }
                out.push(Component {
                    ecosystem: "Go".into(),
                    name: (*path).to_owned(),
                    version: (*version).to_owned(),
                });
                last_dep = Some(out.len() - 1);
            }
            // `=> path version hash`: the replacement actually linked.
            ["=>", path, version, ..] => {
                if let Some(i) = last_dep {
                    if !version.is_empty() && *version != "(devel)" {
                        (*path).clone_into(&mut out[i].name);
                        (*version).clone_into(&mut out[i].version);
                    }
                }
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The crates a Rust binary embeds, when it was built with
/// `cargo-auditable`: the `.dep-v0` section, zlib-compressed JSON with one
/// entry per crate (`name`, `version`, `source`). Only crates.io ones are
/// reported — a `local` or `git` crate has no advisory feed.
#[must_use]
pub fn rust_crates(bytes: &[u8]) -> Vec<Component> {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    struct Dep {
        name: String,
        version: String,
        #[serde(default)]
        source: String,
    }
    #[derive(serde::Deserialize)]
    struct Audit {
        packages: Vec<Dep>,
    }
    let Ok(elf) = goblin::elf::Elf::parse(bytes) else {
        return Vec::new();
    };
    let Some(sh) = elf
        .section_headers
        .iter()
        .find(|sh| elf.shdr_strtab.get_at(sh.sh_name) == Some(".dep-v0"))
    else {
        return Vec::new();
    };
    let Some(raw) = usize::try_from(sh.sh_offset)
        .ok()
        .zip(usize::try_from(sh.sh_size).ok())
        .and_then(|(o, s)| bytes.get(o..o + s))
    else {
        return Vec::new();
    };
    let mut json = Vec::new();
    if flate2::read::ZlibDecoder::new(raw)
        .read_to_end(&mut json)
        .is_err()
    {
        return Vec::new();
    }
    let Ok(audit) = serde_json::from_slice::<Audit>(&json) else {
        return Vec::new();
    };
    let mut out: Vec<Component> = audit
        .packages
        .into_iter()
        .filter(|d| d.source == "crates.io")
        .map(|d| Component {
            ecosystem: "crates.io".into(),
            name: d.name,
            version: d.version,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Everything a binary embeds that an advisory feed could name.
#[must_use]
pub fn embedded(bytes: &[u8]) -> Vec<Component> {
    let mut out = go_modules(bytes);
    out.extend(rust_crates(bytes));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_modules_come_from_the_modinfo_string_with_replacements_applied() {
        let text = "path\tgithub.com/example/tool\nmod\tgithub.com/example/tool\t(devel)\t\ndep\tgolang.org/x/crypto\tv0.21.0\th1:abc\ndep\tgithub.com/old/lib\tv1.0.0\th1:def\n=>\tgithub.com/fork/lib\tv1.0.1\th1:ghi\nbuild\t-buildmode=exe\n";
        let mut bytes = b"\x7fELFjunk".to_vec();
        bytes.extend_from_slice(MODINFO_START);
        bytes.extend_from_slice(text.as_bytes());
        bytes.extend_from_slice(MODINFO_END);
        let mods = go_modules(&bytes);
        assert_eq!(mods.len(), 2, "{mods:?}");
        assert_eq!(
            mods[0],
            Component {
                ecosystem: "Go".into(),
                name: "github.com/fork/lib".into(),
                version: "v1.0.1".into()
            }
        );
        assert_eq!(
            mods[1],
            Component {
                ecosystem: "Go".into(),
                name: "golang.org/x/crypto".into(),
                version: "v0.21.0".into()
            }
        );
        assert!(go_modules(b"not a go binary").is_empty());
    }

    #[test]
    fn the_go_version_follows_the_inline_header() {
        let mut bytes = vec![0u8; 8];
        bytes.extend_from_slice(BUILDINFO_MAGIC);
        bytes.push(8); // pointer size
        bytes.push(FLAG_INLINE_STRINGS);
        bytes.extend_from_slice(&[0u8; 16]); // padding up to offset 32
        bytes.push(8); // uvarint length of "go1.22.3"
        bytes.extend_from_slice(b"go1.22.3");
        assert_eq!(go_version(&bytes).as_deref(), Some("go1.22.3"));
    }

    #[test]
    fn a_plain_elf_embeds_nothing() {
        assert!(rust_crates(b"\x7fELF").is_empty());
        assert!(embedded(b"nothing").is_empty());
    }
}
