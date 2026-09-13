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

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::client::Api;
use crate::gate::{self, GateOptions, Verdict};
use crate::ops;
use crate::security::{self, FastTrackOptions, SecurityOptions};
use crate::sync::SyncOptions;

pub const REPO_URL: &str = "https://github.com/firemanxbr/omarchy-pool";
const HEARTBEAT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_secs(30);

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
    pub group: String,
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

/// # Panics
/// When the heartbeat thread's mutex is poisoned, which needs a panic in that thread first.
pub fn run(opts: &WorkOptions) -> Result<()> {
    std::fs::create_dir_all(&opts.work_dir)?;
    let claimer = Api::new(&opts.api, &opts.worker_token)?;
    let hostname = hostname();
    let version = pkg_manifest::BUILD_VERSION;
    eprintln!(
        "worker ({}) ready — {} — asking {} for {}",
        opts.arch,
        version,
        opts.api,
        opts.kinds.join(", ")
    );
    // The keyrings the health check and the sync need, before the first job.
    if let Err(e) = keyrings(opts) {
        eprintln!("warning: keyrings not fetched yet ({e:#}); the first sync will retry");
    }
    let mut idle = 0u64;
    let mut done = 0u32;
    loop {
        let body = serde_json::json!({
            "arch": opts.arch, "hostname": hostname, "version": version, "labels": opts.labels, "kinds": opts.kinds, "shared": opts.shared,
        });
        let claimed = match claimer.post_json_as(&opts.worker_token, "/factory/claim", &body) {
            Ok(Some(v)) => serde_json::from_value::<Claimed>(v).context("claim response")?,
            Ok(None) => {
                idle += POLL.as_secs();
                if opts.idle_exit > 0 && idle >= opts.idle_exit {
                    eprintln!("no work for {idle}s; exiting");
                    return Ok(());
                }
                std::thread::sleep(POLL);
                continue;
            }
            Err(e) => {
                eprintln!("claim failed: {e}; retrying in 60 s");
                std::thread::sleep(Duration::from_secs(60));
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
        match outcome {
            Ok(o) => {
                let sha = o
                    .result
                    .get("sha256")
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::String("-".into()));
                let filename = o
                    .result
                    .get("filename")
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::String("-".into()));
                let version = o
                    .result
                    .get("version")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                job.post_json_as(
                    &token.lock().unwrap().clone(),
                    &format!("/factory/tasks/{}/complete", task.id),
                    &serde_json::json!({ "summary": o.summary, "result": o.result, "duration_ms": took, "sha256": sha, "filename": filename, "version": version }),
                )?;
                eprintln!("task {}: done — {} ({} s)", task.id, o.summary, took / 1000);
            }
            Err(e) => {
                let msg = format!("{e:#}");
                let _ = job.post_json_as(
                    &token.lock().unwrap().clone(),
                    &format!("/factory/tasks/{}/fail", task.id),
                    &serde_json::json!({ "error": msg, "duration_ms": took, "log_tail": msg }),
                );
                eprintln!("task {}: failed — {e:#}", task.id);
            }
        }
        done += 1;
        if opts.once {
            eprintln!("{done} task(s) done; exiting");
            return Ok(());
        }
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
        "enqueue" => "enqueue: PKGBUILDs on main → the queue".to_owned(),
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
fn repo_dir(opts: &WorkOptions) -> Result<PathBuf> {
    if let Some(d) = &opts.repo_dir {
        return Ok(d.clone());
    }
    let dir = opts.work_dir.join("repo");
    let stamp = dir.join(".fetched");
    let fresh = fresh_within(&stamp, Duration::from_secs(86400));
    if dir.join("tests").is_dir() && fresh {
        return Ok(dir);
    }
    let version = pkg_manifest::BUILD_VERSION;
    let git_ref = if version.starts_with('v') {
        version.to_owned()
    } else {
        "main".to_owned()
    };
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
    let dir = opts.work_dir.join("keyrings");
    let stamp = dir.join(".fetched");
    let fresh = fresh_within(&stamp, Duration::from_secs(86400));
    if fresh && dir.join("archlinux.gpg").exists() {
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

fn sync_job(opts: &WorkOptions, job: &Api, task: &Task) -> Result<Outcome> {
    let p = &task.params;
    let keyring = keyrings(opts)?.join(format!("{}.gpg", s(p, "keyring")));
    let defer: Vec<String> = s(p, "defer_to")
        .split(',')
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
        .collect();
    let o = SyncOptions {
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
        keyring: Some(keyring),
        defer_to: defer,
    };
    let report = ops::run_sync_report(job, &o)?;
    let mut rendered = Vec::new();
    if report.release.is_some() {
        rendered = ops::render(job, &o.ring, &o.arch, opts.sign.as_deref())?;
        let other = if o.arch == "aarch64" {
            "x86_64"
        } else {
            "aarch64"
        };
        rendered.extend(ops::render(job, &o.ring, other, opts.sign.as_deref())?);
    }
    Ok(Outcome {
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
    let status = Command::new("bash")
        .arg(repo.join(rel))
        .args(args)
        .env("OMARCHY_API", &opts.api)
        .env("OMARCHY_POOL", &opts.pool)
        .env("OMARCHY_TOKEN", token.lock().unwrap().clone())
        .env("PKG_REPO", &exe)
        .env("OMARCHY_KEYRINGS", opts.work_dir.join("keyrings"))
        .env("OMARCHY_CLI", bin.join("omarchy-cli"))
        .env("PKG_EXTRACT", bin.join("pkg-extract"))
        .current_dir(&repo)
        .status()
        .with_context(|| format!("running {rel}"))?;
    Ok(status.success())
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
    let group = if task.group.is_empty() {
        "community".to_owned()
    } else {
        task.group.clone()
    };
    let pkgbuild_ref = task.pkgbuild_ref.clone();
    // Inside the container "localhost" is the container: a local pool (wrangler
    // dev) is reached through the runtime's host alias.
    let from_container = |u: &str| {
        u.replace("://localhost", "://host.containers.internal")
            .replace("://127.0.0.1", "://host.containers.internal")
    };
    let meta = format!(
        "name={}\ngroup={}\nref={}\narch={}\npool={}\nexport OMARCHY_API={}\n",
        shell_quote(&task.name),
        shell_quote(&group),
        shell_quote(&pkgbuild_ref),
        shell_quote(&task.arch),
        shell_quote(&from_container(&opts.pool)),
        shell_quote(&from_container(&opts.api))
    );
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
    let status = Command::new(runtime)
        .args([
            "run",
            "--rm",
            "--platform",
            platform,
            "--name",
            &format!("omarchy-build-{}", task.id),
            "-v",
        ])
        .arg(format!("{}:/task", dir.display()))
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
        return Err(anyhow!("build failed (exit {:?}):\n{tail}", status.code()));
    }
    let mut pkgs: Vec<PathBuf> = std::fs::read_dir(dir.join("out"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".pkg.tar.zst"))
        .collect();
    pkgs.sort();
    anyhow::ensure!(!pkgs.is_empty(), "makepkg produced no package");
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
    let arches = ["x86_64".to_owned(), "aarch64".to_owned()];
    // Evidence: health and ABI of the source ring, both architectures. The
    // scripts record events; the gate reads them. Failures are evidence too.
    for arch in &arches {
        let _ = script(opts, token, "tests/health-check.sh", &[&from, arch]);
        let _ = script(opts, token, "tests/abi-gate.sh", &[&from, arch]);
    }
    let report = gate::run(
        job,
        &GateOptions {
            from: &from,
            to: &to,
            arches: &arches,
            soak_days,
            max_age_hours: 24,
            dry_run: false,
        },
    )?;
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
    let created = ops::promote(job, &from, &to, Some(&note))?;
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
