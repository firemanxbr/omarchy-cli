# Runbook

Operating the staging environment. Nothing here is done by hand on the servers:
every write goes through the worker with the publish token, which lives only in
GitHub Actions secrets; humans and agents operate the pipeline through the
workflows and the publisher.

| | |
|---|---|
| Dashboard | https://omarchy-pool.firemanxbr.org |
| Index API | https://pkgs.firemanxbr.org/api/v1/stats |
| Pool (static, what pacman reads) | https://pool.firemanxbr.org/x86_64/ · `/aarch64/` |
| Database signing key | `docs/omarchy-staging.pub.asc` · https://pool.firemanxbr.org/omarchy-staging.pub.asc (expires 2027-09-12) |
| Workflows | Sync (hourly) · Promote (edge→rc 06:00 UTC, rc→stable 09:00 UTC, evidence-gated, auto-rollback) · Health (daily, both arches) · GC (Sundays) · Metrics (every 30 min) · Release (every merge into `main`) |
| Running version | https://pkgs.firemanxbr.org/api/v1/version · the chip in the dashboard header |

## Trust model

* **Packages are never re-signed.** The sync imports a package only if its
  upstream `.sig` verifies against the upstream project's keyring
  (`archlinux.gpg`, `archlinuxarm.gpg`, `omarchy.gpg` — built by
  `tests/fetch-keyrings.sh`). A machine using the pool verifies packages with the
  keys it already trusts (`archlinux-keyring`, `archlinuxarm-keyring`, Omarchy's).
* **Only the databases are signed by the staging key.** Trusting the pool means
  trusting one key for `omarchy-*-<ring>.db`; nothing else.
* **The pool is append-only.** The worker refuses to overwrite an existing object;
  the only deletions are retention (`gc`), which never touches anything the last
  three releases of any ring reference, nor anything younger than seven days.
* **Releases are append-only.** Rollback creates a new release pointing at an old
  selection; history is never rewritten. Every action posts an event.
* **stable needs a human.** Promotions into `stable` run in the GitHub environment
  `stable`, which requires a reviewer's approval; edge → rc is automatic.
* **Nobody holds R2 credentials.** Reads are public objects; writes go through
  the worker with `PUBLISH_TOKEN` (GitHub secret); the R2 bucket has no API tokens.

## Everyday operations

```bash
# manual runs (repository variables OMARCHY_API/OMARCHY_POOL and secrets are set)
gh workflow run sync.yml -f sources="core-x86_64 packages-x86_64" -f limit=0
gh workflow run promote.yml -f from=edge -f to=rc -f note="…"
gh workflow run promote.yml -f from=rc -f to=stable -f note="…"   # 3-day soak of rc by default
gh workflow run promote.yml -f from=rc -f to=stable -f soak_days=0 -f force=yes   # skip the gate (emergency)
gh workflow run health.yml
gh workflow run gc.yml -f keep=3
```

Promotions are gated by evidence (see *Promotion by evidence* in
[ARCHITECTURE.md](ARCHITECTURE.md)): the run first records fresh `health` and
`abi` events for the source ring on both architectures, then `pkg-repo gate`
decides — promote, nothing to promote, or blocked with the reasons in a `gate`
event on the dashboard. After a promotion the target ring is health-checked on
both architectures and rolled back automatically if that fails (`rollback` event
naming the failed and the restored release).

To require a human approval before stable moves, set the repository variable
`STABLE_ENVIRONMENT=stable` (`gh variable set STABLE_ENVIRONMENT -b stable`); the
Promote job then waits in the `stable` environment: GitHub → Actions → the
waiting run → *Review deployments* → approve. Unset the variable to go back to
fully automatic.

```bash
# the same decisions by hand
pkg-repo fast-track --ring stable --from edge --dry-run        # security fixes edge has and stable lacks (exit 3: none)
pkg-repo gate --from rc --to stable --soak-days 3 --dry-run   # exit 0 promote, 3 nothing new, 1 blocked
pkg-repo head --ring stable                                    # current release id (rollback target)
tests/abi-gate.sh rc x86_64                                    # ABI check of rc's upgrades, exit 2 on blockers
```

Locally, with `OMARCHY_API`, `OMARCHY_PUBLISH_TOKEN` (and the GPG key) set:

```bash
pkg-repo releases --ring stable                    # history, head marked *
pkg-repo rollback --ring stable --to <release id>  # then render
pkg-repo render --ring stable --arch x86_64 --sign <key id>
pkg-repo gc --keep 3                               # report; add --delete to free the pool
```

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
   `/api/v1/version` reports the new tag and posts a `deploy` event.

The deploy step needs the `CLOUDFLARE_API_TOKEN` repository secret (Account →
Workers Scripts: Edit, D1: Edit, Account Settings: Read; Zone → Workers Routes:
Edit, Zone: Read, for `firemanxbr.org`). Without it the release is still
published and the run ends with a warning instead of a deployment.

Rolling the worker back is deploying an earlier release: re-run the Deploy job of
that release's run, or `git checkout vX.Y.Z && cd worker && npx wrangler deploy
--var POOL_VERSION:vX.Y.Z`. Migrations are forward-only; keep them additive.

## Security data

`security.yml` (every 3 h) fetches the Arch and Debian trackers, KEV and EPSS,
matches them (`pkg-repo security`) and then fast-tracks fixes into `rc` and
`stable` (`pkg-repo fast-track`, `--min-severity medium`, exploited-in-the-wild
always). Both are safe to run by hand with `--dry-run`. A wrong match is a
tracker's mistake or a name collision: open an issue with the package and the
advisory id shown on the package page; the `same_project` heuristic in
`crates/pkg-repo/src/security.rs` is where collisions are rejected.

## Kill switch

```bash
for w in sync promote health gc; do gh workflow disable "$w.yml"; done   # stop all writes
cd worker && npx wrangler secret put PUBLISH_TOKEN                       # or rotate the token
```

Reads keep working (static objects); nothing changes until the workflows are
enabled again.

## Reset (ephemeral by design)

Everything is reproducible from `main` plus the secrets; a full rebuild from the
mirrors takes a few hours.

```bash
cd worker
npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM release_artifacts; DELETE FROM ring_heads; DELETE FROM release_packages; DELETE FROM releases; DELETE FROM package_files; DELETE FROM package_requires; DELETE FROM package_provides; DELETE FROM package_file_lists; DELETE FROM packages; DELETE FROM events; DELETE FROM sqlite_sequence;"
# optionally empty the bucket (objects are re-uploaded by the next sync, or kept and re-indexed)
gh workflow run sync.yml -f limit=0
```

## Rotate the database signing key

```bash
export GNUPGHOME=~/.cache/omarchy-cli-poc/gnupg
gpg --batch --quiet --passphrase '' --quick-generate-key "Omarchy Staging Signing <staging@firemanxbr.org>" ed25519 sign 1y
KEY=$(gpg --list-keys --with-colons staging@firemanxbr.org | awk -F: '/^fpr/{print $10; exit}')   # newest
gpg --armor --export "$KEY" > docs/omarchy-staging.pub.asc
gpg --batch --armor --export-secret-keys "$KEY" | gh secret set OMARCHY_GPG_KEY
gh secret set OMARCHY_GPG_KEYID --body "$KEY"
cd worker && npx wrangler r2 object put omarchy-packages/omarchy-staging.pub.asc --file ../docs/omarchy-staging.pub.asc --remote
gh workflow run promote.yml -f from=rc -f to=rc   # re-render each ring with the new key
```

Clients must import the new public key (`pacman-key --add … && --lsign-key`).

## Add a source or an architecture

A source is one row in the `SOURCES` table of `sync.yml`: id, source name, arch,
**ring** (`edge` for anything promotion should carry forward; the OPR's own
channels go straight into the matching ring), the directory holding the `.db`,
the db name, the keyring `tests/fetch-keyrings.sh` produces, and the sources it
defers to (`chaotic` defers to `core,extra,multilib,packages`: a name one of
them serves is never imported from chaotic-aur). Add the same source to
`EXPECTED_SOURCES` in `worker/src/meta.ts` (with `optional: true` for a repo
users opt into on *Get started*) and to the sources table on *How it works*.

Add a line to the `SOURCES` table in `.github/workflows/sync.yml` (id, source,
arch, directory URL, db name, keyring). If it is a new upstream project, add its
keyring to `tests/fetch-keyrings.sh`. New architectures also need a health image
in `tests/health-check.sh` and a runner in `health.yml`.

## Budget

R2 storage is the only cost that grows (~$0.015/GB-month; the full x86_64 Arch
set is ~110 GB). Retention keeps it bounded to what the last three releases per
ring reference. Workers Paid ($5/month) covers D1 and the worker.
