# Testing

Everything runs on a developer machine without root and without touching
production. Real Arch packages are used as fixtures wherever the behaviour depends
on the archive format.

## Quick check

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI (`.github/workflows/ci.yml`) runs exactly these on x86_64 **and** arm64 runners,
plus the worker typecheck and its tests, on every pull request. The three end-to-end scripts
below also run in GitHub Actions (`.github/workflows/e2e.yml`) on native x86_64
runners, where the Arch container needs no emulation. Both are required checks on
`main`, and `release.yml` runs them once more on the merged commit before it tags a
version and deploys the worker — so what is running is always a commit that passed
them twice.

## Rust crates

| Crate | What is covered | How |
|---|---|---|
| `pkg-manifest` | dependency rule parsing, `vercmp` against pacman's own test table, manifest JSON round-trip | unit tests |
| `pkg-extract` | `.PKGINFO` parsing, ELF magic detection, soname → Arch provide conversion, symbol version collapsing, Go build information (the `modinfo` string, replacements, the inline version header) | unit tests |
| `pkg-extract` | end-to-end manifests from **real** `zlib` and `xz` packages (`tests/fixtures/`) | `tests/fixtures.rs` |
| `pkg-repo` | `desc`/`files` rendering identical to `repo-add`, database determinism | unit + `tests/database.rs` |
| `omarchy-cli` | the MCP server's protocol handling: initialize, notifications, ping, tools/list, unknown methods, tool errors as results (`isError`) not protocol errors, bad arguments refused before any request | unit tests |
| `pkg-check` | pacman `desc` parsing, satisfiers, ABI check verdicts against a real `liblzma.so.5` | unit + `tests/check.rs` |
| `pkg-store` (`poc/crates`) | install / upgrade / remove, collisions, `.pacnew`, I/O failure rollback, crash recovery before and after commit | `tests/transactions.rs` against a temp root |

Useful invocations:

```bash
cargo test -p pkg-extract                 # one crate
cargo test -p pkg-store -- --nocapture    # see tracing output
RUST_LOG=debug cargo test -p pkg-store    # more detail
```

### Fixtures

`crates/pkg-extract/tests/fixtures/` holds unmodified packages downloaded from the
Arch `core` mirror. To refresh one:

```bash
curl -sSLO "https://geo.mirror.pkgbuild.com/core/os/x86_64/<file>.pkg.tar.zst"
```

Keep fixtures small (< 1 MB). Behavioural tests that need specific file layouts
build **synthetic** archives at runtime with `poc/crates/pkg-store/tests/common/mod.rs`
(`make_pkg`), so no new fixture is needed for a new scenario.

### Manual inspection

```bash
cargo run -p pkg-extract -- inspect crates/pkg-extract/tests/fixtures/xz-5.8.4-1-x86_64.pkg.tar.zst
cargo run -p pkg-extract -- index crates/pkg-extract/tests/fixtures -o /tmp/index.json
```

## Worker

```bash
cd worker && npm install
npm run typecheck
npm test                   # vitest inside workerd: unit and integration tests, about a second
npm run db:migrate:local   # applies migrations to a local D1
npm run dev                # http://localhost:8787 with local D1 + R2
```

`npm test` runs every file in `worker/test/` **inside the Workers runtime**
(`@cloudflare/vitest-pool-workers`, `vitest.config.ts`): a local D1 with every
migration applied before each file (`test/setup.ts`), a local R2, the
bindings of `wrangler.toml` plus a test `JOB_TOKEN_SECRET`. Nothing reaches
the network. Two kinds of tests live there:

| File | What is covered |
|---|---|
| `releases.test.ts` | the release logic through the Worker's own `fetch`: manifests indexed into the pool, `POST /releases` — first release, adds on top of the head, replace-by-name within an architecture, `remove` / `remove_arch`, promote `edge → rc → stable` by copying the source head, rollback to an earlier release (lineage, history, `is_head`), the scopes each ring needs; the diff between releases; `unchanged_arches`; `GET /releases/:ring` paged in `(name, arch)` order with `release_id` pinning, `arch=`, `include=files`; `GET /graph?arch=` (declared dependencies and provides, per architecture); `GET /stats` before any metrics snapshot; the delta model — a release writes only its delta, checkpoints every 24th, an old release read by id is reconstructed, retention keeps the checkpoint a rollback inside it needs and prunes the rest (410 beyond) |
| `factory.test.ts` | the factory's brain: claims with worker tokens (own architecture only, project vs community), leases and per-job tokens, heartbeat, fail → requeue, complete after the package is indexed, the agent a worker reports; a community build staging its evidence (the builder cannot write `audit.*`, the package is for maintainers, the rest is public), the audit queued and taken only by a project worker declaring the kind, the report attached and its verdict on `/factory/review`; approvals — a contributor cannot, a maintainer cannot approve their own package while another maintainer exists, the rebuild queued at project trust, the record and the profile's track record |
| `provenance.test.ts` | the OPR provenance scan against a stubbed GitHub: origin per package from the tree and `.omarchy/package.json`, only changed packages fetched again, packages gone from the repository dropped, the per-ring counts |
| `jobtoken`, `scheduler`, `governance`, `updates`, `metrics`, `cost`, `signing` | the pure functions: tokens and scopes, the scheduler's rules, the governance file, bump detection, the metrics snapshot shape, the bill estimate, OpenPGP signing |

