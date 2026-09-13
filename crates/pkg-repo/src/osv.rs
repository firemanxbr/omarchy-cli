//! OSV (<https://osv.dev>) for what packages embed. Arch's and Debian's
//! trackers name Arch packages; the Go modules and crates.io crates a
//! statically linked binary was built with (`components`, pkg-extract) have
//! their advisories in OSV instead. The pool asks OSV about every
//! component the rings serve, in batches, and records each hit as an
//! advisory against the Arch package that embeds it — an exact match, since
//! the build information names the version precisely.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Deserialize;

use crate::client::Api;
use crate::security::{Advisory, Match};
use crate::RepoError;

pub const OSV_API: &str = "https://api.osv.dev/v1";
/// OSV accepts up to 1000 queries per batch.
const BATCH: usize = 1000;

/// One entry of `GET /security/components`.
#[derive(Debug, Clone, Deserialize)]
pub struct ServedComponent {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub sha256s: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ComponentsView {
    components: Vec<ServedComponent>,
}

/// A vulnerability as OSV describes it (the fields the pool uses).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OsvVuln {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub severity: Vec<OsvSeverity>,
    #[serde(default)]
    pub affected: Vec<OsvAffected>,
    #[serde(default)]
    pub database_specific: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct OsvSeverity {
    #[serde(rename = "type")]
    pub kind: String,
    pub score: String,
}
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OsvAffected {
    #[serde(default)]
    pub package: Option<OsvPackage>,
    #[serde(default)]
    pub ranges: Vec<OsvRange>,
    #[serde(default)]
    pub ecosystem_specific: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct OsvPackage {
    pub name: String,
    pub ecosystem: String,
}
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OsvRange {
    #[serde(default)]
    pub events: Vec<BTreeMap<String, String>>,
}

/// The version as OSV's ecosystem writes it: Go module versions lose their `v`.
fn osv_version(ecosystem: &str, version: &str) -> String {
    if ecosystem == "Go" {
        version.trim_start_matches('v').to_owned()
    } else {
        version.to_owned()
    }
}

/// `severity` per OSV: what the database says when it says something
/// (`database_specific.severity`, GitHub's records always do), else a coarse
/// reading of the CVSS vector (`CVSS_V3`, `CVSS_V4`).
#[must_use]
pub fn severity_of(v: &OsvVuln) -> String {
    let db = v
        .database_specific
        .as_ref()
        .and_then(|d| d.get("severity"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase);
    match db.as_deref() {
        Some("moderate") => return "medium".to_owned(),
        Some(s @ ("critical" | "high" | "medium" | "low")) => return s.to_owned(),
        _ => {}
    }
    for s in &v.severity {
        if let Some(score) = cvss_base_score(&s.score) {
            return match score {
                x if x >= 9.0 => "critical",
                x if x >= 7.0 => "high",
                x if x >= 4.0 => "medium",
                _ => "low",
            }
            .to_owned();
        }
    }
    "unknown".to_owned()
}

/// A CVSS v3/v4 vector's base score, roughly: OSV records vectors, not
/// scores. Network reachability and how many of confidentiality, integrity
/// and availability are rated high (v3 `C/I/A`, v4 `VC/VI/VA`) place the
/// vector in the usual bands — a coarse reading until a score is attached.
fn cvss_base_score(vector: &str) -> Option<f64> {
    if !vector.starts_with("CVSS:") {
        return None;
    }
    let get = |k: &str| {
        vector
            .split('/')
            .find_map(|m| m.strip_prefix(k).and_then(|v| v.strip_prefix(':')))
    };
    let network = get("AV") == Some("N");
    let v4 = vector.starts_with("CVSS:4");
    let high = |k3: &str, k4: &str| get(if v4 { k4 } else { k3 }) == Some("H");
    let impacts = [high("C", "VC"), high("I", "VI"), high("A", "VA")]
        .iter()
        .filter(|x| **x)
        .count();
    let score = match (network, impacts) {
        (true, 3) => 9.8,
        (true, 2) => 8.1,
        (true, 1) => 7.5,
        (true, 0) => 5.3,
        (false, 3) => 7.8,
        (false, 2) => 6.5,
        (false, 1) => 5.5,
        (false, 0) => 3.3,
        _ => 5.0,
    };
    Some(score)
}

/// The first version the advisory's affected range for this package names as fixed.
#[must_use]
pub fn fixed_version(v: &OsvVuln, ecosystem: &str, name: &str) -> Option<String> {
    v.affected
        .iter()
        .filter(|a| {
            a.package
                .as_ref()
                .is_some_and(|p| p.ecosystem == ecosystem && p.name == name)
        })
        .flat_map(|a| a.ranges.iter())
        .flat_map(|r| r.events.iter())
        .find_map(|e| e.get("fixed").cloned())
}

/// The advisories and matches OSV yields for the served components: one
/// advisory per (vulnerability, Arch package), an exact match per object.
/// `vulns_of` answers a batch of (ecosystem, name, version) with the ids OSV
/// returns; `details_of` fetches one vulnerability (cached by the caller).
pub fn match_osv<Q, D>(
    components: &[ServedComponent],
    objects_by_sha: &BTreeMap<String, (String, String)>,
    mut vulns_of: Q,
    mut details_of: D,
) -> Result<(Vec<Advisory>, Vec<Match>), RepoError>
where
    Q: FnMut(&[ServedComponent]) -> Result<Vec<Vec<String>>, RepoError>,
    D: FnMut(&str) -> Result<OsvVuln, RepoError>,
{
    let mut advisories: BTreeMap<String, Advisory> = BTreeMap::new();
    let mut matches = Vec::new();
    let mut details: BTreeMap<String, OsvVuln> = BTreeMap::new();
    for chunk in components.chunks(BATCH) {
        let ids = vulns_of(chunk)?;
        for (c, vuln_ids) in chunk.iter().zip(ids) {
            for id in vuln_ids {
                if !details.contains_key(&id) {
                    let fetched = details_of(&id)?;
                    details.insert(id.clone(), fetched);
                }
                let v = details[&id].clone();
                let severity = severity_of(&v);
                let fixed = fixed_version(&v, &c.ecosystem, &c.name);
                let cves: Vec<String> = v
                    .aliases
                    .iter()
                    .filter(|a| a.starts_with("CVE-"))
                    .cloned()
                    .collect();
                // One advisory per Arch package that embeds the component.
                let mut packages: BTreeSet<&str> = BTreeSet::new();
                for sha in &c.sha256s {
                    if let Some((name, _)) = objects_by_sha.get(sha) {
                        packages.insert(name);
                        matches.push(Match {
                            sha256: sha.clone(),
                            advisory: format!("osv:{id}:{name}"),
                            r#match: "exact",
                            status: "vulnerable",
                        });
                    }
                }
                for pkg in packages {
                    advisories
                        .entry(format!("osv:{id}:{pkg}"))
                        .or_insert_with(|| Advisory {
                            id: format!("osv:{id}:{pkg}"),
                            source: "osv",
                            package: pkg.to_owned(),
                            cves: cves.clone(),
                            severity: severity.clone(),
                            status: "vulnerable".into(),
                            affected: Some(format!("{}@{}", c.name, c.version)),
                            fixed: fixed.clone(),
                            summary: Some(format!(
                                "{} {} {}: {}",
                                c.ecosystem,
                                c.name,
                                c.version,
                                v.summary.as_deref().unwrap_or(&id)
                            )),
                            url: format!("https://osv.dev/vulnerability/{id}"),
                        });
                }
            }
        }
    }
    matches.sort_by(|a, b| a.sha256.cmp(&b.sha256).then(a.advisory.cmp(&b.advisory)));
    matches.dedup_by(|a, b| a.sha256 == b.sha256 && a.advisory == b.advisory);
    Ok((advisories.into_values().collect(), matches))
}

/// The served components (`GET /security/components`).
pub fn served_components(api: &Api) -> Result<Vec<ServedComponent>, RepoError> {
    let v: ComponentsView = serde_json::from_value(api.get_json("/security/components")?)?;
    Ok(v.components)
}

/// `POST /querybatch`: the vulnerability ids per component.
pub fn query_batch(api: &Api, chunk: &[ServedComponent]) -> Result<Vec<Vec<String>>, RepoError> {
    #[derive(Deserialize)]
    struct Hit {
        id: String,
    }
    #[derive(Deserialize)]
    struct Res {
        #[serde(default)]
        vulns: Vec<Hit>,
    }
    #[derive(Deserialize)]
    struct Batch {
        results: Vec<Res>,
    }
    let queries: Vec<serde_json::Value> = chunk
        .iter()
        .map(|c| {
            serde_json::json!({ "package": { "name": c.name, "ecosystem": c.ecosystem }, "version": osv_version(&c.ecosystem, &c.version) })
        })
        .collect();
    let res = api.post_external_json(
        &format!("{OSV_API}/querybatch"),
        &serde_json::json!({ "queries": queries }),
    )?;
    let b: Batch = serde_json::from_value(res)?;
    Ok(b.results
        .into_iter()
        .map(|r| r.vulns.into_iter().map(|h| h.id).collect())
        .collect())
}

/// `GET /vulns/{id}`, cached in `cache` (OSV records change rarely; the
/// `modified` field would say when, one day).
pub fn vuln_details(api: &Api, cache: &Path, id: &str) -> Result<OsvVuln, RepoError> {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = cache.join(format!("{safe}.json"));
    if let Ok(text) = std::fs::read(&path) {
        if let Ok(v) = serde_json::from_slice::<OsvVuln>(&text) {
            return Ok(v);
        }
    }
    let v = api.get_external_json(&format!("{OSV_API}/vulns/{id}"))?;
    std::fs::create_dir_all(cache)?;
    std::fs::write(&path, serde_json::to_vec(&v)?)?;
    Ok(serde_json::from_value(v)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real API, for `cargo test -p pkg-repo osv -- --ignored`: an old
    /// x/crypto has advisories, their records parse, a fixed version is named.
    #[test]
    #[ignore = "network"]
    fn the_real_osv_answers_a_batch_and_a_record() {
        let api = Api::new("http://127.0.0.1:1", "none").unwrap();
        let chunk = vec![
            comp("Go", "golang.org/x/crypto", "v0.21.0", &["a"]),
            comp("crates.io", "openssl", "0.10.64", &["b"]),
        ];
        let ids = query_batch(&api, &chunk).unwrap();
        assert!(
            !ids[0].is_empty(),
            "x/crypto v0.21.0 has advisories: {ids:?}"
        );
        let cache = std::env::temp_dir().join(format!("osv-{}", std::process::id()));
        let v = vuln_details(&api, &cache, &ids[0][0]).unwrap();
        assert_eq!(v.id, ids[0][0]);
        assert!(
            fixed_version(&v, "Go", "golang.org/x/crypto").is_some(),
            "{v:?}"
        );
        assert_ne!(severity_of(&v), "");
        // Cached: a second read does not hit the network.
        let again = vuln_details(
            &Api::new("http://127.0.0.1:1", "none").unwrap(),
            &cache,
            &ids[0][0],
        )
        .unwrap();
        assert_eq!(again.id, v.id);
        let _ = std::fs::remove_dir_all(&cache);
    }

    fn comp(eco: &str, name: &str, version: &str, shas: &[&str]) -> ServedComponent {
        ServedComponent {
            ecosystem: eco.into(),
            name: name.into(),
            version: version.into(),
            sha256s: shas.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn a_hit_becomes_an_exact_advisory_against_every_package_that_embeds_it() {
        let components = vec![
            comp("Go", "golang.org/x/crypto", "v0.21.0", &["aaa", "bbb"]),
            comp("crates.io", "openssl", "0.10.64", &["bbb"]),
            comp("Go", "github.com/clean/lib", "v1.0.0", &["ccc"]),
        ];
        let objects: BTreeMap<String, (String, String)> = [
            ("aaa", ("gopass", "1.17.0-1")),
            ("bbb", ("tool", "2-1")),
            ("ccc", ("other", "1-1")),
        ]
        .iter()
        .map(|(s, (n, v))| ((*s).to_owned(), ((*n).to_owned(), (*v).to_owned())))
        .collect();
        let vulns_of = |chunk: &[ServedComponent]| {
            Ok(chunk
                .iter()
                .map(|c| {
                    if c.name == "golang.org/x/crypto" {
                        vec!["GO-2024-2687".to_owned()]
                    } else {
                        vec![]
                    }
                })
                .collect())
        };
        let details_of = |id: &str| {
            Ok(serde_json::from_value(serde_json::json!({
                "id": id, "summary": "Unbounded memory use in x/crypto/ssh",
                "aliases": ["CVE-2024-1234", "GHSA-xxxx"],
                "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}],
                "affected": [{"package": {"name": "golang.org/x/crypto", "ecosystem": "Go"}, "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "0.22.0"}]}]}]
            }))
            .unwrap())
        };
        let (advisories, matches) = match_osv(&components, &objects, vulns_of, details_of).unwrap();
        assert_eq!(advisories.len(), 2, "{advisories:?}");
        let a = advisories.iter().find(|a| a.package == "gopass").unwrap();
        assert_eq!(a.id, "osv:GO-2024-2687:gopass");
        assert_eq!(a.source, "osv");
        assert_eq!(a.severity, "high");
        assert_eq!(a.cves, vec!["CVE-2024-1234".to_owned()]);
        assert_eq!(a.fixed.as_deref(), Some("0.22.0"));
        assert_eq!(a.affected.as_deref(), Some("golang.org/x/crypto@v0.21.0"));
        assert!(a
            .summary
            .as_deref()
            .unwrap()
            .starts_with("Go golang.org/x/crypto v0.21.0: Unbounded"));
        assert_eq!(matches.len(), 2);
        assert!(matches
            .iter()
            .all(|m| m.r#match == "exact" && m.status == "vulnerable"));
        assert!(matches
            .iter()
            .any(|m| m.sha256 == "bbb" && m.advisory == "osv:GO-2024-2687:tool"));
    }

    #[test]
    fn severities_read_the_vector_or_the_database() {
        let v = |json: serde_json::Value| serde_json::from_value::<OsvVuln>(json).unwrap();
        assert_eq!(
            severity_of(&v(
                serde_json::json!({"id": "x", "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]})
            )),
            "critical"
        );
        assert_eq!(
            severity_of(&v(
                serde_json::json!({"id": "x", "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L"}]})
            )),
            "low"
        );
        assert_eq!(
            severity_of(&v(
                serde_json::json!({"id": "x", "database_specific": {"severity": "MODERATE"}})
            )),
            "medium"
        );
        assert_eq!(severity_of(&v(serde_json::json!({"id": "x"}))), "unknown");
        // The database's word wins over the vector; a v4 vector reads its VC/VI/VA.
        assert_eq!(
            severity_of(&v(
                serde_json::json!({"id": "x", "database_specific": {"severity": "LOW"}, "severity": [{"type": "CVSS_V4", "score": "CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:N/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N/E:U"}]})
            )),
            "low"
        );
        assert_eq!(
            severity_of(&v(
                serde_json::json!({"id": "x", "severity": [{"type": "CVSS_V4", "score": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"}]})
            )),
            "critical"
        );
        assert_eq!(osv_version("Go", "v0.21.0"), "0.21.0");
        assert_eq!(osv_version("crates.io", "0.10.64"), "0.10.64");
    }
}
