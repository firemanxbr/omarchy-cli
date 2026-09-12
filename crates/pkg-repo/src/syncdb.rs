//! Reads an upstream pacman sync database (`core.db`: gzip tar of
//! `<name>-<version>/desc`) into the fields the sync needs.

use std::io::Read;

use flate2::read::GzDecoder;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamPackage {
    pub name: String,
    pub version: String,
    pub filename: String,
    pub sha256: String,
    pub size_download: u64,
}

pub fn parse_sync_db(bytes: &[u8]) -> std::io::Result<Vec<UpstreamPackage>> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes));
    let mut out = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let is_desc = entry.path()?.file_name().is_some_and(|n| n == "desc");
        if !is_desc {
            continue;
        }
        let mut text = String::new();
        entry.read_to_string(&mut text)?;
        if let Some(pkg) = parse_desc(&text) {
            out.push(pkg);
        }
    }
    Ok(out)
}

fn parse_desc(text: &str) -> Option<UpstreamPackage> {
    let mut field = "";
    let mut name = None;
    let mut version = None;
    let mut filename = None;
    let mut sha256 = None;
    let mut csize = None;
    for line in text.lines() {
        if let Some(f) = line.strip_prefix('%').and_then(|l| l.strip_suffix('%')) {
            field = f;
            continue;
        }
        if line.is_empty() {
            field = "";
            continue;
        }
        match field {
            "NAME" => name.get_or_insert(line.to_owned()),
            "VERSION" => version.get_or_insert(line.to_owned()),
            "FILENAME" => filename.get_or_insert(line.to_owned()),
            "SHA256SUM" => sha256.get_or_insert(line.to_owned()),
            "CSIZE" => csize.get_or_insert(line.to_owned()),
            _ => continue,
        };
    }
    Some(UpstreamPackage {
        name: name?,
        version: version?,
        filename: filename?,
        sha256: sha256?,
        size_download: csize?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_desc_fields() {
        let text = "%FILENAME%\nzlib-1:1.3.2-3-x86_64.pkg.tar.zst\n\n%NAME%\nzlib\n\n%VERSION%\n1:1.3.2-3\n\n%CSIZE%\n84690\n\n%SHA256SUM%\nabc\n\n";
        let p = parse_desc(text).unwrap();
        assert_eq!(p.name, "zlib");
        assert_eq!(p.filename, "zlib-1:1.3.2-3-x86_64.pkg.tar.zst");
        assert_eq!(p.size_download, 84690);
        assert_eq!(p.sha256, "abc");
    }
}
