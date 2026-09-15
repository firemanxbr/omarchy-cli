//! `pkg-repo work`: a worker of the pool. It asks the pool for work with its
//! own registered token, receives a task and a credential good for that task
//! only, does the work — sync, render, promote (with evidence, gate, health
//! and rollback), health, gc — and reports. Nothing here needs GitHub: the
//! Cloudflare cron creates the jobs, any machine the project trusts pulls
//! them.
//!
//! The health and ABI checks are the same scripts the pipeline runs
//! (`tests/health-check.sh`, `tests/abi-gate.sh`), taken from a checkout of
//! the repository at this binary's version; they need podman (or docker),
//! python3 and curl on the host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::client::{Api, ReleaseRequest};
use crate::gate::{self, GateOptions, Verdict};
use crate::ops;
use crate::security::{self, FastTrackOptions, SecurityOptions};
use crate::sync::SyncOptions;

pub const REPO_URL: &str = "https://github.com/firemanxbr/omarchy-pool";
const HEARTBEAT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_secs(30);

/// The agent providers `factory/bin/agent.py` knows, in the order it picks
/// them when several keys are set: (name, key variable, default model).
const AGENTS: [(&str, &str, &str); 5] = [
    ("anthropic", "ANTHROPIC_API_KEY", "claude-sonnet-5"),
    ("claude-code", "CLAUDE_CODE_OAUTH_TOKEN", "claude-sonnet-5"),
    ("openai", "OPENAI_API_KEY", "gpt-5"),
    ("gemini", "GEMINI_API_KEY", "gemini-3.6-flash"),
    ("xai", "XAI_API_KEY", "grok-4"),
];

/// A `FACTORY_MODEL` that plainly belongs to another provider is ignored for
/// the default, as agent.py does (a switch of provider with the old model
/// left in the file): the label says what will actually run.
fn model_fits(provider: &str, model: &str) -> bool {
    let family = match provider {
        "anthropic" | "claude-code" => "claude",
        "gemini" => "gemini",
        "xai" => "grok",
        _ => return true,
    };
    model.to_ascii_lowercase().starts_with(family)
}

/// The agent this worker runs, as `<provider>/<model>` — what the claim
/// reports so the Factory page can show it; the key itself stays here.
/// None without a key. `FACTORY_PROVIDER` and `FACTORY_MODEL` override the
/// choice the way `agent.py` honours them.
pub fn agent_label() -> Option<String> {
    let set = |var: &str| std::env::var(var).is_ok_and(|k| !k.is_empty());
    let wanted = std::env::var("FACTORY_PROVIDER")
        .ok()
        .filter(|p| !p.is_empty());
    let (name, _, default_model) = AGENTS
        .iter()
        .find(|(name, key, _)| wanted.as_deref().is_none_or(|w| w == *name) && set(key))?;
    let model = std::env::var("FACTORY_MODEL")
        .ok()
        .filter(|m| !m.is_empty() && model_fits(name, m))
        .unwrap_or_else(|| (*default_model).to_owned());
    Some(format!("{name}/{model}"))
}

/// What a worker pulls when `--kind` is not given: every pool job and the
/// project builds, plus `audit` when this machine has an agent key — the
/// second agent (docs/GOVERNANCE.md) runs only where its owner put one.
pub fn default_kinds() -> Vec<String> {
    let mut kinds: Vec<String> = [
        "build", "sync", "render", "promote", "health", "security", "enqueue", "rollback", "gc",
        "verify", "relayout", "publish",
    ]
    .iter()
    .map(|k| (*k).to_owned())
    .collect();
    if agent_label().is_some() {
        kinds.push("audit".to_owned());
    }
    kinds
}

pub struct WorkOptions {
    pub api: String,
    pub pool: String,
    /// The worker's own token (`omw_…`); the registration names the worker.
    pub worker_token: String,
    pub arch: String,
    pub kinds: Vec<String>,
    /// A community worker that builds anyone's packages, not only its owner's.
    pub shared: bool,
    pub labels: serde_json::Value,
    pub once: bool,
    /// Exit after this many seconds without work (0 = never).
    pub idle_exit: u64,
    pub work_dir: PathBuf,
    /// Local key id that signs packages and databases against a pool
    /// without its own signing key (transition; ignored when the pool signs).
    pub sign: Option<String>,
    /// A checkout of the repository (its tests/ scripts); cloned when absent.
    pub repo_dir: Option<PathBuf>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Task {
    pub id: u64,
    pub kind: String,
    pub name: String,
    pub arch: String,
    pub trust: String,
    #[serde(default)]
    pub pkgbuild_ref: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub max_attempts: u32,
}

#[derive(Deserialize, Debug)]
struct Claimed {
    task: Task,
    token: String,
}

/// What a job reports back: a one-line summary and a JSON result.
pub struct Outcome {
    pub summary: String,
    pub result: serde_json::Value,
}

/// The agent's answer to the probe, as the claim reports it.
#[derive(Debug, Clone, Default)]
struct AgentProbe {
    status: String,
    error: String,
    checked_at: Option<std::time::Instant>,
    checked_iso: String,
}

/// Does the agent answer? `factory/bin/agent.py --probe` in the pool's
/// checkout: one tiny completion. A key set is not an agent that works — a
/// worker whose agent does not answer is not ready for an audit or a build
/// (docs/GOVERNANCE.md, *Workers*); the brain reads this with every claim.
fn probe_agent(opts: &WorkOptions) -> AgentProbe {
    let mut p = AgentProbe {
        checked_at: Some(std::time::Instant::now()),
        checked_iso: chrono_now(),
        ..AgentProbe::default()
    };
    let script = match repo_dir(opts) {
        Ok(dir) => dir.join("factory/bin/agent.py"),
        Err(e) => {
            "error".clone_into(&mut p.status);
            p.error = format!("no checkout to probe from: {e:#}");
            return p;
        }
    };
    let out = Command::new("timeout")
        .args(["120", "python3"])
        .arg(&script)
        .arg("--probe")
        .output();
    match out {
        Ok(o) if o.status.success() => {
            "ok".clone_into(&mut p.status);
            let ms = serde_json::from_slice::<serde_json::Value>(&o.stdout)
                .ok()
                .and_then(|v| v.get("ms").and_then(serde_json::Value::as_u64))
                .unwrap_or(0);
            eprintln!("agent: ok ({ms} ms)");
        }
        Ok(o) => {
            "error".clone_into(&mut p.status);
            p.error = serde_json::from_slice::<serde_json::Value>(&o.stdout)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str().map(str::to_owned)))
                .unwrap_or_else(|| {
                    String::from_utf8_lossy(&o.stderr)
                        .trim()
                        .chars()
                        .take(300)
                        .collect()
                });
            eprintln!("agent: NOT ready — {}", p.error);
        }
        Err(e) => {
            "error".clone_into(&mut p.status);
            p.error = format!("probe did not run: {e}");
            eprintln!("agent: NOT ready — {}", p.error);
        }
    }
    p
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // ISO 8601 without a date crate: civil-from-days (Howard Hinnant).
    let days = i64::try_from(secs / 86400).unwrap_or(0);
    let (hour, minute, second) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

const AGENT_PROBE_EVERY: Duration = Duration::from_secs(30 * 60);

