//! Vulnerability matching: public advisories against the package objects the
//! rings serve, with the real `vercmp`, pushed to the index in batches.
//!
//! Sources, in order of authority for an Arch-based system:
//! * the **Arch Security Tracker** — knows Arch's own versions: `exact` matches;
//! * the **Debian Security Tracker** — same upstream projects under mostly the
//!   same names; used only for CVEs Arch has no advisory for, comparing the
//!   upstream part of the versions (`name-version`) or, when Debian has no
//!   fixed version yet, by name alone (`name-only`);
//! * **CISA KEV** (exploited in the wild) and **FIRST EPSS** (probability of
//!   exploitation) enrich the CVEs the above mention.
//!
//! Exposure through dependencies is not computed here: the index derives it
//! from the dependency and soname graph when a page or the API asks.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use pkg_manifest::vercmp;
use serde::Deserialize;

use crate::client::Api;
use crate::RepoError;

pub struct SecurityOptions {
    pub arch_tracker: PathBuf,
    pub debian: Option<PathBuf>,
    pub kev: Option<PathBuf>,
    pub epss: Option<PathBuf>,
    pub rings: Vec<String>,
    pub dry_run: bool,
}

#[derive(Debug, Default)]
pub struct SecurityReport {
    pub objects: usize,
    pub arch_advisories: usize,
    pub debian_advisories: usize,
    pub matches_vulnerable: usize,
    pub matches_fixed: usize,
    pub cves: usize,
    pub kev: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Advisory {
    pub id: String,
    pub source: &'static str,
    pub package: String,
    pub cves: Vec<String>,
    pub severity: String,
    pub status: String,
    pub affected: Option<String>,
    pub fixed: Option<String>,
    pub summary: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Match {
    pub sha256: String,
    pub advisory: String,
    pub r#match: &'static str,
    pub status: &'static str,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CveMeta {
    pub cve: String,
    pub kev: bool,
    pub kev_added: Option<String>,
    pub epss: Option<f64>,
    pub epss_percentile: Option<f64>,
}

/// A package object a ring serves.
#[derive(Debug, Clone)]
pub struct Object {
    pub sha256: String,
    pub name: String,
    pub version: String,
    pub repo_arch: String,
}

// ---------- Arch Security Tracker (https://security.archlinux.org/issues/all.json) ----------

#[derive(Debug, Deserialize)]
struct ArchAdvisory {
    name: String,
    packages: Vec<String>,
    status: String,
    severity: String,
    #[serde(default)]
    affected: Option<String>,
    #[serde(default)]
    fixed: Option<String>,
    #[serde(default)]
    issues: Vec<String>,
}

/// For one object version: is it fixed, vulnerable, or not affected by an
/// Arch advisory. `None` when the advisory says the package is not affected.
fn arch_status(version: &str, adv: &ArchAdvisory) -> Option<&'static str> {
    if adv.status == "Not affected" {
        return None;
    }
    match &adv.fixed {
        Some(fixed) if vercmp(version, fixed).is_ge() => Some("fixed"),
        _ => Some("vulnerable"),
    }
}

/// Arch advisories (`exact`): every object whose name an advisory lists.
fn match_arch(
    objects: &[Object],
    tracker: &[ArchAdvisory],
) -> (Vec<Advisory>, Vec<Match>, HashSet<(String, String)>) {
    let by_name: HashMap<&str, Vec<&Object>> = objects.iter().fold(HashMap::new(), |mut m, o| {
        m.entry(o.name.as_str()).or_default().push(o);
        m
    });
    let mut advisories = Vec::new();
    let mut matches = Vec::new();
    let mut covered = HashSet::new();
    for adv in tracker {
        let mut touched = false;
        for pkg in &adv.packages {
            let Some(objs) = by_name.get(pkg.as_str()) else {
                continue;
            };
            for cve in &adv.issues {
                covered.insert((pkg.clone(), cve.clone()));
            }
            for o in objs {
                if let Some(status) = arch_status(&o.version, adv) {
                    matches.push(Match {
                        sha256: o.sha256.clone(),
                        advisory: format!("arch:{}:{pkg}", adv.name),
                        r#match: "exact",
                        status,
                    });
                    touched = true;
                }
            }
            if touched {
                advisories.push(Advisory {
                    id: format!("arch:{}:{pkg}", adv.name),
                    source: "arch",
                    package: pkg.clone(),
                    cves: adv.issues.clone(),
                    severity: adv.severity.to_lowercase(),
                    status: match adv.status.as_str() {
                        "Fixed" => "fixed".into(),
                        "Vulnerable" => "vulnerable".into(),
                        "Not affected" => "not-affected".into(),
                        _ => "unknown".into(),
                    },
                    affected: adv.affected.clone(),
                    fixed: adv.fixed.clone(),
                    summary: None,
                    url: format!("https://security.archlinux.org/{}", adv.name),
                });
            }
        }
    }
    advisories.sort_by(|a, b| a.id.cmp(&b.id));
    advisories.dedup_by(|a, b| a.id == b.id);
    (advisories, matches, covered)
}

// ---------- Debian Security Tracker (https://security-tracker.debian.org/tracker/data/json) ----------

#[derive(Debug, Deserialize)]
struct DebianRelease {
    status: String,
    #[serde(default)]
    fixed_version: Option<String>,
    #[serde(default)]
    urgency: Option<String>,
    /// Suite → version Debian currently ships (`sid` is what we compare with).
    #[serde(default)]
    repositories: HashMap<String, String>,
}

/// Same name, same project? Debian's `keystone` is `OpenStack` (29.x), Arch's
/// is the assembler engine (0.9.x). When the leading version components are
/// an order of magnitude apart the name is a coincidence.
#[must_use]
pub fn same_project(ours: &str, theirs: &str) -> bool {
    let lead = |v: &str| -> Option<f64> {
        upstream_version(v)
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|n| n.parse::<f64>().ok())
    };
    match (lead(ours), lead(theirs)) {
        (Some(a), Some(b)) => {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            hi <= 3.0 || lo * 4.0 >= hi
        }
        _ => true,
    }
}

