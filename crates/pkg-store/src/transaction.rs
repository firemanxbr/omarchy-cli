//! Transaction lifecycle:
//!
//! 1. **stage** — extract each archive into `<root>/var/lib/omarchy-cli/staging/<tx>/<pkg>/`;
//! 2. **plan** — diff against `tracked_files`, detect collisions, build the journal;
//! 3. **journal** — persist every planned operation in one database commit;
//! 4. **apply** — per-file `rename(2)`; old content is parked at `path.omarchy-old`;
//! 5. **commit** — write the new package state in one database transaction;
//! 6. **cleanup** — delete backups, prune empty directories, remove staging.
//!
//! Any failure in 1–5 replays the journal in reverse and leaves the system as it
//! was. A crash in 4 is rolled back by [`crate::Store::open`]; a crash in 6 is
//! finished by it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::BufReader;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use pkg_manifest::PackageManifest;
use redb::ReadableTable;

use crate::fsops::{self, join_abs};
use crate::journal::{self, JournalEntry, TransactionRecord, TransactionState};
use crate::tables::{self, CAPABILITIES, FILES, META, META_NEXT_TX, PACKAGES, TRANSACTIONS};
use crate::{InstalledPackage, Result, Store, StoreError, TrackedFile};

/// Metadata entries makepkg stores at the archive root; never installed.
const METADATA_ENTRIES: [&str; 5] = [".PKGINFO", ".BUILDINFO", ".MTREE", ".INSTALL", ".CHANGELOG"];

/// What a committed transaction did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TransactionReport {
    pub id: u64,
    /// `(name, version)` newly installed.
    pub installed: Vec<(String, String)>,
    /// `(name, old version, new version)`.
    pub upgraded: Vec<(String, String, String)>,
    pub removed: Vec<String>,
    /// Config files installed as `.pacnew` because the user had modified them.
    pub pacnew: Vec<String>,
}

/// Builder for one atomic set of installs and removals.
pub struct Transaction<'a> {
    store: &'a Store,
    installs: Vec<(PathBuf, PackageManifest)>,
    removals: Vec<String>,
    crash_after: Option<usize>,
    crash_after_commit: bool,
}

/// In-memory plan derived from the staged archives and the current state.
struct Plan {
    ops: Vec<JournalEntry>,
    /// Journal path → staged source for `Created`/`Replaced` ops.
    sources: HashMap<String, PathBuf>,
    /// Directories to create before applying, in manifest order.
    dirs: Vec<(String, u32)>,
    prune_dirs: Vec<String>,
    tracked: Vec<(String, TrackedFile)>,
    previous: BTreeMap<String, InstalledPackage>,
    pacnew: Vec<String>,
}

