# omarchy-cli

Package manager for the [Omarchy](https://omarchy.org) repository, written in Rust.

* Installs unmodified Arch packages (`.pkg.tar.zst`) — no new package format, no new build tool.
* Resolves dependencies at the **soname/ABI level** with a SAT solver, so installing one
  package never forces a full-system upgrade.
* Keeps local state in a single ACID database and applies filesystem changes through a
  journaled, rollback-safe transaction.
* Served from a Cloudflare edge repository (Workers + D1 + R2): clients fetch only the
  dependency subgraph they need instead of a whole `.db.tar.gz`.
* Coexists with `pacman`; existing libalpm hooks keep working.

> Status: early development. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
> design and roadmap.

## Layout

```
crates/
  pkg-manifest/   shared types, dependency rules, Arch-compatible vercmp
  pkg-extract/    .pkg.tar.zst inspection → PackageManifest (lib + CI binary)
  pkg-resolver/   SAT resolution (resolvo)
  pkg-store/      redb state store + transactional FS engine
  pkg-hooks/      libalpm .hook compatibility
  omarchy-cli/    the CLI
worker/           Cloudflare Worker (TypeScript), D1 migrations
docs/             architecture and design notes
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
