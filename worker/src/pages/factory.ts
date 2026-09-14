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
  <p class="lede">Packages no upstream ships are built here — from recipes contributors bring on <a href="/contribute">Contributors</a> and maintainers approve on <a href="/review">Review</a>, and from the project's own in <a href="${REPO_URL}/tree/main/factory/pkgbuilds"><code>factory/pkgbuilds</code></a>. The pool is the brain: a registered package, a merged recipe, an approval or a new upstream release becomes one build task per architecture, and <b>workers</b> — ephemeral containers anywhere: a contributor's laptop for their own packages, machines the project trusts for what maintainers approved — come here to <b>claim</b> the next task of their architecture, hold a lease while they build, and report back. A lease that expires puts the task back in the queue. A contributor's build is evidence in their staging workspace; a project build is published into <code>edge</code> as source <code>factory</code>, signed by the pool, and rendered; from there it follows the usual rings. <a href="/docs/workers">Run a worker →</a> · <a href="${REPO_URL}/blob/main/factory/README.md">The factory in detail →</a></p>
  <p class="sub" id="updated"></p>

  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Contributed packages</h2>
    <p class="sub">Anyone with a GitHub account registers a package and runs a worker for it — no permission needed, nothing spent by the project. Builds land in the contributor's staging workspace with their PKGBUILD and log; a maintainer of the group approves them into <code>edge</code>. <a href="/contribute">Contribute a package →</a></p>
    <div class="table-wrap"><table id="registry"><thead><tr><th>Package</th><th>Project</th><th>Owner</th><th>Arches</th><th>Detected</th><th>Stage</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Workers</h2>
    <p class="sub">Every worker belongs to someone, and every one runs the same image in one of three roles (<a href="/docs/workers#roles">the three roles</a>). <b>Omarchy workers</b> run for the project — a <em>pool</em> worker takes the pool's own jobs, a <em>review</em> worker the maintainers' rebuilds and audits; <b>community workers</b> are contributors' own and take their (or, if shared, anyone's) community builds. Alive means seen in the last ten minutes; an idle worker asks for work every 30 seconds. <label style="margin-left:8px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></p>
    <h3 style="margin:14px 0 4px">Omarchy workers</h3>
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Role</th><th>Arch</th><th>Where</th><th>Trust</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
    <h3 style="margin:18px 0 4px">Community workers</h3>
    <div class="table-wrap"><table id="cworkers"><thead><tr><th>Worker</th><th>Role</th><th>Owner</th><th>Arch</th><th>Mode</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
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
  function paramsLabel(t) { var p = {}; try { p = typeof t.params === "string" ? JSON.parse(t.params || "{}") : (t.params || {}); } catch (e) {} return [p.source, p.from && p.to ? p.from + " → " + p.to : null, p.ring].filter(Boolean).join(" · "); }
  // A pool job's result, in words: what it did rather than its JSON.
  function jobResult(t) {
    var r = {}; try { r = typeof t.result === "string" ? JSON.parse(t.result) : (t.result || {}); } catch (e) { return String(t.result).slice(0, 90); }
    if (t.kind === "sync") return "upstream " + num(r.upstream_total) + " · uploaded " + num(r.uploaded) + " · removed " + num(r.removed) + (r.failed ? " · failed " + num(r.failed) : "") + (r.release ? " · release " + r.release[0] : " · unchanged");
    if (t.kind === "promote") return r.verdict === "promoted" ? "promoted, release " + r.release_id : r.verdict === "blocked" ? "blocked: " + (r.reasons || []).join("; ") : r.verdict === "rolled-back" ? "rolled back to " + r.to : r.verdict === "skip" ? "nothing to promote" : JSON.stringify(r);
    if (t.kind === "health") return r.ok ? "healthy" : "unhealthy";
    if (t.kind === "gc") return "kept the last " + r.keep + " releases per ring";
    if (t.kind === "render") return "rendered " + (r.repos || []).join(", ");
    return JSON.stringify(r).slice(0, 90);
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  skeletonTiles("#tiles", 5); skeletonRows("#registry", 8, 2); skeletonRows("#workers", 7, 2); skeletonRows("#tasks", 8, 4); skeletonRows("#requests", 8, 2);
  function loadRegistry() {
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#registry", d.packages || [], function (p) {
        var det = p.detected || {};
        return '<tr><td><b>' + esc(p.name) + '</b> <span class="src">' + esc(p.group) + '</span></td><td><a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a></td><td>' + esc(p.owner) + '</td><td>' + esc((p.arches || []).join(", ")) + '</td>' +
          '<td>' + esc([det.build_system, det.language, det.license, det.latest_tag].filter(Boolean).join(" · ")) + '</td><td>' + statusPill(p.status) + (p.staged_builds ? ' <span class="muted">' + p.staged_builds + ' staged</span>' : '') + '</td><td>' + esc(p.detail || "") + '</td><td>' + ago(p.updated_at) + '</td></tr>';
      }, { empty: 'no package registered yet — <a href="/contribute">be the first</a>', text: function (p) { return [p.name, p.group, p.owner, p.url, p.status].join(" "); } });
    }).catch(function () { $("#registry tbody").innerHTML = ""; });
  }
  var REPO = "${REPO_URL}";
  function load() {
    loadRegistry();
    busy(fetch("/api/v1/factory?limit=100")).then(function (r) { return r.json(); }).then(function (d) {
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
      var showAll = $("#all-workers").checked;
      var ws = d.workers.filter(function (w) { return showAll || w.alive; });
      // The role a worker reported in its labels (OMARCHY_WORKER_ROLE: pool, review, community), or what the trust implies.
      function roleCell(w) {
        var r = w.labels && w.labels.role;
        if (r === "pool" || r === "review" || r === "community") return '<span class="pill">' + esc(r) + '</span>';
        return '<span class="muted">' + (w.trust === "project" ? "pool + review" : "own packages") + '</span>';
      }
      pager("#workers", ws.filter(function (w) { return w.side === "omarchy"; }), function (w) {
        var where = w.labels && w.labels.where ? w.labels.where : (w.hostname || "—");
        return '<tr><td class="mono">' + esc(w.id) + (w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + roleCell(w) + '</td><td>' + esc(w.arch) + '</td><td>' + esc(where) + (w.version ? ' <span class="muted">pkg-repo ' + esc(w.version) + '</span>' : '') + '</td>' +
          '<td>' + (w.trust === "project" ? 'project' + (w.trusted_by ? ' <span class="muted">by ' + esc(w.trusted_by) + '</span>' : '') : '<span class="muted">—</span>') + '</td><td>' + agentCell(w) + '</td>' +
          '<td>' + (w.current_task ? '#' + w.current_task : '<span class="muted">idle</span>') + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
      }, { empty: showAll ? "no Omarchy worker registered" : "no Omarchy worker alive — the project's host is off; pool jobs wait", text: function (w) { return w.id + " " + w.arch + " " + (w.trusted_by || "") + " " + JSON.stringify(w.labels || {}); } });
      pager("#cworkers", ws.filter(function (w) { return w.side === "community"; }), function (w) {
        return '<tr><td class="mono">' + esc(w.id) + (w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + roleCell(w) + '</td><td>' + esc(w.owner || "") + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.mode) + (w.packages && w.packages.length ? ' <span class="muted">' + esc(w.packages.join(", ")) + '</span>' : '') + '</td><td>' + agentCell(w) + '</td>' +
          '<td>' + (w.current_task ? '#' + w.current_task : '<span class="muted">idle</span>') + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
      }, { empty: showAll ? "no community worker registered yet" : "no community worker alive right now", text: function (w) { return w.id + " " + (w.owner || "") + " " + w.arch + " " + w.mode; } });
      pager("#tasks", d.tasks, function (t) {
        var result = t.status === "staged"
          ? '<span class="mono">' + esc(t.result_filename || "") + '</span> <a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/build.log">log</a> <a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>'
          : t.status === "done" && t.result_filename && t.result_filename !== "-"
          ? (t.publish === 0 ? '<span class="mono">' + esc(t.result_filename) + '</span>' : '<a href="/package/' + encodeURIComponent(t.name) + '?ring=edge&arch=' + t.arch + '" class="mono">' + esc(t.result_filename) + '</a>')
          : t.status === "done" && t.result ? '<span class="muted">' + esc(jobResult(t)) + '</span>'
          : (t.error ? '<span class="muted" title="' + esc(t.error) + '">' + esc(t.error.slice(0, 90)) + '</span>' : '<span class="muted">—</span>');
        var what = t.kind && t.kind !== "build" ? '<b>' + esc(t.kind) + '</b> <span class="muted">' + esc(paramsLabel(t)) + '</span>' : '<b>' + esc(t.name) + '</b> <span class="src">' + esc(t.group) + '</span>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '');
        return '<tr><td>' + t.id + '</td><td>' + what + '</td><td>' + esc(t.arch) + '</td>' +
          '<td>' + statusPill(t.status) + (t.trust === "community" ? ' <span class="pill none" title="a contributor\'s build: goes to staging, a maintainer approves">' + esc(t.owner || "community") + '</span>' : '') + (t.publish === 0 && t.trust !== "community" ? ' <span class="pill none" title="built and measured, never published">dry run</span>' : '') + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '/' + t.max_attempts + '</span>' : '') + '</td><td>' + esc(t.reason) + '</td>' +
          '<td class="mono">' + esc(t.lease_owner || "") + '</td><td>' + took(t.duration_ms) + '</td><td>' + result + '</td></tr>';
      }, { empty: "nothing queued or built yet", text: function (t) { return [t.id, t.kind, t.name, t.arch, t.status, t.reason, t.lease_owner, t.owner, paramsLabel(t)].join(" "); } });
      pager("#requests", d.requests, function (r) {
        var links = (r.pr_url ? ' <a class="run" href="' + esc(r.pr_url) + '">pull request</a>' : '') + (r.issue_url ? ' <a class="run" href="' + esc(r.issue_url) + '">issue</a>' : '');
        return '<tr><td>' + r.id + '</td><td><b>' + esc(r.name) + '</b> <span class="src">' + esc(r.group) + '</span></td><td>' + (r.url ? '<a href="' + esc(r.url) + '">' + esc(r.url.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : '<span class="muted">—</span>') + '</td><td>' + esc(JSON.parse(r.arches || "[]").join(", ")) + '</td>' +
          '<td>' + statusPill(r.status) + (r.approved_by ? ' <span class="muted">by ' + esc(r.approved_by) + '</span>' : '') + links + '</td>' +
          '<td>' + esc(r.requested_by || "—") + '</td><td>' + esc(r.detail || r.reason || "") + '</td><td>' + ago(r.updated_at || r.created_at) + '</td></tr>';
      }, { empty: "no requests", text: function (r) { return [r.name, r.group, r.url, r.status, r.requested_by].join(" "); } });
      endSkeleton();
    }).catch(function (e) { $("#updated").textContent = "failed: " + e; endSkeleton(); });
  }
  load();
  $("#all-workers").onchange = load;
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