/// # Panics
/// When the heartbeat thread's mutex is poisoned, which needs a panic in that thread first.
pub fn run(opts: &WorkOptions) -> Result<()> {
    std::fs::create_dir_all(&opts.work_dir)?;
    let claimer = Api::new(&opts.api, &opts.worker_token)?;
    let hostname = hostname();
    let version = pkg_manifest::BUILD_VERSION;
    let agent = agent_label();
    eprintln!(
        "worker ({}) ready — {} — asking {} for {}{}",
        opts.arch,
        version,
        opts.api,
        opts.kinds.join(", "),
        agent
            .as_deref()
            .map(|a| format!(" — agent {a}"))
            .unwrap_or_default()
    );
    // The keyrings the health check and the sync need, before the first job.
    if let Err(e) = keyrings(opts) {
        eprintln!("warning: keyrings not fetched yet ({e:#}); the first sync will retry");
    }
    // SIGTERM (what `docker stop` and a rolling upgrade send) drains: the
    // task in hand runs to its end and is reported, no new one is claimed,
    // then the process exits 0. Killing a worker mid-task only hands the
    // task to another worker thirty minutes later, when its lease expires.
    let draining = Arc::new(std::sync::atomic::AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, draining.clone()).context("signal handler")?;
    }
    let is_draining = || draining.load(std::sync::atomic::Ordering::Relaxed);
    let mut idle = 0u64;
    let mut done = 0u32;
    let mut probe = AgentProbe::default();
    loop {
        if is_draining() {
            eprintln!("draining: {done} task(s) done, none claimed since the stop signal; exiting");
            return Ok(());
        }
        if agent.is_some()
            && probe
                .checked_at
                .is_none_or(|t| t.elapsed() >= AGENT_PROBE_EVERY)
        {
            probe = probe_agent(opts);
        }
        let body = serde_json::json!({
            "arch": opts.arch, "hostname": hostname, "version": version, "labels": opts.labels, "kinds": opts.kinds, "shared": opts.shared,
            "agent": agent.clone().unwrap_or_default(),
            "agent_status": probe.status, "agent_error": probe.error, "agent_checked_at": probe.checked_iso,
        });
        let claimed = match claimer.post_json_as(&opts.worker_token, "/factory/claim", &body) {
            Ok(Some(v)) => serde_json::from_value::<Claimed>(v).context("claim response")?,
            Ok(None) => {
                idle += POLL.as_secs();
                if opts.idle_exit > 0 && idle >= opts.idle_exit {
                    eprintln!("no work for {idle}s; exiting");
                    return Ok(());
                }
                sleep_unless(POLL, &is_draining);
                continue;
            }
            Err(e) => {
                eprintln!("claim failed: {e}; retrying in 60 s");
                sleep_unless(Duration::from_secs(60), &is_draining);
                continue;
            }
        };
        idle = 0;
        let task = claimed.task;
        let label = task_label(&task);
        eprintln!(
            "task {}: {label} (attempt {}/{})",
            task.id, task.attempts, task.max_attempts
        );
        let token = Arc::new(Mutex::new(claimed.token));
        let stop = Arc::new(Mutex::new(false));
        let beat = heartbeat(opts.api.clone(), task.id, token.clone(), stop.clone());
        let started = Instant::now();
        let outcome = execute(opts, &task, &token);
        *stop.lock().unwrap() = true;
        let _ = beat.join();
        let took = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let job = Api::new(&opts.api, &token.lock().unwrap().clone())?;
        report(&job, &token.lock().unwrap().clone(), &task, outcome, took)?;
        done += 1;
        if opts.once {
            eprintln!("{done} task(s) done; exiting");
            return Ok(());
        }
    }
}

/// Tells the pool how the task ended: complete with the outcome, or fail
/// with the error (the pool requeues or gives up by the attempt count).
fn report(job: &Api, token: &str, task: &Task, outcome: Result<Outcome>, took: u64) -> Result<()> {
    match outcome {
        Ok(o) => {
            let field =
                |k: &str, default: serde_json::Value| o.result.get(k).cloned().unwrap_or(default);
            let dash = || serde_json::Value::String("-".into());
            job.post_json_as(
                token,
                &format!("/factory/tasks/{}/complete", task.id),
                &serde_json::json!({ "summary": o.summary, "result": o.result, "duration_ms": took,
                    "sha256": field("sha256", dash()), "filename": field("filename", dash()), "version": field("version", serde_json::Value::Null) }),
            )?;
            eprintln!("task {}: done — {} ({} s)", task.id, o.summary, took / 1000);
        }
        Err(e) => {
            let msg = format!("{e:#}");
            // A failed gate is the recipe's failure: the next fresh container
            // fails it the same way — final, as the community worker reports.
            let last = msg.contains("— the gate");
            let _ = job.post_json_as(
                token,
                &format!("/factory/tasks/{}/fail", task.id),
                &serde_json::json!({ "error": msg, "duration_ms": took, "log_tail": msg, "final": last }),
            );
            eprintln!("task {}: failed — {e:#}", task.id);
        }
    }
    Ok(())
}

/// Sleeps `d`, a second at a time, unless `stop` says so first.
fn sleep_unless(d: Duration, stop: &dyn Fn() -> bool) {
    let end = Instant::now() + d;
    while Instant::now() < end && !stop() {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn task_label(t: &Task) -> String {
    let p = &t.params;
    match t.kind.as_str() {
        "sync" => format!(
            "sync {}/{} → {}",
            s(p, "source"),
            s(p, "arch"),
            s(p, "ring")
        ),
        "promote" => format!("promote {} → {}", s(p, "from"), s(p, "to")),
        "security" => "security: advisories, matches, fast-track".to_owned(),
        "rollback" => format!("rollback {} → release {}", s(p, "ring"), s(p, "to")),
        "enqueue" => "enqueue: PKGBUILDs on main → the queue".to_owned(),
        "audit" => format!(
            "audit {} (staged task {})",
            s(p, "name"),
            p.get("task").map(ToString::to_string).unwrap_or_default()
        ),
        "verify" => "verify: do the served OPR objects verify?".to_owned(),
        "render" | "health" => format!("{} {}/{}", t.kind, s(p, "ring"), s(p, "arch")),
        _ => format!("{} {}", t.kind, t.name),
    }
}

fn s(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_owned()
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "worker".to_owned())
}

/// Keeps the lease — and the job token, which moves with it — while the work runs.
fn heartbeat(
    api: String,
    task: u64,
    token: Arc<Mutex<String>>,
    stop: Arc<Mutex<bool>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut waited = Duration::ZERO;
        loop {
            std::thread::sleep(Duration::from_secs(5));
            waited += Duration::from_secs(5);
            if *stop.lock().unwrap() {
                return;
            }
            if waited < HEARTBEAT {
                continue;
            }
            waited = Duration::ZERO;
            let current = token.lock().unwrap().clone();
            if let Ok(client) = Api::new(&api, &current) {
                if let Ok(Some(v)) = client.post_json_as(
                    &current,
                    &format!("/factory/tasks/{task}/heartbeat"),
                    &serde_json::json!({}),
                ) {
                    if let Some(t) = v.get("token").and_then(|t| t.as_str()) {
                        t.clone_into(&mut token.lock().unwrap());
                    }
                }
            }
        }
    })
}

