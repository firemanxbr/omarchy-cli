# The factory

Builds the packages no upstream ships — for the architectures the pool serves
but nobody else covers (today: what the OPR only builds for x86_64, on
aarch64), and, later, the AUR names Omarchy installs. It lives in this
repository for now; it is designed to move out (see *The contract* and
[docs/MIGRATION.md](../docs/MIGRATION.md)).

The pool is the brain. GitHub holds PKGBUILDs and runs CI; it orchestrates
nothing. Workers are ephemeral, live anywhere, and pull.

Contributors and maintainers use the same tools; maintainers never ship a
contributor's bytes — *we do not use what you built, we learn from it*
([docs/GOVERNANCE.md](../docs/GOVERNANCE.md)). A contributor's build is
evidence: the recipe, the log, the manifest that let a maintainer rebuild,
verify and attest the package faster and approve it with more confidence.

```
PKGBUILD reviewed and merged ──▶ pool: build_requests / build_tasks (D1)
                                     ▲            │ claim (lease 30 min)
                                     │ heartbeat  ▼
                          worker: clean Arch container, anywhere
                          fetch PKGBUILD at commit → makepkg
                          → pkg-repo publish --source factory --ring edge (the pool signs)
                          → pkg-repo render edge → complete / fail
                                                       │
                                     lease expired? ◀──┘ back in the queue (scheduler cron)
```

## A package's life

