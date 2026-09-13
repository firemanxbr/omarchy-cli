use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use pkg_check::abi::SystemAbi;
use pkg_check::local::LocalDb;
use pkg_check::{Action, Plan, Severity};
use pkg_hooks::{HookOperation, Matched, TransactionPackage};
use pkg_manifest::{vercmp, PackageManifest};

use crate::api::Api;
use crate::config::Config;
use crate::state::{self, Pinned};

/// Release-aware package client for Omarchy. Drives pacman; never bypasses it.
#[derive(Parser)]
#[command(name = "omarchy-cli", version = pkg_manifest::BUILD_VERSION, about)]
pub struct Cli {
    #[arg(long, global = true, default_value = "/etc/omarchy-cli/config.toml")]
    pub config: PathBuf,
    /// Override the index API URL from the config.
    #[arg(long, global = true, env = "OMARCHY_API")]
    pub api: Option<String>,
    /// Override the static pool URL from the config.
    #[arg(long, global = true, env = "OMARCHY_POOL")]
    pub pool: Option<String>,
    /// Override the ring from the config.
    #[arg(long, global = true)]
    pub ring: Option<String>,
    /// Filesystem root to inspect (testing against an exported rootfs).
    #[arg(long, global = true)]
    pub root: Option<PathBuf>,
    /// Architecture to resolve within (`x86_64` | `aarch64`); defaults to this machine's.
    #[arg(long, global = true)]
    pub arch: Option<String>,
    /// Machine-readable output.
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Shows the ring, the pinned release, what the ring serves now and pending updates.
    Status,
    /// Checks whether installing packages out of band is safe on this machine.
    Check {
        #[arg(required = true)]
        targets: Vec<String>,
    },
    /// Installs packages from the ring's current release via `pacman -U` after the safety check.
    Install {
        #[arg(required = true)]
        targets: Vec<String>,
        /// Print the pacman command instead of running it.
        #[arg(long)]
        dry_run: bool,
        /// Pass `--noconfirm` to pacman.
        #[arg(long)]
        noconfirm: bool,
    },
    /// Upgrades every installed package the ring's release has a newer version of.
    Upgrade {
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        noconfirm: bool,
        /// Only packages the ring flags with an open advisory (and any package
        /// the ring serves a clean newer version of), nothing else.
        #[arg(long)]
        security_only: bool,
    },
    /// Installed packages with an open advisory, and where a fixed version is.
    Security,
    /// Searches the ring's release by name or description.
    Search { query: String },
    /// Shows a package as published in the ring's release.
    Info { package: String },
    /// Lists installed packages that belong to the ring's release.
    List,
}

const EXIT_BLOCKED: i32 = 2;

pub fn run(cli: Cli) -> Result<i32> {
    let mut config = Config::load(&cli.config)?;
    if let Some(api) = cli.api {
        config.api = api;
    }
    if let Some(pool) = cli.pool {
        config.pool = pool;
    }
    if let Some(ring) = cli.ring {
        config.ring = ring;
    }
    if let Some(root) = cli.root {
        config.root = root;
    }
    if let Some(arch) = cli.arch {
        config.arch = arch;
    }
    // The index serves three rings; a typo here would otherwise surface as
    // "ring x has no release" from the API.
    if !["edge", "rc", "stable"].contains(&config.ring.as_str()) {
        bail!(
            "ring must be edge, rc or stable (got '{}'; --ring, or `ring` in {})",
            config.ring,
            cli.config.display()
        );
    }
    if !["x86_64", "aarch64"].contains(&config.arch.as_str()) {
        bail!("arch must be x86_64 or aarch64 (got '{}')", config.arch);
    }
    let api = Api::new(&config.api)?;
    let json = cli.json;

    match cli.command {
        Command::Status => status(&config, &api, json),
        Command::Check { targets } => {
            let (plan, _) = plan_targets(&config, &api, &targets)?;
            let hooks = hook_preview(&config, &api, &plan);
            print_plan(&plan, &hooks, json);
            Ok(if plan.is_safe() { 0 } else { EXIT_BLOCKED })
        }
        Command::Install {
            targets,
            dry_run,
            noconfirm,
        } => {
            let (plan, _) = plan_targets(&config, &api, &targets)?;
            let hooks = hook_preview(&config, &api, &plan);
            print_plan(&plan, &hooks, json);
            apply(&config, &plan, dry_run, noconfirm, None)
        }
        Command::Upgrade {
            dry_run,
            noconfirm,
            security_only,
        } => {
            let view = api.release(&config.ring, &config.arch)?;
            let local = LocalDb::load(&config.root)?;
            // --security-only: what the ring's own report says is worth fixing
            // now — an installed package whose current version has an open
            // advisory and which the ring serves a clean newer version of.
            let only: Option<std::collections::HashSet<String>> = if security_only {
                let report = api.security(&config.ring, &config.arch)?;
                Some(
                    installed_security(&report, &local)
                        .into_iter()
                        .map(|v| v.name)
                        .collect(),
                )
            } else {
                None
            };
            let candidates: Vec<PackageManifest> = view
                .packages
                .into_iter()
                .filter(|p| same_arch(&config, p.repo_arch.as_deref()))
                .map(|p| p.manifest)
                .filter(|m| only.as_ref().is_none_or(|set| set.contains(&m.name)))
                .filter(|m| {
                    local
                        .get(&m.name)
                        .is_some_and(|p| vercmp(&m.version, &p.version).is_gt())
                })
                .collect();
            let plan = pkg_check::check(&candidates, &local, &SystemAbi::new(&config.root));
            let hooks = hook_preview(&config, &api, &plan);
            print_plan(&plan, &hooks, json);
            let pin = Pinned {
                ring: config.ring.clone(),
                release_id: view.release.id,
                seq: view.release.seq,
                at: now(),
            };
            apply(&config, &plan, dry_run, noconfirm, Some(pin))
        }
        Command::Search { query } => search(&config, &api, &query, json),
        Command::Security => security(&config, &api, json),
        Command::Info { package } => info(&config, &api, &package, json),
        Command::List => list(&config, &api),
    }
}

