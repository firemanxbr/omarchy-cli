# omarchy-cli

Proof of concept for the [Omarchy](https://omarchy.org) repository migration:
an **immutable package pool** on Cloudflare R2, an **index** on D1 where `edge`,
`rc` and `stable` are pinned selections, **generated, signed pacman databases**,
and a **thin client** that understands releases and blocks unsafe partial upgrades.

* Packages stay unmodified `makepkg` output — no new format, no new build tool.
* Promoting a release is an index write, not a 275 GB copy.
* pacman keeps working through generated `repo-add` databases.
* `omarchy-cli` drives pacman and adds release awareness plus an ABI-level safety
  check built from the ELF soname graph.

> Status: proof of concept — results in [docs/POC-RESULTS.md](docs/POC-RESULTS.md).
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
> [docs/TESTING.md](docs/TESTING.md) for how to verify it.

## Try the staging repository

The POC runs at **https://pkgs.firemanxbr.org** with two test packages (`zlib`, `xz`
from Arch `core`) published through `edge → rc → stable`. It is a plain pacman mirror:

```ini
# /etc/pacman.conf
[omarchy]
Server = https://pkgs.firemanxbr.org/stable/os/$arch
```

Databases and packages are signed with a throwaway key (`docs/omarchy-poc.pub.asc`,
expires 2026-10-11): `pacman-key --add docs/omarchy-poc.pub.asc && pacman-key --lsign-key poc@omarchy.invalid`.

The thin client works against the same index:

```bash
export OMARCHY_API=https://pkgs.firemanxbr.org
omarchy-cli status          # pinned release vs. what stable serves now
omarchy-cli check xz        # ABI safety check against this machine, exit 2 if unsafe
omarchy-cli upgrade         # pacman -U from the pool, then pin the release
```

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