The end-to-end script below covers the same paths with real containers and
real pacman; the unit tests are what a pull request runs in seconds.

Keep `worker/src/manifest.schema.json` in sync with the Rust types:

```bash
cd worker && npm run schema:sync && git diff --exit-code src/manifest.schema.json
```

## End-to-end: pacman against a generated database

Requires a container runtime (Podman or Docker) and `gpg`. The script indexes the
fixture packages, renders and signs the `omarchy` database with a throwaway key
(created on first run in `~/.cache/omarchy-cli-poc/gnupg`), signs the packages the
way a mirror or build would, and runs a real pacman (`archlinux:base`, x86_64) inside
a container with `SigLevel = Required DatabaseRequired` against a `file://` mirror:

```bash
tests/e2e-pacman.sh
```

It exercises `-Sy` (signed database accepted), `-Sl`, `-Si`, `-Sp`, the files
database (`-Fy`/`-Fl`), `-Sw` (download with signature verification) and a real
`-U` install. On Apple Silicon the x86_64 image runs under emulation; the first run
pulls the image.

| Symptom | Cause |
|---|---|
| `podman: command not found` | install Podman Desktop (or Docker) and `podman machine start` |
| `agent_genkey failed: No agent running` | `GNUPGHOME` path too long for a Unix socket; keep the default cache location |

## End-to-end: the whole pipeline through the worker

Same requirements plus the worker's npm dependencies. Starts a throwaway local
worker (`wrangler dev` with local D1 and R2 under `target/e2e-worker/`), publishes
the fixtures to `edge`, promotes `edge → rc → stable`, renders and signs the
`stable` databases, checks the mirror routes (databases, signatures, blobs, Range),
and finally runs pacman in a container against
`http://host.containers.internal:<port>/stable/os/$arch`:

```bash
tests/e2e-worker.sh
```

This is the local proof for POC questions 1 and 2: pool objects are uploaded once
(re-publishing is a no-op), promotion is an index write measured in milliseconds,
and pacman consumes the generated database exactly as it would a `repo-add` one.

The same run exercises the factory against seeded workers and contributors:
claims with worker and job tokens, a community build staged through the
job token and its evidence served, the audit it queues (a community worker
never gets it; the builder cannot write `audit.*`; a project worker declaring
the `audit` kind attaches the report with the audit's own token, and only
that; Review shows the verdict; the agent the worker reported at claim time
is listed on the Factory API), a shared worker waiting for `shared_after`,
the governance table and groups API, the profile page and API (with the
track record per group), the browser session (`/auth/me` with the
cookie, sign-out invalidating it on the server while the CLI token keeps
working), `workers/self`, and the approval rules (nobody approves their own
package; the bootstrap exception with a single maintainer).

Publisher commands used by the script, for manual runs against any worker:

```bash
export OMARCHY_API=http://127.0.0.1:8787 OMARCHY_TOKEN=<a job token>   # tests/e2e-worker.sh shows how one is minted from JOB_TOKEN_SECRET
pkg-repo publish --ring edge foo-1.0-1-x86_64.pkg.tar.zst   # pool + index + new edge release
pkg-repo promote --from edge --to rc                        # --arch aarch64: that architecture only
pkg-repo render --ring rc                                   # databases for the ring head (the pool signs them)
pkg-repo releases --ring rc                                 # history, newest first (--json, --all)
pkg-repo diff --ring rc                                     # what the head changed: added, removed, upgraded
pkg-repo rollback --ring rc --to <release id>               # then render again (--arch x86_64: that architecture only)
```

## End-to-end: the thin client

Runs `omarchy-cli` against the staging index and two real Arch systems exported
from containers (only `var/lib/pacman/local` and `usr/lib/lib*.so*` are extracted):

```bash
tests/e2e-client.sh
```

* current `archlinux:base` → `check xz` is safe, `install --dry-run` prints the
  `pacman -U` command; three `.hook` files dropped into the rootfs show the
  hook preview: one triggered by the package's name, one by a file it ships
  (`usr/bin/xz`, fetched from the ring), one not (a `Remove` trigger); a typo
  in `--ring` is refused before any request;