fn execute(opts: &WorkOptions, task: &Task, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let job = Api::new(&opts.api, &token.lock().unwrap().clone())?;
    match task.kind.as_str() {
        "sync" => sync_job(opts, &job, task),
        "render" => {
            let ring = s(&task.params, "ring");
            let arch = s(&task.params, "arch");
            let r = ops::render(&job, &ring, &arch, opts.sign.as_deref())?;
            Ok(Outcome {
                summary: format!("{ring}/{arch} rendered: {}", r.join(", ")),
                result: serde_json::json!({ "repos": r }),
            })
        }
        "promote" => promote_job(opts, &job, task, token),
        "security" => security_job(opts, &job, token),
        "rollback" => rollback_job(opts, &job, task),
        "enqueue" => {
            let r = crate::reconcile::run(&job, &opts.work_dir, &opts.arch)?;
            Ok(Outcome {
                summary: format!(
                    "main@{}: {} queued, {} skipped, {} up to date{}",
                    &r.commit[..r.commit.len().min(7)],
                    r.queued.len(),
                    r.skipped.len(),
                    r.up_to_date,
                    if r.queued.is_empty() {
                        String::new()
                    } else {
                        format!(" — {}", r.queued.join("; "))
                    }
                ),
                result: serde_json::json!({ "commit": r.commit, "queued": r.queued, "skipped": r.skipped, "up_to_date": r.up_to_date }),
            })
        }
        "health" => {
            let ring = s(&task.params, "ring");
            let arch = s(&task.params, "arch");
            let ok = script(opts, token, "tests/health-check.sh", &[&ring, &arch])?;
            if ok {
                Ok(Outcome {
                    summary: format!("{ring}/{arch} healthy"),
                    result: serde_json::json!({ "ok": true }),
                })
            } else {
                Err(anyhow!(
                    "health check of {ring}/{arch} failed (see the health event)"
                ))
            }
        }
        "gc" => {
            let keep = u32::try_from(
                task.params
                    .get("keep")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(3),
            )
            .unwrap_or(3);
            ops::gc(&job, keep, true)?;
            Ok(Outcome {
                summary: format!("retention: kept the last {keep} releases per ring"),
                result: serde_json::json!({ "keep": keep }),
            })
        }
        "build" => build_job(opts, &job, task),
        "publish" => publish_job(opts, &job, task),
        "audit" => audit_job(opts, &job, task),
        "verify" => verify_job(opts, &job, task),
        "relayout" => relayout_job(opts, token),
        other => Err(anyhow!("this worker does not run '{other}' jobs")),
    }
}

/// Was the file written less than `max` ago?
fn fresh_within(stamp: &Path, max: Duration) -> bool {
    match stamp.metadata().and_then(|m| m.modified()) {
        Ok(t) => t.elapsed().is_ok_and(|e| e < max),
        Err(_) => false,
    }
}

/// The repository checkout the scripts live in, cloned at this binary's version when missing.
/// `$OMARCHY_PKG_CACHE/<arch>`, created, when the operator shares a pacman
/// package cache with the build containers (a path on the host: the
/// runtime mounts it, so it must be the same on both sides).
fn pkg_cache_dir(arch: &str) -> Result<Option<PathBuf>> {
    cache_dir("OMARCHY_PKG_CACHE", arch)
}

/// `$<var>/<arch>`, created, when the variable names a directory on the
/// host to share with the build containers.
fn cache_dir(var: &str, arch: &str) -> Result<Option<PathBuf>> {
    let Some(root) = std::env::var_os(var) else {
        return Ok(None);
    };
    if root.is_empty() {
        return Ok(None);
    }
    let dir = PathBuf::from(root).join(arch);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {var} {}", dir.display()))?;
    Ok(Some(dir))
}

fn repo_dir(opts: &WorkOptions) -> Result<PathBuf> {
    if let Some(d) = &opts.repo_dir {
        return Ok(d.clone());
    }
    let dir = opts.work_dir.join("repo");
    let stamp = dir.join(".fetched");
    let version = pkg_manifest::BUILD_VERSION;
    let git_ref = if version.starts_with('v') {
        version.to_owned()
    } else {
        "main".to_owned()
    };
    // The checkout is the release this binary came from: a fresh stamp from
    // another ref is another release's scripts. The review worker upgraded
    // to v0.0.116 kept the day-old checkout its predecessor cloned, ran the
    // old agent.py against the new environment, and nineteen audits died on
    // "FACTORY_PROVIDER must be one of …" (2026-09-15).
    let fresh = fresh_within(&stamp, Duration::from_secs(86400))
        && std::fs::read_to_string(&stamp).is_ok_and(|s| s.trim() == git_ref);
    if dir.join("tests").is_dir() && fresh {
        return Ok(dir);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let status = Command::new("git")
        .args([
            "clone", "-q", "--depth", "1", "--branch", &git_ref, REPO_URL,
        ])
        .arg(&dir)
        .status()
        .context("git clone")?;
    if !status.success() {
        // A dev build's version has no tag; main is what it was built from.
        let status = Command::new("git")
            .args(["clone", "-q", "--depth", "1", REPO_URL])
            .arg(&dir)
            .status()?;
        anyhow::ensure!(status.success(), "could not clone {REPO_URL}");
    }
    std::fs::write(&stamp, git_ref)?;
    Ok(dir)
}

/// The keyring files the sync verifies against, refreshed daily by the pipeline's own script.
fn keyrings(opts: &WorkOptions) -> Result<PathBuf> {
    keyrings_for(opts, &[])
}

/// The same, but a keyring the task names and the directory lacks brings the
/// refresh forward: a source added with its own key (asahi-alarm, the Asahi
/// fork on 2026-09-15) must not fail for a day because yesterday's stamp is
/// still fresh.
fn keyrings_for(opts: &WorkOptions, required: &[String]) -> Result<PathBuf> {
    let dir = opts.work_dir.join("keyrings");
    let stamp = dir.join(".fetched");
    let fresh = fresh_within(&stamp, Duration::from_secs(86400));
    let present = |name: &str| dir.join(format!("{name}.gpg")).exists();
    if fresh && present("archlinux") && required.iter().all(|k| present(k)) {
        return Ok(dir);
    }
    let repo = repo_dir(opts)?;
    std::fs::create_dir_all(&dir)?;
    let status = Command::new("bash")
        .arg(repo.join("tests/fetch-keyrings.sh"))
        .arg(&dir)
        .status()
        .context("fetch-keyrings.sh")?;
    anyhow::ensure!(status.success(), "fetching the upstream keyrings failed");
    std::fs::write(&stamp, "")?;
    Ok(dir)
}

/// One upstream source's sync options, from the task's parameters.
fn sync_options(
    opts: &WorkOptions,
    p: &serde_json::Value,
    keys: &Path,
    defer_release: bool,
) -> SyncOptions {
    let defer: Vec<String> = s(p, "defer_to")
        .split(',')
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
        .collect();
    SyncOptions {
        source: s(p, "source"),
        upstream: String::new(),
        base_url: Some(s(p, "base_url")),
        db_name: Some(s(p, "db_name")),
        arch: s(p, "arch"),
        ring: s(p, "ring"),
        limit: 0,
        concurrency: 8,
        work_dir: opts.work_dir.join("sync"),
        dry_run: false,
        keyring: Some(keys.join(format!("{}.gpg", s(p, "keyring")))),
        defer_to: defer,
        defer_release,
    }
}

/// Renders a ring's databases for `arch` and for the other architecture,
/// except the ones the pool says a release left exactly as its parent
/// (`unchanged`): those are already rendered at the live keys and the
/// release carries their artifact rows.
fn render_both(
    opts: &WorkOptions,
    job: &Api,
    ring: &str,
    arch: &str,
    unchanged: &[String],
) -> Result<Vec<String>> {
    let other = if arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    let mut rendered = Vec::new();
    for a in [arch, other] {
        if unchanged.iter().any(|u| u == a) {
            eprintln!("{ring}/{a}: unchanged since the parent release; databases kept");
            continue;
        }
        rendered.extend(ops::render(job, ring, a, opts.sign.as_deref())?);
    }
    Ok(rendered)
}

/// What one ring accumulates across the sources of a batched sync.
#[derive(Default)]
struct Pending {
    add: Vec<String>,
    /// `(source, name)`: each source drops from its own rows only.
    remove: Vec<(String, String)>,
    notes: Vec<String>,
}

/// The sync job. `params.sources` (a JSON list of source configurations,
/// all of one architecture) syncs them in turn and pins the result as
/// **one release per ring** — a release copies the ring's whole selection
/// and D1 bills every row written, so eleven sources an hour must not
/// mean eleven releases. A task with a single source (`params.source`,
/// the old form, and `pkg-repo job sync --param source=…`) pins its own.
/// Uploads a build's evidence files to the task's staging space, the ones
/// that exist: `at_dir` from the task directory, `at_out` from its `out/`.
fn stage_evidence(job: &Api, task: u64, dir: &Path, at_dir: &[&str], at_out: &[&str]) {
    let files = at_dir.iter().map(|f| (dir.join(f), (*f).to_owned())).chain(
        at_out
            .iter()
            .map(|f| (dir.join("out").join(f), (*f).to_owned())),
    );
    for (path, name) in files {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Err(e) =
                job.put_bytes(&format!("/factory/tasks/{task}/artifacts/{name}"), &bytes)
            {
                eprintln!("task {task}: {name} not staged: {e}");
            }
        }
    }
}