#[derive(Debug, Deserialize)]
struct DebianCve {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    releases: HashMap<String, DebianRelease>,
}

/// The upstream part of a version: no epoch, no distribution revision, no
/// Debian `+dfsg`/`+ds` repack suffix. `1:1.2.3+dfsg1-2` → `1.2.3`.
#[must_use]
pub fn upstream_version(v: &str) -> String {
    let v = v.split_once(':').map_or(v, |(_, rest)| rest);
    let v = v.rsplit_once('-').map_or(v, |(up, _)| up);
    let v = v.split_once('+').map_or(v, |(up, _)| up);
    v.to_owned()
}

fn debian_severity(urgency: Option<&str>) -> Option<&'static str> {
    match urgency.unwrap_or("") {
        "high" | "high**" => Some("high"),
        "medium" | "medium**" => Some("medium"),
        "low" | "low**" => Some("low"),
        "unimportant" | "end-of-life" => None,
        _ => Some("unknown"),
    }
}

/// What Debian lets us say about one of our objects for a CVE.
enum DebianDecision {
    /// Debian fixed it at this upstream version: compare ours to it.
    Compare(String),
    /// Still open in Debian's sid: vulnerable by name, no version to compare.
    Open,
}

impl DebianDecision {
    fn judge(&self, o: &Object) -> (&'static str, &'static str) {
        match self {
            DebianDecision::Compare(fixed_up) => {
                let ours = upstream_version(&o.version);
                if vercmp(&ours, fixed_up).is_ge() {
                    ("name-version", "fixed")
                } else {
                    ("name-version", "vulnerable")
                }
            }
            DebianDecision::Open => ("name-only", "vulnerable"),
        }
    }
}

