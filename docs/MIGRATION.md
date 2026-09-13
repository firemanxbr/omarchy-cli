# Migration guide

How to move omarchy-pool from one GitHub account and one Cloudflare account to
others — for instance from `firemanxbr` to the Omarchy foundation — starting
from a copy of this repository. Every step is a command or a click; nothing
depends on the old accounts once it is done. Budget an afternoon, plus the
hours the first full import takes on a project worker.

Throughout, replace:

| Placeholder | Meaning | Today |
|---|---|---|
| `NEWORG/omarchy-pool` | the new GitHub repository | `firemanxbr/omarchy-pool` |
| `ACCOUNT_ID` | the new Cloudflare account id | `34f1918ac9ca522150a1830ea9b61a40` |
| `example.org` | the DNS zone in the new Cloudflare account | `firemanxbr.org` |
| `pool.example.org` | the **pool** host (R2 custom domain; what pacman reads) | `pool.firemanxbr.org` |
| `pkgs.example.org` | the **API** host (worker) | `pkgs.firemanxbr.org` |
| `omarchy-pool.example.org` | the **dashboard** host (worker) | `omarchy-pool.firemanxbr.org` |

Tools on the machine doing the migration: `git`, `gh` (logged in to the new
organisation), `node` 22 with `npm`, `wrangler` (comes with `npm ci` in `worker/`),
`gpg`, `openssl`, `jq`.

## A. GitHub: from one repository to another

### A1. Get the code there

Either **transfer** the repository (keeps history, releases, issues, labels; on
GitHub: *Settings → Danger zone → Transfer ownership* → the new organisation), or
**mirror** it into a fresh repository:

```bash
gh repo create NEWORG/omarchy-pool --public --description "One package repository for Omarchy"
git clone --mirror https://github.com/firemanxbr/omarchy-pool.git
cd omarchy-pool.git && git push --mirror https://github.com/NEWORG/omarchy-pool.git && cd ..
git clone https://github.com/NEWORG/omarchy-pool.git && cd omarchy-pool
```

Tags come along with the mirror, so the next release continues the `v0.0.x`
sequence; releases (the GitHub release objects with the binaries) do not — the
next merge publishes a new one, and the old ones stay readable at the old URL.

### A2. Repository settings

```bash
gh repo edit NEWORG/omarchy-pool --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
gh api -X PATCH repos/NEWORG/omarchy-pool -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
gh label create "release:minor" --color 1d76db --description "Bump the minor version on merge" -R NEWORG/omarchy-pool
gh label create "release:major" --color b60205 --description "Bump the major version on merge" -R NEWORG/omarchy-pool
```

### A3. Variables, secrets, environments

The values come from part B (Cloudflare) and part D (key); create the
placeholders now and fill them as you go. All names are what the workflows read.

```bash
gh variable set OMARCHY_API  -b "https://pkgs.example.org" -R NEWORG/omarchy-pool
gh variable set OMARCHY_POOL -b "https://pool.example.org" -R NEWORG/omarchy-pool
gh secret set CLOUDFLARE_API_TOKEN   < cloudflare-token -R NEWORG/omarchy-pool   # B6
gh api -X PUT "repos/NEWORG/omarchy-pool/environments/pool" >/dev/null           # the release's deploy environment
```

GitHub keeps only that token and, once the factory's hosted fallback is set
up (F2), the two worker tokens. Nothing on GitHub can write to the pool.

### A4. Protect `main`

The ruleset is versioned in the repository:

```bash
gh api -X POST repos/NEWORG/omarchy-pool/rulesets --input .github/rulesets/main.json
```

From here on every change is a pull request with the six required checks and,
for the files `CODEOWNERS` names (the governance file, the recipes), a review
by a maintainer other than the author (CONTRIBUTING.md, GOVERNANCE.md). Do the
remaining edits of this guide on a branch. Put the new maintainers in
`factory/MAINTAINERS.toml` and run `factory/bin/check-governance --write`.

## B. Cloudflare: from one account to another

### B1. Account

The new account needs the **Workers Paid** plan (the cron trigger, D1 at this
size) and **R2** enabled, and the DNS zone `example.org` must live in it
(*Add a site* if it does not).

### B2. Create the storage and the index

```bash
cd worker && npm ci
npx wrangler login                                  # the new account
npx wrangler r2 bucket create omarchy-packages
npx wrangler d1 create omarchy-repo                 # prints the database_id
```