/// The publish job: the project's approved build, from its staging space
/// into the pool — the packages the approval listed, downloaded with this
/// job's token (a package in staging is for maintainers and for this job),
/// published into edge as source `factory` (the pool signs), edge rendered
/// for both architectures. What users get.
fn publish_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let built = task
        .params
        .get("task")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| anyhow!("publish: params.task names the project's build"))?;
    let files: Vec<String> = task
        .params
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    anyhow::ensure!(
        !files.is_empty(),
        "publish: params.files lists the staged packages"
    );
    let dir = opts.work_dir.join(format!("publish-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let mut pkgs = Vec::new();
    for f in &files {
        anyhow::ensure!(
            f.ends_with(".pkg.tar.zst") && !f.contains('/'),
            "publish: {f} is not a package file name"
        );
        let dest = dir.join(f);
        job.download_as_self(
            &format!("{}/api/v1/factory/tasks/{built}/artifacts/{f}", job.base()),
            &dest,
        )
        .with_context(|| format!("fetching {f} of the project's build {built}"))?;
        pkgs.push(dest);
    }
    pkgs.sort();
    ops::publish(
        job,
        "edge",
        "factory",
        &task.arch,
        Some(&format!(
            "factory task {built}: {} approved ({})",
            task.name,
            s(&task.params, "by")
        )),
        &pkgs,
    )?;
    let mut rendered = ops::render(job, "edge", &task.arch, opts.sign.as_deref())?;
    let other = if task.arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    rendered.extend(ops::render(job, "edge", other, opts.sign.as_deref())?);
    let main = pkgs
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
        })
        .unwrap_or(&pkgs[0]);
    let manifest = pkg_extract::extract_manifest(main)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(Outcome {
        summary: format!(
            "{} {} — the project's build {built}, approved — published into edge for {} ({})",
            manifest.name,
            manifest.version,
            task.arch,
            rendered.join(", ")
        ),
        result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "rendered": rendered, "task": built }),
    })
}

/// The keyrings a sync task names: one per source of the batch, or the single source's.
fn task_keyrings(task: &Task, batch: &[serde_json::Value]) -> Vec<String> {
    let names = if batch.is_empty() {
        vec![s(&task.params, "keyring")]
    } else {
        batch.iter().map(|p| s(p, "keyring")).collect()
    };
    names.into_iter().filter(|k| !k.is_empty()).collect()
}

fn sync_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let batch: Vec<serde_json::Value> = task
        .params
        .get("sources")
        .and_then(serde_json::Value::as_str)
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    let keys = keyrings_for(opts, &task_keyrings(task, &batch))?;
    if batch.is_empty() {
        let o = sync_options(opts, &task.params, &keys, false);
        let report = ops::run_sync_report(job, &o)?;
        let rendered = if report.release.is_some() {
            render_both(opts, job, &o.ring, &o.arch, &report.unchanged_arches)?
        } else {
            Vec::new()
        };
        return Ok(Outcome {
            summary: format!(
                "{}/{} → {}: upstream {}, uploaded {}, removed {}, failed {}{}",
                o.source,
                o.arch,
                o.ring,
                report.upstream_total,
                report.uploaded,
                report.removed,
                report.failed.len(),
                if rendered.is_empty() {
                    String::new()
                } else {
                    format!("; rendered {}", rendered.join(", "))
                }
            ),
            result: serde_json::json!({ "upstream_total": report.upstream_total, "uploaded": report.uploaded, "already_indexed": report.already_indexed, "removed": report.removed, "deferred": report.deferred, "failed": report.failed.len(), "release": report.release, "rendered": rendered }),
        });
    }

    // Per ring: what to pin, what to drop, and the note's pieces.
    let mut pending: BTreeMap<String, Pending> = BTreeMap::new();
    let mut lines = Vec::new();
    let mut per_source = Vec::new();
    let mut arch = String::new();
    for p in &batch {
        let o = sync_options(opts, p, &keys, true);
        arch.clone_from(&o.arch);
        let report = match ops::run_sync_report(job, &o) {
            Ok(r) => r,
            Err(e) => {
                // One source failing (a mirror down) must not stop the others;
                // its own sync event says what happened.
                lines.push(format!("{}: failed ({e:#})", o.source));
                per_source.push(serde_json::json!({ "source": o.source, "ring": o.ring, "error": format!("{e:#}") }));
                continue;
            }
        };
        lines.push(format!(
            "{}: +{} -{} of {}",
            o.source, report.uploaded, report.removed, report.upstream_total
        ));
        per_source.push(serde_json::json!({ "source": o.source, "ring": o.ring, "upstream_total": report.upstream_total, "uploaded": report.uploaded, "removed": report.removed, "failed": report.failed.len() }));
        if !report.pending_add.is_empty() || !report.pending_remove.is_empty() {
            let e = pending.entry(o.ring.clone()).or_default();
            e.add.extend(report.pending_add);
            e.remove.extend(report.pending_remove);
            e.notes.push(format!(
                "{} +{} -{}",
                o.source, report.uploaded, report.removed
            ));
        }
    }
    let mut releases = Vec::new();
    let mut rendered = Vec::new();
    for (ring, p) in &pending {
        let note = format!("sync {arch}: {}", p.notes.join(", "));
        let created = job.create_release(&ReleaseRequest {
            ring,
            add: &p.add,
            remove_from: &p.remove,
            remove_arch: Some(&arch),
            note: Some(&note),
            ..ReleaseRequest::default()
        })?;
        releases.push(serde_json::json!({ "ring": ring, "id": created.release.id, "seq": created.release.seq, "packages": created.package_count, "unchanged": created.unchanged_arches }));
        rendered.extend(render_both(
            opts,
            job,
            ring,
            &arch,
            &created.unchanged_arches,
        )?);
    }
    Ok(Outcome {
        summary: format!(
            "{arch}: {}; {} release(s){}",
            lines.join(", "),
            releases.len(),
            if rendered.is_empty() {
                String::new()
            } else {
                format!("; rendered {}", rendered.join(", "))
            }
        ),
        result: serde_json::json!({ "arch": arch, "sources": per_source, "releases": releases, "rendered": rendered }),
    })
}