fn search(config: &Config, api: &Api, query: &str, json: bool) -> Result<i32> {
    let view = api.release_summary(&config.ring)?;
    let q = query.to_lowercase();
    let hits: Vec<&crate::api::PackageSummary> = view
        .packages
        .iter()
        .filter(|m| same_arch(config, m.repo_arch.as_deref()))
        .filter(|m| {
            m.name.to_lowercase().contains(&q)
                || m.description
                    .as_deref()
                    .is_some_and(|d| d.to_lowercase().contains(&q))
        })
        .collect();
    if json {
        println!("{}", serde_json::to_string_pretty(&hits)?);
    } else {
        for m in hits {
            println!(
                "{}/{} {}\n    {}",
                config.repo,
                m.name,
                m.version,
                m.description.as_deref().unwrap_or("")
            );
        }
    }
    Ok(0)
}

fn info(config: &Config, api: &Api, package: &str, json: bool) -> Result<i32> {
    let view = api.release(&config.ring, &config.arch)?;
    let Some(m) = view
        .packages
        .iter()
        .filter(|p| same_arch(config, p.repo_arch.as_deref()))
        .map(|p| &p.manifest)
        .find(|m| m.name == package)
    else {
        bail!("{package} is not in {}#{}", config.ring, view.release.seq);
    };
    if json {
        println!("{}", serde_json::to_string_pretty(m)?);
        return Ok(0);
    }
    println!("Name         : {}", m.name);
    println!("Version      : {}", m.version);
    println!(
        "Release      : {}#{} (id {})",
        config.ring, view.release.seq, view.release.id
    );
    println!("Description  : {}", m.description.as_deref().unwrap_or(""));
    println!("URL          : {}", m.url.as_deref().unwrap_or(""));
    println!("Download     : {} bytes", m.size_download);
    println!("Installed    : {} bytes", m.size_installed);
    println!("SHA-256      : {}", m.sha256);
    println!("Depends      : {}", m.pkginfo.depends.join("  "));
    println!("Provides     : {}", m.pkginfo.provides.join("  "));
    let abi: Vec<String> = m
        .requires
        .iter()
        .filter(|r| r.name.contains(".so"))
        .map(ToString::to_string)
        .collect();
    println!("ABI needs    : {}", abi.join("  "));
    println!("Mirror       : {}", config.package_url(&m.filename));
    Ok(0)
}

/// The ring's vulnerable packages that are installed here at a version the
/// advisory still applies to (the ring may already serve a clean one).
fn installed_security(
    report: &crate::api::SecurityView,
    local: &LocalDb,
) -> Vec<crate::api::VulnerablePackage> {
    report
        .vulnerable
        .iter()
        .filter(|v| {
            local
                .get(&v.name)
                .is_some_and(|p| vercmp(&p.version, &v.version).is_le())
        })
        .cloned()
        .collect()
}

