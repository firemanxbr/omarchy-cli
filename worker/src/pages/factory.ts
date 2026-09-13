/**
 * Factory: what is queued, building and built, and the workers pulling the
 * work. The brain is the pool's own API (`/api/v1/factory`); the page only
 * reads it.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <h1>Factory</h1>
  <p class="lede">Packages no upstream ships are built here, from PKGBUILDs reviewed in <a href="${REPO_URL}/tree/main/factory/pkgbuilds"><code>factory/pkgbuilds</code></a>. The pool is the brain: a merged PKGBUILD becomes one build task per architecture, and <b>workers</b> — ephemeral containers anywhere: a laptop, a GitHub-hosted runner, a VM — come here to <b>claim</b> the next task of their architecture, hold a lease while they build, and report back. A lease that expires puts the task back in the queue. A finished build is signed, published into <code>edge</code> as source <code>factory</code> and rendered; from there it follows the usual rings. <a href="${REPO_URL}/blob/main/factory/README.md">How to run a worker or request a package →</a></p>
  <p class="sub" id="updated"></p>

  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Contributed packages</h2>
    <p class="sub">Anyone with a GitHub account registers a package and runs a worker for it — no permission needed, nothing spent by the project. Builds land in the contributor's staging workspace with their PKGBUILD and log; a maintainer of the group approves them into <code>edge</code>. <a href="${REPO_URL}/blob/main/factory/README.md#contribute-a-package">Contribute a package →</a></p>
    <div class="table-wrap"><table id="registry"><thead><tr><th>Package</th><th>Project</th><th>Owner</th><th>Arches</th><th>Detected</th><th>Stage</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Workers</h2>
    <p class="sub">Alive means seen in the last ten minutes. A worker with no current task is asking for work every 30 seconds.</p>
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Arch</th><th>Where</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Build tasks</h2>
    <p class="sub">Leased first, then queued, then the most recent finished ones. Attempts count every claim; after three the task is marked failed.</p>
    <div class="table-wrap"><table id="tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Reason</th><th>Worker</th><th>Took</th><th>Result</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Requests</h2>
    <p class="sub">A request is a project URL. The factory drafts the PKGBUILD, builds it as a dry run on both architectures and opens a pull request; a maintainer of the group approves it once by merging. After that, new versions build without a human. <a href="${REPO_URL}/issues/new?template=package-request.yml">Request a package →</a></p>
    <div class="table-wrap"><table id="requests"><thead><tr><th>#</th><th>Package</th><th>Project</th><th>Arches</th><th>Stage</th><th>Requested by</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  function statusPill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", requested: "var(--amber)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", drafting: "var(--blue)", validating: "var(--blue)", review: "var(--amber)", approved: "var(--green)", rejected: "var(--dim)", unmaintained: "var(--dim)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  skeletonTiles("#tiles", 5); skeletonRows("#registry", 8, 2); skeletonRows("#workers", 6, 2); skeletonRows("#tasks", 8, 4); skeletonRows("#requests", 8, 2);
  function loadRegistry() {
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).then(function (d) {
      $("#registry tbody").innerHTML = (d.packages || []).map(function (p) {
        var det = p.detected || {};
        return '<tr><td><b>' + esc(p.name) + '</b> <span class="src">' + esc(p.group) + '</span></td><td><a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a></td><td>' + esc(p.owner) + '</td><td>' + esc((p.arches || []).join(", ")) + '</td>' +
          '<td>' + esc([det.build_system, det.language, det.license, det.latest_tag].filter(Boolean).join(" · ")) + '</td><td>' + statusPill(p.status) + (p.staged_builds ? ' <span class="muted">' + p.staged_builds + ' staged</span>' : '') + '</td><td>' + esc(p.detail || "") + '</td><td>' + ago(p.updated_at) + '</td></tr>';
      }).join("") || '<tr><td colspan="8" class="muted">no package registered yet — <a href="' + REPO + '/blob/main/factory/README.md#contribute-a-package">be the first</a></td></tr>';
    }).catch(function () {});
  }
  var REPO = "${REPO_URL}";
  function load() {
    loadRegistry();
    busy(fetch("/api/v1/factory")).then(function (r) { return r.json(); }).then(function (d) {
      var count = function (st, arch) { return d.counts.filter(function (c) { return c.status === st && (!arch || c.arch === arch); }).reduce(function (n, c) { return n + c.n; }, 0); };
      var alive = d.workers.filter(function (w) { return w.alive; });
      var tiles = [
        ["Queued", num(count("queued")), num(count("queued", "x86_64")) + " x86_64 · " + num(count("queued", "aarch64")) + " aarch64"],
        ["Building", num(count("leased")), "lease " + d.lease_minutes + " min, extended by heartbeats"],
        ["Workers alive", num(alive.length), alive.filter(function (w) { return w.arch === "x86_64"; }).length + " x86_64 · " + alive.filter(function (w) { return w.arch === "aarch64"; }).length + " aarch64"],
        ["Built", num(count("done") + count("staged")), num(count("staged")) + " staged for a maintainer · " + num(count("failed")) + " failed"],
        ["Awaiting approval", num(d.requests.filter(function (r) { return r.status === "requested"; }).length), "requests without a merged PKGBUILD"]
      ];
      tiles.forEach(function (t, i) { var el = $("#tiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
      $("#updated").textContent = "Refreshed " + ago(d.generated_at) + " · live every 30 s";
      $("#workers tbody").innerHTML = d.workers.map(function (w) {
        var where = w.labels && w.labels.where ? w.labels.where : (w.hostname || "—");
        return '<tr><td class="mono">' + esc(w.id) + (w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(where) + (w.version ? ' <span class="muted">pkg-repo ' + esc(w.version) + '</span>' : '') + '</td>' +
          '<td>' + (w.current_task ? '#' + w.current_task : '<span class="muted">idle</span>') + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
      }).join("") || '<tr><td colspan="6" class="muted">no worker has reported yet</td></tr>';
      $("#tasks tbody").innerHTML = d.tasks.map(function (t) {
        var result = t.status === "staged"
          ? '<span class="mono">' + esc(t.result_filename || "") + '</span> <a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/build.log">log</a> <a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>'
          : t.status === "done" && t.result_filename
          ? (t.publish === 0 ? '<span class="mono">' + esc(t.result_filename) + '</span>' : '<a href="/package/' + encodeURIComponent(t.name) + '?ring=edge&arch=' + t.arch + '" class="mono">' + esc(t.result_filename) + '</a>')
          : (t.error ? '<span class="muted" title="' + esc(t.error) + '">' + esc(t.error.slice(0, 90)) + '</span>' : '<span class="muted">—</span>');
        return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b> <span class="src">' + esc(t.group) + '</span>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td>' +
          '<td>' + statusPill(t.status) + (t.trust === "community" ? ' <span class="pill none" title="a contributor\'s build: goes to staging, a maintainer approves">' + esc(t.owner || "community") + '</span>' : '') + (t.publish === 0 && t.trust !== "community" ? ' <span class="pill none" title="built and measured, never published">dry run</span>' : '') + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '/' + t.max_attempts + '</span>' : '') + '</td><td>' + esc(t.reason) + '</td>' +
          '<td class="mono">' + esc(t.lease_owner || "") + '</td><td>' + took(t.duration_ms) + '</td><td>' + result + '</td></tr>';
      }).join("") || '<tr><td colspan="8" class="muted">nothing queued or built yet</td></tr>';
      $("#requests tbody").innerHTML = d.requests.map(function (r) {
        var links = (r.pr_url ? ' <a class="run" href="' + esc(r.pr_url) + '">pull request</a>' : '') + (r.issue_url ? ' <a class="run" href="' + esc(r.issue_url) + '">issue</a>' : '');
        return '<tr><td>' + r.id + '</td><td><b>' + esc(r.name) + '</b> <span class="src">' + esc(r.group) + '</span></td><td>' + (r.url ? '<a href="' + esc(r.url) + '">' + esc(r.url.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : '<span class="muted">—</span>') + '</td><td>' + esc(JSON.parse(r.arches || "[]").join(", ")) + '</td>' +
          '<td>' + statusPill(r.status) + (r.approved_by ? ' <span class="muted">by ' + esc(r.approved_by) + '</span>' : '') + links + '</td>' +
          '<td>' + esc(r.requested_by || "—") + '</td><td>' + esc(r.detail || r.reason || "") + '</td><td>' + ago(r.updated_at || r.created_at) + '</td></tr>';
      }).join("") || '<tr><td colspan="8" class="muted">no requests</td></tr>';
    }).catch(function (e) { $("#updated").textContent = "failed: " + e; });
  }
  load();
  setInterval(load, 30000);
  liveStats(function () {}, 120000);
`;

export function factoryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Factory · omarchy-pool",
    description: "Build queue, workers and results of the factory that builds packages no upstream ships.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
