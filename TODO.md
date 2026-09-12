# TODO

Open work, roughly in order of value for effort. The POC questions are answered
(see [docs/POC-RESULTS.md](docs/POC-RESULTS.md)) and the staging environment runs
the whole pipeline on every upstream repository; everything here is what would
turn it into something the migration can rely on. Pick an item, open a pull
request (see [CONTRIBUTING.md](CONTRIBUTING.md)), and keep
[docs/TESTING.md](docs/TESTING.md) in step with what you add.

## Quick wins (an hour or so each)

- [ ] **Hook preview in `omarchy-cli check`.** Parse the libalpm `.hook` files in
      `/usr/share/libalpm/hooks` and `/etc/pacman.d/hooks` and list which ones the
      plan would trigger (`mkinitcpio`, `glib-compile-schemas`, …). Read-only;
      `crates/pkg-hooks` already has the types.
- [ ] **`pkg-repo releases --json`** (and `--all` for every ring at once), so agents
      and scripts read release state without scraping text; `head` covers the
      common case today.
- [ ] **Release diff.** `GET /api/v1/releases/:ring/diff?from=<id>&to=<id>` returning
      added / removed / upgraded packages, and `pkg-repo diff`. Cheap with
      `release_packages`; the promotion and rollback events would link to it.
- [ ] **Client config file example** in `docs/` (`/etc/omarchy-cli/config.toml`)
      and a `--ring` sanity check against the index (`edge|rc|stable` only).
- [ ] **Coverage on the dashboard for `any` packages built twice.** Arch Linux ARM
      rebuilds and re-signs architecture-independent packages; count how many bytes
      that costs the pool (cheap, but worth knowing).

## Medium (half a day)

- [ ] **Worker unit tests.** Cover `POST /api/v1/releases` (promote, rollback,
      add/remove, per-arch), the paged release view, `/graph?arch=` and `/stats`
      with `@cloudflare/vitest-pool-workers` + `applyD1Migrations`, so the release
      logic is tested in seconds instead of only by the end-to-end scripts.
- [ ] **Package provenance.** Record, per OPR package, the PKGBUILD commit and
      whether it is AUR-synced or Omarchy's own (`omarchy-pkgs` has
      `.omarchy/package.json`), and show on the dashboard how many packages in
      `stable` still come from an AUR-synced PKGBUILD — the number to drive to zero.
- [ ] **Per-architecture promotion.** `promote` copies the whole selection; add
      `--arch` to `POST /api/v1/releases` (copy only rows of that arch, keep the
      others) so x86_64 and aarch64 can move at different times when one
      architecture's evidence is red and the other's green.
- [ ] **ABI gate on real installations.** The gate checks the upgrades against the
      official base image; run it also against an exported Omarchy installation
      (the ISO's package set) so the check covers what users actually have.
- [ ] **`omarchy-cli` MCP surface.** The `--json` outputs of `status`, `check`,
      `info` and `list` are the shape an MCP server would expose; wrap them.

## Larger (needs a design conversation first)

- [ ] **Production keys and hosting.** The staging database key is throwaway and
      the pool lives on a personal account; moving to omarchy.org means a key in
      the team's custody (the workflows only need `OMARCHY_GPG_KEY` /
      `OMARCHY_GPG_KEYID`), the Cloudflare resources in the team's account, and
      `STABLE_ENVIRONMENT=stable` if the team wants a human before stable moves.
- [ ] **Native install engine.** `crates/pkg-store` (redb state + journaled,
      crash-safe transactions) is implemented and tested but not wired into the
      client. Wiring it means also writing pacman's local database
      (`/var/lib/pacman/local/<pkg>/{desc,files,mtree}`) and running `.hook` /
      `.INSTALL` scriptlets, or pacman and yay stop seeing what it installs. Only
      worth it if the thin client proves insufficient.
- [ ] **Multi-repo per ring.** `release_artifacts` is keyed by `(repo, arch)` already;
      allow more than one `[repo]` section per source and ring end to end through
      `render` and the mirror route (e.g. `omarchy-t2`).

## Housekeeping

- [ ] Rotate the staging key (`docs/omarchy-staging.pub.asc`, expires 2027-09-12)
      before it expires; the workflows read it from the `OMARCHY_GPG_KEY` secret.
- [ ] Pin the `archlinux:base` / `menci/archlinuxarm:base` image digests used by
      the e2e, health and ABI scripts for reproducible runs.
- [ ] The `events` table grows by ~1.5k rows a month from the metrics snapshots;
      prune snapshots older than 90 days in the GC workflow.

## Done (kept for the record)

Pool retention with grace period · signature verification on import against the
upstream keyrings · resilient publishing (retries, parallel imports, per-source
reports) · every Arch, Arch Linux ARM and OPR repository mirrored on both
architectures · paged release view · evidence-driven promotion with ABI check and
automatic rollback · releases of the pool itself on every merge · dashboard with
coverage, charts and pipeline metrics.