fn security(config: &Config, api: &Api, json: bool) -> Result<i32> {
    let report = api.security(&config.ring, &config.arch)?;
    let local = LocalDb::load(&config.root)?;
    let summary = api.release_summary(&config.ring)?;
    let mine = installed_security(&report, &local);
    // Which of them does this ring already serve a newer, clean version of?
    let serves_clean = |v: &crate::api::VulnerablePackage| {
        v.fixed_in.iter().any(|f| f.ring == config.ring)
            || summary.packages.iter().any(|p| {
                p.name == v.name
                    && same_arch(config, p.repo_arch.as_deref())
                    && vercmp(&p.version, &v.version).is_gt()
            })
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ring": report.ring, "arch": report.arch, "advisories_updated_at": report.updated_at,
                "installed_vulnerable": mine.iter().map(|v| serde_json::json!({
                    "name": v.name, "installed": local.get(&v.name).map(|p| p.version.clone()), "worst": v.worst, "kev": v.kev, "epss": v.epss,
                    "advisories": v.advisories, "fixed_in": v.fixed_in, "upgrade_fixes_it": serves_clean(v),
                })).collect::<Vec<_>>(),
            }))?
        );
        return Ok(0);
    }
    println!(
        "Ring       : {} ({})   advisories refreshed {}",
        report.ring,
        report.arch,
        report.updated_at.as_deref().unwrap_or("never")
    );
    if mine.is_empty() {
        println!("No installed package has an open advisory in this ring's report.");
        return Ok(0);
    }
    println!("Installed packages with an open advisory: {}", mine.len());
    for v in &mine {
        let installed = local
            .get(&v.name)
            .map(|p| p.version.clone())
            .unwrap_or_default();
        let cves: Vec<&str> = v
            .advisories
            .iter()
            .flat_map(|a| a.cves.iter().map(String::as_str))
            .collect();
        let confidence: std::collections::BTreeSet<&str> =
            v.advisories.iter().map(|a| a.confidence.as_str()).collect();
        println!(
            "  {:<9} {:<26} {:<20} {}{}",
            v.worst.to_uppercase(),
            v.name,
            installed,
            if v.kev {
                "EXPLOITED IN THE WILD · "
            } else {
                ""
            },
            cves.join(", ")
        );
        println!(
            "            confidence {} · {}",
            confidence.into_iter().collect::<Vec<_>>().join(", "),
            if serves_clean(v) {
                "this ring serves a fixed version: run `omarchy-cli upgrade --security-only`"
                    .to_owned()
            } else if let Some(f) = v.fixed_in.first() {
                format!(
                    "fixed version in {} ({}); the fast-track brings it here after its checks",
                    f.ring, f.version
                )
            } else {
                "no fixed version in any ring yet".to_owned()
            }
        );
    }
    Ok(0)
}

/// Rows of this machine's architecture (older indexes carried no `repo_arch`).
fn same_arch(config: &Config, repo_arch: Option<&str>) -> bool {
    repo_arch.is_none_or(|a| a == config.arch)
}

fn list(config: &Config, api: &Api) -> Result<i32> {
    let view = api.release_summary(&config.ring)?;
    let local = LocalDb::load(&config.root)?;
    for m in &view.packages {
        if !same_arch(config, m.repo_arch.as_deref()) {
            continue;
        }
        if let Some(p) = local.get(&m.name) {
            let mark = match vercmp(&m.version, &p.version) {
                std::cmp::Ordering::Greater => format!("  [update: {}]", m.version),
                std::cmp::Ordering::Less => "  [newer than release]".into(),
                std::cmp::Ordering::Equal => String::new(),
            };
            println!("{} {}{mark}", m.name, p.version);
        }
    }
    Ok(0)
}

