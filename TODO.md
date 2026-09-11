# TODO

Open work, roughly in order of value for effort. The POC questions are answered
(see [docs/POC-RESULTS.md](docs/POC-RESULTS.md)); everything here is what would
turn it into something the migration can rely on. Pick an item, open an issue or a
PR, and keep [docs/TESTING.md](docs/TESTING.md) in step with what you add.

## Quick wins (an hour or so each)

- [ ] **Pool retention.** `GET /api/v1/pool/unreferenced` listing objects no release
      references, plus `pkg-repo gc --dry-run` / `--delete`. The query is
      `packages LEFT JOIN release_packages … WHERE release_id IS NULL`; deleting
      also removes the R2 object and its `.sig`.
- [ ] **Per-architecture promotion.** `packages.arch` exists and `render --arch`
      filters on it, but `promote` copies the whole selection. Add `--arch` to
      `POST /api/v1/releases` (copy only rows of that arch, keep the others) so
      x86_64 and aarch64 can move at different times, as `advance-channel --arch`
      does today.
- [ ] **Hook preview in `omarchy-cli check`.** Parse the libalpm `.hook` files in
      `/usr/share/libalpm/hooks` and `/etc/pacman.d/hooks` and list which ones the
      plan would trigger (`mkinitcpio`, `glib-compile-schemas`, …). Read-only;
      `crates/pkg-hooks` already has the types.
- [ ] **Upload limits.** Document the Workers request-body limit on
      `PUT /api/v1/pool/:sha256` and return 413 early from `content-length`; note
      the direct-to-R2 (presigned multipart) path for packages above it.
- [ ] **`pkg-repo releases` for every ring at once** and a `--json` flag, so
      dashboards and agents can read release state without scraping text.
- [ ] **Client config file example** in `docs/` (`/etc/omarchy-cli/config.toml`)
      and a `--ring` sanity check against the index (`edge|rc|stable` only).

## Medium (half a day)

- [ ] **Resilient publishing.** `pkg-repo publish` stops at the first failed
      request. Add retry with backoff, a concurrency flag, and a summary of what was
      uploaded / skipped / failed; publishing a whole mirror sync needs this.
- [ ] **Worker unit tests.** Cover `POST /api/v1/releases` (promote, rollback,
      add/remove, per-arch), the mirror resolver and `/graph` with
      `@cloudflare/vitest-pool-workers` + `applyD1Migrations`, so the release logic
      is tested in seconds instead of only by the end-to-end scripts.
- [ ] **Import a real slice of the Arch mirror.** `rsync` `core/os/x86_64` (~1 GB),
      `pkg-repo publish` it to staging with the upstream `.sig` files, then run
      `tests/e2e-client.sh` against it. This is the evidence at real scale that
      the synthetic benchmark approximates.
- [ ] **Signature verification at publish time.** `PUT /api/v1/pool/:sha256/sig`
      stores whatever it is given; verify the detached signature against a
      configured keyring (or reject unsigned uploads) before indexing.
- [ ] **Release notes / diff.** `GET /api/v1/releases/:ring/diff?from=<id>&to=<id>`
      returning added / removed / upgraded packages, and `pkg-repo diff`. Cheap
      with `release_packages`; useful for the promotion announcement.
- [ ] **`omarchy-cli` MCP surface.** The `--json` outputs of `status`, `check`,
      `info` and `list` are the shape an MCP server would expose; wrap them.

## Larger (needs a design conversation first)

- [ ] **Mirror sync feeding the index.** Replace `omarchy-mirror-sync`'s
      rsync → rclone flow with `pkg-extract` + `pkg-repo publish` driven by the
      upstream database, so core/extra/multilib live in the same pool and rings as
      Omarchy's own packages. Decide the retention policy first.
- [ ] **Signing in CI.** Move database signing from a local GPG key to the build
      pipeline's key handling (`omarchy-pkgs` already signs packages there); the
      publisher only needs `gpg --detach-sign`.
- [ ] **Native install engine.** `crates/pkg-store` (redb state + journaled,
      crash-safe transactions) is implemented and tested but not wired into the
      client. Wiring it means also writing pacman's local database
      (`/var/lib/pacman/local/<pkg>/{desc,files,mtree}`) and running `.hook` /
      `.INSTALL` scriptlets, or pacman and yay stop seeing what it installs. Only
      worth it if the thin client proves insufficient.
- [ ] **Multi-repo per ring.** `release_artifacts` is keyed by `(repo, arch)` already;
      allow more than one `[repo]` section per ring (e.g. `omarchy` and `omarchy-t2`)
      end to end through `render` and the mirror route.

## Housekeeping

- [ ] Replace the throwaway POC key (`docs/omarchy-poc.pub.asc`, expires
      2026-10-11) before it expires or the staging mirror stops validating.
- [ ] `tests/e2e-client.sh` depends on `pkgs.firemanxbr.org` being up; mirror the
      fixture publish into the script (like `e2e-worker.sh`) so CI does not depend on
      staging.
- [ ] Pin the `archlinux:base` image digests used by the e2e scripts for
      reproducible runs.
