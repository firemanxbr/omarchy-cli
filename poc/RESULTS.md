# POC results

Evidence for the three questions in the repository migration outline. Everything
below is reproducible with the scripts in `tests/` (see [TESTING.md](../docs/TESTING.md))
against the staging deployment. Nothing touches production.

**Live:** https://omarchy-pool.firemanxbr.org — the pipeline running hourly on
the real Arch `core`/`extra`/`multilib` packages from the Omarchy mirror: sync into
the pool, promotion `edge → rc → stable`, signed databases per source and ring at
`https://pool.firemanxbr.org/x86_64/`, and a daily health check with a real pacman.

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
* **Rollback is the same operation.** `pkg-repo rollback --ring stable --to <id>`
  creates a new release whose selection equals an earlier one (4 ms in the local
  run; history stays append-only), then `render` republishes the databases.

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

## Benchmark: today's mechanics versus the index

![Release promotion at 275 GB — today vs pool + index](diagrams/benchmark-promotion.svg)

Two scripts, both run on a native x86_64 GitHub Actions runner
(`.github/workflows/bench.yml`) with the tools production uses today:

**`poc/bench/bench-current.sh 1000 5`** builds 1,000 valid packages of 5 MB (4.9 GB),
then measures what `omacom/omarchy-mirror` and `omacom/omarchy-pkgs` do on a
promotion — `rsync -a --delete` of the ring tree and `repo-add` over every archive
(pacman 7.1) — next to the index model at the same package count.

| | 1,000 packages, 4.9 GB (measured) | 275 GB ring (extrapolated, linear in bytes) | Pool + index (measured) |
|---|---|---|---|
| Promotion: copy the tree | 8.0 s | ~7.5 min, local copy only | **22 ms**, 0 bytes |
| Promotion: upload + prune the second R2 bucket | — | 30–60 min as reported by the team | not needed |
| Database: `repo-add` vs `pkg-repo render` | 58.9 s | ~55 min | **0.18 s**, 0 archives read |

**`poc/bench/bench-promotion.sh 10000`** seeds 10,000 synthetic packages
(≈176 GB at 18 MB average, the 275 GB / ~15k ratio of a ring) and measures the
index model alone: promote **37 ms** and **27 ms**, render 512 ms
(`omarchy.db` 987 KB, `omarchy.files` 2.1 MB), closure query 132 ms, the release
listing the client downloads 2.9 MB, `pacman -Sy` 172 ms with 10,000 packages listed.
Against the live staging worker a promotion takes 350–430 ms — the network floor.

| | Today | Pool + index |
|---|---|---|
| Promotion time | 30–60 min | well under a second |
| Bytes moved per promotion | ~275 GB | 0 |
| Storage for edge + rc + stable | ~825 GB (three buckets) | ~275 GB + the packages that differ between rings |
| Database generation | `repo-add` reads every archive | rendered from the index |

The index cost depends on the number of packages in the selection, not on their
size; storage figures follow from the model (one object per sha256) rather than a
275 GB measurement.

## Running at full scale

The staging environment mirrors every upstream repository, not a slice. The first
complete import of Arch `extra` (x86_64) on 2026-09-12, one GitHub-hosted runner,
6 parallel workers:

| | |
|---|---|
| Packages | 14,954 of 14,959 (5 transient failures, retried on the next hourly run) |
| Bytes | 106 GB, each downloaded from `mirror.omarchy.org`, signature-verified, extracted and uploaded to R2 through the worker |
| Wall time | 103 min — **17.6 MB/s** sustained on one runner (OPR: 23–27 MB/s) |
| Pool afterwards | 15,777 objects / 120 GB, one copy per sha256 |
| Cost | R2 storage ≈ US$ 0.015/GB-month → ≈ US$ 2/month for the pool; upload operations for 16k objects are cents; the worker runs on the existing Workers Paid plan; GitHub Actions minutes are free for a public repository |

What broke at that size, and what changed:

* **Rendering a 15k-package ring failed** (Cloudflare error 1102, the worker
  exceeded its resource limits) because the release view with file lists was built
  in one invocation. The view is paged now (`?arch=&limit=&offset=`, pinned to a
  `release_id` so a ring moving on mid-render cannot mix selections); render and
  the thin client page through one architecture.
* `metasploit` ships payload templates that start with the ELF magic but are not
  loadable objects; the extractor now lists them and skips their facts instead of
  failing the package.
* Two uploads hit an R2 `internal error (10001)`; the worker reports storage-side
  failures as 503 so the publisher's retry covers them, and keeps 422 for real
  checksum mismatches.

Live numbers, the coverage of every source and the pipeline's own metrics are on
the dashboard.

## What is not covered by the POC

* The ABI gate checks the upgrades a ring would apply to the official base image,
  not to every real installation; `omarchy-cli check` does that on the machine.
* Package provenance (which PKGBUILD commit, AUR-synced or own) is not recorded in
  the index yet; the OPR packages carry Omarchy's signature and nothing more.
* `pkg-store` (a native, journaled install engine) exists and is tested but is not
  wired into the client — the thin client did not need it.

## Reproduce

```bash
tests/e2e-pacman.sh   # local file:// mirror, pacman in a container
tests/e2e-worker.sh   # local worker (wrangler dev), publish → promote → render → pacman
tests/e2e-client.sh   # thin client: safe vs blocked systems, real upgrade in a container
poc/bench/bench-promotion.sh 10000   # index model at scale: promotion / render / pacman -Sy
poc/bench/bench-current.sh 1000 5    # today's rsync + repo-add vs the index, same package count
```