fn status(config: &Config, api: &Api, json: bool) -> Result<i32> {
    let view = api.release_summary(&config.ring)?;
    let pinned = state::load(&config.root)?;
    let local = LocalDb::load(&config.root)?;
    let mut updates = Vec::new();
    let mut tracked = 0;
    for m in &view.packages {
        if !same_arch(config, m.repo_arch.as_deref()) {
            continue;
        }
        if let Some(p) = local.get(&m.name) {
            tracked += 1;
            if vercmp(&m.version, &p.version).is_gt() {
                updates.push((m.name.clone(), p.version.clone(), m.version.clone()));
            }
        }
    }
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ring": config.ring,
                "api": config.api,
                "pinned": pinned.as_ref().map(|p| serde_json::json!({"release_id": p.release_id, "seq": p.seq, "pinned_at": p.at})),
                "head": {"release_id": view.release.id, "seq": view.release.seq, "created_at": view.release.created_at, "note": view.release.note, "package_count": view.package_count},
                "installed_from_release": tracked,
                "updates": updates.iter().map(|(n, o, nw)| serde_json::json!({"name": n, "installed": o, "available": nw})).collect::<Vec<_>>(),
            })
        );
        return Ok(0);
    }
    println!("Repository : {}  [{}]", config.api, config.ring);
    match &pinned {
        Some(p) => println!(
            "Pinned     : {}#{} (id {}) since {}",
            p.ring, p.seq, p.release_id, p.at
        ),
        None => println!("Pinned     : none (never synchronised with omarchy-cli)"),
    }
    println!(
        "Serving    : {}#{} (id {}) — {} packages, created {}{}",
        config.ring,
        view.release.seq,
        view.release.id,
        view.package_count,
        view.release.created_at,
        view.release
            .note
            .as_deref()
            .map(|n| format!(" — {n}"))
            .unwrap_or_default()
    );
    let behind = pinned
        .as_ref()
        .is_some_and(|p| p.release_id != view.release.id);
    if behind {
        println!("           : this machine is behind the ring head");
    }
    println!("Installed  : {tracked} packages from this repository");
    if updates.is_empty() {
        println!("Updates    : none");
    } else {
        println!("Updates    : {}", updates.len());
        for (n, o, nw) in &updates {
            println!("             {n}  {o} -> {nw}");
        }
    }
    Ok(0)
}

fn plan_targets(config: &Config, api: &Api, targets: &[String]) -> Result<(Plan, u64)> {
    let graph = api.graph(&config.ring, &config.arch, targets)?;
    if !graph.missing_targets.is_empty() {
        bail!(
            "not in {} release: {}",
            config.ring,
            graph.missing_targets.join(", ")
        );
    }
    if graph.truncated {
        bail!("dependency graph too large; refusing to guess");
    }
    let local = LocalDb::load(&config.root)
        .with_context(|| format!("reading {}", LocalDb::db_path(&config.root).display()))?;
    let abi = SystemAbi::new(&config.root);
    let candidates: Vec<PackageManifest> = graph.packages.into_iter().map(|p| p.manifest).collect();
    Ok((
        pkg_check::check(&candidates, &local, &abi),
        graph.release_id,
    ))
}

/// A libalpm hook the plan would make pacman run, and why.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HookPreview {
    pub hook: String,
    pub when: &'static str,
    pub description: Option<String>,
    /// `package` (a name matched), `path` (a file matched), `maybe` (a path
    /// trigger against a package whose file list could not be fetched).
    pub matched: &'static str,
    pub because: String,
}

/// Which `.hook` files of this system the transaction triggers: the
/// `[Trigger]` sections matched against the packages the plan installs or
/// upgrades, by name and by the files they ship (fetched from the ring).
/// Read-only — pacman runs them when the client hands it the packages;
/// this says what to expect (`mkinitcpio`, `glib-compile-schemas`, …).
fn hook_preview(config: &Config, api: &Api, plan: &Plan) -> Vec<HookPreview> {
    let (hooks, errors) = pkg_hooks::load(&config.root);
    for e in errors {
        eprintln!("warning: hook skipped: {e}");
    }
    if hooks.is_empty() {
        return Vec::new();
    }
    // File lists only when a hook has a Path trigger (most have): one request per package.
    let needs_files = hooks.iter().any(|h| {
        h.triggers.iter().any(|t| {
            t.targets
                .iter()
                .any(|x| matches!(x, pkg_hooks::HookTarget::Path(_)))
        })
    });
    let mut files: Vec<Option<Vec<String>>> = Vec::new();
    let to_install: Vec<_> = plan.to_install().collect();
    for p in &to_install {
        files.push(if needs_files {
            match api.files(&config.ring, &config.arch, &p.name) {
                Ok(f) => Some(f),
                Err(e) => {
                    eprintln!("warning: files of {}: {e:#}", p.name);
                    None
                }
            }
        } else {
            None
        });
    }
    let transaction: Vec<TransactionPackage<'_>> = to_install
        .iter()
        .zip(&files)
        .map(|(p, f)| TransactionPackage {
            name: &p.name,
            operation: match p.action {
                Action::Install => HookOperation::Install,
                _ => HookOperation::Upgrade,
            },
            files: f.as_deref(),
        })
        .collect();
    hooks
        .iter()
        .filter_map(|h| {
            let m = h.triggered_by(&transaction)?;
            let (matched, because) = match m {
                Matched::Package(n) => ("package", n),
                Matched::Path { target, file } => ("path", format!("{file} ({target})")),
                Matched::Undecided { target, package } => (
                    "maybe",
                    format!("{package} may ship {target}; file list not fetched"),
                ),
            };
            Some(HookPreview {
                hook: h.name.clone(),
                when: h.when.as_str(),
                description: h.description.clone(),
                matched,
                because,
            })
        })
        .collect()
}

