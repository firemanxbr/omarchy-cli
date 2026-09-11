# Architecture

`omarchy-cli` is a package manager for the [Omarchy](https://omarchy.org) repository.
It installs standard Arch Linux packages (`.pkg.tar.zst`, produced by `makepkg`,
never modified) using a SAT solver for dependency resolution, an ACID local state
store and a transactional filesystem engine, served from a Cloudflare edge repository.

It **coexists with pacman**: it manages only packages from the Omarchy repository and
treats the pacman local database as the read-only source of truth for everything
else on the system.

## Layers

```
[ makepkg ] ──► foo.pkg.tar.zst (unchanged)
                     │
      ┌──────────────┴──────────────┐
      ▼                             ▼
[ R2 upload ]              [ pkg-extract (CI) ]
      │                    reads .PKGINFO + ELF sonames
      ▼                             ▼
Cloudflare R2 ◄───────── Cloudflare D1 (package graph)
      ▲                             ▲
      │  GET /blob/:sha256          │  GET /graph?targets=...
      └──────────────┬──────────────┘
                     ▼
              [ omarchy-cli ]
               ├── pkg-resolver   SAT solver (resolvo) over installed + remote candidates
               ├── pkg-store      redb state + journaled transactional FS engine
               ├── pkg-hooks      libalpm .hook compatibility
               └── pkg-extract    local inspection of AUR-built packages
```

### 1. Extraction pipeline (`crates/pkg-extract`)

ABI metadata is extracted **out-of-band**: the archive stored in R2 is byte-for-byte
what `makepkg` produced. For each package the extractor:

1. parses `.PKGINFO` (`depend=`, `provides=`, `conflict=`, `replaces=`, `backup=`, sizes);
2. walks every regular file, and for ELF objects reads `DT_SONAME`, `DT_NEEDED`
   and `.gnu.version_r` (e.g. `libc.so.6(GLIBC_2.38)`);
3. merges both into a `PackageManifest` (`crates/pkg-manifest`).

Merge rules:

* `provides` = `name=version` + `.PKGINFO` `provides=` + for every `DT_SONAME` both
  the raw soname (`libz.so.1`, what `DT_NEEDED` asks for) and Arch's convention
  (`libz.so=1-64`, what PKGBUILDs declare);
* `requires` = `.PKGINFO` `depend=` + every `DT_NEEDED` + symbol version needs,
  minus sonames the package ships itself;
* symbol version needs are collapsed to the highest version per
  `(soname, namespace)` — `GLIBC_2.34` subsumes `GLIBC_2.14` — which turns a typical
  17-entry list into 2–3 rules without losing information;
* `makedepend=` never reaches the manifest.

`pkg-extract index <dir>` writes a `RepoIndex` (`index.json`) so the client can be
developed against a directory of packages instead of the edge API.

ELF facts *refine* declarative dependencies; they never replace them, because
scripts, data files and `dlopen()`-loaded plugins are invisible to the loader.

The same library runs inside `omarchy-cli` so packages built locally from the AUR
get the same treatment before being recorded in the state store.

### 2. Edge repository (`worker/`)

Cloudflare Worker (TypeScript) in front of D1 (metadata) and R2 (blobs).
The worker **does not resolve dependencies** — it does not know the client's
installed state and Workers have a bounded CPU budget. It only serves the subgraph
the client asks for.

| Route | Purpose |
|---|---|
| `GET /api/v1/graph?targets=a,b&channel=stable` | transitive dependency closure of the latest version of each target |
| `GET /api/v1/packages/:name` | every published version of a package |
| `GET /api/v1/blob/:sha256` | streams the archive from R2, supports `Range` |
| `POST /api/v1/sync/diff` | `{installed: {name: version}}` → available updates |
| `PUT /api/v1/packages` | CI publish (bearer token), writes R2 + D1 in one batch |

D1 schema: `worker/migrations/`. Packages are keyed by `(name, version, epoch, arch, channel)`
and by `sha256`; the full manifest is stored as JSON alongside the normalized
`package_provides` / `package_requires` / `package_files` rows used for graph queries.

The JSON Schema for `PackageManifest` is generated from the Rust types
(`pkg-extract schema`) and checked into `worker/src/manifest.schema.json` so both
sides share one contract.

### 3. Resolver (`crates/pkg-resolver`)

Built on [resolvo](https://github.com/prefix-dev/resolvo). Candidates come from two
sources:

* **Installed state** — pacman local DB (`/var/lib/pacman/local`, read-only) plus
  the omarchy-cli store. These are *locked/favored*: the solver keeps them unless a
  hard soname requirement of a target cannot otherwise be satisfied.
* **Remote candidates** — the subgraph returned by `/graph`.

Result: a `Plan` with the minimal set of packages to download. If the system already
provides every `DT_NEEDED` soname a target needs, the plan contains exactly one package.

Version comparison is a byte-for-byte port of `alpm_pkg_vercmp` (`pkg-manifest::vercmp`)
so the resolver and `pacman -Q` always agree on ordering.

### 4. State store and transactions (`crates/pkg-store`)

One redb file at `/var/lib/omarchy-cli/state.redb`:

| table | key | value |
|---|---|---|
| `installed_packages` | name | version, sha256, install date, manifest |
| `installed_capabilities` | capability | package, version |
| `tracked_files` | path | owner, mode, sha256 |
| `transactions` | tx id | rollback journal |

Transaction lifecycle:

```
1. resolve            SAT plan
2. download + verify  stream from R2 → sha256 → ed25519 signature
3. PreTransaction     hooks
4. stage              extract into /usr/.omarchy-staging/<tx>/ (same FS as /usr)
                      collision check against tracked_files
5. apply              per-file rename(2); every op journaled *before* it runs
6. commit             single redb write transaction
7. PostTransaction    hooks (ldconfig, mkinitcpio, glib-compile-schemas, ...)
```

Atomicity across many files is not something the filesystem gives us
(`renameat2(RENAME_EXCHANGE)` is per-file). What makes the transaction safe is the
journal: any failure in 4–6, including `SIGKILL` or power loss, is undone by replaying
the journal in reverse on next start. On btrfs systems (Omarchy default) a snapper
snapshot before step 5 is an optional last-resort rollback.

### 5. Hooks (`crates/pkg-hooks`)

Parses `.hook` files from `/etc/pacman.d/hooks` and `/usr/share/libalpm/hooks`
(same precedence as pacman) and runs matching `Exec` lines in the right phase so
existing Arch triggers keep working without changes.

## Coexistence with pacman

| Concern | Approach |
|---|---|
| pacman must not overwrite our files | we only manage `[omarchy]` packages; collisions against `tracked_files` and pacman's DB abort the transaction |
| `pacman -Qo` / `yay` should see our packages | phase 6: also write a `/var/lib/pacman/local/<pkg>/{desc,files,mtree}` entry |
| base libraries | never installed by us; read from pacman DB as satisfied capabilities |

## Signing

Detached ed25519 signatures (minisign-compatible) stored next to the archive in R2.
The public key is embedded in the client binary. Simpler than GPG and sufficient for a
single-publisher repository.

## Roadmap

| Phase | Crate(s) | Deliverable |
|---|---|---|
| 1 ✅ | `pkg-manifest`, `pkg-extract` | `pkg-extract inspect foo.pkg.tar.zst` prints a complete manifest; `pkg-extract index <dir>` emits an `index.json` so the client can be developed without Cloudflare |
| 2 | `pkg-store` | install/remove from a local repo with journaled rollback; integration tests against a temp root |
| 3 | `pkg-resolver` | resolvo provider over pacman DB + store + candidates; `install --dry-run` prints a plan |
| 4 | `worker/` | D1 migrations, `/graph` BFS closure, publish endpoint, signatures, `sync/diff` with vercmp |
| 5 | `pkg-hooks` | `.hook` parser + executor wired into the transaction |
| 6 | `omarchy-cli` | pacman local DB write-compat, `upgrade`, `search`, `owns` |