/// Runs one of the pipeline's scripts with the job's credential; true when it exited 0.
fn script(
    opts: &WorkOptions,
    token: &Arc<Mutex<String>>,
    rel: &str,
    args: &[&str],
) -> Result<bool> {
    let repo = repo_dir(opts)?;
    let exe = std::env::current_exe()?;
    let bin = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    // The scripts start containers that mount their scratch directory
    // (`mktemp -d`): under the work directory, which is the same path on
    // the host when this worker is itself a container (docs: /docs/workers),
    // rather than a /tmp the runtime on the host cannot see.
    let tmp = opts.work_dir.join("tmp");
    std::fs::create_dir_all(&tmp)?;
    let status = Command::new("bash")
        .arg(repo.join(rel))
        .args(args)
        .env("OMARCHY_API", &opts.api)
        .env("OMARCHY_POOL", &opts.pool)
        .env("OMARCHY_TOKEN", token.lock().unwrap().clone())
        .env("PKG_REPO", &exe)
        .env("OMARCHY_KEYRINGS", opts.work_dir.join("keyrings"))
        .env("OMARCHY_WORK_DIR", &opts.work_dir)
        .env("OMARCHY_CLI", bin.join("omarchy-cli"))
        .env("PKG_EXTRACT", bin.join("pkg-extract"))
        .env("TMPDIR", &tmp)
        .current_dir(&repo)
        .status()
        .with_context(|| format!("running {rel}"))?;
    Ok(status.success())
}

/// A rollback: the ring pointed at an earlier release — all of it, or one
/// architecture — then rendered where it changed.
fn rollback_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let ring = s(&task.params, "ring");
    let to = task
        .params
        .get("to")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
        })
        .ok_or_else(|| anyhow!("rollback needs `to`, a release id"))?;
    let note = s(&task.params, "note");
    let only = s(&task.params, "arch");
    let created = ops::rollback(
        job,
        &ring,
        to,
        if note.is_empty() { None } else { Some(&note) },
        if only.is_empty() { None } else { Some(&only) },
    )?;
    // One architecture rolled back: the other's databases are as they were.
    let keep: Vec<String> = if only.is_empty() {
        Vec::new()
    } else {
        ["x86_64", "aarch64"]
            .iter()
            .filter(|a| **a != only)
            .map(|a| (*a).to_owned())
            .collect()
    };
    let rendered = render_both(opts, job, &ring, &opts.arch, &keep)?;
    Ok(Outcome {
        summary: format!(
            "{ring} rolled back to release {to} as release {created}; rendered {}",
            rendered.join(", ")
        ),
        result: serde_json::json!({ "ring": ring, "to": to, "release_id": created, "rendered": rendered }),
    })
}

/// Does what the pool serves verify? Every OPR object of every ring and
/// architecture, downloaded and checked against Omarchy's keyring; what is
/// wrong is repaired (`verify.rs`) and the rings re-pinned are rendered.
/// The one-time move of every object into its source's directory
/// (`<source>/<arch>/<filename>`, routes/relayout.ts): copy until nothing
/// remains, render every ring so its databases sit in the same directories
/// (the include then names them), and purge the flat directories last. The
/// pool does the copying; this loops, a page at a time, and renders. Hours
/// of pages: every call takes the token the heartbeat last renewed — a
/// per-job token lives thirty minutes, and the first run died on a 401
/// with the token it started with (task 275, 2026-09-15).
fn relayout_job(opts: &WorkOptions, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let started = Instant::now();
    let fresh = || Api::new(&opts.api, &token.lock().unwrap().clone());
    let (mut moved, mut ghosts, mut missing) = (0u64, 0u64, 0u64);
    let mut errors: Vec<String> = Vec::new();
    loop {
        let r = fresh()?.relayout("copy", 40)?;
        let step = r["moved"].as_u64().unwrap_or(0) + r["ghosts"].as_u64().unwrap_or(0);
        moved += r["moved"].as_u64().unwrap_or(0);
        ghosts += r["ghosts"].as_u64().unwrap_or(0);
        missing += r["missing"].as_u64().unwrap_or(0);
        if let Some(e) = r["errors"].as_array() {
            errors.extend(e.iter().filter_map(|v| v.as_str().map(str::to_owned)));
        }
        let remaining = r["remaining"].as_u64().unwrap_or(0);
        tracing::info!(moved, ghosts, missing, remaining, "relayout: copying");
        if remaining == 0 {
            break;
        }
        if step == 0 {
            // Nothing moved in a whole page: what is left cannot be copied
            // (an object missing from the pool, a storage error) — the
            // flat directory stays, the include keeps naming it, and the
            // rows say which.
            return Err(anyhow!(
                "relayout stalled with {remaining} object(s) left: {missing} missing, {} error(s){}",
                errors.len(),
                errors.first().map(|e| format!(" — {e}")).unwrap_or_default()
            ));
        }
    }
    let mut rendered = Vec::new();
    for ring in ["edge", "rc", "stable"] {
        for arch in ["x86_64", "aarch64"] {
            let repos = ops::render(&fresh()?, ring, arch, opts.sign.as_deref())
                .with_context(|| format!("rendering {ring}/{arch} after the move"))?;
            rendered.extend(repos.into_iter().map(|r| format!("{ring}/{arch}/{r}")));
        }
    }
    let mut deleted = 0u64;
    loop {
        let r = fresh()?.relayout("purge", 40)?;
        deleted += r["deleted"].as_u64().unwrap_or(0);
        if !r["truncated"].as_bool().unwrap_or(false) {
            break;
        }
    }
    let summary = format!(
        "relayout: {moved} object(s) moved into their source's directory, {ghosts} ghost row(s) marked, {} database(s) rendered, {deleted} old key(s) purged",
        rendered.len()
    );
    fresh()?.post_event(&serde_json::json!({
        "kind": "relayout", "status": if errors.is_empty() && missing == 0 { "ok" } else { "warn" },
        "summary": summary,
        "duration_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "payload": { "moved": moved, "ghosts": ghosts, "missing": missing, "errors": errors, "rendered": rendered, "purged": deleted },
    }))?;
    Ok(Outcome {
        summary,
        result: serde_json::json!({ "moved": moved, "ghosts": ghosts, "missing": missing, "errors": errors, "rendered": rendered, "purged": deleted }),
    })
}

fn verify_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let keys = keyrings(opts)?;
    let ring = s(&task.params, "ring");
    let arch = s(&task.params, "arch");
    let report = crate::verify::run(
        job,
        &crate::verify::VerifyOptions {
            pool: opts.pool.clone(),
            rings: if ring.is_empty() {
                vec!["edge".into(), "rc".into(), "stable".into()]
            } else {
                vec![ring]
            },
            arches: if arch.is_empty() {
                vec!["x86_64".into(), "aarch64".into()]
            } else {
                vec![arch]
            },
            keyring: keys.join("omarchy.gpg"),
            work_dir: opts.work_dir.clone(),
            repair: s(&task.params, "repair") != "no",
        },
    )?;
    let mut rendered = Vec::new();
    for (ring, arch) in &report.repinned_rings {
        rendered.extend(ops::render(job, ring, arch, opts.sign.as_deref())?);
    }
    for d in &report.details {
        eprintln!("  {d}");
    }
    job.post_event(&serde_json::json!({
        "kind": "verify", "status": if report.clean() { "ok" } else if report.unfixable > 0 { "error" } else { "warn" },
        "summary": report.summary(),
        "payload": { "objects": report.objects, "bad_signatures": report.bad_signatures, "repaired_signatures": report.repaired_signatures,
                     "mismatched": report.mismatched, "repinned": report.repinned, "unfixable": report.unfixable, "rendered": rendered,
                     "details": report.details.iter().take(60).collect::<Vec<_>>() },
    }))?;
    Ok(Outcome {
        summary: format!(
            "{}{}",
            report.summary(),
            if rendered.is_empty() {
                String::new()
            } else {
                format!("; rendered {}", rendered.join(", "))
            }
        ),
        result: serde_json::to_value(&report)?,
    })
}

