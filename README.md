# omarchy-pool

The package pool for the [Omarchy](https://omarchy.org) repository migration:
an **immutable package pool** on Cloudflare R2, an **index** on D1 where `edge`,
`rc` and `stable` are pinned selections, **generated, signed pacman databases**
served statically, a **publisher** that syncs Arch, Arch Linux ARM and Omarchy
packages into it with upstream signature verification, a public **dashboard**, and
a **thin client** (`omarchy-cli`) that understands releases and blocks unsafe
partial upgrades.

* Packages stay unmodified `makepkg` output — no new format, no new build tool.
* Promoting a release is an index write, not a 275 GB copy.
* pacman keeps working through generated `repo-add` databases.
* `omarchy-cli` drives pacman and adds release awareness plus an ABI-level safety
  check built from the ELF soname graph.

> Status: proof of concept — results in [docs/POC-RESULTS.md](docs/POC-RESULTS.md).
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design,
> [docs/TESTING.md](docs/TESTING.md) for how to verify it, [docs/RUNBOOK.md](docs/RUNBOOK.md)
> to operate the staging environment, and [TODO.md](TODO.md) if you want to help.

## The staging environment

**Dashboard: https://omarchy-pool.firemanxbr.org** — the pool, the three rings,
every sync/promotion/render/health check as it happens.

The pipeline runs hourly on GitHub Actions: it imports Arch `core`, `extra` and
`multilib` from the Omarchy edge mirror into one immutable pool on R2, pins them on
`edge`, promotes `edge → rc` daily and `rc → stable` weekly, renders and signs one
pacman database per source and ring, and checks each ring with a real pacman.
Packages and databases are plain objects served from **https://pool.firemanxbr.org**:

```ini
# /etc/pacman.conf — databases live beside the packages; only the repo name changes per ring
[omarchy-core-stable]
Server = https://pool.firemanxbr.org/$arch

[omarchy-extra-stable]
Server = https://pool.firemanxbr.org/$arch
```

Databases are signed with the staging key (`docs/omarchy-staging.pub.asc`, also at
`https://pool.firemanxbr.org/omarchy-staging.pub.asc`, expires 2027-09-12); packages
keep their upstream Arch / Arch Linux ARM / Omarchy signatures:

```bash
curl -O https://pool.firemanxbr.org/omarchy-staging.pub.asc
sudo pacman-key --add omarchy-staging.pub.asc && sudo pacman-key --lsign-key staging@firemanxbr.org
```

The index API lives at **https://pkgs.firemanxbr.org/api/v1/** and the thin client
uses it by default:

```bash
omarchy-cli status          # pinned release vs. what stable serves now
omarchy-cli check xz        # ABI safety check against this machine, exit 2 if unsafe
omarchy-cli upgrade         # pacman -U from the pool, then pin the release
omarchy-cli security        # installed packages with open advisories, and where the fix is
omarchy-cli upgrade --security-only
```

This is an evidence environment: throwaway signing key, no SLA, may be reset.

## Releases

Every merge into `main` is a release: [`release.yml`](.github/workflows/release.yml)
re-runs CI and E2E, tags the next version (`v0.0.1`, `v0.0.2`, … — patch by default,
`release:minor` / `release:major` labels on the pull request bump the rest), builds
`pkg-repo`, `omarchy-cli` and `pkg-extract` for x86_64 and aarch64, publishes a
[GitHub release](https://github.com/firemanxbr/omarchy-pool/releases) and deploys the
worker. The dashboard header and `https://pkgs.firemanxbr.org/api/v1/version` show
what is running. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
crates/
  pkg-manifest/   shared types, dependency rules, Arch-compatible vercmp
  pkg-extract/    .pkg.tar.zst inspection → PackageManifest (lib + CI binary)
  pkg-repo/       renders signed repo-add databases from a release
  pkg-resolver/   dependency / ABI safety checks
  pkg-store/      redb state store + transactional FS engine (future engine)
  pkg-hooks/      libalpm .hook compatibility (later)
  omarchy-cli/    the thin client
worker/           Cloudflare Worker (TypeScript): pool, index, releases, pacman mirror
docs/             architecture, testing, diagrams
```

## Development

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets
```

Worker:

```bash
cd worker && npm install
npm run typecheck
npm run dev            # local wrangler with a local D1
```

## License

MIT
