# Migration guide

How to move omarchy-pool from one GitHub account and one Cloudflare account to
others — for instance from `firemanxbr` to the Omarchy foundation — starting
from a copy of this repository. Every step is a command or a click; nothing
depends on the old owner once it is done. Budget an afternoon, plus the hours the
first full import takes on GitHub runners.

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
openssl rand -hex 32 > publish-token                       # keep it: the worker gets the same value (B5)
gh secret set OMARCHY_PUBLISH_TOKEN  < publish-token   -R NEWORG/omarchy-pool
gh secret set CLOUDFLARE_API_TOKEN   < cloudflare-token -R NEWORG/omarchy-pool   # B6
for e in automatic pool stable; do gh api -X PUT "repos/NEWORG/omarchy-pool/environments/$e" >/dev/null; done
```

`stable` is only used when a human must approve promotions into stable: give it a
required reviewer in *Settings → Environments → stable* and set
`gh variable set STABLE_ENVIRONMENT -b stable`. Without that, promotions are
automatic (the default).

### A4. Protect `main`

The ruleset is versioned in the repository:

```bash
gh api -X POST repos/NEWORG/omarchy-pool/rulesets --input .github/rulesets/main.json
```

From here on every change is a pull request with the six required checks
(CONTRIBUTING.md). Do the remaining edits of this guide on a branch.

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

Edit **`worker/src/scheduler.ts`**: `REPO = "NEWORG/omarchy-pool"`.

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
npx wrangler secret put PUBLISH_TOKEN < ../publish-token   # same value as OMARCHY_PUBLISH_TOKEN
npx wrangler secret put GITHUB_TOKEN  < ../github-token    # part C
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

The worker dispatches overdue workflows through the GitHub API (RUNBOOK, *The
pool's own scheduler*). Create a **fine-grained personal access token** (or a
GitHub App installation token) with *Actions: read and write* on
`NEWORG/omarchy-pool` — under an organisation, from a machine user or a GitHub
App rather than a person — save it to `github-token`, and install it (B5). The
scheduler is idle without it and logs so; the workflow files' own schedules still
apply.

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
`tests/e2e-worker.sh`, `worker/src/pages/get-started.ts`, `README.md`,
`.github/workflows/release.yml` (the release attaches the key file). Keep the
private key only in the GitHub secret and in the owner's password manager.

## E. Refill the pool and seed the rings

The pool is rebuilt from upstream, not copied (every object is verified against
its project's keyring on the way in). With A–D in place:

```bash
gh workflow run sync.yml -f sources=all -f limit=0 -R NEWORG/omarchy-pool       # hours; idempotent, rerun if it stops
gh workflow run promote.yml -f from=edge -f to=rc -f note="seed" -R NEWORG/omarchy-pool
gh workflow run promote.yml -f from=rc -f to=stable -f soak_days=0 -f note="seed" -R NEWORG/omarchy-pool
gh workflow run security.yml -R NEWORG/omarchy-pool
gh workflow run metrics.yml  -R NEWORG/omarchy-pool
```

From then on the hourly sync, the daily promotions (06:00 and 09:00 UTC), the
security run every three hours and the metrics every thirty minutes keep it
current, with the worker's scheduler covering any run GitHub's cron misses.

To keep the old index history instead (releases, journal, security data), export
the old D1 (`wrangler d1 export omarchy-repo --remote --output pool.sql`) and
import it into the new one before the first sync, and copy the bucket with
`rclone` between the two R2 accounts; the object keys are the same.

## F. Verify

```bash
curl -s https://pkgs.example.org/api/v1/status | jq .            # online
curl -s https://pkgs.example.org/api/v1/stats | jq '.rings[] | {ring, package_count}'
curl -sI https://pool.example.org/x86_64/omarchy-core-stable.db | head -1   # 200 from the bucket
gh workflow run health.yml -R NEWORG/omarchy-pool                # real pacman per ring and architecture
```

Open the dashboard: the header says *online*, the version chip shows the release
the Release workflow just deployed, every ring has health *ok* on both
architectures, Coverage lists every source, the journal shows `dispatch` lines
from the scheduler. Point a test machine at `stable` with *Get started* and run
`pacman -Syu`.

## F2. The factory

`factory/` (worker script, PKGBUILDs, CODEOWNERS) and the two
`factory-*.yml` workflows are a **tenant** of this repository, not part of the
pool: they should move to their own repository once a home exists (the
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
- When the factory leaves, delete `factory/`, the two workflows and the
  CODEOWNERS lines; keep `worker/src/routes/factory.ts`, migration 0007 and the
  `factory` source — they are the pool's side of the contract.

## G. What the old owner keeps, and can then remove

Nothing of the new deployment depends on the old accounts. When the new one is
verified: delete the old worker, D1 and bucket (or keep the old dashboard host as a
redirect), revoke the old API tokens, and archive or redirect the old repository.