/// A project build: the PKGBUILD (from the repository, a contributor's
/// repository, a draft, or a staged build a maintainer approved) built in a
/// fresh Arch container by the pipeline's own script, then signed,
/// published into edge as source `factory` and rendered — by this worker,
/// with the job's credential. Community builds stay with the container
/// image (`omarchy-build-worker --container`); this executor takes only
/// tasks a project-trusted worker may claim.
#[allow(clippy::too_many_lines)]
fn build_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    anyhow::ensure!(
        task.trust == "project",
        "community builds run in the Omarchy Packaging image, not here"
    );
    let repo = repo_dir(opts)?;
    let dir = opts.work_dir.join(format!("task-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("out"))?;
    let pkgbuild_ref = task.pkgbuild_ref.clone();
    // Inside the container "localhost" is the container: a local pool (wrangler
    // dev) is reached through the runtime's host alias.
    let from_container = |u: &str| {
        u.replace("://localhost", "://host.containers.internal")
            .replace("://127.0.0.1", "://host.containers.internal")
    };
    // The project's review build (review:<task>, params.review): the
    // request's facts ride along for the drafter, and the result is staged
    // for a maintainer instead of published.
    let review = task
        .params
        .get("review")
        .and_then(serde_json::Value::as_i64);
    let mut meta = format!(
        "name={}\nref={}\narch={}\npool={}\nexport OMARCHY_API={}\n",
        shell_quote(&task.name),
        shell_quote(&pkgbuild_ref),
        shell_quote(&task.arch),
        shell_quote(&from_container(&opts.pool)),
        shell_quote(&from_container(&opts.api))
    );
    if review.is_some() {
        for (var, key) in [
            ("review_url", "project"),
            ("review_source", "source"),
            ("review_version", "version"),
            ("review_desc", "description"),
            ("review_license", "license"),
        ] {
            let v = s(&task.params, key);
            if !v.is_empty() {
                use std::fmt::Write as _;
                let _ = writeln!(meta, "{var}={}", shell_quote(&v));
            }
        }
    }
    std::fs::write(dir.join("meta.sh"), meta)?;
    std::fs::copy(
        repo.join("factory/worker/omarchy-build-worker.sh"),
        dir.join("worker.sh"),
    )?;
    let runtime = ["podman", "docker"]
        .iter()
        .find(|r| Command::new(r).arg("--version").output().is_ok())
        .ok_or_else(|| anyhow!("podman or docker is required"))?;
    let (image, platform) = if task.arch == "aarch64" {
        ("docker.io/menci/archlinuxarm:base-devel", "linux/arm64")
    } else {
        ("docker.io/library/archlinux:base-devel", "linux/amd64")
    };
    let log = std::fs::File::create(dir.join("build.log"))?;
    let mut run = Command::new(runtime);
    run.args([
        "run",
        "--rm",
        "--platform",
        platform,
        "--name",
        &format!("omarchy-build-{}", task.id),
        "-v",
    ])
    .arg(format!("{}:/task", dir.display()));
    // What the operator hands every build container: the agent's address
    // (OMARCHY_BUILD_ENV, comma-separated KEY=VALUE — the agent-proxy on the
    // Studio, where Claude Code cannot run under qemu) and the network it
    // is on (OMARCHY_BUILD_NETWORK). A review build needs an agent inside.
    if let Ok(envs) = std::env::var("OMARCHY_BUILD_ENV") {
        for kv in envs.split(',').map(str::trim).filter(|kv| kv.contains('=')) {
            run.arg("-e").arg(kv);
        }
    }
    if let Ok(net) = std::env::var("OMARCHY_BUILD_NETWORK") {
        if !net.is_empty() {
            run.arg("--network").arg(net);
        }
    }
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.is_empty() {
            run.arg("-e").arg("GITHUB_TOKEN");
        }
    }
    // A package cache shared by every build container on this host
    // (OMARCHY_PKG_CACHE, one directory per architecture): pacman downloads
    // a dependency once, not once per build.
    if let Some(cache) = pkg_cache_dir(&task.arch)? {
        run.arg("-v")
            .arg(format!("{}:/var/cache/pacman/pkg", cache.display()));
    }
    // Build caches that outlive the container (OMARCHY_BUILD_CACHE, one
    // directory per architecture): cargo's registry, Go's module and build
    // caches, ccache — a Rust or Go package rebuilds in minutes, not tens.
    if let Some(cache) = cache_dir("OMARCHY_BUILD_CACHE", &task.arch)? {
        run.arg("-v")
            .arg(format!("{}:/build/cache", cache.display()));
    }
    let status = run
        .args([image, "bash", "/task/worker.sh", "--inside"])
        .stdout(log.try_clone()?)
        .stderr(log)
        .status()
        .context("running the build container")?;
    let log_text = std::fs::read_to_string(dir.join("build.log")).unwrap_or_default();
    if !status.success() {
        let tail: String = log_text
            .lines()
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        if review.is_some() {
            // What there is goes on the record: the log, the gate's verdict, the recipe that failed.
            stage_evidence(
                job,
                task.id,
                &dir,
                &["build.log"],
                &["PKGBUILD", "vet.json", "tests.log"],
            );
        }
        let gate = status.code() == Some(5);
        return Err(anyhow!(
            "build failed (exit {:?}){}:\n{tail}",
            status.code(),
            if gate { " — the gate" } else { "" }
        ));
    }
    let mut pkgs: Vec<PathBuf> = std::fs::read_dir(dir.join("out"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".pkg.tar.zst"))
        .collect();
    pkgs.sort();
    anyhow::ensure!(!pkgs.is_empty(), "makepkg produced no package");
    if let Some(from) = review {
        // The project's review build: everything to staging for a
        // maintainer — the packages, the recipe, the log, the manifest, the
        // gate — nothing to the pool until the approval's publish job.
        let main = pkgs
            .iter()
            .find(|p| {
                p.file_name()
                    .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
            })
            .unwrap_or(&pkgs[0]);
        let manifest = pkg_extract::extract_manifest(main)?;
        let pkginfo = Command::new("tar")
            .arg("-xOf")
            .arg(main)
            .arg(".PKGINFO")
            .output()
            .map(|o| o.stdout)
            .unwrap_or_default();
        for p in &pkgs {
            let name = p
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            job.put_bytes(
                &format!("/factory/tasks/{}/artifacts/{name}", task.id),
                &std::fs::read(p)?,
            )
            .with_context(|| format!("staging {name}"))?;
        }
        if !pkginfo.is_empty() {
            job.put_bytes(
                &format!("/factory/tasks/{}/artifacts/PKGINFO", task.id),
                &pkginfo,
            )
            .context("staging PKGINFO")?;
        }
        stage_evidence(
            job,
            task.id,
            &dir,
            &["build.log"],
            &["PKGBUILD", "vet.json", "tests.log"],
        );
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(Outcome {
            summary: format!(
                "{} {} built by the project for {} from staged task {from} — staged for a maintainer's approval",
                manifest.name, manifest.version, task.arch
            ),
            result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "review": from }),
        });
    }
    // The pool signs what it stores (SECURITY.md); a local key only covers
    // a pool that has none.
    if let Some(key) = &opts.sign {
        if !job.signing()? {
            for p in &pkgs {
                crate::sign::detach_sign(p, key)?;
            }
        }
    }
    ops::publish(
        job,
        "edge",
        "factory",
        &task.arch,
        Some(&format!(
            "factory task {}: {} ({})",
            task.id, task.name, pkgbuild_ref
        )),
        &pkgs,
    )?;
    // A release covers both architectures: render both so the head is
    // complete (the other architecture's databases do not change content).
    let mut rendered = ops::render(job, "edge", &task.arch, opts.sign.as_deref())?;
    let other = if task.arch == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    rendered.extend(ops::render(job, "edge", other, opts.sign.as_deref())?);
    let main = pkgs
        .iter()
        .find(|p| {
            p.file_name()
                .is_some_and(|f| f.to_string_lossy().starts_with(&format!("{}-", task.name)))
        })
        .unwrap_or(&pkgs[0]);
    let manifest = pkg_extract::extract_manifest(main)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(Outcome {
        summary: format!(
            "{} {} built for {} and published into edge ({})",
            manifest.name,
            manifest.version,
            task.arch,
            rendered.join(", ")
        ),
        result: serde_json::json!({ "sha256": manifest.sha256, "filename": manifest.filename, "version": manifest.version, "rendered": rendered }),
    })
}