impl<'a> Transaction<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self {
            store,
            installs: Vec::new(),
            removals: Vec::new(),
            crash_after: None,
            crash_after_commit: false,
        }
    }

    /// Queues an archive for installation. If a package of the same name is
    /// already installed it is upgraded (or downgraded) in place.
    pub fn install(&mut self, archive: &Path, manifest: PackageManifest) -> &mut Self {
        self.installs
            .retain(|(_, existing)| existing.name != manifest.name);
        self.installs.push((archive.to_path_buf(), manifest));
        self
    }

    pub fn remove(&mut self, name: &str) -> &mut Self {
        if !self.removals.iter().any(|n| n == name) {
            self.removals.push(name.to_owned());
        }
        self
    }

    /// Test hook: abort *without rolling back* after `n` filesystem operations,
    /// as if the process had been killed. `Store::open` must then recover.
    #[doc(hidden)]
    pub fn simulate_crash_after(&mut self, n: usize) -> &mut Self {
        self.crash_after = Some(n);
        self
    }

    /// Test hook: abort after the database commit but before cleanup, leaving
    /// `.omarchy-old` backups and the staging directory behind.
    #[doc(hidden)]
    pub fn simulate_crash_after_commit(&mut self) -> &mut Self {
        self.crash_after_commit = true;
        self
    }

    /// Runs the transaction to completion or rolls it back.
    pub fn commit(self) -> Result<TransactionReport> {
        for name in &self.removals {
            if self.store.package(name)?.is_none() {
                return Err(StoreError::NotInstalled(name.clone()));
            }
        }

        let id = self.allocate_id()?;
        let mut record = TransactionRecord {
            id,
            state: TransactionState::Staging,
            staging_dir: self.store.staging_root().join(id.to_string()),
            ops: Vec::new(),
            install: self.installs.iter().map(|(_, m)| m.clone()).collect(),
            remove: self.removals.clone(),
            prune_dirs: Vec::new(),
        };
        self.write_record(&record)?;
        tracing::info!(
            tx = id,
            installs = self.installs.len(),
            removals = self.removals.len(),
            "transaction started"
        );

        match self.run(&mut record) {
            Ok(report) => Ok(report),
            Err(StoreError::SimulatedCrash(n)) => Err(StoreError::SimulatedCrash(n)),
            Err(source) => {
                tracing::error!(tx = id, error = %source, "transaction failed, rolling back");
                match journal::rollback(&self.store.root, &record) {
                    Ok(()) => {
                        self.store.delete_record(id)?;
                        Err(StoreError::RolledBack {
                            tx: id,
                            source: Box::new(source),
                        })
                    }
                    Err(rollback_error) => Err(StoreError::RollbackFailed {
                        tx: id,
                        source: Box::new(source),
                        rollback_error: Box::new(rollback_error),
                    }),
                }
            }
        }
    }

    fn run(&self, record: &mut TransactionRecord) -> Result<TransactionReport> {
        // 1. stage
        for (archive, manifest) in &self.installs {
            let dir = record.staging_dir.join(&manifest.name);
            fsops::create_dir_all(&dir)?;
            unpack(archive, &dir)?;
        }

        // 2. plan
        let plan = self.plan(record)?;
        record.ops.clone_from(&plan.ops);
        record.prune_dirs.clone_from(&plan.prune_dirs);

        // 3. journal
        record.state = TransactionState::Applying;
        self.write_record(record)?;

        // 4. apply
        self.apply(record, &plan)?;

        // 5. commit
        self.commit_state(record, &plan)?;
        if self.crash_after_commit {
            return Err(StoreError::SimulatedCrash(usize::MAX));
        }

        // 6. cleanup
        journal::cleanup(&self.store.root, record);
        self.store.delete_record(record.id)?;

        let mut report = TransactionReport {
            id: record.id,
            pacnew: plan.pacnew,
            removed: self.removals.clone(),
            ..TransactionReport::default()
        };
        for (_, m) in &self.installs {
            match plan.previous.get(&m.name) {
                Some(old) => {
                    report
                        .upgraded
                        .push((m.name.clone(), old.version.clone(), m.version.clone()));
                }
                None => report.installed.push((m.name.clone(), m.version.clone())),
            }
        }
        tracing::info!(tx = record.id, "transaction committed");
        Ok(report)
    }

    fn plan(&self, record: &TransactionRecord) -> Result<Plan> {
        let root = &self.store.root;
        let removing: BTreeSet<&str> = self.removals.iter().map(String::as_str).collect();

        let mut previous = BTreeMap::new();
        for (_, m) in &self.installs {
            if let Some(old) = self.store.package(&m.name)? {
                previous.insert(m.name.clone(), old);
            }
        }

        let mut plan = Plan {
            ops: Vec::new(),
            sources: HashMap::new(),
            dirs: Vec::new(),
            prune_dirs: Vec::new(),
            tracked: Vec::new(),
            previous,
            pacnew: Vec::new(),
        };
        let mut claimed: BTreeMap<&str, &str> = BTreeMap::new(); // path → new owner

        for (_, m) in &self.installs {
            let staged_root = record.staging_dir.join(&m.name);
            let old_files: BTreeSet<String> = plan
                .previous
                .get(&m.name)
                .map(|o| o.manifest.files.iter().cloned().collect())
                .unwrap_or_default();

            for path in &m.files {
                if METADATA_ENTRIES.contains(&path.trim_start_matches('/')) {
                    continue;
                }
                let staged = join_abs(&staged_root, path);
                let meta = std::fs::symlink_metadata(&staged).map_err(fsops::io(&staged))?;
                let mode = meta.mode() & 0o7777;

                if path.ends_with('/') {
                    let existed = fsops::exists_no_follow(&join_abs(root, path));
                    plan.dirs.push((path.clone(), mode));
                    if !existed && !plan.prune_dirs.contains(path) {
                        plan.prune_dirs.push(path.clone());
                    }
                    continue;
                }

                if let Some(other) = claimed.get(path.as_str()) {
                    return Err(StoreError::Collision {
                        path: path.clone(),
                        owner: format!("{other} (in this transaction)"),
                    });
                }
                claimed.insert(path, &m.name);

                let dest = join_abs(root, path);
                let on_disk = fsops::exists_no_follow(&dest);
                let target_path = self.destination_for(m, path, &dest, on_disk, &removing)?;
                if target_path != *path {
                    plan.pacnew.push(target_path.clone());
                }

                let op = if fsops::exists_no_follow(&join_abs(root, &target_path)) {
                    JournalEntry::Replaced {
                        path: target_path.clone(),
                    }
                } else {
                    JournalEntry::Created {
                        path: target_path.clone(),
                    }
                };
                plan.sources.insert(target_path, staged.clone());
                plan.ops.push(op);

                let sha256 = if meta.is_file() {
                    Some(fsops::sha256_file(&staged)?)
                } else {
                    None
                };
                plan.tracked.push((
                    path.clone(),
                    TrackedFile {
                        owner: m.name.clone(),
                        mode,
                        sha256,
                    },
                ));
            }

            // Files the previous version shipped but the new one does not.
            let kept: BTreeSet<String> = m.files.iter().cloned().collect();
            let dropped: Vec<&str> = old_files.difference(&kept).map(String::as_str).collect();
            Self::plan_removed_files(root, &dropped, &claimed, &mut plan);
        }

        for name in &self.removals {
            let pkg = self
                .store
                .package(name)?
                .ok_or_else(|| StoreError::NotInstalled(name.clone()))?;
            let paths: Vec<&str> = pkg.manifest.files.iter().map(String::as_str).collect();
            Self::plan_removed_files(root, &paths, &claimed, &mut plan);
        }

        Ok(plan)
    }

    /// Decides where a file of `m` lands: its own path, `path.pacnew` when it is
    /// a user-modified config file, or an error when another package (or an
    /// untracked file on disk) owns the path.
    fn destination_for(
        &self,
        m: &PackageManifest,
        path: &str,
        dest: &Path,
        on_disk: bool,
        removing: &BTreeSet<&str>,
    ) -> Result<String> {
        match self.store.owner_of(path)? {
            Some(t) if t.owner == m.name || removing.contains(t.owner.as_str()) => {
                if m.backup.iter().any(|b| b == path) && on_disk && user_modified(dest, &t)? {
                    return Ok(format!("{path}.pacnew"));
                }
                Ok(path.to_owned())
            }
            Some(t) => Err(StoreError::Collision {
                path: path.to_owned(),
                owner: t.owner,
            }),
            None if on_disk => Err(StoreError::Collision {
                path: path.to_owned(),
                owner: "filesystem".to_owned(),
            }),
            None => Ok(path.to_owned()),
        }
    }

    /// Queues `Removed` ops for files leaving the system, skipping paths a
    /// package in this transaction is taking over.
    fn plan_removed_files(
        root: &Path,
        paths: &[&str],
        claimed: &BTreeMap<&str, &str>,
        plan: &mut Plan,
    ) {
        for path in paths {
            if path.ends_with('/') {
                if !plan.prune_dirs.iter().any(|d| d == path) {
                    plan.prune_dirs.push((*path).to_owned());
                }
            } else if !claimed.contains_key(path) && fsops::exists_no_follow(&join_abs(root, path))
            {
                plan.ops.push(JournalEntry::Removed {
                    path: (*path).to_owned(),
                });
            }
        }
    }

    fn apply(&self, record: &TransactionRecord, plan: &Plan) -> Result<()> {
        let root = &self.store.root;
        for (dir, mode) in &plan.dirs {
            let abs = join_abs(root, dir);
            if !fsops::exists_no_follow(&abs) {
                fsops::create_dir_all(&abs)?;
                let perms = std::os::unix::fs::PermissionsExt::from_mode(*mode);
                std::fs::set_permissions(&abs, perms).map_err(fsops::io(&abs))?;
            }
        }

        for (i, op) in record.ops.iter().enumerate() {
            if self.crash_after == Some(i) {
                return Err(StoreError::SimulatedCrash(i));
            }
            let dest = join_abs(root, op.path());
            match op {
                JournalEntry::Created { path } => {
                    if let Some(parent) = dest.parent() {
                        fsops::create_dir_all(parent)?;
                    }
                    fsops::place(&plan.sources[path], &dest)?;
                }
                JournalEntry::Replaced { path } => {
                    fsops::rename_if_exists(&dest, &fsops::sibling(&dest, fsops::OLD_SUFFIX))?;
                    fsops::place(&plan.sources[path], &dest)?;
                }
                JournalEntry::Removed { .. } => {
                    fsops::rename_if_exists(&dest, &fsops::sibling(&dest, fsops::OLD_SUFFIX))?;
                }
            }
        }
        if self.crash_after == Some(record.ops.len()) {
            return Err(StoreError::SimulatedCrash(record.ops.len()));
        }
        Ok(())
    }

    /// Single database write: drop old rows, insert new ones, mark the record
    /// `Committed`.
    fn commit_state(&self, record: &mut TransactionRecord, plan: &Plan) -> Result<()> {
        let installed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let txn = self.store.db().begin_write()?;
        {
            let mut packages = txn.open_table(PACKAGES)?;
            let mut caps = txn.open_multimap_table(CAPABILITIES)?;
            let mut files = txn.open_table(FILES)?;
            let mut transactions = txn.open_table(TRANSACTIONS)?;

            let mut gone: Vec<InstalledPackage> = plan.previous.values().cloned().collect();
            for name in &self.removals {
                if let Some(v) = packages.get(name.as_str())? {
                    gone.push(tables::decode("installed_packages", v.value())?);
                }
            }
            for old in &gone {
                packages.remove(old.name.as_str())?;
                for rule in &old.manifest.provides {
                    caps.remove(rule.name.as_str(), old.name.as_str())?;
                }
                for path in &old.manifest.files {
                    let owned_by_old = files
                        .get(path.as_str())?
                        .map(|v| tables::decode::<TrackedFile>("tracked_files", v.value()))
                        .transpose()?
                        .is_some_and(|t| t.owner == old.name);
                    if owned_by_old {
                        files.remove(path.as_str())?;
                    }
                }
            }

            for (_, m) in &self.installs {
                let pkg = InstalledPackage {
                    name: m.name.clone(),
                    version: m.version.clone(),
                    sha256: m.sha256.clone(),
                    installed_at,
                    manifest: m.clone(),
                };
                packages.insert(m.name.as_str(), tables::encode(&pkg).as_slice())?;
                for rule in &m.provides {
                    caps.insert(rule.name.as_str(), m.name.as_str())?;
                }
            }
            for (path, tracked) in &plan.tracked {
                files.insert(path.as_str(), tables::encode(tracked).as_slice())?;
            }

            record.state = TransactionState::Committed;
            transactions.insert(record.id, tables::encode(record).as_slice())?;
        }
        txn.commit()?;
        Ok(())
    }

    fn allocate_id(&self) -> Result<u64> {
        let txn = self.store.db().begin_write()?;
        let id = {
            let mut meta = txn.open_table(META)?;
            let id = meta.get(META_NEXT_TX)?.map_or(1, |v| v.value());
            meta.insert(META_NEXT_TX, id + 1)?;
            id
        };
        txn.commit()?;
        Ok(id)
    }

    fn write_record(&self, record: &TransactionRecord) -> Result<()> {
        let txn = self.store.db().begin_write()?;
        {
            txn.open_table(TRANSACTIONS)?
                .insert(record.id, tables::encode(record).as_slice())?;
        }
        txn.commit()?;
        Ok(())
    }
}

/// Whether the file on disk differs from what we installed.
fn user_modified(dest: &Path, tracked: &TrackedFile) -> Result<bool> {
    match &tracked.sha256 {
        Some(expected) => Ok(fsops::sha256_file(dest)? != *expected),
        None => Ok(false),
    }
}

fn unpack(archive: &Path, dir: &Path) -> Result<()> {
    let file = File::open(archive).map_err(fsops::io(archive))?;
    let decoder = zstd::Decoder::new(BufReader::new(file)).map_err(fsops::io(archive))?;
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.set_preserve_mtime(true);
    tar.set_preserve_ownerships(fsops::is_root());
    tar.set_unpack_xattrs(false);
    tar.unpack(dir).map_err(fsops::io(archive))
}
