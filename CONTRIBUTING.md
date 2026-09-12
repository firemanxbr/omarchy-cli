# Contributing

Everything in the repository — code, documentation, commit messages — is in English.

## Workflow

1. Branch from `main`; `main` itself is protected (no direct pushes, even for admins).
2. Open a pull request. CI (fmt, clippy, tests, worker typecheck, on x86_64 and
   aarch64) and E2E (real pacman through a local worker) must pass. Keep
   [docs/TESTING.md](docs/TESTING.md) in step with what you change.
3. Pull requests are squash-merged; the title becomes the commit message and the
   release note, so write it as one clear sentence: `Render databases per
   architecture`, `Fix Range handling for full responses`.
4. Merging is releasing. `release.yml` tags the next version and deploys the worker
   (details in [docs/RUNBOOK.md](docs/RUNBOOK.md#releasing-the-pool-itself)).

## Versions

Releases are small and frequent, starting at `v0.0.1`:

| Change | Label on the pull request | Example |
|---|---|---|
| anything (default) | — | `v0.0.7 → v0.0.8` |
| a significant feature or behaviour change | `release:minor` | `v0.0.8 → v0.1.0` |
| an incompatible change (API, layout, index schema) | `release:major` | `v0.1.4 → v1.0.0` |

Crate versions and `worker/package.json` stay at `0.0.0`; the git tag is the source
of truth and is compiled into the binaries (`omarchy-cli --version`).

## Local checks

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
(cd worker && npm ci && npm run typecheck)
tests/e2e-worker.sh          # needs docker or podman
```