/// The second agent: reads the evidence a contributor staged (PKGBUILD,
/// build log, .PKGINFO — the public part of the staging workspace), asks
/// the model for a structured review with `factory/bin/audit-pkgbuild`
/// (the owner's agent key, from this process's environment; any provider
/// `factory/bin/agent.py` knows) and
/// attaches `audit.json` and `audit.md` to the same evidence with the job's
/// credential. The maintainer reads it; nothing here decides anything.
fn audit_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    anyhow::ensure!(
        agent_label().is_some(),
        "no agent key on this worker (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY); start it without the audit kind"
    );
    let staged = task
        .params
        .get("task")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|x| x.parse().ok()))
        })
        .ok_or_else(|| anyhow!("audit needs `task`, the staged build's id"))?;
    let repo = repo_dir(opts)?;
    let dir = opts.work_dir.join(format!("audit-{}", task.id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let evidence = format!("{}/api/v1/factory/tasks/{staged}/artifacts", job.base());
    for name in ["PKGBUILD", "build.log"] {
        job.download(&format!("{evidence}/{name}"), &dir.join(name))
            .with_context(|| format!("fetching {name} of staged task {staged}"))?;
    }
    let pkginfo = dir.join("PKGINFO");
    let has_pkginfo = job
        .download(&format!("{evidence}/PKGINFO"), &pkginfo)
        .is_ok();
    // The gate's transcript, when the build ran one (workers before the gate did not).
    let tests = dir.join("tests.log");
    let has_tests = job
        .download(&format!("{evidence}/tests.log"), &tests)
        .is_ok();
    let mut cmd = Command::new("python3");
    cmd.arg(repo.join("factory/bin/audit-pkgbuild"))
        .arg("--pkgbuild")
        .arg(dir.join("PKGBUILD"))
        .arg("--log")
        .arg(dir.join("build.log"))
        .arg("--out")
        .arg(&dir);
    if has_pkginfo {
        cmd.arg("--pkginfo").arg(&pkginfo);
    }
    if has_tests {
        cmd.arg("--tests").arg(&tests);
    }
    let out = cmd.output().context("running audit-pkgbuild")?;
    if !out.status.success() {
        return Err(anyhow!(
            "the audit produced no report (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let report: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("audit.json"))?).context("audit.json")?;
    for name in ["audit.json", "audit.md"] {
        job.put_bytes(
            &format!("/factory/tasks/{staged}/artifacts/{name}"),
            &std::fs::read(dir.join(name))?,
        )
        .with_context(|| format!("attaching {name} to staged task {staged}"))?;
    }
    let _ = std::fs::remove_dir_all(&dir);
    let verdict = s(&report, "verdict");
    let findings = report
        .get("findings")
        .and_then(|f| f.as_array())
        .map_or(0, Vec::len);
    Ok(Outcome {
        summary: format!(
            "{verdict}: {} ({findings} finding(s), {})",
            s(&report, "summary"),
            s(&report, "model")
        ),
        result: report,
    })
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The daily promotion, as the pipeline does it: evidence on both
/// architectures, the gate, the promotion, the OPR channel aligned, both
/// databases rendered, health of the new head — and a rollback when health
/// fails.
#[allow(clippy::too_many_lines)]
fn promote_job(
    opts: &WorkOptions,
    job: &Api,
    task: &Task,
    token: &Arc<Mutex<String>>,
) -> Result<Outcome> {
    let from = s(&task.params, "from");
    let to = s(&task.params, "to");
    let note = s(&task.params, "note");
    let soak_days = u32::try_from(
        task.params
            .get("soak_days")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1),
    )
    .unwrap_or(1);
    // One architecture only (`arch`): its evidence, its gate, its rows, its
    // databases, its health — the other keeps what `to` serves today.
    let only = s(&task.params, "arch");
    let arches: Vec<String> = if only.is_empty() {
        vec!["x86_64".to_owned(), "aarch64".to_owned()]
    } else {
        vec![only.clone()]
    };
    let only_arch = if only.is_empty() {
        None
    } else {
        Some(only.as_str())
    };
    // `force` (a maintainer's emergency, queued by hand) skips the evidence
    // and the gate; the health check of the target still runs and still
    // rolls back.
    let forced = s(&task.params, "force") == "yes";
    if !forced {
        // Evidence: health and ABI of the source ring, both architectures. The
        // scripts record events; the gate reads them. Failures are evidence too.
        for arch in &arches {
            let _ = script(opts, token, "tests/health-check.sh", &[&from, arch]);
            let _ = script(opts, token, "tests/abi-gate.sh", &[&from, arch]);
        }
    }
    let report = if forced {
        gate::GateReport {
            verdict: Verdict::Promote,
            evidence: Vec::new(),
        }
    } else {
        gate::run(
            job,
            &GateOptions {
                from: &from,
                to: &to,
                arches: &arches,
                soak_days,
                max_age_hours: 24,
                dry_run: false,
            },
        )?
    };
    match report.verdict {
        Verdict::Skip(why) => {
            return Ok(Outcome {
                summary: format!("{from} → {to}: nothing to promote ({why})"),
                result: serde_json::json!({ "verdict": "skip", "why": why }),
            })
        }
        Verdict::Block(reasons) => {
            return Ok(Outcome {
                summary: format!("{from} → {to}: blocked — {}", reasons.join("; ")),
                result: serde_json::json!({ "verdict": "blocked", "reasons": reasons }),
            })
        }
        Verdict::Promote => {}
    }
    let previous = ops::head(job, &to)?;
    let created = ops::promote(job, &from, &to, Some(&note), only_arch)?;
    // The OPR channel that matches the ring (aarch64 has only edge upstream).
    let keys = keyrings(opts)?;
    for arch in &arches {
        let channel = if *arch == "aarch64" {
            "edge"
        } else {
            to.as_str()
        };
        let o = SyncOptions {
            source: "packages".into(),
            upstream: String::new(),
            base_url: Some(format!("https://pkgs.omarchy.org/{channel}/{arch}")),
            db_name: Some("omarchy".into()),
            arch: arch.clone(),
            ring: to.clone(),
            limit: 0,
            concurrency: 8,
            work_dir: opts.work_dir.join("sync"),
            dry_run: false,
            keyring: Some(keys.join("omarchy.gpg")),
            defer_to: vec![],
            defer_release: false,
        };
        if let Err(e) = ops::run_sync_report(job, &o) {
            eprintln!("warning: aligning the OPR channel for {arch}: {e:#}");
        }
    }
    let mut rendered = Vec::new();
    for arch in &arches {
        rendered.extend(ops::render(job, &to, arch, opts.sign.as_deref())?);
    }
    let mut unhealthy = Vec::new();
    for arch in &arches {
        if !script(opts, token, "tests/health-check.sh", &[&to, arch])? {
            unhealthy.push(arch.clone());
        }
    }
    if unhealthy.is_empty() {
        job.post_event(&serde_json::json!({ "kind": "promote", "ring": to, "source": from, "status": "ok",
            "summary": format!("{to} serves release {} (from {from}); health ok on {}", created, arches.join(" and ")),
            "payload": { "release_id": created, "note": note } }))?;
        return Ok(Outcome {
            summary: format!("{from} → {to}: release {created}, healthy on both architectures"),
            result: serde_json::json!({ "verdict": "promoted", "release_id": created, "rendered": rendered }),
        });
    }
    match previous {
        Some(prev) => {
            ops::rollback(
                job,
                &to,
                prev,
                Some(&format!(
                    "automatic rollback: health failed after promotion from {from} ({})",
                    unhealthy.join(", ")
                )),
                only_arch,
            )?;
            for arch in &arches {
                ops::render(job, &to, arch, opts.sign.as_deref())?;
            }
            job.post_event(&serde_json::json!({ "kind": "rollback", "ring": to, "source": from, "status": "error",
                "summary": format!("{to} rolled back to release {prev}: health failed on {} after promotion from {from}", unhealthy.join(", ")),
                "payload": { "release_id": created, "rolled_back_to": prev, "unhealthy": unhealthy } }))?;
            Ok(Outcome {
                summary: format!(
                    "{from} → {to}: rolled back to {prev} (health failed on {})",
                    unhealthy.join(", ")
                ),
                result: serde_json::json!({ "verdict": "rolled-back", "release_id": created, "to": prev, "unhealthy": unhealthy }),
            })
        }
        None => Err(anyhow!(
            "health failed on {} after promotion and {to} had no previous release to roll back to",
            unhealthy.join(", ")
        )),
    }
}

/// The public vulnerability feeds the security layer reads (SECURITY.md).
const FEEDS: [(&str, &str); 4] = [
    (
        "arch.json",
        "https://security.archlinux.org/issues/all.json",
    ),
    (
        "debian.json",
        "https://security-tracker.debian.org/tracker/data/json",
    ),
    (
        "kev.json",
        "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    ),
    (
        "epss.csv.gz",
        "https://epss.cyentia.com/epss_scores-current.csv.gz",
    ),
];

/// Fetches the feeds into the work dir; returns the security options that read them.
fn fetch_feeds(opts: &WorkOptions, job: &Api) -> Result<SecurityOptions> {
    let feeds = opts.work_dir.join("feeds");
    std::fs::create_dir_all(&feeds)?;
    for (name, url) in FEEDS {
        job.download(url, &feeds.join(name))
            .with_context(|| format!("fetching {url}"))?;
    }
    let epss = feeds.join("epss.csv");
    let gz = std::fs::File::open(feeds.join("epss.csv.gz"))?;
    let mut out = std::fs::File::create(&epss)?;
    std::io::copy(&mut flate2::read::GzDecoder::new(gz), &mut out)?;
    Ok(SecurityOptions {
        arch_tracker: feeds.join("arch.json"),
        debian: Some(feeds.join("debian.json")),
        kev: Some(feeds.join("kev.json")),
        epss: Some(epss),
        osv_cache: Some(opts.work_dir.join("osv")),
        rings: vec!["edge".into(), "rc".into(), "stable".into()],
        dry_run: false,
    })
}

/// Renders a fast-tracked ring and verifies it on both architectures;
/// rolls it back to `previous` when health fails. Returns whether it was rolled back.
fn verify_fast_track(
    opts: &WorkOptions,
    job: &Api,
    token: &Arc<Mutex<String>>,
    ring: &str,
    previous: Option<u64>,
) -> Result<bool> {
    let arches = ["x86_64", "aarch64"];
    for arch in arches {
        ops::render(job, ring, arch, opts.sign.as_deref())?;
    }
    let mut unhealthy = Vec::new();
    for arch in arches {
        if !script(opts, token, "tests/health-check.sh", &[ring, arch])? {
            unhealthy.push(arch);
        }
    }
    if unhealthy.is_empty() {
        return Ok(false);
    }
    let Some(prev) = previous else {
        return Err(anyhow!(
            "health failed on {} after a fast-track into {ring}, which had no previous release to roll back to",
            unhealthy.join(", ")
        ));
    };
    ops::rollback(
        job,
        ring,
        prev,
        Some(&format!(
            "automatic rollback: health failed after a security fast-track ({})",
            unhealthy.join(", ")
        )),
        None,
    )?;
    for arch in arches {
        ops::render(job, ring, arch, opts.sign.as_deref())?;
    }
    job.post_event(&serde_json::json!({ "kind": "rollback", "ring": ring, "source": "edge", "status": "warn",
        "summary": format!("{ring}: security fast-track failed health on {}; rolled back to {prev}", unhealthy.join(", ")),
        "payload": { "restored_release_id": prev, "unhealthy": unhealthy } }))?;
    Ok(true)
}

/// The security job: fetch the feeds, match advisories against every ring,
/// then fast-track clean versions of exposed packages from edge into rc and
/// stable, render, verify on both architectures and roll back a ring whose
/// health fails — what security.yml did on GitHub, as one pulled task.
fn security_job(opts: &WorkOptions, job: &Api, token: &Arc<Mutex<String>>) -> Result<Outcome> {
    let report = security::run(job, &fetch_feeds(opts, job)?)?;
    let matched = format!(
        "{} advisories, {} vulnerable / {} fixed matches, {} in KEV",
        report.arch_advisories + report.debian_advisories,
        report.matches_vulnerable,
        report.matches_fixed,
        report.kev
    );
    // Fast-track: rc and stable take clean versions from edge, skipping the soak.
    let mut tracked = Vec::new();
    let mut rolled_back = Vec::new();
    for ring in ["rc", "stable"] {
        let previous = ops::head(job, ring)?;
        let ft = security::fast_track(
            job,
            &FastTrackOptions {
                ring,
                from: "edge",
                min_severity: "medium",
                dry_run: false,
            },
        )?;
        if ft.fixes.is_empty() {
            continue;
        }
        tracked.push(serde_json::json!({ "ring": ring, "fixes": ft.fixes.len() }));
        if verify_fast_track(opts, job, token, ring, previous)? {
            rolled_back.push(ring);
        }
    }
    let summary = if tracked.is_empty() {
        format!("{matched}; nothing to fast-track")
    } else {
        format!(
            "{matched}; fast-tracked into {}{}",
            tracked
                .iter()
                .map(|t| format!("{} ({} fix(es))", t["ring"], t["fixes"]))
                .collect::<Vec<_>>()
                .join(", "),
            if rolled_back.is_empty() {
                String::new()
            } else {
                format!("; rolled back {}", rolled_back.join(", "))
            }
        )
    };
    Ok(Outcome {
        summary,
        result: serde_json::json!({ "matches_vulnerable": report.matches_vulnerable, "matches_fixed": report.matches_fixed, "kev": report.kev,
            "fast_tracked": tracked, "rolled_back": rolled_back }),
    })
}

#[cfg(test)]
mod tests {
    use super::chrono_now;

    #[test]
    fn the_probe_time_is_iso_8601_utc() {
        let now = chrono_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z') && now.starts_with("20"), "{now}");
        // The civil-from-days arithmetic, against a date everyone knows.
        let epoch_plus = 1_700_000_000u64; // 2023-11-14T22:13:20Z
        let days = i64::try_from(epoch_plus / 86400).unwrap();
        let shifted = days + 719_468;
        let era = shifted.div_euclid(146_097);
        let day_of_era = shifted.rem_euclid(146_097);
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_index = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_index + 2) / 5 + 1;
        let month = if month_index < 10 {
            month_index + 3
        } else {
            month_index - 9
        };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        assert_eq!((year, month, day), (2023, 11, 14));
    }
}
