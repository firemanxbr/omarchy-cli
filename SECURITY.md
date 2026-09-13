# Security

How omarchy-pool decides who may do what, where the keys live, and what a
compromised piece can and cannot do. Decisions are recorded here as they
are made; the *Status* column says what is running today.

Report a vulnerability privately to the maintainers listed on the Factory
page's trust list (or open a GitHub security advisory on this repository);
please do not file a public issue for it.

## Principles

1. **Users trust the pool, nothing else.** A machine installs from the
   pool's signed databases; every package it serves was either verified
   against its upstream project's key at import or built by a worker the
   project trusts and signed by the pool. No contributor's bytes reach a
   user before a maintainer approves them and the project rebuilds them.
2. **The signing key never travels.** It signs inside the pool's own
   service; builders produce bytes and evidence, never signatures.
3. **A credential is worth exactly one job.** Nothing holds a token that
   "does everything". A worker's token can only ask for work; each job gets
   a credential scoped to the routes it needs, valid for its lease.
4. **Trust is granted per machine and per person, recorded and revocable.**
   Project workers are promoted by a maintainer; maintainers are named by
   `factory/MAINTAINERS.toml` — a pull request another maintainer approves,
   never a database write (docs/GOVERNANCE.md); every grant and every
   approval is a journal line with a name.
5. **GitHub hosts code and cuts releases.** It runs none of the pool's
   operations and holds none of its keys.

## Credentials

| Credential | Held by | Can do | Cannot do | Status |
|---|---|---|---|---|
| Contributor token `omc_…` | one person (GitHub identity read once, never stored) | register packages under their name, queue community builds, register and revoke their workers, read their own state | write to the pool, claim jobs, approve | live |
| Worker token `omw_…` | one machine, registered by a contributor | claim tasks its trust allows (community: its owner's or shared builds; project: pool jobs too); heartbeat | write to the pool or staging directly | live |
| Job token `omj.…` | the worker running one task, for the lease | the routes that task needs — e.g. `sync`: upload objects, index, create a release in one ring, store that ring's databases; community `build`: upload to that task's staging folder | anything outside its scopes (403, journaled); anything after the lease (30 min, renewed by heartbeat) | live |
| Maintainer role | a contributor listed under a group in `factory/MAINTAINERS.toml` on `main` (applied by the brain every ten minutes) | promote a worker to project trust; approve or reject staged builds of their groups (recorded); review the group's PKGBUILDs and governance pull requests | operate as a worker; grant a role | live |
| Publish token | GitHub Actions (pipeline), maintainers on the command line | everything a job can, on any ring | — | live; **retiring** as each job kind moves to pulled jobs |
| Signing key (OpenPGP) | the pool's Worker only (`SIGNING_KEY` secret, `worker/src/signing.ts`) | sign the databases it stores and the packages the factory builds (`POST /pool/:sha256/sign`) | — | live; no worker, runner or repository holds it |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions release workflow | deploy the Worker, apply migrations | — | live; the only secret GitHub will keep |
| GitHub PAT on the Worker | the scheduler | dispatch workflows | — | live; removed once no rule dispatches a workflow |

Tokens are 192-bit random values shown once and stored as SHA-256 hashes;
job tokens are HMAC-SHA256-signed claims (`JOB_TOKEN_SECRET`, a Worker
secret). Everything travels in the `Authorization` header over TLS only.

## Trust levels

| Who | Gets | How |
|---|---|---|
| Contributor | register packages, run community workers | GitHub account |
| Community worker | community builds of its owner's packages; anyone's only when started with `--shared` / `WORKER_SHARED=1`; results go to a separate staging bucket in the owner's workspace | registered by its owner |
| Project worker | pool jobs (sync, render, promote, health, security, gc) and the rebuild of approved packages — never a build without evidence and review | a maintainer sets `trust = project` on the worker (`POST /factory/workers/:id/trust`) |
| Maintainer | approve staged builds of their groups, promote workers, review governance | listed in `factory/MAINTAINERS.toml`, merged with another maintainer's review |
| Agent key | drafts and corrects PKGBUILDs on a worker | the worker owner's own `ANTHROPIC_API_KEY`, set in the container's environment; the pool and GitHub hold none |

## Isolation

- **Builds run in a fresh container per task** that sees the PKGBUILD and
  the network and nothing else — no tokens, no keys, no access to the
  container runtime. The worker process outside the container holds the
  job token.
- **Contributor results never touch the pool.** They land in
  `omarchy-factory-staging` under `staging/<login>/<package>/<task>/`,
  through the pool (the key is derived from the task, never given),
  with quotas (2 GB, 10 tasks) and a 30-day lifecycle. Logs and PKGBUILDs
  are public; packages are readable by maintainers.
- **Approved packages are rebuilt by the project** from the same PKGBUILD
  (`pkgbuild_ref = staging:<task>`) on a project-trusted worker before they
  are signed and enter `edge`; a contributor's build is evidence, not the
  product.
- **The pool serves immutable objects.** An object under a filename is
  never rewritten; a signature must match the stored object or it is
  refused; superseded versions stay until retention runs.
- **The Omarchy Packaging image is signed** (cosign, keyless, GitHub OIDC)
  so a contributor can verify the worker they run is the project's.

## After approval, the gates still hold

A carelessly approved package still faces what every package faces: a real
pacman on both architectures after every promotion, the ABI check, a day in
`rc` and a day in `stable`'s soak, automatic rollback on a failed health
check, and the security layer's advisories.

## What a compromise costs

| Compromised | Blast radius | Recovery |
|---|---|---|
| a contributor's token | their registrations and their staging folder | they register again (the old token dies) |
| a community worker's token | claims of that owner's tasks; uploads to those tasks' staging | owner revokes the worker |
| a job token | that task's writes, until its lease ends | expires by itself; the task can be cancelled |
| a project worker's token | claims of pool jobs — each still executed with a scoped job token — until revoked | a maintainer revokes the worker |
| a maintainer's token | approvals in their groups, worker trust | a governance pull request removes the login; approvals are journaled and reversible (rollback) |
| the publish token (transition) | any write to the pool | rotate the secret and the GitHub secret; retire it sooner |
| the signing key | signatures on bad content — only through the Worker's own routes, since the key is a secret of the service | rotate: `wrangler secret put SIGNING_KEY`, re-render every ring, users import the new public key (RUNBOOK) |

## Roadmap

1. ~~Per-job scoped tokens; project workers registered and trusted by a maintainer; pool jobs pulled by workers~~ — live (v0.0.40).
2. ~~Signing inside the pool's Worker: the key becomes a Worker secret; `publish` and `render` stop signing on workers; the GitHub secret is deleted~~ — live (v0.0.49). A client's `.sig` for a database is superseded; a package signature must match the stored bytes.
3. ~~Retire `FACTORY_TOKEN`~~ — gone (v0.0.50): every worker, the hosted fallback included, is a registration with its own token. ~~The pipeline's last workflows become jobs~~ — done (v0.0.51: `security` is a pulled job, the metrics snapshot is the brain's own). Retire the publish token: maintainers use personal tokens, the factory's enqueue/update workflows become jobs, GitHub keeps only the release.
4. ~~Phase 2: maintainers by area, approval as a recorded action, rebuild at approval on project workers~~ — live (v0.0.42). A promotion gate for the `factory` source is unnecessary: nothing unapproved enters `edge`.
