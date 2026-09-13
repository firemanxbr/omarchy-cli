# TODO

Open work, roughly in order of value for effort. The POC questions are answered
(see [poc/RESULTS.md](poc/RESULTS.md)) and the staging environment runs
the whole pipeline on every upstream repository; everything here is what would
turn it into something the migration can rely on. Pick an item, open a pull
request (see [CONTRIBUTING.md](CONTRIBUTING.md)), and keep
[docs/TESTING.md](docs/TESTING.md) in step with what you add.

## Quick wins (an hour or so each)


## Medium (half a day)



## Larger (needs a design conversation first)

- [ ] **Audit the rebuild too.** The second agent reads the staged
      evidence; a second pass on the project's own rebuild (its log and
      `.PKGINFO` against the staged ones) would catch a recipe that builds
      differently on the trusted worker.

- [ ] **Production keys and hosting.** The staging database key is throwaway and
      the pool lives on a personal account; moving to omarchy.org means a key in
      the team's custody (one Worker secret, `SIGNING_KEY`, RUNBOOK *Rotate the
      signing key*), the Cloudflare resources in the team's account, and
      the OAuth App and the two hosted-worker tokens registered under it.
- [ ] **Native install engine.** `poc/crates/pkg-store` (redb state + journaled,
      crash-safe transactions) is implemented and tested but not wired into the
      client. Wiring it means also writing pacman's local database
      (`/var/lib/pacman/local/<pkg>/{desc,files,mtree}`) and running `.hook` /
      `.INSTALL` scriptlets, or pacman and yay stop seeing what it installs. Only
      worth it if the thin client proves insufficient.
- [ ] **Multi-repo per ring.** `release_artifacts` is keyed by `(repo, arch)` already;
      allow more than one `[repo]` section per source and ring end to end through
      `render` and the mirror route (e.g. `omarchy-t2`).

## Upstream findings worth reporting

- [ ] **Arch Linux ARM ships x86_64 binaries in aarch64-labelled packages**:
      `gtpin`, `intel-oneapi-*`, `openai-codex-desktop` in `extra` need
      `GLIBC_2.2.5` (an x86_64 symbol version); the ABI gate found them on
      2026-09-12. They cannot run on aarch64; report to ALARM.

- [ ] **OPR: `opencode-1.1.51-1` in the rc channel is signed by a key that is not
      in Omarchy's published keyring** (`omarchy-iso` `builder/omarchy.gpg`); the
      pool rejects it. Report to the OPR maintainers.
- [ ] **OPR rebuilds the same version with different bytes per channel** (76
      packages on 2026-09-12, e.g. `wayfreeze-0.2.0-1`). The pool keeps the object
      it already has for that filename and says so in the journal; ask whether
      channel builds could be promoted as-is instead of rebuilt.

- [ ] **Health summary shows an empty package count** in the journal ("( packages
      across N repos)") when pacman's progress output hides the TOTAL line; the
      parse was relaxed, verify on the next runs.

## Housekeeping

- [ ] Rotate the staging key (`docs/omarchy-staging.pub.asc`, expires 2027-09-12)
      before it expires; it is the Worker secret `SIGNING_KEY` (RUNBOOK).
- [x] ~~The `events` table grows by ~1.5k rows a month from the metrics snapshots~~ — the snapshot prunes the ones older than 90 days.

## Done (kept for the record)

Pool retention with grace period · signature verification on import against the
upstream keyrings · resilient publishing (retries, parallel imports, per-source
reports) · every Arch, Arch Linux ARM and OPR repository mirrored on both
architectures · paged release view · evidence-driven promotion with ABI check and
automatic rollback · releases of the pool itself on every merge · dashboard with
coverage, charts and pipeline metrics · user-facing dashboard (rings guidance, Get
started, How it works, Status, API docs, mobile) · package search and package page
with dependency graph · OPR channels per ring, chaotic-aur as optional repo ·
security layer (Arch + Debian trackers, KEV, EPSS, confidence levels, exposure
through the graph, fast-track of fixes, `omarchy-cli security`) · paged release
view and linear release creation at 30k packages · edge-cached API reads ·
the factory: contributors' workers and staging, maintainers' approvals, the
project's rebuild, package requests and bumps as evidence · every pipeline
step a pulled job with a per-job token, no shared secret, GitHub only
releasing · signing inside the Worker · governance from a file, two roles ·
the cost estimate, the guard and the daily report · one worker image for
everyone, nobody approves their own package · the second agent (the audit
of a staged build, attached to its evidence) · the track record per group
on profiles · any agent provider on a worker · Worker tests inside workerd
(releases, the factory) · release diff (API, page, `pkg-repo diff`),
`releases --json --all`, the rollback button, databases kept for an
architecture a release did not touch, CVE metadata pruned by gc · releases
stored as deltas with checkpoints every 24th · OPR provenance (Omarchy's own
or AUR-synced, per package; the AUR count in stable on the overview) ·
security regressions block a promotion · promotion and rollback per
architecture · the client's hook preview, config example and ring check ·
`any` packages stored twice, counted on the overview · what statically linked
binaries embed (Go modules, cargo-auditable crates) in the manifest and the
index · OSV advisories against them · the ABI gate against an Omarchy
installation too · the verify job (served OPR objects checked and repaired).

## Factory findings (2026-09-12)

- OPR aarch64 `omarchy` cannot be installed in a clean Arch Linux ARM container: `unable to satisfy dependency 'hyprland' required by omarchy` although `omarchy-packages-edge` serves `hyprland 0.56.2-3` for aarch64 (version constraint?). Anything depending on `omarchy` (flea) cannot be built for aarch64 until that is understood.
- The OPR ships most names for aarch64 too; what is missing there is mostly `-debug` packages, x86-only drivers/kernels/nvidia, proprietary binaries (dropbox, spotify, cursor, lmstudio…) and a few Omarchy tools (omakade, omapresent, omareel, omarchy-herdr, schist, flea, hey-cli, vi, pinta). Their PKGBUILDs are not in the AUR except hey-cli, vi, flea.
- An `any` package is stored once per architecture directory (sha256 is unique in the index), so an `any` PKGBUILD builds once per architecture.

