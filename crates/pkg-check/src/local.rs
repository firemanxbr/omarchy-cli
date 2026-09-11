//! Read-only view of the pacman local database: one directory per installed
//! package under `<root>/var/lib/pacman/local/<name>-<version>/` with a `desc`
//! file in the same `%FIELD%` format as sync databases.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use pkg_manifest::DependencyRule;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalPackage {
    pub name: String,
    pub version: String,
    pub provides: Vec<DependencyRule>,
    pub depends: Vec<DependencyRule>,
}

#[derive(Debug, Default)]
pub struct LocalDb {
    packages: BTreeMap<String, LocalPackage>,
    /// capability name → packages providing it (with the full rule).
    providers: HashMap<String, Vec<(String, DependencyRule)>>,
}

impl LocalDb {
    pub fn load(root: &Path) -> std::io::Result<Self> {
        let dir = root.join("var/lib/pacman/local");
        let mut db = Self::default();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(db),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            let desc = entry.path().join("desc");
            let Ok(text) = std::fs::read_to_string(&desc) else {
                continue;
            };
            if let Some(pkg) = parse_desc(&text) {
                db.insert(pkg);
            }
        }
        Ok(db)
    }

    pub fn from_packages(packages: impl IntoIterator<Item = LocalPackage>) -> Self {
        let mut db = Self::default();
        for p in packages {
            db.insert(p);
        }
        db
    }

    fn insert(&mut self, pkg: LocalPackage) {
        // Every package provides itself at its version.
        let self_rule = DependencyRule::with_constraint(
            pkg.name.clone(),
            pkg_manifest::VersionOp::Eq,
            pkg.version.clone(),
        );
        for rule in pkg
            .provides
            .iter()
            .cloned()
            .chain(std::iter::once(self_rule))
        {
            self.providers
                .entry(rule.name.clone())
                .or_default()
                .push((pkg.name.clone(), rule));
        }
        self.packages.insert(pkg.name.clone(), pkg);
    }

    pub fn get(&self, name: &str) -> Option<&LocalPackage> {
        self.packages.get(name)
    }

    pub fn packages(&self) -> impl Iterator<Item = &LocalPackage> {
        self.packages.values()
    }

    /// Installed packages satisfying `rule` (name and version constraint).
    pub fn satisfiers(&self, rule: &DependencyRule) -> Vec<&str> {
        self.providers
            .get(&rule.name)
            .map(|v| {
                v.iter()
                    .filter(|(_, provided)| rule.satisfied_by(provided))
                    .map(|(pkg, _)| pkg.as_str())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn db_path(root: &Path) -> PathBuf {
        root.join("var/lib/pacman/local")
    }
}

/// Parses a `desc` file. Returns `None` when `%NAME%` or `%VERSION%` is missing.
pub fn parse_desc(text: &str) -> Option<LocalPackage> {
    let mut fields: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current: Option<&str> = None;
    for line in text.lines() {
        if let Some(field) = line.strip_prefix('%').and_then(|l| l.strip_suffix('%')) {
            current = Some(field);
            fields.entry(field).or_default();
        } else if line.is_empty() {
            current = None;
        } else if let Some(field) = current {
            fields.entry(field).or_default().push(line);
        }
    }
    let rules = |key: &str| -> Vec<DependencyRule> {
        fields
            .get(key)
            .map(|v| v.iter().filter_map(|s| s.parse().ok()).collect())
            .unwrap_or_default()
    };
    Some(LocalPackage {
        name: (*fields.get("NAME")?.first()?).to_owned(),
        version: (*fields.get("VERSION")?.first()?).to_owned(),
        provides: rules("PROVIDES"),
        depends: rules("DEPENDS"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GLIBC: &str = "%NAME%\nglibc\n\n%VERSION%\n2.42+r34-1\n\n%DESC%\nGNU C Library\n\n%PROVIDES%\nlibc.so=6-64\nlibm.so=6-64\n\n%DEPENDS%\nlinux-api-headers>=4.10\ntzdata\n\n";
    const BASH: &str = "%NAME%\nbash\n\n%VERSION%\n5.3.3-1\n\n%PROVIDES%\nsh\n\n";

    #[test]
    fn parses_desc_and_answers_satisfiers() {
        let db = LocalDb::from_packages([parse_desc(GLIBC).unwrap(), parse_desc(BASH).unwrap()]);
        assert_eq!(db.get("glibc").unwrap().version, "2.42+r34-1");
        assert_eq!(db.satisfiers(&"glibc".parse().unwrap()), ["glibc"]);
        assert_eq!(db.satisfiers(&"glibc>=2.40".parse().unwrap()), ["glibc"]);
        assert!(db.satisfiers(&"glibc>=3".parse().unwrap()).is_empty());
        assert_eq!(db.satisfiers(&"sh".parse().unwrap()), ["bash"]);
        assert_eq!(db.satisfiers(&"libc.so=6-64".parse().unwrap()), ["glibc"]);
        assert!(db.satisfiers(&"python".parse().unwrap()).is_empty());
    }

    #[test]
    fn loads_from_a_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("var/lib/pacman/local/bash-5.3.3-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("desc"), BASH).unwrap();
        let db = LocalDb::load(tmp.path()).unwrap();
        assert_eq!(db.packages().count(), 1);
        assert!(LocalDb::load(&tmp.path().join("nope"))
            .unwrap()
            .packages()
            .next()
            .is_none());
    }
}
