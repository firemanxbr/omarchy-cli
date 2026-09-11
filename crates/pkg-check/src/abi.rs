//! The shared libraries present on the machine and the symbol versions they
//! define. This is the ground truth an out-of-band install is checked against.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const LIB_DIRS: [&str; 5] = ["usr/lib", "usr/lib64", "lib", "lib64", "usr/local/lib"];

pub struct SystemAbi {
    root: PathBuf,
    versions: RefCell<HashMap<String, Option<Vec<String>>>>,
}

impl SystemAbi {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            versions: RefCell::new(HashMap::new()),
        }
    }

    /// Where `soname` (e.g. `libc.so.6`) lives, following symlinks.
    pub fn find_library(&self, soname: &str) -> Option<PathBuf> {
        LIB_DIRS
            .iter()
            .map(|d| self.root.join(d).join(soname))
            .find(|p| p.is_file())
    }

    /// Symbol versions defined by `soname`, or `None` when the library is not
    /// installed. Results are cached per soname.
    pub fn defined_versions(&self, soname: &str) -> Option<Vec<String>> {
        if let Some(cached) = self.versions.borrow().get(soname) {
            return cached.clone();
        }
        let result = self.find_library(soname).and_then(|path| {
            let bytes = std::fs::read(&path).ok()?;
            match pkg_extract::elf::defined_versions(&bytes) {
                Ok(Some(v)) => Some(v),
                Ok(None) => Some(Vec::new()),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "unreadable ELF");
                    Some(Vec::new())
                }
            }
        });
        self.versions
            .borrow_mut()
            .insert(soname.to_owned(), result.clone());
        result
    }
}