* `archlinux:base-20210131` (glibc 2.32) → `check xz` is **BLOCKED** on
  `libc.so.6(GLIBC_2.34)` with exit code 2 and pacman is never invoked;
* with `cargo-zigbuild` installed (`brew install zig && cargo install cargo-zigbuild`)
  the client is cross-compiled for `x86_64-unknown-linux-musl` and `omarchy-cli upgrade`
  runs inside the container: safety check, `pacman -U` from the pool with signature
  verification, hooks, and the release pin.

The container needs `DisableSandboxSyscalls` in `/etc/pacman.conf` because pacman
7's seccomp download sandbox cannot run under x86_64 emulation; the script sets it.

You can also point the client at any rootfs by hand:

```bash
OMARCHY_API=https://pkgs.firemanxbr.org omarchy-cli --root target/rootfs-2021 check xz
```

## Benchmark (historical)

The proof-of-concept benchmarks — the index model at scale and today's rsync +
repo-add mechanics at the same package count — live in `poc/bench/`
(`bench-promotion.sh`, `bench-current.sh`, `seed.py`) with their results in
[`poc/RESULTS.md`](../poc/RESULTS.md); the `Benchmark` workflow runs them by hand.

## The images the checks run in

`tests/images.env` pins `archlinux:base` and `menci/archlinuxarm:base` by
digest; every script that starts a container sources it, so a run today and
a run next month see the same image. `tests/pin-images.sh` moves the pins
to the current digests (commit the diff).

## Health check

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… tests/health-check.sh stable
```

Second argument selects the architecture (`x86_64` default, `aarch64` uses the Arch
Linux ARM image on an ARM host). Reads the ring's rendered repos from
`/api/v1/stats`, writes a `pacman.conf` with
`SigLevel = Required DatabaseRequired`, runs `pacman -Sy`, lists every repo and
downloads the first package with signature verification inside an Arch container,
then posts a `health` event (ok / warn when nothing is rendered / error). The
`health` job runs it daily for every ring and architecture; the `promote` job
runs it for the source ring before the gate and for the target ring after the
promotion — on the project worker, with the job's token (`OMARCHY_TOKEN`).

## ABI gate

`tests/abi-gate.sh <ring> [arch]` checks two references: the distribution's
base image and, on x86_64, the Omarchy installation `tests/omarchy-rootfs.sh`
builds from `stable` (cached a week under `OMARCHY_WORK_DIR`); the `abi`
event carries one entry per reference (`references`), blockers in either
block. Run by hand:

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… OMARCHY_KEYRINGS=… OMARCHY_WORK_DIR=… tests/abi-gate.sh rc x86_64
```

### The check itself

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… tests/abi-gate.sh rc x86_64
```

Exports the pacman database and shared libraries of the official base image
(`archlinux:base`, `menci/archlinuxarm:base` for aarch64), asks
`omarchy-cli status --json` which installed packages the ring would upgrade, and
runs `omarchy-cli check` on them in batches of 40 (each batch resolves its
dependency closure through `/api/v1/graph?arch=`). Posts an `abi` event with the
counts and the first blockers; exits 2 on any blocker, 1 if a batch could not be
checked. Runs in a few seconds; the `promote` job runs it for both architectures.

## Security matching

OSV: `cargo test -p pkg-repo osv` covers the matcher (a hit becomes an exact
advisory against every Arch package that embeds the component, one per
package; severities from the database's word, else a coarse reading of the
CVSS v3/v4 vector; Go versions lose their `v`); `cargo test -p pkg-repo osv --
--ignored` asks the real API about an old `golang.org/x/crypto` and caches
the record. The worker test indexes a manifest with components and checks
`GET /security/components` lists them once a ring serves the package.

### Trackers

```bash
curl -sfL https://security.archlinux.org/issues/all.json -o arch.json
curl -sfL https://security-tracker.debian.org/tracker/data/json -o debian.json
curl -sfL https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json -o kev.json
curl -sfL https://epss.cyentia.com/epss_scores-current.csv.gz | gunzip -c > epss.csv
pkg-repo security --arch-tracker arch.json --debian debian.json --kev kev.json --epss epss.csv --dry-run
```

The dry run prints the vulnerable matches by source and confidence and samples of
the Debian `name-version` matches (ours vs Debian's fixed version) to eyeball the
heuristics; without `--dry-run` it writes to the index and posts a `security`
event. The decisions are unit-tested in `crates/pkg-repo/src/security.rs`
(`cargo test -p pkg-repo security`): version comparison against Arch advisories,
Debian filling only what Arch does not cover, the upstream-version extraction
and the name-collision rejection. `tests/e2e-worker.sh` puts an advisory on the
zlib fixture and checks the ring report and the KEV flag.

```bash
pkg-repo fast-track --ring stable --from edge --dry-run     # candidates only; exit 3 when none
omarchy-cli --ring stable --root <rootfs> security          # installed packages with open advisories
omarchy-cli --ring stable --root <rootfs> upgrade --security-only --dry-run
```

The candidate rule (confident match, medium or worse or exploited in the wild,
a clean newer version in the source ring) is unit-tested with the rest of the
security module.

## The agent without a key

`factory/bin/agent.py` honours `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`GEMINI_BASE_URL` and `XAI_BASE_URL`, so a stub that answers
`POST /v1/messages` (Anthropic) and `POST …/chat/completions` (the
OpenAI-compatible path Gemini and xAI share) with a fixed report exercises
every provider path of `audit-pkgbuild` — parsing, the verdict check, the
Markdown rendering — without a key; `pkg-repo work
--kind audit --once` against a local pool with the same variables runs the
whole executor (fetch the staged evidence, attach `audit.json` / `audit.md`,
complete with the verdict).

