/**
 * API: the endpoints a script, an agent or omarchy-cli uses, with examples.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>API</h1>
  <p class="lede">Everything this site shows comes from a small JSON API at <code>https://pkgs.firemanxbr.org/api/v1</code>. Reads need no authentication and allow cross-origin requests; writes need the per-job token a worker gets when it claims a task — there is no shared secret — or, on the factory's own routes, a maintainer's token.</p>

  <section>
    <h2>Read</h2>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
      <tr><td><code>GET /version</code></td><td>The running release, its commit and when it was deployed.</td></tr>
      <tr><td><code>GET /signing-key</code></td><td>The pool's public signing key (fingerprint, user id, armored) — what <code>pacman-key --add</code> imports.</td></tr>
      <tr><td><code>GET /status</code></td><td>Service check, measured now: index (D1) and pool (R2) reachable, with timings. 503 when one is not. What <em>online</em> in the header means.</td></tr>
      <tr><td><code>GET /stats</code></td><td>Everything the overview shows in one response: rings, coverage, pool totals, chart series, the latest metrics snapshot, recent journal entries, OPR recipes by origin per ring (<code>provenance</code>), <code>any</code> packages stored once per architecture and what that costs (<code>any</code>). Cached 30 s.</td></tr>
      <tr><td><code>GET /releases/:ring?fields=summary&amp;arch=</code></td><td>The ring's current release and a light row per package (name, version, arch, filename, sha256, sizes, description). This is what <code>omarchy-cli status</code> reads.</td></tr>
      <tr><td><code>GET /releases/:ring?arch=&amp;limit=&amp;after=&amp;release_id=</code></td><td>Full manifests, paged (≤ 1000 per request; above 2000 packages paging is required): <code>page.next</code> names the row the next page starts after — pass it as <code>after=</code> (keyset; <code>offset=</code> still works). Add <code>include=files</code> for file lists. <code>release_id</code> pins a release across pages.</td></tr>
      <tr><td><code>GET /releases/:ring/history</code></td><td>The ring's releases, newest first, with lineage (parent, from) and which one is the head.</td></tr>
      <tr><td><code>GET /releases/:ring/diff?from=&amp;to=&amp;arch=</code></td><td>What changed between two releases of the ring: packages added, removed and upgraded (same name and architecture, another object). <code>to</code> defaults to the head, <code>from</code> to its parent; 410 once GC pruned a side's package list. The dashboard's <code>/diff</code> page and <code>pkg-repo diff</code> read this.</td></tr>
      <tr><td><code>GET /packages/:sha256</code></td><td>One package object's manifest.</td></tr>
      <tr><td><code>GET /search?q=&amp;ring=&amp;arch=&amp;limit=</code></td><td>Packages in the ring whose name or description matches (exact and prefix matches first).</td></tr>
      <tr><td><code>GET /package/:name?ring=&amp;arch=</code> · <code>/files</code></td><td>Everything the package page shows: the version in every ring, the manifest, declared dependencies and loaded sonames resolved to their providers, what depends on it (declared or by loading one of its libraries); the file list separately. For an OPR package, <code>provenance</code>: whether its recipe is Omarchy's own or AUR-synced, the AUR commit tracked, the last commit that touched it (<code>omacom/omarchy-pkgs</code>, read daily).</td></tr>
      <tr><td><code>GET /graph?ring=&amp;arch=&amp;targets=a,b</code></td><td>Dependency closure of the targets within the ring's release: the manifests <code>omarchy-cli check</code> evaluates.</td></tr>
      <tr><td><code>GET /security/components</code></td><td>What the rings' packages embed — Go modules and crates.io crates from the binaries' build information — with the sha256 of every served object that embeds each; what the security job asks OSV about.</td></tr>
      <tr><td><code>GET /security?ring=&amp;arch=</code></td><td>Packages in the ring with an open advisory: severity, confidence (exact / name-version / name-only), CVEs, exploited-in-the-wild and EPSS, rings already serving a clean version, how many packages it exposes. <code>GET /package/:name</code> carries the same per package plus what it is exposed through.</td></tr>
      <tr><td><code>GET /events?kind=&amp;limit=</code></td><td>The journal: sync, gate, promote, render, health, abi, rollback, deploy, gc, metrics.</td></tr>
      <tr><td><code>GET /pool/unreferenced?keep=3</code></td><td>What retention would delete now.</td></tr>
      <tr><td><code>GET /cost</code></td><td>The month's estimated bill, line by line (D1, R2, Workers), the projection and the guard's state. Estimated daily at 06:30 UTC.</td></tr>
    </tbody></table></div>
  </section>

  <section>
    <h2>The factory (read)</h2>
    <p class="sub">What the Factory, Contributors, Review and profile pages show. Public, cached briefly.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
      <tr><td><code>GET /factory?limit=</code></td><td>Workers the pool has heard from (owner, trust, mode, the agent each reported, current task), the queue (every kind: builds, pool jobs, audits), package requests, counts.</td></tr>
      <tr><td><code>GET /factory/packages</code> · <code>/built</code> · <code>/tasks/:id</code></td><td>The registry of packages people brought; what the factory built; one task with its log tail.</td></tr>
      <tr><td><code>GET /factory/review</code></td><td>Staged community builds waiting for a maintainer, each with links to its evidence (PKGBUILD, log, .PKGINFO, the audit) and the second agent's verdict (<code>ok</code> / <code>warn</code> / <code>block</code>, or <em>queued</em> / <em>failed</em>).</td></tr>
      <tr><td><code>GET /factory/tasks/:id/artifacts/&lt;file&gt;</code></td><td>A staged build's evidence: <code>PKGBUILD</code>, <code>build.log</code>, <code>PKGINFO</code>, <code>audit.md</code>, <code>audit.json</code> are public; the package itself is for maintainers.</td></tr>
      <tr><td><code>GET /factory/approvals</code> · <code>/groups</code> · <code>/trust</code></td><td>The record: every decision with who signed it; the groups and their maintainers (from <code>factory/MAINTAINERS.toml</code>); project-trusted workers.</td></tr>
      <tr><td><code>GET /users/:login</code></td><td>A contributor's or maintainer's public profile: packages, builds, approvals, workers, and the <em>track record</em> per group (<a href="/docs/governance">Governance</a>).</td></tr>
      <tr><td><code>GET /factory/workers/self</code></td><td>With a worker token: what that registration is (id, arch, trust, owner, mode) — how the image decides its mode.</td></tr>
      <tr><td><code>GET /factory/me</code></td><td>With a contributor token or the browser session: who you are, your packages, tasks, workers and staging quota.</td></tr>
    </tbody></table></div>
  </section>

  <section>
    <h2>Examples</h2>
    <div class="steps">
      <div class="step"><h3>Which version of a package does each ring serve?</h3>
<pre>for ring in edge rc stable; do
  curl -s "https://pkgs.firemanxbr.org/api/v1/releases/$ring?fields=summary&amp;arch=x86_64" \
    | jq -r --arg r "$ring" '.packages[] | select(.name == "openssl") | "\($r)\t\(.version)"'
done</pre></div>
      <div class="step"><h3>What changed in stable today?</h3>
<pre>curl -s https://pkgs.firemanxbr.org/api/v1/events?kind=promote | jq '.events[0]'
curl -s https://pkgs.firemanxbr.org/api/v1/releases/stable/history | jq '.releases[0:3]'</pre></div>
      <div class="step"><h3>Is the pool healthy right now?</h3>
<pre>curl -s https://pkgs.firemanxbr.org/api/v1/stats \
  | jq '[.latest[] | select(.kind == "health") | {ring, arch: .source, status, at: .created_at}]'</pre></div>
      <div class="step"><h3>The static side (what pacman reads)</h3>
<pre>curl -sI https://pool.firemanxbr.org/x86_64/omarchy-core-stable.db | head -3
curl -s  https://pool.firemanxbr.org/x86_64/omarchy-core-stable.db | tar -tz | head</pre></div>
    </div>
  </section>

  <section>
    <h2>Write (jobs only)</h2>
    <p class="sub">Bearer <code>omj.…</code>: the per-job token issued at <code>POST /factory/claim</code>, scoped to what that task needs (<code>pool:write</code>, <code>release:&lt;ring&gt;</code>, <code>artifacts:*:&lt;ring&gt;</code>, <code>security:write</code>, <code>gc</code>, <code>events</code>) and valid for its lease. Used by <code>pkg-repo work</code>; documented in <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/SECURITY.md">SECURITY.md</a>. A maintainer queues one of these jobs by hand with <code>POST /factory/jobs</code>.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>PUT /pool/:sha256?filename=&amp;arch=</code> · <code>/sig</code> · <code>/multipart</code></td><td>Store a package object (integrity-checked, never overwritten) and its upstream signature.</td></tr>
      <tr><td><code>POST /pool/:sha256/sign?filename=&amp;arch=</code></td><td>The pool signs a package it built (source <em>factory</em>) with its own key; the key never leaves the service.</td></tr>
      <tr><td><code>POST /packages?source=&amp;arch=</code> · <code>POST /packages/known</code></td><td>Index a manifest; ask which sha256s are already indexed.</td></tr>
      <tr><td><code>POST /releases</code></td><td>Create, promote or roll back a release (an index write); <code>arch</code> moves one architecture only while the other keeps what the ring serves.</td></tr>
      <tr><td><code>PUT /releases/:id/artifacts/:kind?repo=&amp;arch=</code></td><td>Publish a rendered database beside the packages; the pool signs it as it stores it.</td></tr>
      <tr><td><code>POST /events</code> · <code>POST /pool/gc</code></td><td>Record a journal entry; run retention.</td></tr>
      <tr><td><code>PUT /factory/tasks/:id/artifacts/&lt;file&gt;</code></td><td>A community build's token uploads its evidence to its own staging workspace; an audit's token adds <code>audit.json</code> / <code>audit.md</code> to a staged build, and nothing else.</td></tr>
    </tbody></table></div>
  </section>

  <section>
    <h2>Write (people)</h2>
    <p class="sub">Bearer <code>omc_…</code> (a contributor token from your profile) or the browser session after <em>Sign in with GitHub</em>. Nothing here touches the pool directly: maintainers queue jobs and approve builds; workers do the work with per-job tokens.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Who</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>POST /factory/packages</code> · <code>/packages/:name/build</code> · <code>DELETE /packages/:name</code></td><td>contributor</td><td>Request a package (the project's URL, a description, the licence, the checklist — written once to the record), ask for a build, remove the request.</td></tr>
      <tr><td><code>POST /factory/workers</code> · <code>DELETE /workers/:id</code></td><td>contributor</td><td>Register a worker (the token is shown once), revoke it.</td></tr>
      <tr><td><code>POST /factory/tasks/:id/approve</code> · <code>/reject</code></td><td>maintainer of the group</td><td>Approve a staged build — the decision on the record — or send it back with a note. Never your own package.</td></tr>
      <tr><td><code>POST /factory/jobs</code></td><td>maintainer</td><td>Queue a pool job by hand (sync, promote, rollback, render, health, security, gc, enqueue) — what <code>pkg-repo job</code> calls.</td></tr>
      <tr><td><code>POST /factory/workers/:id/trust</code></td><td>maintainer</td><td>Promote a registration to project trust, or back.</td></tr>
      <tr><td><code>GET /auth/github</code> · <code>/auth/me</code> · <code>/auth/logout</code></td><td>anyone</td><td>Sign in with GitHub (a session cookie for the dashboard); who is signed in; sign out — the session stops working on the server, the CLI token is untouched.</td></tr>
    </tbody></table></div>
  </section>
`;

export function apiDocsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "API · omarchy-pool",
    description: "The omarchy-pool JSON API: rings, releases, packages, dependency graph, journal.",
    active: "docs",
    doc: "api",
    body: BODY,
    script: "liveStats(function () {}, 120000);",
    poolUrl,
    version,
  });
}
