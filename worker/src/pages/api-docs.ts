/**
 * API: the endpoints a script, an agent or omarchy-cli uses, with examples.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>API</h1>
  <p class="lede">Everything this site shows comes from a small JSON API at <code>https://pkgs.firemanxbr.org/api/v1</code>. Reads need no authentication and allow cross-origin requests; writes need the publish token and are what the pipeline uses.</p>

  <section>
    <h2>Read</h2>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
      <tr><td><code>GET /version</code></td><td>The running release, its commit and when it was deployed.</td></tr>
      <tr><td><code>GET /status</code></td><td>Service check, measured now: index (D1) and pool (R2) reachable, with timings. 503 when one is not. What <em>online</em> in the header means.</td></tr>
      <tr><td><code>GET /stats</code></td><td>Everything the overview shows in one response: rings, coverage, pool totals, chart series, the latest metrics snapshot, recent journal entries. Cached 30 s.</td></tr>
      <tr><td><code>GET /releases/:ring?fields=summary&amp;arch=</code></td><td>The ring's current release and a light row per package (name, version, arch, filename, sha256, sizes, description). This is what <code>omarchy-cli status</code> reads.</td></tr>
      <tr><td><code>GET /releases/:ring?arch=&amp;limit=&amp;offset=&amp;release_id=</code></td><td>Full manifests, paged (≤ 1000 per request; above 2000 packages paging is required). Add <code>include=files</code> for file lists. <code>release_id</code> pins a release across pages.</td></tr>
      <tr><td><code>GET /releases/:ring/history</code></td><td>The ring's releases, newest first, with lineage (parent, from) and which one is the head.</td></tr>
      <tr><td><code>GET /packages/:sha256</code></td><td>One package object's manifest.</td></tr>
      <tr><td><code>GET /search?q=&amp;ring=&amp;arch=&amp;limit=</code></td><td>Packages in the ring whose name or description matches (exact and prefix matches first).</td></tr>
      <tr><td><code>GET /package/:name?ring=&amp;arch=</code> · <code>/files</code></td><td>Everything the package page shows: the version in every ring, the manifest, declared dependencies and loaded sonames resolved to their providers, what depends on it (declared or by loading one of its libraries); the file list separately.</td></tr>
      <tr><td><code>GET /graph?ring=&amp;arch=&amp;targets=a,b</code></td><td>Dependency closure of the targets within the ring's release: the manifests <code>omarchy-cli check</code> evaluates.</td></tr>
      <tr><td><code>GET /events?kind=&amp;limit=</code></td><td>The journal: sync, gate, promote, render, health, abi, rollback, deploy, gc, metrics.</td></tr>
      <tr><td><code>GET /pool/unreferenced?keep=3</code></td><td>What retention would delete now.</td></tr>
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
    <h2>Write (pipeline only)</h2>
    <p class="sub">Bearer <code>PUBLISH_TOKEN</code>. Used by <code>pkg-repo</code> from GitHub Actions; documented in the repository's <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/docs/ARCHITECTURE.md">architecture notes</a>.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>PUT /pool/:sha256?filename=&amp;arch=</code> · <code>/sig</code> · <code>/multipart</code></td><td>Store a package object (integrity-checked, never overwritten) and its upstream signature.</td></tr>
      <tr><td><code>POST /packages?source=&amp;arch=</code> · <code>POST /packages/known</code></td><td>Index a manifest; ask which sha256s are already indexed.</td></tr>
      <tr><td><code>POST /releases</code></td><td>Create, promote or roll back a release (an index write).</td></tr>
      <tr><td><code>PUT /releases/:id/artifacts/:kind?repo=&amp;arch=</code></td><td>Publish a rendered database or its signature beside the packages.</td></tr>
      <tr><td><code>POST /events</code> · <code>POST /pool/gc</code></td><td>Record a journal entry; run retention.</td></tr>
    </tbody></table></div>
  </section>
`;

export function apiDocsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "API · omarchy-pool",
    description: "The omarchy-pool JSON API: rings, releases, packages, dependency graph, journal.",
    active: "overview",
    body: BODY,
    script: "liveStats(function () {}, 30000);",
    poolUrl,
    version,
  });
}
