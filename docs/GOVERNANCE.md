# Governance

Two roles, one file, decisions by pull request.

- Anyone who signs in with GitHub is a **contributor**: requests packages,
  runs workers on their own machines, follows their builds. Nothing to ask,
  nothing spent by the project.
- The logins listed under a group in [`factory/MAINTAINERS.toml`](../factory/MAINTAINERS.toml)
  are the **maintainers** of that group. Nobody is above that — no owner,
  no superuser, no API that grants a role: the project belongs to its
  maintainers and contributors, and the pool reads the file on `main` every
  ten minutes and
  applies it (`worker/src/governance.ts`); every change is a `role` line in
  the journal.

## Contributors and maintainers

*We do not use what you built; we learn from it.*

A contributor uses exactly the tools a maintainer uses — the same signed
worker image, the same PKGBUILD conventions, `namcap`, the same build — to
produce a package that respects the packaging practices, is checked for
quality and is safer for users. An AI agent may help: nobody knows better
than the author how their software should be compiled and packaged, and an
agent turns that knowledge into a recipe faster. The agent's key is the
contributor's, on their machine; the project runs no agent for them.

**Nothing the contributor built is ever used — not the package, not the
recipe.** The maintainer does not trust it and must not. What they have in
front of them is not "some software, go package it" — it is a recipe that
already built, its log, its manifest, the gate's transcript, the second
agent's audit, the corrections made along the way. Evidence. A maintainer
(never the owner) reads it and has **the project build the package
again**: on a worker the project trusts, with the project's agent, which
gets the request and that evidence as the lesson and writes the project's
own recipe from the project's sources — through the same gate, staged
like any build, its evidence on the record. Then a maintainer approves
*the project's build*, and only that goes into the pool, signed. The pool
enforces the line: a contributor's build cannot be approved (the API says
so), a worker refuses to start from a staged artifact, and the project's
build carries `review:<task>` — where it learned, never what it copied.

Zero trust between people, shared knowledge between them. Users get a
package at least **two different people** stood behind — the contributor
who made it work, the maintainer who had it built again and attested it —
built twice, on two workers, by two agents, and never the first one.

### The second agent

The contributor's agent, if any, wrote the recipe. The maintainer's side
has one too: when a build is staged, the pool queues an **audit** — a job
a project worker takes only if its owner set an agent key. That worker
reads the same evidence the maintainer will (the PKGBUILD, the build log,
the `.PKGINFO`), asks its model for a structured review — supply chain,
security, packaging practice, correctness against the log, licence
(`factory/prompts/audit.md`) — and attaches `audit.json` and `audit.md` to
the evidence. The Review page shows the verdict next to the build: `ok`,
`warn` (approve with the findings in mind), `block` (do not approve as
is). It is evidence, never a decision: nothing in the pool acts on it, the
maintainer does. The builder cannot write those two files, and the audit
cannot write anything else; a build decided before the audit ran cancels
it. No project worker with a key, no audit: the column says *waiting*.

## Groups

A group is an area of interest — `omarchy` (what Omarchy ships or depends
on), `community` (everything else) today. Every package registers into one;
its maintainers approve what is built for it and review
`factory/pkgbuilds/<group>/`. The live list, with descriptions and
maintainers, is on the dashboard's [Governance](https://omarchy-pool.firemanxbr.org/docs/governance)
page and at `GET /api/v1/factory/groups`.

## What a maintainer does

- Reads a contributor's staged build — PKGBUILD, log, PKGINFO, the gate,
  the audit — and either rejects it with a note or has **the project
  build it** (`POST /factory/tasks/:id/build`): a review worker, the
  project's agent, the project's own recipe, the same gate, staged.
- Approves or rejects **the project's build**, with its evidence in
  front of them. An approval is the decision, on the record with a name,
  and the publish job: the project's package into `edge`, signed by the
  pool, the registration `published`, the seal written next to the
  object. **Never their own package**: a maintainer who brought a package
  is its contributor, and another maintainer of the group has it built
  and approves it (conflict of interest, refused by the pool). A group
  with a single maintainer is no exception: that maintainer's own
  packages wait for a second one — which is why a group needs two.
