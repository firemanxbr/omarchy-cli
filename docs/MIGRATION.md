# Migrating to another account or organisation

Everything the pool needs is either in this repository or listed here. Moving it
— for instance to the Omarchy foundation's Cloudflare account and GitHub
organisation — is a matter of recreating a handful of resources, setting the
names in three files, and letting the pipeline refill the pool.

## 1. Cloudflare

| Resource | Create | Then |
|---|---|---|
| Workers Paid plan | required for the cron trigger and D1 at this size | — |
| R2 bucket `omarchy-packages` | `npx wrangler r2 bucket create omarchy-packages` | custom domain for it (the *pool* host, e.g. `pool.omarchy.org`); this is what pacman reads |
| D1 database `omarchy-repo` | `npx wrangler d1 create omarchy-repo` | put its id in `worker/wrangler.toml`; migrations apply on the first deploy |
| Worker `omarchy-repo` | first `wrangler deploy` (or the Release workflow) | custom domains: the *API* host and the *dashboard* host |
| Secrets | `wrangler secret put PUBLISH_TOKEN` (any long random string), `wrangler secret put GITHUB_TOKEN` (see §3) | — |
| API token for CI | Account → Workers Scripts: Edit, D1: Edit, Account Settings: Read; Zone → Workers Routes: Edit, Zone: Read | GitHub secret `CLOUDFLARE_API_TOKEN` |

Names to change: `worker/wrangler.toml` (`account_id`, `database_id`, `routes`,
`POOL_URL`), `worker/src/meta.ts` (`REPO_URL`, `DASHBOARD_HOST`,
`LEGACY_DASHBOARD_HOST` — or drop the redirect), and the defaults in
`crates/omarchy-cli/src/config.rs` (`api`, `pool`). The pool root must also carry
the public database key (`omarchy-staging.pub.asc` today; upload the new one with
`wrangler r2 object put`).

## 2. GitHub

* Repository: transfer or fork, keep `main` protected (the ruleset in
  RUNBOOK: pull requests only, the six required checks, squash merges).
* Variables: `OMARCHY_API` (API host), `OMARCHY_POOL` (pool host).
* Secrets: `OMARCHY_PUBLISH_TOKEN` (same value as the worker's `PUBLISH_TOKEN`),
  `OMARCHY_GPG_KEY` / `OMARCHY_GPG_KEYID` (§4), `CLOUDFLARE_API_TOKEN` (§1).
* Environments: `automatic` (no rules), `pool` (deploys; url = dashboard), and
  `stable` with a required reviewer if humans should approve stable promotions
  (then set the variable `STABLE_ENVIRONMENT=stable`).
* Labels `release:minor`, `release:major`.

## 3. The scheduler token

The worker dispatches overdue workflows itself (RUNBOOK, *The pool's own
scheduler*). It needs a fine-grained personal access token — or a GitHub App
token — with *Actions: read and write* on the repository, stored as the worker
secret `GITHUB_TOKEN`. Under an organisation prefer a GitHub App or a machine
user so the token does not belong to a person. `worker/src/scheduler.ts` holds
the repository name.

## 4. The database signing key

Packages keep their upstream signatures; only the generated databases are signed,
by one key. Generate a new one for the new owner (RUNBOOK, *Rotate the database
signing key*), export the public part to `docs/<name>.pub.asc` and the pool root,
put the private part in `OMARCHY_GPG_KEY` and its id in `OMARCHY_GPG_KEYID`, and
tell users to import the new key. `tests/health-check.sh`, `tests/abi-gate.sh`
and the Get started page reference the key file name and the key's e-mail.

## 5. Refill

The pool is rebuilt from upstream, not copied: run `Sync` (`sources=all`,
`limit=0`) — the full import takes a few hours of runner time and is idempotent —
then promote `edge → rc` and `rc → stable` by hand once (`soak_days=0`) to seed
the rings. From then on the daily promotions and the hourly syncs keep it current.
Or copy the R2 bucket and export/import the D1 database to keep history.

## 6. What is not portable

* The dashboard's own domain is in three places (above); the legacy redirect is
  optional.
* Upstream sources are configured in `.github/workflows/sync.yml` (`SOURCES`),
  `worker/src/meta.ts` (`EXPECTED_SOURCES`) and the sources table on *How it
  works*; the Omarchy mirror host (`mirror.omarchy.org`) is the Arch source and
  would become the foundation's own mirror.
* The security feeds (Arch and Debian trackers, CISA KEV, EPSS) are public and
  need no credentials.