/// Debian's view of the same upstream projects, for CVEs Arch does not cover.
fn match_debian(
    objects: &[Object],
    debian: &HashMap<String, HashMap<String, DebianCve>>,
    covered_by_arch: &HashSet<(String, String)>,
) -> (Vec<Advisory>, Vec<Match>) {
    let by_name: HashMap<&str, Vec<&Object>> = objects.iter().fold(HashMap::new(), |mut m, o| {
        m.entry(o.name.as_str()).or_default().push(o);
        m
    });
    let mut advisories = Vec::new();
    let mut matches = Vec::new();
    for (name, objs) in &by_name {
        let Some(cves) = debian.get(*name) else {
            continue;
        };
        for (cve, info) in cves {
            if covered_by_arch.contains(&((*name).to_owned(), cve.clone())) {
                continue;
            }
            let Some(sid) = info.releases.get("sid") else {
                continue;
            };
            let Some(severity) = debian_severity(sid.urgency.as_deref()) else {
                continue;
            };
            // Only objects that plausibly are the same project as Debian's.
            let sid_version = sid.repositories.get("sid").cloned();
            let objs: Vec<&&Object> = objs
                .iter()
                .filter(|o| {
                    sid_version
                        .as_deref()
                        .is_none_or(|v| same_project(&o.version, v))
                })
                .collect();
            if objs.is_empty() {
                continue;
            }
            let decision = match (sid.status.as_str(), sid.fixed_version.as_deref()) {
                ("resolved", Some(fixed)) => DebianDecision::Compare(upstream_version(fixed)),
                ("open", _) => DebianDecision::Open,
                _ => continue,
            };
            let adv_status = match decision {
                DebianDecision::Compare(_) => "fixed",
                DebianDecision::Open => "vulnerable",
            };
            let id = format!("debian:{cve}:{name}");
            let mut touched = false;
            for o in objs {
                let (kind, status) = decision.judge(o);
                // Debian's resolved history is decades deep; only what is
                // vulnerable for our versions is worth a row.
                if status != "vulnerable" {
                    continue;
                }
                matches.push(Match {
                    sha256: o.sha256.clone(),
                    advisory: id.clone(),
                    r#match: kind,
                    status,
                });
                touched = true;
            }
            if touched {
                advisories.push(Advisory {
                    id,
                    source: "debian",
                    package: (*name).to_owned(),
                    cves: vec![cve.clone()],
                    severity: severity.into(),
                    status: adv_status.into(),
                    affected: None,
                    fixed: sid.fixed_version.clone(),
                    summary: info.description.clone(),
                    url: format!("https://security-tracker.debian.org/tracker/{cve}"),
                });
            }
        }
    }
    advisories.sort_by(|a, b| a.id.cmp(&b.id));
    (advisories, matches)
}

// ---------- KEV + EPSS ----------

#[derive(Debug, Deserialize)]
struct Kev {
    vulnerabilities: Vec<KevEntry>,
}
#[derive(Debug, Deserialize)]
struct KevEntry {
    #[serde(rename = "cveID")]
    cve_id: String,
    #[serde(rename = "dateAdded")]
    date_added: String,
}

fn load_kev(path: &Path) -> Result<HashMap<String, String>, RepoError> {
    let kev: Kev = serde_json::from_slice(&std::fs::read(path)?)?;
    Ok(kev
        .vulnerabilities
        .into_iter()
        .map(|e| (e.cve_id, e.date_added))
        .collect())
}

