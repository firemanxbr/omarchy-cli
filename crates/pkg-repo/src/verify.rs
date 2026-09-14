//! Does what the pool serves verify? For every OPR object a ring serves,
//! the bytes at `<arch>/<filename>` must be the bytes the index names, and
//! the `.sig` beside them must be Omarchy's signature of those bytes —
//! pacman refuses anything else as corrupted. Two ways it went wrong before
//! the pool refused a signature for bytes it does not serve (2026-09-12):
//! the OPR rebuilds the same version per channel with different bytes, so a
//! later channel's `.sig` landed beside an earlier channel's object, and a
//! second index row for the same filename got pinned while the object
//! stayed the first build's. `run` finds both and, with `repair`, fixes
//! them: the right `.sig` from the channel that still serves those bytes;
//! the ring re-pinned to the object the pool actually holds (indexed from
//! the bytes when the index never saw them). What no channel serves any
//! more is reported for a replacement.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::client::{Api, ReleaseRequest};
use crate::RepoError;

pub const OPR: &str = "https://pkgs.omarchy.org";
const CHANNELS: [&str; 3] = ["edge", "rc", "stable"];

pub struct VerifyOptions {
    pub pool: String,
    pub rings: Vec<String>,
    pub arches: Vec<String>,
    /// Omarchy's keyring (`omarchy.gpg`, tests/fetch-keyrings.sh).
    pub keyring: PathBuf,
    pub work_dir: PathBuf,
    pub repair: bool,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct VerifyReport {
    pub objects: usize,
    pub bad_signatures: usize,
    pub repaired_signatures: usize,
    pub mismatched: usize,
    pub repinned: usize,
    pub unfixable: usize,
    /// `ring/arch` rendered after a re-pin (the caller renders; this lists what needs it).
    pub repinned_rings: Vec<(String, String)>,
    pub details: Vec<String>,
}

/// A good signature of `file`, from the channel that serves exactly these bytes.
fn signature_from_upstream(
    api: &Api,
    arch: &str,
    filename: &str,
    sha: &str,
    file: &Path,
    keyring: &Path,
    work: &Path,
) -> Result<Option<(String, Vec<u8>)>, RepoError> {
    let up = work.join("upstream.pkg");
    let up_sig = work.join("upstream.sig");
    for channel in CHANNELS {
        let Ok(up_sha) = api.download(&format!("{OPR}/{channel}/{arch}/{filename}"), &up) else {
            continue;
        };
        if up_sha != sha {
            continue;
        }
        if api
            .download(&format!("{OPR}/{channel}/{arch}/{filename}.sig"), &up_sig)
            .is_err()
        {
            continue;
        }
        if crate::sign::verify_with_keyring(file, &up_sig, keyring).is_ok() {
            return Ok(Some((channel.to_owned(), std::fs::read(&up_sig)?)));
        }
    }
    Ok(None)
}

#[allow(clippy::too_many_lines)]
pub fn run(api: &Api, opts: &VerifyOptions) -> Result<VerifyReport, RepoError> {
    let mut report = VerifyReport::default();
    let work = opts.work_dir.join("verify");
    std::fs::create_dir_all(&work)?;
    let pkg = work.join("object.pkg");
    let sig = work.join("object.sig");
    // (arch, filename, indexed sha) already verified in this run: the rings
    // mostly share objects.
    let mut seen: BTreeSet<(String, String, String)> = BTreeSet::new();
    // What the pool stores under `<arch>/<filename>`, per directory: an
    // `any` package is one object per architecture directory, with
    // different bytes (Arch Linux ARM rebuilds them), so the filename
    // alone does not name an object.
    let mut stored_by_object: BTreeMap<(String, String), String> = BTreeMap::new();
    for ring in &opts.rings {
        for arch in &opts.arches {
            let Some(view) = api.release_summary_arch(ring, arch)? else {
                continue;
            };
            let mut repin: Vec<String> = Vec::new();
            for p in view.packages.iter().filter(|p| p.source == "packages") {
                let key = (arch.clone(), p.filename.clone(), p.sha256.clone());
                if seen.contains(&key) {
                    // Verified for another ring already. Whatever the
                    // signature's story was (repaired once, for the object),
                    // this ring pins the same bytes — wrong the same way when
                    // the pool stores something else under the name.
                    if opts.repair {
                        if let Some(stored) =
                            stored_by_object.get(&(arch.clone(), p.filename.clone()))
                        {
                            if *stored != p.sha256 {
                                repin.push(stored.clone());
                            }
                        }
                    }
                    continue;
                }
                seen.insert(key);
                report.objects += 1;
                let stored =
                    match api.download(&format!("{}/{arch}/{}", opts.pool, p.filename), &pkg) {
                        Ok(s) => s,
                        Err(e) => {
                            report.unfixable += 1;
                            report
                                .details
                                .push(format!("{ring}/{arch} {}: not served ({e})", p.filename));
                            continue;
                        }
                    };
                stored_by_object.insert((arch.clone(), p.filename.clone()), stored.clone());
                let has_sig = api
                    .download(&format!("{}/{arch}/{}.sig", opts.pool, p.filename), &sig)
                    .is_ok();
                let sig_ok =
                    has_sig && crate::sign::verify_with_keyring(&pkg, &sig, &opts.keyring).is_ok();
                if stored != p.sha256 {
                    // The pool holds another build under this filename than
                    // the one the ring pins: the ring must pin what is stored.
                    report.mismatched += 1;
                    report.details.push(format!(
                        "{ring}/{arch} {}: the pool stores {} while the ring pins {}",
                        p.filename,
                        &stored[..12],
                        &p.sha256[..12]
                    ));
                    if opts.repair {
                        // The ring can only pin bytes the index knows for
                        // this architecture; index them from the object when
                        // it never did. What the index refuses (one row per
                        // sha256: the same bytes already indexed for the
                        // other architecture) stays as it is and is reported.
                        let mut indexed = true;
                        if api.known(std::slice::from_ref(&stored), arch)?.is_empty() {
                            let manifest = pkg_extract::extract_manifest(&pkg)?;
                            match api.index_manifest(&manifest, "packages", arch) {
                                Ok(()) => report.details.push(format!(
                                    "{ring}/{arch} {}: indexed the stored bytes",
                                    p.filename
                                )),
                                Err(e) => {
                                    indexed = false;
                                    report.unfixable += 1;
                                    report.details.push(format!(
                                        "{ring}/{arch} {}: the stored bytes cannot be indexed for {arch} ({e}); the pin stays",
                                        p.filename
                                    ));
                                }
                            }
                        }
                        if indexed {
                            repin.push(stored.clone());
                        }
                    }
                }
                if !sig_ok {
                    report.bad_signatures += 1;
                    report.details.push(format!(
                        "{ring}/{arch} {}: {} for the stored bytes",
                        p.filename,
                        if has_sig {
                            "bad signature"
                        } else {
                            "no signature"
                        }
                    ));
                    if opts.repair {
                        if let Some((channel, bytes)) = signature_from_upstream(
                            api,
                            arch,
                            &p.filename,
                            &stored,
                            &pkg,
                            &opts.keyring,
                            &work,
                        )? {
                            let tmp = work.join("good.sig");
                            std::fs::write(&tmp, &bytes)?;
                            api.upload_pool_signature(&stored, &p.filename, arch, &tmp)?;
                            report.repaired_signatures += 1;
                            report.details.push(format!(
                                "{ring}/{arch} {}: signature repaired from the {channel} channel",
                                p.filename
                            ));
                        } else {
                            report.unfixable += 1;
                            report.details.push(format!("{ring}/{arch} {}: no channel serves these bytes any more — the object needs replacing", p.filename));
                        }
                    }
                }
            }
            if opts.repair && !repin.is_empty() {
                repin.sort();
                repin.dedup();
                let created = api.create_release(&ReleaseRequest {
                    ring,
                    add: &repin,
                    remove_arch: Some(arch),
                    note: Some(&format!(
                        "verify: {} object(s) re-pinned to what the pool stores ({arch})",
                        repin.len()
                    )),
                    ..ReleaseRequest::default()
                })?;
                report.repinned += repin.len();
                report.repinned_rings.push((ring.clone(), arch.clone()));
                report.details.push(format!(
                    "{ring}/{arch}: release {} pins the stored objects",
                    created.release.id
                ));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    Ok(report)
}

impl VerifyReport {
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "{} OPR objects verified: {} bad signature(s) ({} repaired), {} pinned bytes the pool does not store ({} re-pinned), {} need a replacement",
            self.objects,
            self.bad_signatures,
            self.repaired_signatures,
            self.mismatched,
            self.repinned,
            self.unfixable
        )
    }
    #[must_use]
    pub fn clean(&self) -> bool {
        self.bad_signatures == 0 && self.mismatched == 0 && self.unfixable == 0
    }
}
