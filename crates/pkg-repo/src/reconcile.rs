//! The `enqueue` job: reconciles the PKGBUILDs on `main` with what the
//! factory has built. Every (package, architecture, version) under
//! `factory/pkgbuilds/<name>/` without a task yet is queued at that
//! commit — the merge of a reviewed PKGBUILD is what a maintainer decided,
//! this only tells the brain. It replaced factory-enqueue.yml: no GitHub
//! secret, a per-job token instead.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use crate::client::Api;
use crate::RepoError;

pub const REPO_URL: &str = "https://github.com/firemanxbr/omarchy-pool";

#[derive(Debug, Default)]
pub struct Report {
    pub commit: String,
    pub queued: Vec<String>,
    pub skipped: Vec<String>,
    pub up_to_date: usize,
}

/// A shallow checkout of `main`, fetched fresh on every run.
fn checkout_main(work_dir: &Path) -> Result<(PathBuf, String)> {
    let dir = work_dir.join("main");
    if dir.join(".git").is_dir() {
        for args in [
            vec!["fetch", "-q", "--depth", "1", "origin", "main"],
            vec!["reset", "-q", "--hard", "FETCH_HEAD"],
        ] {
            let st = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .status()?;
            anyhow::ensure!(st.success(), "git {}", args.join(" "));
        }
    } else {
        let _ = std::fs::remove_dir_all(&dir);
        let st = Command::new("git")
            .args(["clone", "-q", "--depth", "1", "--branch", "main", REPO_URL])
            .arg(&dir)
            .status()
            .context("git clone")?;
        anyhow::ensure!(st.success(), "cloning {REPO_URL}");
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "HEAD"])
        .output()?;
    Ok((dir, String::from_utf8_lossy(&out.stdout).trim().to_owned()))
}

/// What each PKGBUILD declares, sourced with its functions neutralised in a
/// throwaway container (a bash 4 the host may not have; nothing runs here).
struct Meta {
    name: String,
    arches: Vec<String>,
    version: String,
}

fn pkgbuild_meta(repo: &Path, arch: &str) -> Result<Vec<Meta>> {
    let runtime = ["podman", "docker"]
        .iter()
        .find(|r| Command::new(r).arg("--version").output().is_ok())
        .ok_or_else(|| anyhow!("podman or docker is required"))?;
    let (image, platform) = if arch == "aarch64" {
        ("docker.io/menci/archlinuxarm:base", "linux/arm64")
    } else {
        ("docker.io/library/archlinux:base", "linux/amd64")
    };
    let script = r#"set -u; shopt -s expand_aliases nullglob
for f in /repo/factory/pkgbuilds/*/PKGBUILD; do (
  for fn in prepare build check package pkgver; do eval "$fn() { :; }"; done
  source "$f" >/dev/null 2>&1 || true
  d=${f%/PKGBUILD}; d=${d#/repo/factory/pkgbuilds/}
  printf '%s\t%s\t%s\t%s\t%s\n' "$d" "${arch[*]:-}" "${pkgver:-}" "${pkgrel:-1}" "${epoch:-}"
); done"#;
    let out = Command::new(runtime)
        .args(["run", "--rm", "--platform", platform, "-v"])
        .arg(format!("{}:/repo:ro", repo.display()))
        .args([image, "bash", "-c", script])
        .output()
        .context("reading the PKGBUILDs in a container")?;
    anyhow::ensure!(
        out.status.success(),
        "pkgbuild meta: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let mut metas = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 || f[2].is_empty() {
            continue;
        }
        let name = f[0];
        if name.is_empty() || name.contains('/') {
            continue;
        }
        let mut arches: Vec<String> = Vec::new();
        for a in f[1].split_whitespace() {
            match a {
                "any" => {
                    arches = vec!["x86_64".into(), "aarch64".into()];
                    break;
                }
                "x86_64" | "aarch64" => arches.push(a.to_owned()),
                _ => {}
            }
        }
        let version = if f[4].is_empty() {
            format!("{}-{}", f[2], f[3])
        } else {
            format!("{}:{}-{}", f[4], f[2], f[3])
        };
        metas.push(Meta {
            name: name.to_owned(),
            arches,
            version,
        });
    }
    Ok(metas)
}

/// Queues, at the current `main`, every PKGBUILD version the factory has no task for.
pub fn run(api: &Api, work_dir: &Path, arch: &str) -> Result<Report> {
    let (repo, commit) = checkout_main(work_dir)?;
    let built = api.get_json("/factory/built")?;
    let have: HashSet<(String, String, String)> = built["built"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some((
                        r["name"].as_str()?.to_owned(),
                        r["version"].as_str()?.to_owned(),
                        r["arch"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut report = Report {
        commit: commit.clone(),
        ..Report::default()
    };
    for m in pkgbuild_meta(&repo, arch)? {
        let missing: Vec<&String> = m
            .arches
            .iter()
            .filter(|a| !have.contains(&(m.name.clone(), m.version.clone(), (*a).clone())))
            .collect();
        if missing.is_empty() {
            report.up_to_date += 1;
            continue;
        }
        let body = serde_json::json!({
            "name": m.name, "pkgbuild_ref": commit, "version": m.version,
            "arches": missing, "reason": "pkgbuild-changed", "publish": true,
        });
        match api.post_json("/factory/enqueue", &body) {
            Ok(_) => {
                report.queued.push(format!(
                    "{} {} ({})",
                    m.name,
                    m.version,
                    missing
                        .iter()
                        .map(|a| a.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            Err(RepoError::Api { status: 409, body }) => {
                report.skipped.push(format!("{}: {}", m.name, body.trim()));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(report)
}
