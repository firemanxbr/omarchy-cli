# The factory

Builds the packages no upstream ships — for the architectures the pool serves
but nobody else covers (today: what the OPR only builds for x86_64, on
aarch64), and, later, the AUR names Omarchy installs. It lives in this
repository for now; it is designed to move out (see *The contract* and
[docs/MIGRATION.md](../docs/MIGRATION.md)).

The pool is the brain. GitHub holds PKGBUILDs and runs CI; it orchestrates
nothing. Workers are ephemeral, live anywhere, and pull.

```
PKGBUILD reviewed and merged ──▶ pool: build_requests / build_tasks (D1)
                                     ▲            │ claim (lease 30 min)
                                     │ heartbeat  ▼
                          worker: clean Arch container, anywhere
                          fetch PKGBUILD at commit → makepkg → sign
                          → pkg-repo publish --source factory --ring edge
                          → pkg-repo render edge → complete / fail
                                                       │
                                     lease expired? ◀──┘ back in the queue (scheduler cron)
```

## A package's life

1. **Someone asks for it** — a [package request issue](../../../issues/new?template=package-request.yml)
   with the project's URL (or `POST /api/v1/factory/requests`, or *Actions →
   Factory request*). `factory-request.yml` takes it from there.
2. **Does someone ship it already?** The pool is asked first. If Arch, Arch
   Linux ARM or the OPR ship the name for an architecture it enters the pool's
   cycle as it is: the issue gets the answer and closes, the factory refuses to
   build that architecture (`override:true` exists for the deliberate case).
   It only builds what is missing.
3. **The PKGBUILD is drafted, not written.** `factory/bin/draft-pkgbuild`
   reads the repository (metadata, latest release, build files, README) and
   asks Claude for the PKGBUILD following `factory/prompts/pkgbuild.md`;
   without `ANTHROPIC_API_KEY` a template covers Rust, Go, CMake, Meson,
   autotools and prebuilt release binaries. `updpkgsums` fills the checksums
   and `namcap` lints, in an Arch container.
4. **It is built before anyone reviews it.** The draft goes to a branch and a
   draft pull request; the factory queues **dry-run builds** on both
   architectures (nothing published). A failure feeds the log back to the
   drafter for a corrected PKGBUILD — three attempts. When the builds pass the
   pull request is marked ready and the build times are posted on it.