fn load_epss(
    path: &Path,
    wanted: &HashSet<String>,
) -> Result<HashMap<String, (f64, f64)>, RepoError> {
    let text = std::fs::read_to_string(path)?;
    let mut out = HashMap::new();
    for line in text.lines() {
        if line.starts_with('#') || line.starts_with("cve,") {
            continue;
        }
        let mut it = line.split(',');
        let (Some(cve), Some(epss), Some(pct)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        if wanted.contains(cve) {
            if let (Ok(e), Ok(p)) = (epss.parse::<f64>(), pct.parse::<f64>()) {
                out.insert(cve.to_owned(), (e, p));
            }
        }
    }
    Ok(out)
}

// ---------- run ----------

fn objects_of(api: &Api, rings: &[String]) -> Result<Vec<Object>, RepoError> {
    let mut seen = BTreeMap::new();
    for ring in rings {
        if let Some(view) = api.release_summary(ring)? {
            for p in view.packages {
                seen.entry(p.sha256.clone()).or_insert(Object {
                    sha256: p.sha256,
                    name: p.name,
                    version: p.version,
                    repo_arch: p.repo_arch,
                });
            }
        }
    }
    Ok(seen.into_values().collect())
}

pub fn run(api: &Api, opts: &SecurityOptions) -> Result<SecurityReport, RepoError> {
    let started = std::time::Instant::now();
    let run_at = chrono_now();
    let objects = objects_of(api, &opts.rings)?;
    let tracker: Vec<ArchAdvisory> = serde_json::from_slice(&std::fs::read(&opts.arch_tracker)?)?;
    tracing::info!(
        objects = objects.len(),
        arch_advisories = tracker.len(),
        "matching"
    );

    let (mut advisories, mut matches, covered) = match_arch(&objects, &tracker);
    let mut report = SecurityReport {
        objects: objects.len(),
        arch_advisories: advisories.len(),
        ..SecurityReport::default()
    };
    if let Some(path) = &opts.debian {
        let debian: HashMap<String, HashMap<String, DebianCve>> =
            serde_json::from_slice(&std::fs::read(path)?)?;
        let (adv, m) = match_debian(&objects, &debian, &covered);
        report.debian_advisories = adv.len();
        advisories.extend(adv);
        matches.extend(m);
    }
    report.matches_vulnerable = matches.iter().filter(|m| m.status == "vulnerable").count();
    report.matches_fixed = matches.iter().filter(|m| m.status == "fixed").count();

    let cves = enrich(&advisories, opts)?;
    report.cves = cves.len();
    report.kev = cves.iter().filter(|c| c.kev).count();

    println!(
        "{} objects · {} Arch + {} Debian advisories · {} vulnerable / {} fixed matches · {} CVEs, {} exploited in the wild",
        report.objects, report.arch_advisories, report.debian_advisories, report.matches_vulnerable, report.matches_fixed, report.cves, report.kev
    );
    if opts.dry_run {
        print_dry_run(&objects, &advisories, &matches);
        return Ok(report);
    }
    upload(api, &run_at, &advisories, &cves, &matches)?;

    let vulnerable_names: BTreeSet<&str> = matches
        .iter()
        .filter(|m| m.status == "vulnerable")
        .filter_map(|m| {
            objects
                .iter()
                .find(|o| o.sha256 == m.sha256)
                .map(|o| o.name.as_str())
        })
        .collect();
    api.post_event(&serde_json::json!({
        "kind": "security",
        "status": "ok",
        "summary": format!(
            "{} advisories matched: {} objects vulnerable ({} packages), {} CVEs exploited in the wild",
            report.arch_advisories + report.debian_advisories, report.matches_vulnerable, vulnerable_names.len(), report.kev
        ),
        "duration_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "payload": {
            "objects": report.objects, "arch_advisories": report.arch_advisories, "debian_advisories": report.debian_advisories,
            "vulnerable_objects": report.matches_vulnerable, "vulnerable_packages": vulnerable_names.len(),
            "fixed_matches": report.matches_fixed, "cves": report.cves, "kev": report.kev, "run_at": run_at,
        }
    }))?;
    Ok(report)
}

