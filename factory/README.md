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
PKGBUILD reviewed and merged ──▶ pool: package_requests / build_tasks (D1)
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

1. **Someone requests it.** A contributor signs in and asks, on the
   dashboard: the project's URL (a GitHub repository or its release tarball
   — for a project elsewhere, its home page and the release's source and
   version), a name, one line of description, the licence (SPDX), the
   architectures, and four things they confirm (the URL is the project's
   own, the licence is the project's, nobody ships or requested it, their
   build is evidence). The pool checks all of it — a blocked contributor,
   a name or a project already in the pool, an upstream that ships the
   name, a source that does not answer — and only then writes the request
   **once** to the record, `factory/<name>/<id>/request.json` in the pool
   bucket with the pool's detached signature, public and immutable
   (`worker/src/record.ts`). Nothing about a request lives on GitHub.
   Then **Build**: a worker the project shares (the project's agent) or
   one of the contributor's own (their agent) — a contributor's worker
   builds only its owner's packages.
2. **Does someone ship it already?** The pool is asked first. If Arch, Arch
   Linux ARM or the OPR ship the name for an architecture it enters the pool's
   cycle as it is; the factory refuses to build that architecture
   (`override:true` exists for the deliberate case). It only builds what is
   missing.
3. **The PKGBUILD is drafted, not written**, when none is given:
   `factory/bin/draft-pkgbuild` in the worker reads the repository (metadata,
   latest release, build files, README) and asks the owner's agent for the
   PKGBUILD following `factory/prompts/pkgbuild.md` — `factory/bin/agent.py`
   speaks to Anthropic, OpenAI, Gemini or xAI by the key set
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`;
   `FACTORY_MODEL` picks the model) — or runs Claude Code in print mode on
   a Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude
   setup-token`; the dashboard's *Run a worker* page has the steps) — the
   worker owner's key, never the pool's; without one a template covers Rust,
   Go, CMake, Meson, autotools and prebuilt release binaries. `updpkgsums`
   fills the checksums and `namcap` lints, in the container.
4. **It is built before anyone reviews it.** The worker builds it in its
   fresh container; a failure feeds the log back to the drafter for a
   corrected PKGBUILD — three attempts. The package, the PKGBUILD and the log
   land in the contributor's staging workspace as **evidence**; nothing is
   published.
5. **The second agent reads it.** Staging the build queues an `audit`: a
   project worker whose owner set an agent key reads the PKGBUILD, the log
   and the `.PKGINFO`, asks the model for a structured review
   (`factory/bin/audit-pkgbuild`, `factory/prompts/audit.md`) and attaches
   `audit.json` / `audit.md` to the evidence. The Review page shows the
   verdict (`ok`, `warn`, `block`); nothing acts on it, the maintainer does.
6. **A maintainer approves — never their own package.** On the Review page,
   a maintainer of the group (`factory/MAINTAINERS.toml`) approves or
   rejects with the evidence in front of them. The approval is the decision
   on the record; it queues nothing and copies nothing.
7. **A maintainer writes the recipe.** With the evidence as the lesson —
   the contributor's PKGBUILD, the log, the metrics, the audit — a
   maintainer (not the owner) writes the project's own
   `factory/pkgbuilds/<group>/<name>/PKGBUILD` and opens the pull request.
   The merge is what the project builds: the hourly `enqueue` job queues it
   from `main`, a worker the project trusts builds it, the pool signs it and
   publishes it into `edge`, and the build is linked to the approval it
   answers (the seal shows the chain). The project's own recipes take the
   same door without a staged build first.
8. **After that: bumps are evidence too.** Once a day the brain asks GitHub
   for each approved package's latest release and queues a community build
   from the contributor's staged PKGBUILD with `pkgver` moved to the tag
   (`bump:<task>@<tag>`) — for the owner's worker first, for any `--shared`
   worker after 14 days — and a maintainer reviews it like the first time.
   30 days without a build and the package is *unmaintained* until someone
   takes it (docs/GOVERNANCE.md). Recipes in `factory/pkgbuilds/` are bumped
   by `factory-update.yml`: one pull request per package, reviewed, never
   auto-merged.
9. **A worker builds it.** Any worker of that architecture claims the task,
   holds a lease, builds in its fresh container, publishes the result
   into `edge` as source `factory` — the pool signs it with its own key —
   and renders the edge databases. From there
   it is a package like any other: health checks, the soak, `rc`, `stable`,
   the security layer, `omarchy-cli`.
10. **If it fails**, the task returns to the queue with the log tail; after
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

# 2. Request the package: the pool checks nobody ships it, that the source answers, and writes the request to the record.
curl -s -X POST $API/factory/packages -H "authorization: Bearer $OMC" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/you/project","description":"What it does, one line","license":"MIT",
       "checklist":{"official":true,"license":true,"unshipped":true,"evidence":true}}'
#    optional: "name", "arches"; for a project not on GitHub: "source" (the release tarball) and "version"
#    → {"package":…,"request":{"id":12,"record":"https://pool.firemanxbr.org/factory/<name>/12/request.json",…}}

# 3. Register a worker. It builds your packages; WORKER_SHARED=1 at start makes it build anyone's.
curl -s -X POST $API/factory/workers -H "authorization: Bearer $OMC" -H 'content-type: application/json' \
  -d '{"name":"laptop","arch":"aarch64"}'
#    → {"worker":"you-laptop-ab12","token":"omw_…"}   shown once

# 4. Queue the build(s).
curl -s -X POST $API/factory/packages/project/build -H "authorization: Bearer $OMC"

