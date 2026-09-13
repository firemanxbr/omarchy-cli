# Runbook

Operating the staging environment. Nothing here is done by hand on the servers:
every write goes through the Worker with a per-job token a worker got at claim
time; there is no shared secret. Humans operate the pipeline by queueing jobs
(`pkg-repo job`, or the API with a maintainer's token) that project workers run.

| | |
|---|---|
| Dashboard | https://omarchy-pool.firemanxbr.org |
| Index API | https://pkgs.firemanxbr.org/api/v1/stats |
| Pool (static, what pacman reads) | https://pool.firemanxbr.org/x86_64/ · `/aarch64/` |
| Signing key | `docs/omarchy-staging.pub.asc` · https://pool.firemanxbr.org/omarchy-staging.pub.asc · https://pkgs.firemanxbr.org/api/v1/signing-key (expires 2027-09-12); the private key is the Worker secret `SIGNING_KEY` — nowhere else |
| Jobs (pulled by project workers) | Sync (every 3 h, one task per architecture) · Promote (edge→rc 06:00 UTC, rc→stable 09:00 UTC after a one-day soak, evidence-gated, auto-rollback) · Health (daily, both arches) · Security (every 3 h, with fast-track) · GC (Sundays) · Metrics snapshot (every 30 min, by the brain itself) · Release (GitHub, every merge into `main`) |
| Running version | https://pkgs.firemanxbr.org/api/v1/version · the chip in the dashboard header |

## Trust model

* **Packages are never re-signed.** The sync imports a package only if its
  upstream `.sig` verifies against the upstream project's keyring
  (`archlinux.gpg`, `archlinuxarm.gpg`, `omarchy.gpg` — built by
  `tests/fetch-keyrings.sh`). A machine using the pool verifies packages with the
  keys it already trusts (`archlinux-keyring`, `archlinuxarm-keyring`, Omarchy's).
* **The pool signs with its own key, inside the Worker.** Databases are signed
  as they are stored (`PUT /releases/:id/artifacts/db|files`); a package the
  factory built is signed on request (`POST /pool/:sha256/sign`) against the
  bytes actually stored. Trusting the pool means trusting one key for
  `omarchy-*-<ring>.db` and `factory` packages; nothing else. No worker,
  runner or repository holds the key (SECURITY.md).
* **The pool is append-only.** The worker refuses to overwrite an existing object;
  the only deletions are retention (`gc`), which never touches anything the last
  three releases of any ring reference, nor anything younger than seven days.
* **Releases are append-only.** Rollback creates a new release pointing at an old
  selection; history is never rewritten. Every action posts an event.
* **Nobody holds R2 credentials, and nobody holds a pool credential.** Reads
  are public objects; writes go through the Worker with the per-job token of
  a task a project worker claimed; the R2 bucket has no API tokens.

## Everyday operations

Everything the scheduler does can be queued by hand by a maintainer
(`OMARCHY_API` and `OMARCHY_TOKEN=omc_…` set — the token from the Contributors
page); a project worker runs it with a per-job token and the Factory page
follows it:

```bash
pkg-repo job sync --param arch=x86_64                                  # every source of the architecture, one release per ring
pkg-repo job sync --param source=packages --param arch=x86_64 --param ring=rc   # one source
pkg-repo job promote --param from=edge --param to=rc --param note="…"
pkg-repo job promote --param from=rc --param to=stable --param note="…"        # evidence-gated, one-day soak
pkg-repo job promote --param from=rc --param to=stable --param force=yes       # emergency: skips the gate (the target's health still rolls back)
pkg-repo job rollback --param ring=stable --param to=<release id>              # then renders both architectures
pkg-repo job render --param ring=stable --param arch=x86_64
pkg-repo job health --param ring=stable --param arch=aarch64
pkg-repo job security
pkg-repo job enqueue                                                   # the PKGBUILDs on main → the queue, now
pkg-repo job gc --param keep=3
```

Promotions are gated by evidence (see *Promotion by evidence* in
[ARCHITECTURE.md](ARCHITECTURE.md)): the job first records fresh `health` and
`abi` events for the source ring on both architectures, then the gate
decides — promote, nothing to promote, or blocked with the reasons in a `gate`
event on the dashboard. After a promotion the target ring is health-checked on
both architectures and rolled back automatically if that fails (`rollback` event
naming the failed and the restored release). There is no human in the daily
path: the evidence is the reviewer, and a maintainer who disagrees rolls back.

```bash
# the same decisions by hand
pkg-repo fast-track --ring stable --from edge --dry-run        # security fixes edge has and stable lacks (exit 3: none)
pkg-repo gate --from rc --to stable --soak-days 1 --dry-run   # exit 0 promote, 3 nothing new, 1 blocked
pkg-repo head --ring stable                                    # current release id (rollback target)
tests/abi-gate.sh rc x86_64                                    # ABI check of rc's upgrades, exit 2 on blockers
```

The reads run directly from anywhere (`pkg-repo releases --ring stable`,
`pkg-repo head`, `pkg-repo gc --keep 3` without `--delete` is a report); the
writes above are jobs.

## Releasing the pool itself

`main` is protected: no direct pushes, every change is a pull request that CI and
E2E must pass, squash-merged with the pull request title as the commit message.
Every merge is a release — there is no separate "cut a version" step:

1. `release.yml` runs CI and E2E again on the merged commit.
2. The next version is the last tag plus one **patch** (`v0.0.1 → v0.0.2`). Label
   the pull request `release:minor` for a significant change (`v0.1.0`) or
   `release:major` for an incompatible one; `workflow_dispatch` with `bump=` does
   the same by hand. Crate and `package.json` versions stay at `0.0.0` — the tag is
   the source of truth and is compiled into the binaries as `POOL_VERSION`.
3. Binaries (`pkg-repo`, `omarchy-cli`, `pkg-extract`) are built on x86_64 and
   aarch64 runners and attached to a GitHub release with notes generated from the
   merged pull requests.
4. The worker is migrated (`wrangler d1 migrations apply`) and deployed with
   `POOL_VERSION`, `POOL_COMMIT` and `POOL_DEPLOYED_AT`; the run verifies
   `/api/v1/version` reports the new tag and records a `deploy` event through
   `wrangler d1 execute` (the release holds no credential of the pool's API).

The deploy step needs the `CLOUDFLARE_API_TOKEN` repository secret (Account →
Workers Scripts: Edit, D1: Edit, Account Settings: Read; Zone → Workers Routes:
Edit, Zone: Read, for `firemanxbr.org`). Without it the release is still
published and the run ends with a warning instead of a deployment.

Rolling the worker back is deploying an earlier release: re-run the Deploy job of
that release's run, or `git checkout vX.Y.Z && cd worker && npx wrangler deploy
--var POOL_VERSION:vX.Y.Z`. Migrations are forward-only; keep them additive.

## Security data

The `security` job (every 3 h, pulled by a project worker; `pkg-repo job
security` queues one by hand) fetches the Arch and Debian trackers, KEV and EPSS,
matches them (`pkg-repo security`) and then fast-tracks fixes into `rc` and
`stable` (`pkg-repo fast-track`, `--min-severity medium`, exploited-in-the-wild
always), renders, checks health on both architectures and rolls back a ring
that fails. Both commands are safe to run by hand with `--dry-run`. A wrong match is a
tracker's mistake or a name collision: open an issue with the package and the
advisory id shown on the package page; the `same_project` heuristic in
`crates/pkg-repo/src/security.rs` is where collisions are rejected.

## The pool's own scheduler

GitHub's cron is best-effort (on 2026-09-12 it delayed the hourly sync by an
hour and never started the half-hourly metrics), so the pool has its own
clock: a Cloudflare cron trigger on the Worker (`src/scheduler.ts`, every
ten minutes). Intervals for sync (3 h) and security (3 h), the PKGBUILD
reconcile (`enqueue`, hourly); daily slots for promote (06:00 edge→rc,
09:00 rc→stable), health (08:30) and the Sunday GC — each queued as a
pulled job (below) when due and never doubled while one is queued or
running. The metrics snapshot (30 min), the governance sync (10 min), the
package-request issues (10 min), the update check (05:45) and the cost
estimate (06:30) it does itself. Two things still start on GitHub, by
dispatch: `factory-update.yml` (05:45, pull requests for the project's own
recipes) and `pool-worker.yml` (a hosted worker when pool jobs wait and no
project worker is idle). Each dispatch is a `dispatch` line in the journal
and needs the worker secret `GITHUB_TOKEN` (fine-grained, this repository,
*Actions: read and write*):

```bash
cd worker && npx wrangler secret put GITHUB_TOKEN < ~/.cache/omarchy-cli-poc/github-token
```

Without the secret the jobs still run; only those two dispatches stop.

## Pulled jobs (the pool without GitHub)

The pool's own work — sync, promote, rollback, render, health, security,
enqueue, gc — runs as tasks in the factory's queue when `JOB_KINDS` (a
Worker var, comma-separated kinds) lists the kind: the cron creates them
on schedule, a maintainer queues one by hand, and a **project worker**
pulls and runs them:

```bash
# on any machine with podman/docker, python3, curl, git (the health and ABI
# scripts) — a droplet, a laptop, a Hetzner box
pkg-repo work --worker-token omw_… --labels '{"where":"droplet-1"}'
```

The worker is registered like any other (`POST /factory/workers`) and a
maintainer promotes it: `POST /factory/workers/<id>/trust {"trust":"project"}`
with a maintainer's contributor token; maintainers are named by
`factory/MAINTAINERS.toml` (docs/GOVERNANCE.md), nowhere else. Every task
runs with a per-job token the pool issues at claim time (SECURITY.md);
the worker's own token only claims. No pipeline step runs on GitHub any
more: the workflows that did are gone, and a run by hand is a job. When
pool jobs wait and no project worker is idle, the scheduler starts one on
a GitHub-hosted runner (`pool-worker.yml`, a registered project worker per
architecture) — the fallback fleet, never for a package build. Worker
secret: `JOB_TOKEN_SECRET` (any random string) signs the job tokens.

## Maintainers: reviewing contributed builds

The **Review** page lists staged builds (a contributor's package built on
their worker, with PKGBUILD, log and PKGINFO). A maintainer of the package's
group — a login listed under that group in `factory/MAINTAINERS.toml`, signed
in with GitHub — approves or rejects:

- **Approve** records the decision (`approvals`, with your login and note)
  and queues a **project build** of the staged PKGBUILD (`pkgbuild_ref =
  staging:<task>`, trust `project`). A project worker (`pkg-repo work`, or
  the hosted fallback) builds it in a fresh container, signs it, publishes
  it into `edge` as source `factory` and renders; from there the package
  follows the rings like any other. The contributor's bytes are never
  served.
- **Reject** needs a note; the package returns to *registered* with the
  note in its detail, the staged objects expire with the rest.

**Sign in with GitHub** (the header's *Sign in*) is the GitHub OAuth App
`omarchy-pool` (registered under the GitHub account that runs the staging
deployment, *Settings → Developer settings → OAuth Apps*; it moves with the
project, MIGRATION part C;
callback `https://omarchy-pool.firemanxbr.org/auth/github/callback`,
homepage the dashboard, no device flow, expiring user tokens on — the
token is used once, to read the login). Its client id is
`GITHUB_OAUTH_CLIENT_ID` in `wrangler.toml`; the secret is set with
`npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET` and rotated from the
app's page (*Generate a new client secret*, set, then delete the old one).
The logo is `docs/omarchy-pool-logo.png`.
The session is an HttpOnly cookie on the dashboard's origin; the pages call
the API same-origin. Without the app, the Contributors page still accepts a
GitHub token used once.

Roles come from the repository, not from an API: `factory/MAINTAINERS.toml`
names the groups and their maintainers, the brain reads `main` every ten
minutes (`worker/src/governance.ts`) and sets each contributor's role and
areas from it — every change a `role` line in the journal. Changing the file
is a pull request another maintainer approves (`.github/CODEOWNERS` is
generated from it by `factory/bin/check-governance --write`; CI checks they
agree). See [GOVERNANCE.md](GOVERNANCE.md). `GET /api/v1/factory/groups` and
`/factory/approvals` are the public record.

## The factory

What no upstream ships is built from `factory/pkgbuilds` by workers that pull
tasks from the pool ([factory/README.md](../factory/README.md)). Day to day:

- **Add a package**: sign in and register it on the Contributors page, run
  your worker, and a maintainer of the group reviews the staged build
  (docs/GOVERNANCE.md). A *Package request* issue does the same for someone
  without a worker: the brain reads open issues every ten minutes and queues
  a community build with a drafted PKGBUILD (`draft:<url>@latest`) for the
  issue's author; a *shared* worker whose owner runs an agent takes it, and
  the request shows on the Factory page until then. The project's own
  recipes live in `factory/pkgbuilds/<group>/`: a pull request the group's
  maintainers review; the merge queues the build (the hourly `enqueue` job,
  or `pkg-repo job enqueue` right away).
- **Rebuild**: `curl -X POST $API/factory/enqueue` with a maintainer's token
  (`{"name","group","pkgbuild_ref":"<commit>","version","arches"}`;
  `override` builds even a name upstream ships), or approve a staged build
  again on the Review page.
- **A failed task**: the Factory page shows the error and the log tail
  (`GET /api/v1/factory/tasks/:id` has the full tail). Fix the PKGBUILD in a
  pull request; merging queues it again.
- **Workers**: contributors' builds run on their workers; project builds
  (approvals, `factory/pkgbuilds`) on project-trusted workers — today the
  Mac (`pkg-repo work`, one process per architecture). No GitHub runner
  builds packages; a queued build waits for a project worker. Workers
  hold no key: the pool signs what they publish.
- **The audit** (the second agent, GOVERNANCE.md): every staged community
  build queues an `audit` task. A project worker takes it only when it
  was started with `ANTHROPIC_API_KEY` in its environment (`pkg-repo work`
  adds the `audit` kind by itself then; `FACTORY_MODEL` picks the model,
  default `claude-sonnet-5`). The report lands next to the evidence
  (`/api/v1/factory/tasks/<id>/artifacts/audit.md`) and the Review page
  shows the verdict; *waiting* in that column means no such worker is
  running. It is advice for the maintainer; nothing acts on it. A build
  approved or rejected before the audit ran cancels it.
- **New upstream versions** — two paths, one rule (evidence before review):
  - a package a contributor registered: once a day (05:45 UTC) the brain
    asks GitHub for each approved package's latest release and queues a
    community build from the approved PKGBUILD with `pkgver` moved to the
    tag (`bump:<task>@<tag>`, `updpkgsums` in the worker). The owner's
    worker has **14 days**; then any `--shared` worker may build it. A
    maintainer reviews the staged build like the first one. **30 days**
    without a build and the package is *unmaintained* (Factory page badge,
    `bump` journal line): no more bumps until its owner builds again, or a
    maintainer removes the registration (`DELETE /factory/packages/<name>`)
    so someone else can take it;
  - a recipe in `factory/pkgbuilds/<group>/`: `factory-update.yml` (daily,
    05:45 UTC from the scheduler) bumps `pkgver`, refreshes checksums and
    opens one pull request per package for a maintainer of the group to
    review — never auto-merged; the merge queues the build. It relies on the
    repository setting *Actions may create pull requests*. Packages without
    a GitHub `url=` (vi) are bumped by hand.
- **Contributors' builds** land in the `omarchy-factory-staging` bucket
  (`staging/<login>/<package>/<task>/`, lifecycle rule: 30 days), listed on
  the Factory page with their PKGBUILD and log; the packages themselves are
  readable by maintainers (`GET /api/v1/factory/tasks/:id/artifacts/<file>`).
  Quotas per contributor: 10 tasks queued or building, 2 GB staged. A
  contributor token (`omc_…`) or worker token (`omw_…`) is a random secret
  hashed in D1; revoke a worker with `DELETE /factory/workers/<id>` as its
  owner, or set `revoked_at` in `build_workers` by hand.
- **Tokens**: there is no shared worker secret. Every worker — the Mac's,
  a droplet's, the hosted fallback's — is a registration with its own
  `omw_` token; project trust is a maintainer's decision on that
  registration. The hosted `pool-worker.yml` runs as two registered
  workers, one per architecture, whose tokens are the GitHub secrets
  `POOL_WORKER_TOKEN_X86_64` / `POOL_WORKER_TOKEN_AARCH64`; to rotate one,
  revoke the worker, register a new one, trust it, `gh secret set`.

## Costs

The account's card is capped at **US$ 30 a month**. What costs money on
Workers Paid is usage over the included quotas — above all D1 rows read
(25 B/month included, then US$ 0.001 per million) and rows written
(50 M/month included, then **US$ 1.00 per million**), then R2 storage
(US$ 0.015/GB after 10 GB; egress is free). The review of 2026-09-13 found
the overview re-scanning `release_packages` on every call (US$ 14 a day)
and every release copying its whole selection three times (index included).
What keeps the bill near US$ 10:

- a release's summary is computed once and stored (`releases.package_count`,
  `bytes`, `sources`); the pool-wide aggregates that need the join are
  computed by the metrics snapshot every 30 minutes, not per request;
- `release_packages` has no secondary index and GC prunes the membership
  of releases outside retention, so it holds what the last 3 releases per
  ring pin, not every release ever;
- the sync runs **every three hours, one task per architecture, one release
  per ring** — not one release per source per hour.

**Watching it.** Once a day (06:30 UTC) the brain estimates the month's
bill from Cloudflare's own analytics — what was used so far, priced, plus
the *current* rate (the last six hours, scaled) for the days left, so a fix
shows in the next estimate instead of being averaged with the expensive
days before it (`src/cost.ts`; secret
`CLOUDFLARE_ANALYTICS_TOKEN`, an API token with *Account Analytics: Read*
and *D1: Read*) and records a `cost` journal line; `GET /api/v1/cost` has
the breakdown and the overview shows the projection. `cost-report.yml`
(06:45 UTC) posts it as a comment on the *Cost report* issue — GitHub
e-mails it to whoever watches the issue — and fails the run at a projected
US$ 15, which is one more e-mail. Cloudflare's own budget notifications
e-mail at actual charges of US$ 10, 20 and 28 (*Notifications → Billing →
Usage based billing*; the API token cannot create them).

**The guard.** At a projected or actual US$ 25 the brain sets
`settings.cost_guard` and the scheduler stops creating the jobs that write
(sync, promote, render, security, enqueue) until the next daily estimate is
back under the line; health, gc and metrics keep running, the pool keeps
serving. The header of the overview says so. To lift it by hand:
`npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM settings WHERE key = 'cost_guard'"`.

## Known limits

* **D1 under a bulk import.** Importing a whole repository (thousands of
  manifests with file lists) makes the index the bottleneck: reads can hit
  D1's per-query CPU limit ("exceeded its CPU time limit and was reset") and
  `wrangler d1 migrations apply` in a release can fail on it — re-run the job.
  pacman is never affected (packages and databases are static objects on R2);
  the dashboard shows the index as *degraded* on its status pill. GET responses
  of the API are cached at the edge for their `max-age` (30 s for stats, 60 s
  for search and package pages, 120 s for security), so viewers do not multiply
  the load; the pages poll every 60–120 s and retry transient errors.

## Kill switch

```bash
cd worker && npx wrangler secret put JOB_TOKEN_SECRET   # a new value: every job token in flight stops working
# then set JOB_KINDS = "" in wrangler.toml and deploy: the scheduler queues nothing
```

Reads keep working (static objects); workers find no work and their tokens
buy nothing. Revoke a single worker with `DELETE /factory/workers/<id>`.

## Reset (ephemeral by design)

Everything is reproducible from `main` plus the secrets; a full rebuild from the
mirrors takes a few hours.

```bash
cd worker
npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM release_artifacts; DELETE FROM ring_heads; DELETE FROM release_packages; DELETE FROM releases; DELETE FROM package_files; DELETE FROM package_requires; DELETE FROM package_provides; DELETE FROM package_file_lists; DELETE FROM packages; DELETE FROM events; DELETE FROM sqlite_sequence;"
# optionally empty the bucket (objects are re-uploaded by the next sync, or kept and re-indexed)
pkg-repo job sync --param arch=x86_64 && pkg-repo job sync --param arch=aarch64
```

## Rotate the signing key

The private key lives only in the Worker secret `SIGNING_KEY` (armored
OpenPGP; `SIGNING_KEY_PASSPHRASE` when it has one). Generate it on a
trusted machine, pipe it straight into the secret and keep no copy:

```bash
export GNUPGHOME=~/.cache/omarchy-cli-poc/gnupg
gpg --batch --quiet --passphrase '' --quick-generate-key "Omarchy Staging Signing <staging@firemanxbr.org>" ed25519 sign 1y
KEY=$(gpg --list-keys --with-colons staging@firemanxbr.org | awk -F: '/^fpr/{print $10; exit}')   # newest
gpg --armor --export "$KEY" > docs/omarchy-staging.pub.asc
cd worker
gpg --batch --armor --export-secret-keys "$KEY" | npx wrangler secret put SIGNING_KEY
npx wrangler r2 object put omarchy-packages/omarchy-staging.pub.asc --file ../docs/omarchy-staging.pub.asc --remote
cd .. && gpg --batch --yes --delete-secret-keys "$KEY"   # the Worker is the only holder
curl -s https://pkgs.firemanxbr.org/api/v1/signing-key | jq .fingerprint   # the new key
for ring in edge rc stable; do for arch in x86_64 aarch64; do pkg-repo render --ring $ring --arch $arch; done; done
```

Clients must import the new public key (`pacman-key --add … && --lsign-key`).
Packages the factory built under the old key keep their signatures — those
verify against the old public key until each package is rebuilt (a
`POST /pool/:sha256/sign` per stored object re-signs them with the new one).

## Add a source or an architecture

A source is one row of `SYNC_SOURCES` in `worker/src/scheduler.ts`: source
name, arch, **ring** (`edge` for anything promotion should carry forward;
the OPR's own channels go straight into the matching ring), the directory
holding the `.db`, the db name, the keyring `tests/fetch-keyrings.sh`
produces, and the sources it defers to (`chaotic` defers to
`core,extra,multilib,packages,factory`: a name one of them serves is never
imported from chaotic-aur). Add the same source to `EXPECTED_SOURCES` in
`worker/src/meta.ts` (with `optional: true` for a repo users opt into on
*Get started*) and to the sources table on *How it works*. If it is a new
upstream project, add its keyring to `tests/fetch-keyrings.sh`. A new
architecture also needs an image in `tests/images.env`, a worker of that
architecture and the arch lists in `scheduler.ts` (`jobsOf`) and
`jobs.ts`.