1. **Someone brings it.** A contributor signs in, registers the package
   (the project's URL; a `PKGBUILD` in that repository if there is one) and
   runs their own worker: the signed `omarchy-worker` image, on their
   machine, with their agent key if they want the PKGBUILD drafted and
   corrected for them. Someone without a worker files a
   [package request issue](../../../issues/new?template=package-request.yml)
   instead: the brain reads open issues every ten minutes and queues the
   same build for a *shared* community worker whose owner runs an agent.
2. **Does someone ship it already?** The pool is asked first. If Arch, Arch
   Linux ARM or the OPR ship the name for an architecture it enters the pool's
   cycle as it is; the factory refuses to build that architecture
   (`override:true` exists for the deliberate case). It only builds what is
   missing.
3. **The PKGBUILD is drafted, not written**, when none is given:
   `factory/bin/draft-pkgbuild` in the worker reads the repository (metadata,
   latest release, build files, README) and asks Claude for the PKGBUILD
   following `factory/prompts/pkgbuild.md` — the worker owner's
   `ANTHROPIC_API_KEY`, never the pool's; without one a template covers Rust,
   Go, CMake, Meson, autotools and prebuilt release binaries. `updpkgsums`
   fills the checksums and `namcap` lints, in the container.
4. **It is built before anyone reviews it.** The worker builds it in its
   fresh container; a failure feeds the log back to the drafter for a
   corrected PKGBUILD — three attempts. The package, the PKGBUILD and the log
   land in the contributor's staging workspace as **evidence**; nothing is
   published.
5. **A maintainer approves.** On the Review page, a maintainer of the group
   (`factory/MAINTAINERS.toml`) approves or rejects with the evidence in
   front of them. Approval queues a **project build** of the same PKGBUILD
   on a worker the project trusts; what users get is the project's build,
   signed by the pool. The project's own recipes take the other door: a pull
   request adding `factory/pkgbuilds/<group>/<name>/PKGBUILD`, reviewed by
   the group's maintainers, queued by the hourly `enqueue` job on merge.
6. **After that: bumps are evidence too.** Once a day the brain asks GitHub
   for each approved package's latest release and queues a community build
   from the approved PKGBUILD with `pkgver` moved to the tag
   (`bump:<task>@<tag>`) — for the owner's worker first, for any `--shared`
   worker after 14 days — and a maintainer reviews it like the first time.
   30 days without a build and the package is *unmaintained* until someone
   takes it (docs/GOVERNANCE.md). Recipes in `factory/pkgbuilds/` are bumped
   by `factory-update.yml`: one pull request per package, reviewed, never
   auto-merged.
7. **A worker builds it.** Any worker of that architecture claims the task,
   holds a lease, builds in its fresh container, publishes the result
   into `edge` as source `factory` — the pool signs it with its own key —
   and renders the edge databases. From there
   it is a package like any other: health checks, the soak, `rc`, `stable`,
   the security layer, `omarchy-cli`.
8. **If it fails**, the task returns to the queue with the log tail; after
   three attempts it is marked failed and the Factory page shows why. A
   worker that dies mid-build loses its lease and the task is requeued by the
   pool's scheduler within ten minutes.

The Factory page follows a request through every stage
(`requested → drafting → validating → review → approved`).

## Contribute a package

You have something to package for Omarchy. No permission needed, nothing
spent by the project until a maintainer approves a build: you register the
package, you run the worker (on your machine, with your tokens), the result
waits in your staging workspace.

```bash
API=https://pkgs.firemanxbr.org/api/v1

# 1. Who you are — a GitHub token is used once to read your login and never stored
#    (a fine-grained token with no permissions is enough; `gh auth token` works).
curl -s -X POST $API/factory/register -H 'content-type: application/json' \
  -d "{\"github_token\":\"$(gh auth token)\"}"
#    → {"login":"you","token":"omc_…"}   keep it: export OMC=omc_…

# 2. Register the package: the pool checks nobody ships it, detects what it is.
curl -s -X POST $API/factory/packages -H "authorization: Bearer $OMC" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/you/project"}'
#    optional: "name", "group" (one of GET $API/factory/groups — who reviews it), "arches", "release" (a tag), "pkgbuild_path" (a PKGBUILD in your repo)

# 3. Register a worker. It builds your packages; WORKER_SHARED=1 at start makes it build anyone's.
curl -s -X POST $API/factory/workers -H "authorization: Bearer $OMC" -H 'content-type: application/json' \
  -d '{"name":"laptop","arch":"aarch64"}'
#    → {"worker":"you-laptop-ab12","token":"omw_…"}   shown once

# 4. Queue the build(s).
curl -s -X POST $API/factory/packages/project/build -H "authorization: Bearer $OMC"

# 5. Run the worker: the project's signed image, one fresh container per task.
#    ANTHROPIC_API_KEY is *your* agent key, on your machine: the pool never holds one.
#    WORKER_SHARED=1 donates the worker to other contributors' packages too.
WORKER_ID=you-laptop-ab12 OMARCHY_WORKER_TOKEN=omw_… ANTHROPIC_API_KEY=sk-… \
  podman compose -f factory/image/compose.yml up -d        # or docker compose
#    or, one task by hand:
podman run -d --name omarchy-worker --restart unless-stopped -e OMARCHY_WORKER_TOKEN=omw_… ghcr.io/firemanxbr/omarchy-worker:latest

# 6. Follow it.
curl -s $API/factory/me -H "authorization: Bearer $OMC"       # your packages, workers, tasks, staging quota
```

What happens: the worker claims your task (a dedicated worker only ever
sees your packages; a shared one takes any community task), builds it in the
container — from the `PKGBUILD` in your repository if you named one, else a
PKGBUILD **drafted** from the project (with your `ANTHROPIC_API_KEY` your agent
writes it and corrects it from the build log, up to three times; without a
key a template covers Rust, Go, CMake, Meson, autotools and release
binaries) — and uploads the package, the PKGBUILD, `PKGINFO` and the build
log to `staging/<you>/<package>/<task>/`. The task is then **staged**: the
Factory page lists it, the log and the PKGBUILD are public, the package is
for maintainers. Nothing you build reaches users until a maintainer of the
group approves it on the [Review](../../../../review) page — then a
project worker rebuilds the same PKGBUILD and publishes it into `edge` as
source `factory`, signed by the pool; your build was the evidence, the
project's build is the product. A rejection comes with a note you see on your Contribute
page.

Limits: 10 tasks queued or building and 2 GB of staging per contributor;
staging objects expire after 30 days. A worker token is revocable
(`DELETE /factory/workers/<id>`); registering again replaces your contributor
token. `cosign verify ghcr.io/firemanxbr/omarchy-worker:latest
--certificate-identity-regexp github.com/firemanxbr/omarchy-pool
--certificate-oidc-issuer https://token.actions.githubusercontent.com` checks
the image is the project's.

Who approves, and how one becomes a maintainer, is
[docs/GOVERNANCE.md](../docs/GOVERNANCE.md): a file in this repository,
`factory/MAINTAINERS.toml`, changed by pull requests other maintainers review.

## Sizing a package before committing to it

A **dry run** builds and measures but never publishes or renders: a
maintainer queues it with `publish:false` —
`curl -X POST $API/factory/enqueue -H "authorization: Bearer omc_…" -d '{"name":"chromium","group":"sizing","pkgbuild_ref":"<commit>","version":"…","arches":["aarch64"],"reason":"sizing","publish":false,"override":true}'`
(`override` when an upstream source ships the name). The worker keeps the
result under its work directory; the Factory page shows the task with a
*dry run* pill and how long it took. `factory/pkgbuilds/sizing/` holds
recipes kept only for this (chromium, from Arch Linux ARM).

## Run a worker

Anything with `podman` or `docker` and `curl` is a project worker: a
laptop, a VM, a Droplet. **Every task builds in a fresh Arch container**
(`archlinux:base-devel` for x86_64, `menci/archlinuxarm:base-devel` for
aarch64) that sees the PKGBUILD and the network and nothing else; the worker
process on the host holds only its own token, publishes the result and the
pool signs it — no key ever sits on a worker. A host builds its own
architecture natively and the other one emulated (`--arch`).

The easiest way is the same container image every worker runs,
`ghcr.io/firemanxbr/omarchy-worker` (both architectures, signed, tagged with
the pool's release; `factory/image/Containerfile`): given a token whose
registration a maintainer trusted, it runs `pkg-repo work` and starts each
build as a sibling container through the runtime's socket — the dashboard's
*Run a worker* page has the exact commands for Docker Desktop and Podman.
Without a container, the release binaries do the same:

```bash
# once: the pool's publisher (from the releases, or cargo build --release -p pkg-repo)
export OMARCHY_API=https://pkgs.firemanxbr.org OMARCHY_POOL=https://pool.firemanxbr.org

# register (POST /factory/workers with your contributor token) and have a
# maintainer trust it; then, native architecture:
pkg-repo work --worker-token omw_… --labels '{"where":"laptop"}'
# the other one, emulated (Apple silicon builds x86_64 through podman machine)
pkg-repo work --worker-token omw_… --arch x86_64 --labels '{"where":"laptop","emulated":true}'
```

`--idle-exit 300` makes a worker exit after five minutes without work (what
the hosted fallback uses); `--once` makes it one-shot. A build container gets `[omarchy-factory-edge]` in its `pacman.conf` once that
database exists, so a package can depend on an earlier factory build.

**Whose compute.** Contributors build on their own workers (or a shared
community worker someone else runs); project builds — the rebuild after an
approval, the packages in `factory/pkgbuilds` — run on machines the project
trusts. No GitHub runner ever builds a package: the project's compute is
not for building everyone's software. The pool's own jobs (sync, promote,
health, gc) do get a hosted fallback when no project worker is idle
(`pool-worker.yml`), so operations never stop.

## The contract

The factory touches the pool through four things, all versioned in the API:

| The factory uses | Meaning |
|---|---|
| `GET /api/v1/package/:name` | who ships a name already (the guard) |
| `POST /api/v1/factory/{requests,enqueue}` · `/requests/:id/{approve,reject}` · `/tasks/:id/cancel` (a maintainer's token, or the enqueue job's) · `/tasks/:id/{approve,reject}` (a maintainer of the group) · `POST /factory/jobs` (a maintainer queues a pool job) · `GET /factory/built`, `/factory/groups`, `/factory/review` | maintainers and the enqueue job |
| `POST /api/v1/factory/claim` (a registered worker's token) · `/tasks/:id/{heartbeat,complete,fail}` (the claim's job token) | the worker protocol |
| `POST /api/v1/factory/register` · `/factory/packages[/:name/build]` · `/factory/workers` (contributor token) · `PUT /factory/tasks/:id/artifacts/:file` (worker token) · `GET /factory/packages`, `/factory/me` | contributors: registry, own workers, staging uploads |
| `pkg-repo publish --source factory --ring edge --arch …` · `pkg-repo render` | how a result enters the pool: as a source like any other |

Nothing in the pool knows how a package is built, where a worker runs or what a
PKGBUILD looks like; nothing in the factory knows how rings, rendering or
promotion work. Moving the factory to its own repository means moving
`factory/`, `factory-update.yml`, the `worker-image` jobs of `release.yml` and the issue form, and
pointing the repository name in the worker script, `reconcile.rs`,
`governance.ts` and `requests.ts` at the new home; the pool keeps
`worker/src/routes/factory.ts` (the queue) and the `factory` source.

### Worker protocol

```
POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?, shared?}   Authorization: Bearer omw_… (the registration)
  200 {task:{id,name,group,arch,version,pkgbuild_ref,reason,attempts,…}, token: "omj.…", token_expires_at, lease_minutes, repo, pkgbuild_path, upload}
  204 nothing queued for this worker
POST /factory/tasks/:id/heartbeat                                 (the job token) → lease extended 30 min, a fresh token
POST /factory/tasks/:id/complete    {sha256, filename, version?, duration_ms?, log_tail?} · jobs: {result, summary}
  409 unless the sha256 is in the pool (project) or in staging (community)
POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?}
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
  worker/omarchy-build-worker.sh  the build half: `--inside` (called by pkg-repo work in a fresh container),
                                  `--container` (the contributor's one-task-per-container mode)
  MAINTAINERS.toml                the governance file: groups and their maintainers (docs/GOVERNANCE.md)
  bin/check-governance            validates it and generates .github/CODEOWNERS from it
  image/Containerfile             the one worker image (Arch, both architectures, signed, built by the release workflow); image/entrypoint.sh
                                  reads the registration and runs the contributor's or the project's half; image/compose.yml runs it
  bin/pkgbuild-meta               PKGBUILD → arches and version, without executing it as you
  pkgbuilds/<group>/<name>/       reviewed PKGBUILDs; CODEOWNERS per group
.github/workflows/factory-update.yml    daily: pull requests bumping the project's own recipes (reviewed, never auto-merged)
.github/ISSUE_TEMPLATE/package-request.yml   the request form the brain reads every ten minutes
  bin/draft-pkgbuild              project URL → PKGBUILD (Claude, or a template), checksums left to updpkgsums
  prompts/pkgbuild.md             the packaging rules the drafter follows
  bin/check-updates               which PKGBUILDs are behind their GitHub upstream
.github/CODEOWNERS                      who approves which group
```
