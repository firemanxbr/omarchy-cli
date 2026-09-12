/**
 * Status: is the pool serving, is it being fed, and did anything go wrong
 * recently — the page to open when something looks off.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>Status</h1>
  <p class="lede" id="headline">Checking…</p>

  <section>
    <h2>Service</h2>
    <p class="sub">Measured right now by the API: can it reach the index and the pool. This is what <em>online</em> in the header means.</p>
    <div class="tiles" id="service"></div>
  </section>

  <section>
    <h2>Pipeline <span id="pipeline-state" class="pill none" style="vertical-align:middle;margin-left:8px">checking</span></h2>
    <p class="sub">Whether the pool is being kept up to date: the syncs, the checks, the promotions.</p>
    <div class="tiles" id="tiles"></div>
  </section>

  <section>
    <h2>Rings</h2>
    <p class="sub">Latest real-pacman check per ring and architecture, and when the ring last moved.</p>
    <div class="table-wrap"><table id="rings"><thead><tr><th>Ring</th><th>Arch</th><th>Health</th><th>Checked</th><th>Release</th><th>Moved</th><th>Databases</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Sources</h2>
    <p class="sub">Last sync of every upstream repository. A source is late when its last sync is older than six hours (a long import of one source makes the others wait their turn).</p>
    <div class="table-wrap"><table id="sources"><thead><tr><th>Source</th><th>Arch</th><th>Last sync</th><th>Result</th><th class="num">Upstream</th><th class="num">In the pool</th><th class="num">Missing</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Incidents</h2>
    <p class="sub">Rollbacks, blocked gates and failed checks in the journal, newest first. An empty list is the goal.</p>
    <div class="table-wrap"><table id="incidents"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Summary</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  function render(d) {
    var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
    var problems = problemsOf(d);
    var lastSync = latest(d.events, "sync");
    var healthRows = [];
    RINGS.forEach(function (ring) {
      var r = d.rings.filter(function (x) { return x.ring === ring; })[0] || {};
      ARCHES.forEach(function (arch) {
        var h = latest(d.latest, "health", ring, arch);
        var dbs = (r.artifacts || []).filter(function (a) { return a.kind === "db" && a.arch === arch; });
        if (!dbs.length && !(r.sources || []).some(function (s) { return s.arch === arch; })) return;
        healthRows.push('<tr><td>' + ring + '</td><td>' + arch + '</td><td>' + (h ? '<span class="pill ' + h.status + '">' + h.status + '</span>' : '<span class="pill none">none</span>') + '</td><td class="when">' + (h ? ago(h.created_at) : "—") + '</td><td>' + (r.release ? "#" + r.release.seq : "—") + '</td><td class="when">' + (r.release ? ago(r.release.created_at) : "—") + '</td><td>' + (dbs.length ? dbs.map(function (a) { return '<code>' + esc(a.repo) + '</code>'; }).join(" ") : '<span class="muted">not rendered</span>') + '</td></tr>');
      });
    });
    $("#rings tbody").innerHTML = healthRows.join("") || '<tr><td colspan="7" class="muted">no rings yet</td></tr>';

    $("#sources tbody").innerHTML = (d.coverage || []).map(function (c) {
      var isLate = c.last_sync && Date.now() - Date.parse(c.last_sync) > 6 * 3600e3;
      return '<tr><td>' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="when">' + (c.last_sync ? ago(c.last_sync) + (isLate ? ' <span class="pill warn">late</span>' : '') : '<span class="pill none">never</span>') + '</td><td>' + (c.last_status ? '<span class="pill ' + c.last_status + '">' + c.last_status + '</span>' : '—') + '</td><td class="num">' + (c.upstream_total == null ? "—" : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (c.missing == null ? "—" : num(c.missing)) + '</td></tr>';
    }).join("");

    var incidents = d.events.filter(function (e) { return e.kind === "rollback" || e.status === "error" || (e.kind === "gate" && e.payload && e.payload.verdict === "block"); });
    $("#incidents tbody").innerHTML = incidents.map(function (e) {
      var run = e.payload && e.payload.ci && e.payload.ci.run_url;
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '">' + esc(e.summary) + '</a>' : esc(e.summary)) + '</td><td class="when">' + ago(e.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="5" class="muted">none in the last 40 journal entries</td></tr>';

    $("#headline").innerHTML = problems.length
      ? '<span style="color:var(--amber)">Pipeline behind:</span> ' + esc(problems.join("; ")) + '. The rings keep serving what they have; the journal below shows what the pipeline is doing about it.'
      : '<span style="color:var(--green)">Pipeline keeping up.</span> Every source synced recently, every ring passed its latest health check.';
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0] || {};
    var tiles = [
      ["Stable", stable.release ? "#" + stable.release.seq : "—", stable.release ? "moved " + ago(stable.release.created_at) : "no release"],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : ""],
      ["Incidents", num(incidents.length), "in the last 40 journal entries"]
    ];
    tiles.forEach(function (t, i) { var el = $("#tiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
  }
  function renderService() {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var tiles = [
        ["API", "up", "answering · " + esc(s.checked_at.replace("T", " ").slice(0, 19)) + " UTC"],
        ["Index", s.index.ok ? "up" : "down", s.index.ok ? "D1 answered in " + s.index.ms + " ms" : esc(s.index.error || "failed")],
        ["Pool", s.pool.ok ? "serving" : "down", s.pool.ok ? "R2 answered in " + s.pool.ms + " ms" : esc(s.pool.error || "failed")]
      ];
      tiles.forEach(function (t, i) { var el = $("#service"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num" style="color:' + (t[1] === "down" ? "var(--red)" : "var(--green)") + '">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
    }).catch(function (e) {
      $("#service").innerHTML = '<div class="tile"><div class="k">API</div><div class="v" style="color:var(--red)">down</div><div class="s">' + esc(String(e)) + '</div></div>';
    });
  }
  renderService(); setInterval(renderService, 20000);
  liveStats(render, 20000);
`;

export function statusHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Status · omarchy-pool",
    description: "Is the pool serving, is it being fed, and did anything go wrong recently.",
    active: "overview",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
