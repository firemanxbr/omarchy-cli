/**
 * Governance: who decides what in the factory, and how one becomes a
 * maintainer. The rules are a file in the repository, changed by pull
 * requests other maintainers approve; this page explains them and shows
 * the groups and maintainers the pool applied from that file.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const FILE = `${REPO_URL}/blob/main/factory/MAINTAINERS.toml`;

const BODY = String.raw`
  <h1>Governance</h1>
  <p class="lede">Two roles, one file, decisions by pull request. Anyone who signs in with GitHub is a <b>contributor</b>. The people listed in <a href="${FILE}"><code>factory/MAINTAINERS.toml</code></a> are the <b>maintainers</b> of the groups that list them. Nobody is above that — no owner, no superuser, no button that grants a role: the project belongs to its maintainers and contributors, and the pool reads the file on <code>main</code> every ten minutes and applies it.</p>

  <section>
    <h2>Groups and their maintainers</h2>
    <p class="sub">A <em>group</em> is an area of interest: every package registers into one, and its maintainers are the ones who approve what is built for it. Read live from the pool, which read it from <code>main</code> <span id="synced"></span>.</p>
    <div class="table-wrap"><table id="groups"><thead><tr><th>Group</th><th>What it is for</th><th>Maintainers</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Contributors and maintainers: we do not use what you built, we learn from it</h2>
    <p class="sub">A contributor uses exactly the tools a maintainer uses — the same signed worker image, the same PKGBUILD conventions, <code>namcap</code>, the same build — to produce a package that respects the packaging practices, is checked for quality and is safer for users; an AI agent may help, because nobody knows better than the author how their software should be compiled and packaged, and an agent turns that knowledge into a recipe faster. <b>What the contributor built is never what users get.</b> The maintainer does not trust it and must not: they redo the work on a worker the project trusts. What they have in front of them is not "some software, go package it" — it is a recipe that already built, its log, its manifest, its metrics, the corrections the agent made along the way. Evidence. It makes the maintainer faster and less likely to err, and the approval more confident, not less demanding.</p>
    <p class="sub">Zero trust between people, shared knowledge between them. Users get a package at least <b>two different people</b> checked — the contributor who made it work, the maintainer who rebuilt and attested it — and, when both sides run an agent, one that two independent agents built and tested.</p>
    <p class="sub"><b>The second agent.</b> The contributor's agent, if any, wrote the recipe; the maintainer's side has one too. When a build is staged the pool queues an <em>audit</em>, a job a project worker takes only if its owner set an agent key. It reads the same evidence the maintainer will — PKGBUILD, build log, <code>.PKGINFO</code> — and attaches a structured review (supply chain, security, packaging practice, correctness against the log, licence) to it. <a href="/review">Review</a> shows the verdict: <code>ok</code>, <code>warn</code>, <code>block</code>. Evidence, never a decision — nothing in the pool acts on it; the maintainer does.</p>
  </section>

  <section>
    <h2>What each role does</h2>
    <div class="steps">
      <div class="step"><h3>Contributor</h3><p>Signs in with GitHub — nothing else is asked. Requests packages, runs workers on their own machines, follows their builds. A contributor's worker builds <em>their</em> packages; the result is evidence in their staging workspace, never a package users receive.</p></div>
      <div class="step"><h3>Maintainer of a group</h3><p>A contributor listed under that group. Reads a contributor's staged build with the evidence in front of them and either rejects it or has <b>the project build it again</b> — a worker the project trusts, the project's agent, its own recipe written with the contributor's PKGBUILD, log, gate and audit as the lesson, never as the product — then approves or rejects <em>the project's build</em>; the approval is what goes into the rings, signed. <b>Never their own package</b>: another maintainer of the group approves what a maintainer brought, and a group with a single maintainer is no exception — that maintainer's own packages wait for a second one. Trusts workers as project workers; reviews governance pull requests.</p></div>
      <div class="step"><h3>The project's workers</h3><p>Machines maintainers trust. They only do what a maintainer would: the pool's jobs (sync, promote, health, security, gc), the audit of staged builds and the build of the recipes on <code>main</code>. They never build from a contributor's staged artifact and never pull a new package that has no evidence and no review yet.</p></div>
    </div>
  </section>

  <section>
    <h2>Becoming a maintainer</h2>
    <div class="steps">
      <div class="step"><h3>1. Contribute first</h3><p>Every maintainer was a contributor: packages registered, builds staged, reviews taken part in. Sign in, and the record of what you did is public on the <a href="/factory">Factory</a> page.</p></div>
      <div class="step"><h3>2. A maintainer proposes you</h3><p>A maintainer of the group opens a pull request adding your login to that group in <code>factory/MAINTAINERS.toml</code>. The pull request says why; it is a decision people make, not a database write.</p></div>
      <div class="step"><h3>3. Another maintainer approves</h3><p>The file is owned by all maintainers (<code>CODEOWNERS</code>) and <code>main</code> requires a code-owner review: at least one <em>other</em> maintainer approves, nothing is auto-merged. The merge is the promotion; within ten minutes the pool applies it and your next sign-in shows the role.</p></div>
      <div class="step"><h3>Groups, departures, the first maintainer</h3><p>Adding or retiring a group, or a maintainer stepping down, is the same pull request with the same review. While the project has a single maintainer there is nobody else to approve <em>the pull request that adds the second one</em>: that maintainer merges it alone and GitHub records the bypassed review — the one bootstrap exception, gone the moment the second maintainer exists. It never extends to packages: a sole maintainer's own packages wait.</p></div>
    </div>
  </section>

  <section>
    <h2>Workers, compute and agents</h2>
    <div class="steps">
      <div class="step"><h3>One image, the registration decides</h3><p>Contributors and maintainers run the same container, <code>ghcr.io/firemanxbr/omarchy-worker</code>; what it does follows the trust a maintainer gave the registration behind its token — a contributor's builds inside the container, or the project's jobs, audits and builds of the recipes on <code>main</code> in fresh sibling containers. <a href="/docs/workers">Run a worker →</a></p></div>
      <div class="step"><h3>Yours, and only yours</h3><p>A registered worker builds only its owner's packages. Donating compute to everyone's builds is a maintainer's call — the project's shared community workers are the ones maintainers run; a contributor's worker is never shared, whatever flag it starts with. And a worker is <em>ready</em> only when what its work needs answers: a build or an audit needs an agent that replies to the probe, not merely a key that is set.</p></div>
      <div class="step"><h3>Agent keys stay with the worker's owner</h3><p>If a worker drafts or corrects PKGBUILDs with an agent (community trust), or audits staged builds for the maintainers (project trust), the key is its owner's, in the container's environment when it starts — <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code> or <code>XAI_API_KEY</code>, whichever provider they use; <code>FACTORY_MODEL</code> picks the model. The worker reports which agent it runs (<code>anthropic/claude-sonnet-5</code>, <code>openai/gpt-5</code>, …) for the Factory page; the key itself never travels. The pool holds no agent key and GitHub runs no agent — nothing of the pipeline runs there; what an agent produces is evidence like any other build, reviewed by a maintainer before it reaches anyone.</p></div>
      <div class="step"><h3>Package requests</h3><p>A request opened as a GitHub issue becomes a task for a <em>shared</em> community worker whose owner runs an agent. No such worker, no draft: the request waits, visibly, on the Factory page.</p></div>
    </div>
  </section>

  <section>
    <h2>The record</h2>
    <p class="sub">Every role change is a <code>role</code> line in the <a href="/">journal</a>, every approval an <code>approvals</code> row a maintainer signed with their login, every trust decision a <code>trust</code> line. The file's history on GitHub is the history of who decided what.</p>
    <p class="sub"><b>Track record, per group.</b> A profile sums that record per group — as a contributor: packages a maintainer let in, builds staged, bumps, builds done for others, rejections; as a maintainer: approvals, rejections, approvals whose project build then failed — into one number with a public, dull formula: <code>3·let in + staged + bumps + for others − 2·rejected + 2·approvals + rejections − 3·builds failed</code>. It says where the work was done, orders the groups on the profile, and nothing else: no rank, no badge, no threshold.</p>
    <div class="table-wrap"><table id="roles"><thead><tr><th>When</th><th>What</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonRows("#groups", 3, 3); skeletonRows("#roles", 5, 2);
  busy(fetch("/api/v1/factory/groups")).then(function (r) { return r.json(); }).then(function (d) {
    $("#synced").textContent = d.synced_at ? "(" + ago(d.synced_at) + ")" : "(not yet)";
    pager("#groups", d.groups || [], function (g) {
      return '<tr><td><b>' + esc(g.name) + '</b><br><span class="mono muted">factory/pkgbuilds/' + esc(g.name) + '/</span></td><td>' + esc(g.description) + '</td><td>' + (g.maintainers || []).map(function (m) { return '<a href="/user/' + encodeURIComponent(m) + '">' + esc(m) + '</a>'; }).join(", ") + '</td></tr>';
    }, { empty: "no groups applied yet — the pool reads factory/MAINTAINERS.toml on main every ten minutes" });
  }).catch(function () { endSkeleton(); });
  busy(fetch("/api/v1/events?kind=role&limit=50")).then(function (r) { return r.json(); }).then(function (d) {
    pager("#roles", d.events || [], function (e) { return '<tr><td class="when">' + ago(e.created_at) + '</td><td>' + esc(e.summary) + '</td></tr>'; }, { empty: "no role change recorded yet" });
  }).catch(function () { endSkeleton(); });
  liveStats(function () {}, 120000);
`;

export function governanceHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Governance · omarchy-pool",
    description: "Contributors and maintainers, groups, and how a pull request is the only way to become a maintainer.",
    active: "docs",
    doc: "governance",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