## Promotion gate

`pkg-repo gate --from <ring> --to <ring> [--soak-days N] [--dry-run]` reads the
`health` and `abi` events and decides (exit 0 promote, 3 nothing to promote, 1
blocked, reasons printed and recorded as a `gate` event unless `--dry-run`). The
decision is a pure function with unit tests in `crates/pkg-repo/src/gate.rs`:
fresh green evidence promotes; a failed latest health, a failure inside the soak
window, stale or missing evidence, recent ABI blockers, or a security
regression (a package the target serves clean that the source would replace
with a version under an open exact advisory of medium severity or worse, or
in KEV — `security::security_regressions`, from `GET /security?ring=<from>`)
block; `warn` (nothing rendered for an architecture) is ignored; a target that
already serves the source's head is a skip. `cargo test -p pkg-repo gate` and
`cargo test -p pkg-repo regression` run them.

## Cloudflare (staging)

The staging worker runs at `https://pkgs.firemanxbr.org` (index API + dashboard at
`https://omarchy-pool.firemanxbr.org`) with a real D1 database and an R2 bucket
whose custom domain `https://pool.firemanxbr.org` serves packages and databases
statically. Deploying is what a merge into `main` does (`release.yml`, see
[RUNBOOK.md](RUNBOOK.md#releasing-the-pool-itself)); by hand, for a hotfix or a
rollback to an earlier tag:

```bash
cd worker
npx wrangler d1 migrations apply omarchy-repo --remote
npx wrangler deploy --var POOL_VERSION:vX.Y.Z --var POOL_COMMIT:$(git rev-parse HEAD) --var POOL_DEPLOYED_AT:$(date -u +%FT%TZ)
```

To try dashboard or API changes against the real data without deploying,
`npx wrangler dev --remote --port 8799` runs the local code with the remote D1
and R2 bindings (reads only, unless you publish to it).

Writing to the production pool is what jobs do, with the per-job token a
worker gets at claim time; there is no shared secret to export. A maintainer
runs any of them by hand by queueing the job (`pkg-repo job`, or
`POST /api/v1/factory/jobs` with their contributor token):

```bash
export OMARCHY_API=https://pkgs.firemanxbr.org OMARCHY_TOKEN=omc_…   # a maintainer's token
pkg-repo job sync --param source=core --param arch=x86_64             # import from mirror.omarchy.org → edge
pkg-repo job promote --param from=edge --param to=rc
pkg-repo job render --param ring=stable --param arch=x86_64           # one omarchy-<source>-stable db per source
pkg-repo job gc --param keep=3
```

The same commands run directly (`pkg-repo sync|publish|promote|render|gc`)
against a local pool with a job token (`tests/e2e-worker.sh` mints one).

With `--keyring <file>` the sync rejects any package whose upstream `.sig` does
not verify against that keyring; `tests/fetch-keyrings.sh <dir>` builds
`archlinux.gpg`, `archlinuxarm.gpg` and `omarchy.gpg`. Arch Linux ARM and the OPR
have their own layouts: `--base-url http://os.archlinuxarm.org/aarch64/core --arch aarch64`,
`--base-url https://pkgs.omarchy.org/edge/x86_64 --db-name omarchy --source packages`.

The scheduler queues exactly these as jobs (sync every 3 h, promote daily,
health daily, security every 3 h, gc weekly, enqueue hourly); project workers
run them. No GitHub workflow writes to the pool.

To validate with pacman, use the same container recipe as the local scripts with

```
[omarchy-core-stable]
Server = https://pool.firemanxbr.org/$arch
```

and the POC public key imported into `pacman-key`. This has been exercised end to end:
`-Sy` accepts the signed database, `-Sw` downloads the package and its signature from
the pool through the worker, and `-U` installs it.