- Reviews pull requests touching `factory/pkgbuilds/<group>/` (a new recipe
  of the project's own, a version bump).
- Trusts workers as project workers (`POST /factory/workers/:id/trust`).
- Blocks a contributor or a package when the evidence says so, with the
  reason on the record (*Blocking*, below).
- Reviews governance pull requests: this file's changes.

## Blocking

The brake. It is on the Review page, *Blocks*, and in the API; it takes a
maintainer and a reason of at least four characters, and the reason is
what the record and the contributor see.

**A blocked contributor** (`POST /factory/contributors/<login>/block`)
gets nothing more in: no package request, no build, no worker
registration — the pool answers `403` with the reason. Their workers are
revoked at once, their queued and running tasks cancelled, their
registrations rejected and their packages pulled from every ring
(a release per architecture, rendered by a pool worker). Their projects
and source URLs stay closed: a new account asking for the same project or
the same tarball gets `403 requested by <login>, who is blocked` — a fresh
login does not open the door again. A maintainer cannot block themself
or another maintainer; the latter is a governance pull request removing
the name from `factory/MAINTAINERS.toml`.

**A blocked package** (`POST /factory/packages/<name>/block`) leaves every
ring the same way, its tasks are cancelled and its registration is
`rejected`; the project URL answers `403` to any new request until the
block is lifted.

**Lifting** (`…/unblock`, a reason again) is by **another** maintainer,
never the one who blocked — the same two-person rule as the approval.
Lifting a contributor restores nothing: their workers register again,
their packages are requested again, and everything goes through the gate
and the review as if for the first time.

Every block and every lift is a signed record in the public bucket —
`contributors/<login>/block-<stamp>.json`, `…/unblock-<stamp>.json`,
`factory/<name>/<request>/decision-<stamp>.json` — with who, when and
why; `GET /api/v1/factory/blocks` lists what is in force.

## The project's workers

Machines maintainers trust. They only do what a maintainer would: the
pool's jobs (sync, promote, health, security, gc), the audit of a staged
build and the build of the recipes on `main`. They never build from a
contributor's staged artifact, and never pull a new package that has no
evidence and no review yet — that is a contributor's worker's job.

The project runs them as two roles of the same image, and a third for the
community (`OMARCHY_WORKER_ROLE`, [factory/README.md](../factory/README.md)
*Three roles*): a **pool** worker takes the pool's jobs and nothing else; a
**review** worker takes the maintainers' work and nothing else — the
build of the recipes maintainers merge and the audit of every staged build
(the second agent); a shared **community** worker builds contributors' packages and
drafts package requests with an agent key its owner brought. The split
keeps the maintainers' agent and the contributors' agent apart, and a
container that is not a review worker never audits.

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
else to approve *the pull request that adds the second one*: that
maintainer merges it alone, and GitHub records the bypassed review. The
exception ends the moment a second maintainer exists, and it never
extended to packages — a sole maintainer's own packages wait.

## Workers, compute and agents

- **One image, one command, for everyone**: `ghcr.io/firemanxbr/omarchy-worker`.
  There is no technical difference between a contributor's container and a
  maintainer's; the registration behind the token decides. Community trust
  (every registration starts here) builds the owner's packages inside the
  container and never sees a package in review; project trust (a
  maintainer's decision on the registration) runs the pool's jobs and the
  rebuild of approved packages in fresh sibling containers. A maintainer
  who also contributes registers a second, untrusted worker.
- A registered worker builds **its owner's packages** and nothing else.
  Donating compute to everyone's builds is a maintainer's call: the
  project's shared community workers are the ones maintainers run
  (`WORKER_SHARED=1` on the container, `--shared` on `pkg-repo work`); a
  contributor's worker is never shared, whatever flag it starts with — the
  pool ignores it. Nobody's laptop ends up busy with strangers' packages,
  and no stranger's machine ends up building for everyone.
- **Ready is not online.** A worker is ready for the work it declares
  when it is alive *and* what that work needs answers: a build or an
  audit needs an agent that replies. A key set is not an agent that
  works — no credit, a revoked token, a dead endpoint, a retired model —
  so the worker probes its agent (`factory/bin/agent.py --probe`, one tiny
  completion) at start and every thirty minutes, and says so with every
  claim. The pool hands a draft or an audit only to a worker whose agent
  answered, and the People page shows each worker's agent and whether it
  answers. The pool's own jobs (sync, promote, health, security, gc) need
  no agent and are not gated by one.
- **Agent keys stay with the worker's owner.** A worker that drafts or
  corrects PKGBUILDs with an agent (community trust), or audits staged
  builds for the maintainers (project trust), gets the owner's key in its
  environment when it starts — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY` or `XAI_API_KEY`, whichever provider they use
  (`factory/bin/agent.py`; `FACTORY_MODEL` picks the model). The worker
  reports *which* agent it runs (`anthropic/claude-sonnet-5`,
  `openai/gpt-5`, …) so the Factory page can show it; the key itself never
  travels. The pool holds no agent key and GitHub runs no agent — nothing
  of the pipeline runs there; what an agent produces is evidence like any
  other build, reviewed by a maintainer before it reaches anyone.
- **Package requests** are made on the dashboard, on the record; the
  build a contributor asks for goes to the project's shared community
  workers (the project's agent) or to the contributor's own worker (their
  agent). No ready worker, no draft: the request waits, visibly, on the
  Factory page.

## Bumps and packages nobody builds

A new upstream release of an approved package is built the way the first
version was — on the owner's worker, as evidence a maintainer reviews. Once
a day the pool queues that build (`bump:<task>@<tag>`: the contributor's
staged PKGBUILD with `pkgver` moved to the tag; evidence again, never the
product). The owner's worker has **14 days**; after that any `--shared`
worker may build it. **30 days** without a build and the package is
*unmaintained*: no more bumps until its owner builds again, or a
maintainer of the group removes the registration so someone else can take
the name. The project's recipes (`factory/pkgbuilds/<group>/`, the
maintainers' own and the ones written from contributors' evidence) are
bumped by pull request — `factory-update.yml` opens one per package —
reviewed by the group's maintainers, never auto-merged.

## The record

Role changes are `role` events, approvals are rows a maintainer signed with
their login (`GET /api/v1/factory/approvals`), trust decisions are `trust`
events, blocks and their lifting are signed records in the public bucket
(*Blocking*). The file's history on GitHub is the history of who decided what.

### Track record, per group

A profile (`/user/<login>`, `GET /api/v1/users/<login>` → `record`) sums
that record per group, so it says where a person has done the work — not
who they are. Per group, as a contributor: distinct packages a maintainer
let in, builds that produced evidence (staged), of which bumps, builds
their workers did for other people (donated compute), rejections. As a
maintainer: approvals, rejections, and approvals whose project rebuild
then failed. One number per group, so that the formula is public and dull:

```
score = 3·let in + staged + bumps + for others − 2·rejected      (contributed)
      + 2·approvals + rejections − 3·rebuilds failed              (maintained)
```

It orders the groups on a profile and nothing else: no rank, no badge, no
threshold. Becoming a maintainer is still a pull request another
maintainer approves, with this record as one thing they look at.
