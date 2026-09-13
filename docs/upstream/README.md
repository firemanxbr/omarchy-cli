# Findings to report upstream

What the pool's checks found in the projects it mirrors, written up for the
people who can fix them. Filing is a person's act: the maintainer who files
one links the issue here and moves the entry to *Reported*.

## Open

### Arch Linux ARM: x86_64 binaries in aarch64-labelled packages

- **Where**: `extra` for aarch64, packages `gtpin`, `intel-oneapi-*`,
  `openai-codex-desktop`.
- **What**: their ELF binaries need `libc.so.6(GLIBC_2.2.5)` — a symbol
  version that exists only on x86_64 — so they cannot run on aarch64. The
  pool's ABI gate found them on 2026-09-12 (`abi` events for `edge`
  aarch64); `omarchy-cli check <pkg> --arch aarch64` reproduces it against
  an Arch Linux ARM base image.
- **Suggested report** (to https://github.com/archlinuxarm/PKGBUILDs/issues):
  > The aarch64 `extra` repository serves `gtpin`, `intel-oneapi-*` and
  > `openai-codex-desktop` whose binaries are x86_64 ELF objects (they
  > require `GLIBC_2.2.5`, an x86_64-only symbol version). They install but
  > cannot run. Found by an ELF-level check of every upgrade the repository
  > would apply to `menci/archlinuxarm:base`; happy to share the tool.

### OPR: `opencode-1.1.51-1` in `rc` is signed by a key outside the published keyring

- **Where**: `https://pkgs.omarchy.org/rc/x86_64/opencode-1.1.51-1-x86_64.pkg.tar.zst.sig`.
- **What**: the signature does not verify against `builder/omarchy.gpg` of
  `omacom/omarchy-iso` (the keyring `omarchy-keyring` installs). The pool
  refuses the package on import (`sync` events, source `packages`, ring
  `rc`); a user with the published keyring would be refused it too.
- **Suggested report** (to https://github.com/omacom/omarchy-pkgs/issues):
  > `rc/x86_64/opencode-1.1.51-1` is signed by a key that is not in
  > `omarchy.gpg` as shipped by omarchy-iso/omarchy-keyring; pacman with
  > `SigLevel = Required` refuses it. Was it signed on a machine with a
  > different key, or has the keyring a key to add?

### OPR: the same version is rebuilt with different bytes per channel

- **Where**: every package that reaches `rc` and `stable` through
  `bin/repo advance` and is built again for the target channel (76 of them
  on 2026-09-12, e.g. `wayfreeze-0.2.0-1`).
- **What**: `<name>-<version>` names two or three different archives with
  different checksums and signatures depending on the channel. Any mirror
  that stores one object per filename — the pool, or a pacman cache — keeps
  the first and rejects or misverifies the rest; a user moving from `edge`
  to `stable` gets a package pacman calls corrupted. The pool now pins the
  object it already holds and repairs signatures from the channel that
  serves those bytes (its `verify` job); the simpler fix is upstream.
- **Suggested report** (to https://github.com/omacom/omarchy-pkgs/issues):
  > Advancing a channel rebuilds packages instead of promoting the archives
  > already built for the previous one, so `wayfreeze-0.2.0-1` in `edge`,
  > `rc` and `stable` are three different files with the same name. Could
  > `bin/repo advance` copy the archive and its signature when the recipe
  > and the build inputs did not change (or bump `pkgrel` when they did)?
  > Filename-keyed caches and mirrors cannot tell the builds apart.

## Verified, nothing to report

- **Health summary showed an empty package count** in the pool's own
  journal (`( packages across N repos)`): the parser was relaxed on
  2026-09-12; every health event since names the count (e.g. `15663
  packages across 4 repos`). Ours, fixed.
