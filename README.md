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

> Status: proof of concept. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
> design and roadmap and [docs/TESTING.md](docs/TESTING.md) for how to verify it.

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