5. **First time: a human approves.** CODEOWNERS of the group
   (`factory/pkgbuilds/<group>/`) review the pull request — that review *is*
   the approval. Merging queues the real builds (`factory-enqueue.yml`, and
   its hourly reconcile from the pool's scheduler); the request is marked
   approved.
6. **After that: automatic.** `factory-update.yml` runs daily: for every
   PKGBUILD with a GitHub `url=` it asks upstream for the latest release,
   bumps `pkgver` (`pkgrel=1`), refreshes the checksums and opens a pull
   request with auto-merge on. CI is the only gate — CODEOWNERS are not asked
   again for a version bump — and the merge queues the build.
7. **A worker builds it.** Any worker of that architecture claims the task,
   holds a lease, builds in its fresh container, signs, publishes the result
   into `edge` as source `factory` and renders the edge databases. From there
   it is a package like any other: health checks, the soak, `rc`, `stable`,
   the security layer, `omarchy-cli`.
8. **If it fails**, the task returns to the queue with the log tail; after
   three attempts it is marked failed and the Factory page shows why. A
   worker that dies mid-build loses its lease and the task is requeued by the
   pool's scheduler within ten minutes.

The Factory page follows a request through every stage
(`requested → drafting → validating → review → approved`).

## Sizing a package before committing to it

A **dry run** builds and measures but never signs, publishes or renders:
*Actions → Factory enqueue → Run workflow* with `group/name`, `dry_run`
(and `override` when an upstream source ships the name). The worker keeps
the result under `~/.cache/omarchy-factory/dry-run/`; the Factory page shows
the task with a *dry run* pill and how long it took. `factory/pkgbuilds/sizing/`
holds recipes kept only for this (chromium, from Arch Linux ARM).

## Run a worker

Anything with `podman` or `docker`, `gpg`, `jq` and `curl` is a worker: a
laptop, a VM, a Droplet, a GitHub-hosted runner. **Every task builds in a
fresh Arch container** (`archlinux:base-devel` for x86_64,
`menci/archlinuxarm:base-devel` for aarch64) that sees the PKGBUILD and the
network and nothing else; the worker process on the host holds the tokens and
the signing key, signs the result and publishes it. A host builds its own
architecture natively and the other one emulated (`WORKER_ARCH`).

```bash
# once: the pool's publisher (Linux hosts download it from the releases automatically)
cargo build --release -p pkg-repo        # macOS: set PKG_REPO to it

export OMARCHY_API=https://pkgs.firemanxbr.org OMARCHY_POOL=https://pool.firemanxbr.org
export FACTORY_TOKEN="$(cat ~/.cache/omarchy-cli-poc/factory-token)"
export OMARCHY_PUBLISH_TOKEN="$(cat ~/.cache/omarchy-cli-poc/publish-token)"
export GNUPGHOME=~/.cache/omarchy-cli-poc/gnupg OMARCHY_GPG_KEYID="$(cat ~/.cache/omarchy-cli-poc/gnupg/STAGING_KEYID)"

# native architecture
WORKER_LABELS='{"where":"laptop"}' factory/worker/omarchy-build-worker.sh
# the other one, emulated (Apple silicon builds x86_64 through podman machine)
WORKER_ARCH=x86_64 WORKER_LABELS='{"where":"laptop","emulated":true}' factory/worker/omarchy-build-worker.sh
```

`IDLE_EXIT=300` makes a worker exit after five minutes without work (what the
hosted runner uses); `MAX_TASKS=1` makes it one-shot; `OMARCHY_GPG_KEY` (an
armored private key) replaces `GNUPGHOME` on hosts with no keyring. A build
container gets `[omarchy-factory-edge]` in its `pacman.conf` once that
database exists, so a package can depend on an earlier factory build.

**Free compute.** On a public repository GitHub-hosted runners cost nothing,
x86_64 and aarch64 alike (`ubuntu-24.04-arm`). `factory-worker.yml` runs the
same script there; the pool's scheduler starts one when tasks are queued and
no worker of that architecture has reported in ten minutes. It is a worker,
not an orchestrator: the queue, the lease and the result live in the pool. Its
limits: six hours per job, 4 vCPU / 16 GB — a browser does not fit; a laptop,
an Oracle free-tier Ampere VM or a Droplet running the same script does.
Cloudflare Containers can host an x86_64 worker the same way (Workers Paid
plan, billed per vCPU-second, no aarch64) — not wired up.

## The contract

The factory touches the pool through four things, all versioned in the API:

| The factory uses | Meaning |
|---|---|
| `GET /api/v1/package/:name` | who ships a name already (the guard) |
| `POST /api/v1/factory/{requests,enqueue}` · `/requests/:id/{approve,reject}` · `/tasks/:id/cancel` (publish token) · `GET /factory/built` | maintainers and the enqueue workflow |
| `POST /api/v1/factory/claim` · `/tasks/:id/{heartbeat,complete,fail}` (factory token) | the worker protocol |
| `pkg-repo publish --source factory --ring edge --arch …` · `pkg-repo render` | how a result enters the pool: as a source like any other |

Nothing in the pool knows how a package is built, where a worker runs or what a
PKGBUILD looks like; nothing in the factory knows how rings, rendering or
promotion work. Moving the factory to its own repository means moving
`factory/` and the two workflows, and pointing `REPO_URL` in the worker script
at the new home; the pool keeps `worker/src/routes/factory.ts` (the queue) and
the `factory` source.

### Worker protocol

```
POST /factory/claim                 {worker, arch, hostname?, labels?, version?}
  200 {task:{id,name,group,arch,version,pkgbuild_ref,reason,attempts,…}, lease_minutes, repo, pkgbuild_path}
  204 nothing queued for this architecture
POST /factory/tasks/:id/heartbeat   {worker}                     → lease extended 30 min
POST /factory/tasks/:id/complete    {worker, sha256, filename, version?, duration_ms?, log_tail?}
  409 unless the sha256 is already indexed in the pool (publish first)
POST /factory/tasks/:id/fail        {worker, error, duration_ms?, log_tail?}
  → {status:"queued"} while attempts < max_attempts, else {status:"failed"}
```

A claim is one `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`; D1
serialises writes, so two workers never receive the same task. Only the lease
owner can heartbeat, complete or fail it (409 otherwise). The scheduler's cron
requeues leases past `lease_expires_at`.

## Layout

```
factory/
  README.md                       this file
  worker/omarchy-build-worker.sh  the worker: claims on the host, builds each task in a fresh container
  bin/pkgbuild-meta               PKGBUILD → arches and version, without executing it as you
  pkgbuilds/<group>/<name>/       reviewed PKGBUILDs; CODEOWNERS per group
.github/workflows/factory-enqueue.yml   merged PKGBUILD → tasks
.github/workflows/factory-worker.yml    a worker on a hosted runner, started on demand
.github/workflows/factory-request.yml   issue with a URL → drafted PKGBUILD → dry-run builds → pull request
.github/workflows/factory-update.yml    daily: bump approved packages to their latest upstream release
  bin/draft-pkgbuild              project URL → PKGBUILD (Claude, or a template), checksums left to updpkgsums
  prompts/pkgbuild.md             the packaging rules the drafter follows
  bin/check-updates               which PKGBUILDs are behind their GitHub upstream
.github/CODEOWNERS                      who approves which group
```