/// What a `--dry-run` shows: the vulnerable matches by source and kind, and
/// samples to eyeball the Debian heuristics.
fn print_dry_run(objects: &[Object], advisories: &[Advisory], matches: &[Match]) {
    let mut by_kind: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for m in matches.iter().filter(|m| m.status == "vulnerable") {
        let source = if m.advisory.starts_with("arch:") {
            "arch"
        } else {
            "debian"
        };
        *by_kind.entry((source, m.r#match)).or_default() += 1;
    }
    for ((source, kind), n) in &by_kind {
        println!("  vulnerable · {source:<7} {kind:<13} {n}");
    }
    let mut names: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for m in matches
        .iter()
        .filter(|m| m.status == "vulnerable" && m.r#match == "exact")
    {
        if let Some(o) = objects.iter().find(|o| o.sha256 == m.sha256) {
            names.entry(o.name.as_str()).or_default().push(&m.advisory);
        }
    }
    println!(
        "  Arch-exact vulnerable packages ({}): {}",
        names.len(),
        names.keys().take(40).copied().collect::<Vec<_>>().join(" ")
    );
    println!("  Debian name-version examples (ours vs Debian's fixed version):");
    for m in matches
        .iter()
        .filter(|m| m.status == "vulnerable" && m.r#match == "name-version")
        .take(16)
    {
        let object = objects.iter().find(|o| o.sha256 == m.sha256);
        let advisory = advisories.iter().find(|a| a.id == m.advisory);
        if let (Some(o), Some(a)) = (object, advisory) {
            println!(
                "    {:<28} ours {:<24} debian fixed {:<20} {}",
                o.name,
                o.version,
                a.fixed.as_deref().unwrap_or("-"),
                a.cves.join(",")
            );
        }
    }
}

/// KEV and EPSS for every CVE the advisories mention.
fn enrich(advisories: &[Advisory], opts: &SecurityOptions) -> Result<Vec<CveMeta>, RepoError> {
    let wanted: HashSet<String> = advisories
        .iter()
        .flat_map(|a| a.cves.iter().cloned())
        .collect();
    let kev = opts
        .kev
        .as_deref()
        .map(load_kev)
        .transpose()?
        .unwrap_or_default();
    let epss = opts
        .epss
        .as_deref()
        .map(|p| load_epss(p, &wanted))
        .transpose()?
        .unwrap_or_default();
    let mut cves: Vec<CveMeta> = wanted
        .iter()
        .map(|cve| CveMeta {
            cve: cve.clone(),
            kev: kev.contains_key(cve),
            kev_added: kev.get(cve).cloned(),
            epss: epss.get(cve).map(|e| e.0),
            epss_percentile: epss.get(cve).map(|e| e.1),
        })
        .collect();
    cves.sort_by(|a, b| a.cve.cmp(&b.cve));
    Ok(cves)
}

/// Batches everything into the index, then drops what this run did not write.
fn upload(
    api: &Api,
    run_at: &str,
    advisories: &[Advisory],
    cves: &[CveMeta],
    matches: &[Match],
) -> Result<(), RepoError> {
    for chunk in advisories.chunks(300) {
        api.put_json(
            "/security/advisories",
            &serde_json::json!({ "advisories": chunk, "updated_at": run_at }),
        )?;
    }
    for chunk in cves.chunks(500) {
        api.put_json(
            "/security/advisories",
            &serde_json::json!({ "cves": chunk, "updated_at": run_at }),
        )?;
    }
    for chunk in matches.chunks(500) {
        api.put_json(
            "/security/matches",
            &serde_json::json!({ "matches": chunk, "updated_at": run_at }),
        )?;
    }
    api.post_json(
        &format!("/security/prune?before={run_at}"),
        &serde_json::json!({}),
    )?;
    Ok(())
}

/// ISO-8601 now (UTC, seconds) without pulling a date crate in.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (hour, minute, second) = ((secs % 86_400) / 3600, (secs % 3600) / 60, secs % 60);
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let shifted = i64::try_from(secs / 86_400).unwrap_or(0) + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(name: &str, version: &str) -> Object {
        Object {
            sha256: format!("sha-{name}-{version}"),
            name: name.into(),
            version: version.into(),
            repo_arch: "x86_64".into(),
        }
    }

    #[test]
    fn upstream_version_strips_epoch_revision_and_repack() {
        assert_eq!(upstream_version("1:1.2.3+dfsg1-2"), "1.2.3");
        assert_eq!(upstream_version("3.6.4-1"), "3.6.4");
        assert_eq!(upstream_version("2.0~rc1-1"), "2.0~rc1");
        assert_eq!(upstream_version("9.0.1225"), "9.0.1225");
    }

    #[test]
    fn arch_versions_decide_fixed_or_vulnerable() {
        let adv = ArchAdvisory {
            name: "AVG-1".into(),
            packages: vec!["vim".into()],
            status: "Fixed".into(),
            severity: "High".into(),
            affected: Some("9.0.1224-1".into()),
            fixed: Some("9.0.1225-1".into()),
            issues: vec!["CVE-2023-0433".into()],
        };
        assert_eq!(arch_status("9.0.1225-1", &adv), Some("fixed"));
        assert_eq!(arch_status("9.1.0-1", &adv), Some("fixed"));
        assert_eq!(arch_status("9.0.1224-1", &adv), Some("vulnerable"));
        let open = ArchAdvisory {
            fixed: None,
            status: "Vulnerable".into(),
            ..adv
        };
        assert_eq!(arch_status("9.9.9-1", &open), Some("vulnerable"));
        let na = ArchAdvisory {
            status: "Not affected".into(),
            ..open
        };
        assert_eq!(arch_status("1-1", &na), None);
    }

    #[test]
    fn arch_matches_cover_the_cves_for_debian() {
        let objects = vec![
            obj("vim", "9.0.1224-1"),
            obj("vim", "9.0.1225-1"),
            obj("nano", "8.0-1"),
        ];
        let tracker = vec![ArchAdvisory {
            name: "AVG-1".into(),
            packages: vec!["vim".into()],
            status: "Fixed".into(),
            severity: "High".into(),
            affected: Some("9.0.1224-1".into()),
            fixed: Some("9.0.1225-1".into()),
            issues: vec!["CVE-2023-0433".into()],
        }];
        let (adv, matches, covered) = match_arch(&objects, &tracker);
        assert_eq!(adv.len(), 1);
        assert_eq!(adv[0].id, "arch:AVG-1:vim");
        assert_eq!(
            matches.iter().filter(|m| m.status == "vulnerable").count(),
            1
        );
        assert_eq!(matches.iter().filter(|m| m.status == "fixed").count(), 1);
        assert!(covered.contains(&("vim".to_owned(), "CVE-2023-0433".to_owned())));
    }

    #[test]
    fn debian_fills_only_what_arch_does_not_cover() {
        let objects = vec![obj("openssl", "3.6.4-1"), obj("nano", "8.0-1")];
        let mut debian: HashMap<String, HashMap<String, DebianCve>> = HashMap::new();
        let mut openssl = HashMap::new();
        let rel = |status: &str, fixed: Option<&str>, urgency: &str| DebianCve {
            description: Some("d".into()),
            releases: HashMap::from([(
                "sid".to_owned(),
                DebianRelease {
                    status: status.into(),
                    fixed_version: fixed.map(Into::into),
                    urgency: Some(urgency.into()),
                    repositories: HashMap::new(),
                },
            )]),
        };
        openssl.insert(
            "CVE-2026-1".into(),
            rel("resolved", Some("3.6.5-1"), "high"),
        ); // ours 3.6.4 < 3.6.5 → vulnerable
        openssl.insert(
            "CVE-2026-2".into(),
            rel("resolved", Some("3.6.0-1"), "medium"),
        ); // fixed
        openssl.insert("CVE-2026-3".into(), rel("open", None, "low")); // name-only vulnerable
        openssl.insert("CVE-2026-4".into(), rel("open", None, "unimportant")); // skipped
        openssl.insert("CVE-2026-5".into(), rel("open", None, "high")); // covered by arch → skipped
        debian.insert("openssl".into(), openssl);
        let covered = HashSet::from([("openssl".to_owned(), "CVE-2026-5".to_owned())]);
        let (adv, matches) = match_debian(&objects, &debian, &covered);
        let ids: Vec<&str> = adv.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            ["debian:CVE-2026-1:openssl", "debian:CVE-2026-3:openssl"],
            "fixed-for-us history is not recorded"
        );
        let status = |cve: &str| {
            matches
                .iter()
                .find(|m| m.advisory.contains(cve))
                .map(|m| (m.r#match, m.status))
        };
        assert_eq!(status("CVE-2026-1"), Some(("name-version", "vulnerable")));
        assert_eq!(status("CVE-2026-2"), None);
        assert_eq!(status("CVE-2026-3"), Some(("name-only", "vulnerable")));
    }

    #[test]
    fn name_collisions_are_rejected_by_version_distance() {
        assert!(!same_project("0.9.2-8", "2:29.0.1-2")); // keystone: assembler vs OpenStack
        assert!(same_project("2.12.3-1", "1:2.13.0-5")); // amavisd-new
        assert!(same_project("2.10.1-2", "3.2.0-1")); // ruby-jwt, one major apart
        assert!(same_project("1.2-1", "3.0-1")); // small numbers: never rejected
        assert!(!same_project("1.5-1", "20240101-1")); // date-based vs semver
        assert!(same_project("git-1", "1.0-1")); // no leading number: keep
    }

    #[test]
    fn now_is_iso8601() {
        let s = chrono_now();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }
}