### B3. Point the code at the new account

Edit **`worker/wrangler.toml`**: `account_id = "ACCOUNT_ID"`, the printed
`database_id`, the three `routes` patterns (`pkgs.example.org`,
`omarchy-pool.example.org`, and the legacy dashboard pattern — remove it if
there is no old name to redirect), and `POOL_URL = "https://pool.example.org"`.

Edit **`worker/src/meta.ts`**: `REPO_URL` (`https://github.com/NEWORG/omarchy-pool`),
`DASHBOARD_HOST`, `LEGACY_DASHBOARD_HOST` (or delete the redirect in
`worker/src/index.ts`).

Edit **`worker/src/scheduler.ts`** (`REPO`), **`worker/src/governance.ts`**,
**`worker/src/requests.ts`** and **`crates/pkg-repo/src/reconcile.rs`**: the
repository they read (`NEWORG/omarchy-pool`); and `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_D1_ID` in `wrangler.toml` for the cost estimate.

Edit **`crates/omarchy-cli/src/config.rs`**: the default `api` and `pool` URLs.

Search for the old hosts to be sure nothing is left:

```bash
grep -rn "firemanxbr" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git .
```

What remains are documentation and the key's e-mail address (part D).

### B4. The pool's custom domain

pacman reads packages and databases straight from the bucket, so the bucket
needs its own hostname: Cloudflare dashboard → *R2 → omarchy-packages → Settings
→ Custom domains → Connect domain* → `pool.example.org`. (Wrangler cannot do
this one.) The worker's two hostnames are created by the first deploy from the
`routes` in `wrangler.toml`.

### B5. Worker secrets

```bash
openssl rand -hex 32 | npx wrangler secret put JOB_TOKEN_SECRET   # signs the per-job tokens; nobody else needs it
npx wrangler secret put GITHUB_TOKEN  < ../github-token           # part C
npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN                # an API token with Account Analytics: Read and D1: Read — the daily cost estimate (RUNBOOK, Costs)
```

### B6. An API token for the release workflow

Cloudflare dashboard → *Manage account → Account API tokens → Create Token →
Custom*: **Account** → Workers Scripts: Edit, D1: Edit, Account Settings: Read;
**Zone** (`example.org`) → Workers Routes: Edit, Zone: Read. Save it as the GitHub
secret `CLOUDFLARE_API_TOKEN` (A3). Every merge into `main` then migrates the
database and deploys the worker with the release version.

### B7. First deploy

Either merge the branch with the edits of B3 and let the Release workflow deploy,
or from the machine:

```bash
npx wrangler d1 migrations apply omarchy-repo --remote
npx wrangler deploy
curl -s https://pkgs.example.org/api/v1/status      # {"ok":true,...} once D1 and R2 answer
```

## C. The scheduler token

