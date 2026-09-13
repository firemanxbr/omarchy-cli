# omarchy-pool

One package repository for [Omarchy](https://omarchy.org): every Arch Linux, Arch
Linux ARM and Omarchy (OPR) package, verified against its project's signing key,
stored once in an **immutable pool**, and served in three **rings** —
`edge` follows upstream within hours, `rc` is what passed a real pacman and an ABI
check on both architectures a day later, `stable` is what stayed healthy in `rc`
for another day — with **automatic rollback** when a promotion fails its checks.
Packages stay unmodified `makepkg` output; pacman reads generated, signed
databases as plain static files; a **thin client** adds release awareness and an
ELF-level safety check; a **security layer** matches public advisories to what
each ring serves and fast-tracks fixes.

**Live:** https://omarchy-pool.firemanxbr.org · packages and databases at
https://pool.firemanxbr.org · API at https://pkgs.firemanxbr.org/api/v1

## Use it

Three steps, generated for your ring and architecture on
[Get started](https://omarchy-pool.firemanxbr.org/docs/get-started):

```bash
# 1. trust the key that signs the databases (packages keep their upstream signatures)
curl -O https://pool.firemanxbr.org/omarchy-staging.pub.asc
sudo pacman-key --add omarchy-staging.pub.asc && sudo pacman-key --lsign-key staging@firemanxbr.org

# 2. /etc/pacman.conf — one host for every repository and both architectures
[omarchy-core-stable]
SigLevel = Required DatabaseRequired
Server = https://pool.firemanxbr.org/$arch
[omarchy-extra-stable]
SigLevel = Required DatabaseRequired
Server = https://pool.firemanxbr.org/$arch
[omarchy-multilib-stable]
SigLevel = Required DatabaseRequired
Server = https://pool.firemanxbr.org/$arch
[omarchy-packages-stable]
SigLevel = Required DatabaseRequired
Server = https://pool.firemanxbr.org/$arch

# 3.
sudo pacman -Syu
```

Change `stable` to `rc` or `edge` to change rings. The optional
`[omarchy-chaotic-<ring>]` adds prebuilt AUR packages (x86_64).

The thin client ships with every [release](https://github.com/firemanxbr/omarchy-pool/releases):

```bash
omarchy-cli status                    # what the ring would change on this machine
omarchy-cli check <pkg>               # ABI safety check before an out-of-band install (exit 2 if unsafe), and the hooks pacman would run
omarchy-cli upgrade                   # pacman -U from the pool, then pin the release
omarchy-cli security                  # installed packages with open advisories, and where the fix is
omarchy-cli upgrade --security-only
```

## How it works

Read [How it works](https://omarchy-pool.firemanxbr.org/docs/how-it-works) on the
dashboard, or [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design:
the pool and index, the release model, promotion by evidence (health + ABI gate,
one-day soak, automatic rollback), the sources, the security layer, the pipeline.
Packages nobody ships yet come through the factory: contributors build them
with the same tools maintainers use (one signed worker image for everyone,
the owner's own agent if they like — Anthropic, OpenAI, Gemini or xAI), a
second agent audits the staged evidence, maintainers rebuild and attest
them, never their own — *we do not use what you built, we learn from it*
([docs/GOVERNANCE.md](docs/GOVERNANCE.md)).

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | design, API, pipeline, security |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | operating it: jobs, promotions, keys, costs, the kill switch, the scheduler, known limits |
| [docs/GOVERNANCE.md](docs/GOVERNANCE.md) | contributors and maintainers, groups, how a pull request is the only way to become a maintainer |
| [SECURITY.md](SECURITY.md) | the trust model: who holds what, per-job tokens, the key that never leaves the pool |
| [docs/TESTING.md](docs/TESTING.md) | how every piece is verified, locally and in CI |
| [docs/MIGRATION.md](docs/MIGRATION.md) | moving the whole thing to another Cloudflare account and GitHub organisation |
| [CONTRIBUTING.md](CONTRIBUTING.md) | pull requests, releases, versions |
| [TODO.md](TODO.md) | open work, and findings to report upstream |
| [poc/](poc/) | the proof of concept this grew out of: the three questions, the evidence, the benchmarks, the parked native engine |

## Layout

```
crates/
  pkg-manifest/   shared types, dependency rules, Arch-compatible vercmp, the build version
  pkg-extract/    .pkg.tar.{zst,xz} inspection → PackageManifest (lib + binary)
  pkg-repo/       the publisher: sync, publish, promote, gate, fast-track, render, security, gc
  pkg-check/      the ABI safety check (ELF symbol versions against a system)
  omarchy-cli/    the thin client
worker/           Cloudflare Worker (TypeScript): index API, dashboard pages, the scheduler (jobs, governance, requests, bumps, cost); D1 migrations
tests/            end-to-end scripts (real pacman), health check, ABI gate, keyring fetcher, pinned images
docs/             architecture, runbook, governance, testing, migration, diagrams, the signing key's public part
factory/          the factory: the governance file, the worker script and image, the project's own recipes (a tenant; moves out later)
poc/              the proof of concept: results, benchmarks, parked crates
.github/          CI, E2E, Release (every merge), Sync, Promote, Health, Security, Metrics, GC, Factory
```

## Releases

Every merge into `main` is a release: [`release.yml`](.github/workflows/release.yml)
re-runs CI and E2E, tags the next version (`v0.0.1`, `v0.0.2`, … — patch by default,
`release:minor` / `release:major` labels bump the rest), builds the binaries for
x86_64 and aarch64, publishes a GitHub release and deploys the worker. The dashboard
header and `/api/v1/version` show what is running. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
cargo build --workspace && cargo test --workspace && cargo clippy --workspace --all-targets
cd worker && npm install && npm run typecheck && npm test
tests/e2e-worker.sh          # real pacman through a local worker (docker or podman)
```

## License

MIT