# 5. Run the worker: the project's signed image, one fresh container per task.
#    GITHUB_TOKEN: the worker reads GitHub's API for every package (the release, the files) — without one,
#    60 requests an hour from your address; a fine-grained token with no permissions is enough.
#    the agent key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY — or CLAUDE_CODE_OAUTH_TOKEN,
#    a Claude subscription through Claude Code) is *yours*, on your machine: the pool never holds one.
#    WORKER_SHARED=1 donates the worker to other contributors' packages too.
OMARCHY_WORKER_TOKEN=omw_… GITHUB_TOKEN="$(gh auth token)" ANTHROPIC_API_KEY=sk-… \
  podman compose -f factory/image/compose.yml up -d        # or docker compose; a stop waits for the build (3 h)
#    or, one task by hand (--stop-timeout: a stop lets the build finish instead of killing it):
podman run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 \
  -e OMARCHY_WORKER_TOKEN=omw_… -e GITHUB_TOKEN="$(gh auth token)" ghcr.io/firemanxbr/omarchy-worker:latest

# 6. Follow it.
curl -s $API/factory/me -H "authorization: Bearer $OMC"       # your packages, workers, tasks, staging quota
```

What happens: the worker claims your task (a dedicated worker only ever
sees your packages; a shared one takes any community task), builds it in the
container — from the `PKGBUILD` in your repository if you named one, else a
PKGBUILD **drafted** from the project (with your agent key your agent
writes it and corrects it from the build log, up to three times; without a
key a template covers Rust, Go, CMake, Meson, autotools and release
binaries) — and uploads the package, the PKGBUILD, `PKGINFO` and the build
log to `staging/<you>/<package>/<task>/`. The task is then **staged**: the
Factory page lists it, the log and the PKGBUILD are public, the package is
for maintainers. Nothing you build reaches users: a maintainer of the
group approves it on the [Review](../../../../review) page, then writes
the project's own recipe from what your build taught — the PKGBUILD, the
log, the metrics — and merges it into `factory/pkgbuilds`; a project
worker builds *that* and publishes it into `edge` as source `factory`,
signed by the pool. Your build was the evidence, the maintainer's recipe
is the product. A rejection comes with a note you see on your Contribute
page.

What a build can and cannot do, learned from the first contributor's day
(2026-09-15): a failed build is **not retried** — the next fresh container
would fail the same way — so fix the PKGBUILD and press *Build* again (the
pool retries only what the infrastructure broke: a download, a mirror, a
container killed under the build). A dependency that is itself a factory
package (pinta needs dotnet) is available to your build only once *that*
package was approved and published into `edge`; until then pacman says
*target not found*. A project with no release or tag is not built — the
factory packages releases (a `-git` package has nothing to pin). A split
PKGBUILD (`pkgname=(a b c)`) builds; only the base's `depends`,
`makedepends` and `checkdepends` are installed, as `makepkg --syncdeps`
would.

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

`--idle-exit 300` makes a worker exit after five minutes without work;
`--once` makes it one-shot; SIGTERM (`docker stop`) drains it — the task in
hand runs to its end and is reported, nothing new is claimed, exit 0 — so
a container can be replaced without losing work. A build container gets `[omarchy-factory-edge]`
in its `pacman.conf` once that database exists, so a package can depend on
an earlier factory build. `OMARCHY_PKG_CACHE=/path` on the host shares one
pacman package cache (a directory per architecture) with every build
container it starts, so a dependency downloads once; `OMARCHY_BUILD_CACHE`
likewise mounts a build cache at `/build/cache` — cargo's registry, Go's
module and build caches, ccache's objects — so a Rust or Go package
rebuilds in minutes. A build container uses every core it sees
(`MAKEFLAGS`, `NINJAFLAGS`, `CARGO_BUILD_JOBS`) with ccache on.

**Three roles.** The project runs its workers as three kinds of container
of that same image, `OMARCHY_WORKER_ROLE` set (`factory/image/entrypoint.sh`;
the dashboard's *Run a worker* page, *The three roles*): **pool** — a
project-trusted registration that takes only the pool's jobs (sync, render,
promote, rollback, health, security, enqueue, gc, verify); **review** — a
project-trusted registration that takes only the maintainers' work, the
build of the recipes on `main` and the audit of staged builds, with an
agent key; **community** — a community registration, shared, that builds anyone's
registered packages and drafts PKGBUILDs for package requests with an agent
key. A role narrows what the trust allows and the container refuses a
registration that does not match. Two of each, one per architecture, run on
the project's own host (`factory/host/`, RUNBOOK *The Studio host*).

**Whose compute.** Contributors build on their own workers (or a shared
community worker someone else runs); project builds — the recipes in
`factory/pkgbuilds`, the maintainers' own and the ones written from
contributors' evidence — run on machines the project trusts. No GitHub runner ever builds a package: the project's compute is
not for building everyone's software, and GitHub Actions runs CI and the
release only — no worker, not even for the pool's own jobs: when the
project's host is down they wait, and the Factory page says so.

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
  bin/agent.py                    the owner's agent, whichever provider: Anthropic, OpenAI, Gemini, xAI (by the key set)
  bin/draft-pkgbuild              project URL → PKGBUILD (the agent, or a template), checksums left to updpkgsums
  prompts/pkgbuild.md             the packaging rules the drafter follows
  bin/audit-pkgbuild              the second agent: staged PKGBUILD + log + .PKGINFO → audit.json / audit.md
  prompts/audit.md                what the auditor looks for, and the report's shape
  bin/check-updates               which PKGBUILDs are behind their GitHub upstream
.github/CODEOWNERS                      who approves which group
```
