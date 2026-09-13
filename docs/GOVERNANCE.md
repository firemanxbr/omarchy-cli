# Governance

Two roles, one file, decisions by pull request.

- Anyone who signs in with GitHub is a **contributor**: registers packages,
  runs workers on their own machines, follows their builds. Nothing to ask,
  nothing spent by the project.
- The logins listed under a group in [`factory/MAINTAINERS.toml`](../factory/MAINTAINERS.toml)
  are the **maintainers** of that group. Nobody is above that — no owner,
  no administrator, no API that grants a role: the project belongs to its
  maintainers and contributors, and the pool reads the file on `main` every
  ten minutes and
  applies it (`worker/src/governance.ts`); every change is a `role` line in
  the journal.

## Groups

A group is an area of interest — `omarchy` (what Omarchy ships or depends
on), `community` (everything else) today. Every package registers into one;
its maintainers approve what is built for it and review
`factory/pkgbuilds/<group>/`. The live list, with descriptions and
maintainers, is on the dashboard's [Governance](https://omarchy-pool.firemanxbr.org/governance)
page and at `GET /api/v1/factory/groups`.

## What a maintainer does

- Approves or rejects the staged builds of their groups, with the evidence
  (PKGBUILD, log, PKGINFO) in front of them. An approval queues the
  project's own rebuild; users only ever get what the project built and
  signed.
- Reviews pull requests touching `factory/pkgbuilds/<group>/` (a new recipe
  of the project's own, a version bump).
- Trusts workers as project workers (`POST /factory/workers/:id/trust`).
- Reviews governance pull requests: this file's changes.

## The project's workers

Machines maintainers trust. They only do what a maintainer would: the
pool's jobs (sync, promote, health, security, gc) and the rebuild of a
package a maintainer approved. They never pull a new package that has no
evidence and no review yet — that is a contributor's worker's job.

## Becoming a maintainer

1. **Contribute first.** Every maintainer was a contributor: packages
   registered, builds staged, reviews taken part in. The record is public on
   the Factory page.
2. **A maintainer proposes you** — a pull request adding your login to a
   group in `factory/MAINTAINERS.toml`, saying why. It is a decision people
   make, not a database write.
3. **Another maintainer approves.** The file (and `CODEOWNERS`, generated
   from it) is owned by every maintainer and `main` requires a code-owner
   review, so at least one *other* maintainer approves; nothing about it is
   auto-merged. The merge is the promotion: within ten minutes the pool
   applies it and the next sign-in shows the role.

Adding or retiring a group, or a maintainer stepping down, is the same pull
request with the same review. Run `factory/bin/check-governance --write` in
that pull request to regenerate `CODEOWNERS`; CI fails when the two
disagree.

**Bootstrap.** While the project has a single maintainer there is nobody
else to approve: that maintainer merges alone, and GitHub records the
bypassed review. The exception ends the moment a second maintainer exists.

## Workers, compute and agents

- A registered worker builds **its owner's packages**. Donating it to
  anyone's is decided where it runs — `WORKER_SHARED=1` on the container,
  `--shared` on `pkg-repo work` — never at registration, so nobody's laptop
  ends up busy with strangers' packages by accident.
- **Agent keys stay with the worker's owner.** A worker that drafts or
  corrects PKGBUILDs with an agent gets `ANTHROPIC_API_KEY` in its
  environment when it starts — community and project workers alike. The
  pool holds no agent key and GitHub runs no agent; what an agent produces
  is evidence like any other build, reviewed by a maintainer before it
  reaches anyone.
- **Package requests** (a GitHub issue) become a task for a *shared*
  community worker whose owner runs an agent. No such worker, no draft: the
  request waits, visibly, on the Factory page.

## Bumps and packages nobody builds

A new upstream release of an approved package is built the way the first
version was — on the owner's worker, as evidence a maintainer reviews. Once
a day the pool queues that build (`bump:<task>@<tag>`: the approved
PKGBUILD with `pkgver` moved to the tag). The owner's worker has **14
days**; after that any `--shared` worker may build it. **30 days** without
a build and the package is *unmaintained*: no more bumps until its owner
builds again, or a maintainer of the group removes the registration so
someone else can take the name. The project's own recipes
(`factory/pkgbuilds/<group>/`) are bumped by pull request, reviewed by the
group's maintainers, never auto-merged.

## The record

Role changes are `role` events, approvals are rows a maintainer signed with
their login (`GET /api/v1/factory/approvals`), trust decisions are `trust`
events. The file's history on GitHub is the history of who decided what.
