//! The safety check: would handing these packages to `pacman -U` leave the
//! system with an unsatisfied soname or symbol version?

use std::collections::BTreeSet;

use pkg_manifest::{vercmp, DependencyRule, PackageManifest};
use serde::Serialize;

use crate::abi::SystemAbi;
use crate::local::LocalDb;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Install,
    Upgrade,
    Downgrade,
    /// Already installed at this version; listed for completeness, not acted on.
    Keep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Satisfied by the system or by the plan itself.
    Ok,
    /// pacman will have to pull this from another repository.
    Warning,
    /// The system cannot run the result; refuse.
    Blocker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub package: String,
    pub requirement: String,
    pub severity: Severity,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedPackage {
    pub name: String,
    pub version: String,
    pub installed: Option<String>,
    pub action: Action,
    pub filename: String,
    pub size_download: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub packages: Vec<PlannedPackage>,
    pub findings: Vec<Finding>,
}

impl Plan {
    pub fn is_safe(&self) -> bool {
        !self
            .findings
            .iter()
            .any(|f| f.severity == Severity::Blocker)
    }

    pub fn blockers(&self) -> impl Iterator<Item = &Finding> {
        self.findings
            .iter()
            .filter(|f| f.severity == Severity::Blocker)
    }

    /// Packages pacman actually has to install.
    pub fn to_install(&self) -> impl Iterator<Item = &PlannedPackage> {
        self.packages.iter().filter(|p| p.action != Action::Keep)
    }
}

/// Builds the plan for `candidates` (the dependency closure the index returned
/// for the requested targets) against the machine described by `local` and
/// `abi`.
pub fn check(candidates: &[PackageManifest], local: &LocalDb, abi: &SystemAbi) -> Plan {
    let mut plan = Plan::default();

    for m in candidates {
        let installed = local.get(&m.name).map(|p| p.version.clone());
        let action = match &installed {
            None => Action::Install,
            Some(v) => match vercmp(&m.version, v) {
                std::cmp::Ordering::Greater => Action::Upgrade,
                std::cmp::Ordering::Equal => Action::Keep,
                std::cmp::Ordering::Less => Action::Downgrade,
            },
        };
        plan.packages.push(PlannedPackage {
            name: m.name.clone(),
            version: m.version.clone(),
            installed,
            action,
            filename: m.filename.clone(),
            size_download: m.size_download,
        });
    }

    // Capabilities the plan itself brings along.
    let planned: Vec<&PackageManifest> = candidates
        .iter()
        .zip(&plan.packages)
        .filter(|(_, p)| p.action != Action::Keep)
        .map(|(m, _)| m)
        .collect();
    let plan_provides: Vec<&DependencyRule> =
        planned.iter().flat_map(|m| m.provides.iter()).collect();

    let mut seen = BTreeSet::new();
    for m in &planned {
        for rule in &m.requires {
            if !seen.insert((m.name.clone(), rule.to_string())) {
                continue;
            }
            let finding = classify(m, rule, &plan_provides, local, abi);
            if finding.severity != Severity::Ok {
                plan.findings.push(finding);
            }
        }
    }
    plan.findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.package.cmp(&b.package))
    });
    plan
}

fn classify(
    m: &PackageManifest,
    rule: &DependencyRule,
    plan_provides: &[&DependencyRule],
    local: &LocalDb,
    abi: &SystemAbi,
) -> Finding {
    let finding = |severity: Severity, detail: String| Finding {
        package: m.name.clone(),
        requirement: rule.to_string(),
        severity,
        detail,
    };

    if plan_provides.iter().any(|p| rule.satisfied_by(p)) {
        return finding(Severity::Ok, "provided by this transaction".into());
    }

    let is_soname = rule.name.contains(".so");
    if is_soname {
        return match abi.defined_versions(&rule.name) {
            None => {
                // Not on disk. The pacman database may still know a provider
                // (e.g. a library installed under a different path). A library
                // that is entirely absent is almost always an *optional*
                // dependency of one binary in the package (glibc's memusagestat
                // needs libgd): a hard dependency would be declared in
                // `depends` and pulled in by pacman. So absence is a warning;
                // the blocker case is a library that is present but too old.
                if local
                    .satisfiers(&DependencyRule::unversioned(rule.name.clone()))
                    .is_empty()
                {
                    finding(
                        Severity::Warning,
                        format!(
                            "shared library {} is not installed; pacman resolves it if declared, otherwise a binary in this package treats it as optional",
                            rule.name
                        ),
                    )
                } else {
                    finding(Severity::Ok, "provided by an installed package".into())
                }
            }
            Some(defined) => match &rule.symbol_version {
                None => finding(Severity::Ok, "library present".into()),
                Some(need) if defined.iter().any(|d| d == need) => {
                    finding(Severity::Ok, "symbol version present".into())
                }
                Some(need) => {
                    let (ns, _) = split_namespace(need);
                    let mut have: Vec<&str> = defined
                        .iter()
                        .map(String::as_str)
                        .filter(|d| split_namespace(d).0 == ns && split_namespace(d).1.is_some())
                        .collect();
                    have.sort_by(|a, b| {
                        vercmp(
                            split_namespace(a).1.unwrap_or(""),
                            split_namespace(b).1.unwrap_or(""),
                        )
                    });
                    let newest = have.last().map_or("none", |s| *s);
                    finding(
                        Severity::Blocker,
                        format!(
                            "{} on this system does not define {need} (newest {ns} version: {newest}); a release upgrade is required first",
                            rule.name
                        ),
                    )
                }
            },
        };
    }

    if !local.satisfiers(rule).is_empty() {
        return finding(Severity::Ok, "installed".into());
    }
    match local.get(&rule.name) {
        Some(p) => finding(
            Severity::Warning,
            format!(
                "installed version {} does not satisfy {}; pacman will try to upgrade it from its configured repositories",
                p.version, rule
            ),
        ),
        None => finding(
            Severity::Warning,
            format!("{} is not installed and not part of this release; pacman will resolve it from its configured repositories", rule.name),
        ),
    }
}

fn split_namespace(sym: &str) -> (&str, Option<&str>) {
    match sym.rsplit_once('_') {
        Some((ns, ver)) if ver.bytes().next().is_some_and(|b| b.is_ascii_digit()) => {
            (ns, Some(ver))
        }
        _ => (sym, None),
    }
}