The worker still dispatches two workflows through the GitHub API (RUNBOOK,
*The pool's own scheduler*): the recipe bumps and the hosted fallback worker.
Create a **fine-grained personal access token** (or a GitHub App installation
token) with *Actions: read and write* on `NEWORG/omarchy-pool` — under an
organisation, from a machine user or a GitHub App rather than a person — save
it to `github-token`, and install it (B5). Without it the jobs still run; only
those two dispatches (and the higher rate limit of the daily update check)
are missing.

## D. A new signing key

Packages imported from upstream keep the signatures of the projects that built
them; the generated pacman databases and the packages the factory builds are
signed by one key, inside the Worker (secret `SIGNING_KEY`), and users import
its public part once. The new owner must have its own:

```bash
export GNUPGHOME=$(mktemp -d)
gpg --batch --quiet --passphrase '' --quick-generate-key "Omarchy Pool Signing <pool@example.org>" ed25519 sign 2y
KEYID=$(gpg --list-keys --with-colons pool@example.org | awk -F: '/^fpr/{print $10; exit}')
gpg --armor --export "$KEYID" > docs/omarchy-pool.pub.asc
cd worker
gpg --batch --armor --export-secret-keys "$KEYID" | npx wrangler secret put SIGNING_KEY   # the only copy
npx wrangler r2 object put omarchy-packages/omarchy-pool.pub.asc --file ../docs/omarchy-pool.pub.asc --remote
cd .. && rm -rf "$GNUPGHOME"
```

Then rename the key file and the e-mail wherever they appear (`docs/omarchy-staging.pub.asc`,
`staging@firemanxbr.org`): `tests/health-check.sh`, `tests/abi-gate.sh`,
`worker/src/pages/get-started.ts`, `README.md`, `.github/workflows/release.yml`
(the release attaches the key file). The private key exists only in the Worker
secret; `GET /api/v1/signing-key` serves the public part.

## E. Refill the pool and seed the rings

The pool is rebuilt from upstream, not copied (every object is verified against
its project's keyring on the way in). With A–D in place:

```bash
# a project worker (RUNBOOK, Pulled jobs) must be running; as a maintainer:
export OMARCHY_API=https://pkgs.example.org OMARCHY_TOKEN=omc_…
pkg-repo job sync --param arch=x86_64 && pkg-repo job sync --param arch=aarch64   # hours; idempotent, queue again if it stops
pkg-repo job promote --param from=edge --param to=rc --param note=seed
pkg-repo job promote --param from=rc --param to=stable --param force=yes --param note=seed
pkg-repo job security
```

From then on the scheduler keeps it current: the sync every three hours, the
daily promotions (06:00 and 09:00 UTC), the security run every three hours,
the metrics snapshot every thirty minutes.

To keep the old index history instead (releases, journal, security data), export
the old D1 (`wrangler d1 export omarchy-repo --remote --output pool.sql`) and
import it into the new one before the first sync, and copy the bucket with
`rclone` between the two R2 accounts; the object keys are the same.

## F. Verify

```bash
curl -s https://pkgs.example.org/api/v1/status | jq .            # online
curl -s https://pkgs.example.org/api/v1/stats | jq '.rings[] | {ring, package_count}'
curl -sI https://pool.example.org/x86_64/omarchy-core-stable.db | head -1   # 200 from the bucket
pkg-repo job health --param ring=stable --param arch=x86_64      # real pacman per ring and architecture (and aarch64)
```

Open the dashboard: the header says *online*, the version chip shows the release
the Release workflow just deployed, every ring has health *ok* on both
architectures, Coverage lists every source, the journal shows `dispatch` lines
from the scheduler. Point a test machine at `stable` with *Get started* and run
`pacman -Syu`.

## F2. The factory

`factory/` (worker script, image, PKGBUILDs, the governance file), the
`factory-update.yml` and `factory-image.yml` workflows and the
package-request issue form are a **tenant** of this repository, not part of
the pool: they should move to their own repository once a home exists (the
contract is in [factory/README.md](../factory/README.md), *The contract*).
Until then, moving the pool moves them too:

- The staging bucket: `npx wrangler r2 bucket create omarchy-factory-staging`
  and `npx wrangler r2 bucket lifecycle add omarchy-factory-staging --name
  expire-30d --prefix staging/ --expire-days 30` (binding `STAGING` in
  `wrangler.toml`). The worker image lives at
  `ghcr.io/<owner>/omarchy-packaging` (`factory-image.yml`, `IMAGE` env);
  the compose file and the README name it.
- Sign in with GitHub: a GitHub OAuth App on the new organisation
  (callback `https://<dashboard>/auth/github/callback`): client id in
  `wrangler.toml` (`GITHUB_OAUTH_CLIENT_ID`), secret with
  `npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET`.
- Workers: register one per architecture for the hosted fallback (`POST
  /factory/workers` with your contributor token, then trust it as a
  maintainer) and store their tokens as the GitHub secrets
  `POOL_WORKER_TOKEN_X86_64` / `POOL_WORKER_TOKEN_AARCH64`. Workers you run
  elsewhere are registered the same way; `JOB_TOKEN_SECRET` (any random
  string, `npx wrangler secret put JOB_TOKEN_SECRET`) signs the per-job
  tokens.
- `REPO_URL` in `factory/worker/omarchy-build-worker.sh` and `repo` in
  `worker/src/routes/factory.ts` name the repository holding the PKGBUILDs.
- When the factory leaves, delete `factory/`, the two workflows, the issue
  form and the CODEOWNERS lines; keep `worker/src/routes/factory.ts`, the
  migrations and the `factory` source — they are the pool's side of the
  contract.

## G. What the old owner keeps, and can then remove

Nothing of the new deployment depends on the old accounts. When the new one is
verified: delete the old worker, D1 and bucket (or keep the old dashboard host as a
redirect), revoke the old API tokens, and archive or redirect the old repository.
