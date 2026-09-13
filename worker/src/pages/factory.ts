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
    <p class="sub">A request is the first step for a package nobody ships: a maintainer of its group approves it by merging a PKGBUILD; after that, new versions build without a human.</p>
    <div class="table-wrap"><table id="requests"><thead><tr><th>#</th><th>Package</th><th>Group</th><th>Arches</th><th>Status</th><th>Requested by</th><th>Reason</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  function statusPill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", requested: "var(--amber)", approved: "var(--green)", rejected: "var(--dim)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  function load() {
    fetch("/api/v1/factory").then(function (r) { return r.json(); }).then(function (d) {
      var count = function (st, arch) { return d.counts.filter(function (c) { return c.status === st && (!arch || c.arch === arch); }).reduce(function (n, c) { return n + c.n; }, 0); };
      var alive = d.workers.filter(function (w) { return w.alive; });
      var tiles = [
        ["Queued", num(count("queued")), num(count("queued", "x86_64")) + " x86_64 · " + num(count("queued", "aarch64")) + " aarch64"],
        ["Building", num(count("leased")), "lease " + d.lease_minutes + " min, extended by heartbeats"],
        ["Workers alive", num(alive.length), alive.filter(function (w) { return w.arch === "x86_64"; }).length + " x86_64 · " + alive.filter(function (w) { return w.arch === "aarch64"; }).length + " aarch64"],
        ["Built", num(count("done")), num(count("failed")) + " failed · " + num(count("cancelled")) + " cancelled"],
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
        var result = t.status === "done" && t.result_filename
          ? (t.publish === 0 ? '<span class="mono">' + esc(t.result_filename) + '</span>' : '<a href="/package/' + encodeURIComponent(t.name) + '?ring=edge&arch=' + t.arch + '" class="mono">' + esc(t.result_filename) + '</a>')
          : (t.error ? '<span class="muted" title="' + esc(t.error) + '">' + esc(t.error.slice(0, 90)) + '</span>' : '<span class="muted">—</span>');
        return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b> <span class="src">' + esc(t.group) + '</span>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td>' +
          '<td>' + statusPill(t.status) + (t.publish === 0 ? ' <span class="pill none" title="built and measured, never published">dry run</span>' : '') + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '/' + t.max_attempts + '</span>' : '') + '</td><td>' + esc(t.reason) + '</td>' +
          '<td class="mono">' + esc(t.lease_owner || "") + '</td><td>' + took(t.duration_ms) + '</td><td>' + result + '</td></tr>';
      }).join("") || '<tr><td colspan="8" class="muted">nothing queued or built yet</td></tr>';
      $("#requests tbody").innerHTML = d.requests.map(function (r) {
        return '<tr><td>' + r.id + '</td><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.group) + '</td><td>' + esc(JSON.parse(r.arches || "[]").join(", ")) + '</td><td>' + statusPill(r.status) + (r.approved_by ? ' <span class="muted">by ' + esc(r.approved_by) + '</span>' : '') + '</td>' +
          '<td>' + esc(r.requested_by || "—") + '</td><td>' + esc(r.reason || "") + '</td><td>' + ago(r.created_at) + '</td></tr>';
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