fn print_plan(plan: &Plan, hooks: &[HookPreview], json: bool) {
    if json {
        let mut v = serde_json::to_value(plan).expect("plan serializes");
        v["hooks"] = serde_json::to_value(hooks).expect("hooks serialize");
        println!(
            "{}",
            serde_json::to_string_pretty(&v).expect("plan serializes")
        );
        return;
    }
    let to_install: Vec<_> = plan.to_install().collect();
    if to_install.is_empty() {
        println!("Nothing to do: everything is already installed at the release version.");
    } else {
        println!("Packages ({}):", to_install.len());
        for p in &to_install {
            let action = match p.action {
                Action::Install => "install".to_owned(),
                Action::Upgrade => {
                    format!("upgrade from {}", p.installed.as_deref().unwrap_or("?"))
                }
                Action::Downgrade => {
                    format!("DOWNGRADE from {}", p.installed.as_deref().unwrap_or("?"))
                }
                Action::Keep => "keep".to_owned(),
            };
            println!("  {:<24} {:<20} {action}", p.name, p.version);
        }
    }
    for f in &plan.findings {
        let tag = match f.severity {
            Severity::Blocker => "BLOCKED",
            Severity::Warning => "warning",
            Severity::Ok => "ok",
        };
        println!("  {tag:<8} {}: {} — {}", f.package, f.requirement, f.detail);
    }
    if !hooks.is_empty() {
        println!("Hooks pacman would run ({}):", hooks.len());
        for h in hooks {
            println!(
                "  {:<34} {:<4} {}{}",
                h.hook,
                h.when,
                h.description.as_deref().unwrap_or(""),
                match h.matched {
                    "maybe" => format!(" — maybe: {}", h.because),
                    _ => format!(" — {}", h.because),
                }
            );
        }
    }
    if plan.is_safe() {
        println!("Verdict: safe to install out of band.");
    } else {
        println!(
            "Verdict: BLOCKED — {} requirement(s) this system cannot satisfy.",
            plan.blockers().count()
        );
    }
}

fn apply(
    config: &Config,
    plan: &Plan,
    dry_run: bool,
    noconfirm: bool,
    pin: Option<Pinned>,
) -> Result<i32> {
    if !plan.is_safe() {
        return Ok(EXIT_BLOCKED);
    }
    let urls: Vec<String> = plan
        .to_install()
        .map(|p| config.package_url(&p.filename))
        .collect();
    if urls.is_empty() {
        if let Some(pin) = pin {
            state::save(&config.root, &pin)?;
        }
        return Ok(0);
    }
    let mut cmd = std::process::Command::new("pacman");
    cmd.arg("-U");
    if noconfirm {
        cmd.arg("--noconfirm");
    }
    if config.root != std::path::Path::new("/") {
        cmd.arg("--root").arg(&config.root);
    }
    cmd.args(&urls);
    if dry_run {
        println!("Would run: {}", render(&cmd));
        return Ok(0);
    }
    println!("Running: {}", render(&cmd));
    let status = cmd.status().context("running pacman")?;
    if !status.success() {
        bail!("pacman exited with {status}");
    }
    if let Some(pin) = pin {
        state::save(&config.root, &pin)?;
        println!("Pinned to {}#{}.", pin.ring, pin.seq);
    }
    Ok(0)
}

fn render(cmd: &std::process::Command) -> String {
    std::iter::once(cmd.get_program())
        .chain(cmd.get_args())
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Current time as `YYYY-MM-DDTHH:MM:SSZ` without pulling in a date crate
/// (Howard Hinnant's civil-from-days algorithm).
fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}
