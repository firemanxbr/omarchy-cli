# POC results

Evidence for the three questions in the repository migration outline. Everything
below is reproducible with the scripts in `tests/` (see [TESTING.md](TESTING.md))
against the staging deployment at **https://pkgs.firemanxbr.org**. Nothing touches
production.

## 1. Can the immutable pool and index cleanly represent complete releases?

**Yes.**

* A package is uploaded **once** into R2 (`pool/<sha256>.pkg.tar.zst`); R2 verifies
  the SHA-256 on upload. Re-publishing the same archive is a no-op
  (`already in pool, skipping upload`).
* A release is a pinned selection: `releases (ring, seq, parent, source)` +
  `release_packages`. `edge`, `rc` and `stable` are three rows in `ring_heads`, not
  three directory trees.
* **Promotion is an index write.** Measured against the live worker:

  ```
  promoted edge → rc#1     (id 3, from release 2) — 2 packages, 941070 bytes, 348 ms, zero bytes copied
  promoted rc   → stable#1 (id 4, from release 3) — 2 packages, 941070 bytes, 430 ms, zero bytes copied
  ```

  The cost does not depend on the size of the packages; a 275 GB ring promotes in the
  same time.
* Lineage is kept: every release records its parent (previous head of the ring) and
  its source (the release it was promoted from), so "what does stable#7 contain and
  where did it come from" is one query.

## 2. Can we generate valid, signed pacman databases from it?

**Yes, and pacman cannot tell the difference.**

`pkg-repo render` builds `omarchy.db` / `omarchy.files` for a ring's current release
in `repo-add`'s exact `desc`/`files` layout, signs them with GPG and stores them next
to the release. The worker serves `/<ring>/os/<arch>/…` as a normal mirror.

Verified with **pacman 7.1.0** in an `archlinux:base` container using
`SigLevel = Required DatabaseRequired` and
`Server = https://pkgs.firemanxbr.org/stable/os/$arch`:

| Command | Result |
|---|---|
| `pacman -Sy` | signed database accepted |
| `pacman -Sl omarchy`, `-Si zlib` | every `desc` field rendered (`Validated By: SHA-256 Sum`) |
| `pacman -Sp zlib xz` | URLs resolved through the release into the pool |
| `pacman -Fy` / `-Fl xz` | files database works |
| `pacman -Sw xz` | package and `.sig` fetched from the pool, signature verified |
| `pacman -U …/xz-5.8.4-1-x86_64.pkg.tar.zst` | real upgrade 5.8.3 → 5.8.4, hooks ran |

The database served by the worker is byte-identical to one rendered locally from
the same manifests (deterministic output, same SHA-256).

## 3. Does a thin client give enough control to justify becoming load-bearing?

**Yes for the cases that matter; it never bypasses pacman.**

`omarchy-cli` reads the index and the machine (`/var/lib/pacman/local` plus the
shared libraries on disk) and drives `pacman -U` with URLs from the release.

* **Release awareness** — `status` shows the pinned release, what the ring serves and
  pending updates; `upgrade` moves the machine to the ring head and pins it.
  Discovering a new release does not require `pacman -Sy`.
* **Unsafe out-of-band installs are refused.** The index carries the ELF facts of
  every package (`DT_NEEDED`, `.gnu.version_r`); the client checks them against the
  real libraries on the system (`.gnu.version_d`). On a January 2021 Arch system
  (glibc 2.32):

  ```
  $ omarchy-cli check xz
  Packages (1):
    xz                       5.8.4-1              upgrade from 5.2.5-1
    BLOCKED  xz: libc.so.6(GLIBC_2.34) — libc.so.6 on this system does not define GLIBC_2.34
             (newest GLIBC version: GLIBC_2.32); a release upgrade is required first
  Verdict: BLOCKED — 2 requirement(s) this system cannot satisfy.   (exit 2)
  ```

  pacman would have installed this package (`.PKGINFO` only says `depend = glibc`)
  and `xz` would have failed at load time. On a current system the same check passes
  and `omarchy-cli upgrade` runs
  `pacman -U https://pkgs.firemanxbr.org/stable/os/x86_64/xz-5.8.4-1-x86_64.pkg.tar.zst`,
  pacman verifies the signature, installs, hooks run, and the machine is pinned to
  `stable#1`. A second `upgrade` is a no-op.
* Everything the client knows is available as `--json`, which is the shape an MCP
  server would expose.

## What is not covered by the POC

* The Arch mirror side (core/extra) is not in the index; the client warns when a
  dependency has to come from another repository and lets pacman resolve it.
* Uploads go through the worker (fine for CI; multi-GB packages would use direct
  R2 uploads).
* Package signatures are produced by whoever builds or mirrors the package; the POC
  uses a throwaway key for both packages and databases.
* Retention (garbage-collecting pool objects no release references) is a query away
  but not implemented.
* `pkg-store` (a native, journaled install engine) exists and is tested but is not
  wired into the client — the thin client did not need it.

## Reproduce

```bash
tests/e2e-pacman.sh   # local file:// mirror, pacman in a container
tests/e2e-worker.sh   # local worker (wrangler dev), publish → promote → render → pacman
tests/e2e-client.sh   # thin client: safe vs blocked systems, real upgrade in a container
```
