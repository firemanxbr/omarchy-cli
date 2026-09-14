/**
 * Status: is the pool serving, is it being fed, did anything go wrong
 * recently — and every number behind the Pool page: coverage per source,
 * the jobs, the charts. The page to open when something looks off.
 */
import { page } from "./layout";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Status</p>
    <h1>Is it up, is it keeping up, is every ring healthy</h1>
    <p class="lede" id="headline">Checking…</p>
  </div>

  <section>
    <h2>Service</h2>
    <p class="sub">Measured right now by the API: can it reach the index and the pool. This is what <em>online</em> in the header means.</p>
    <div class="svc" id="service"></div>
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
    <div class="table-wrap"><table id="sources"><thead><tr><th>Source</th><th>Arch</th><th>Last sync</th><th>Result</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Coverage</h2><span class="hint">every source, every number</span></div>
    <p class="sub">What upstream serves, what <code>edge</code> already pins, what <code>stable</code> pins. Superseded versions stay in the pool until retention runs, so the size can exceed the upstream's.</p>
    <div class="table-wrap"><table id="coverage"><thead><tr><th>Source</th><th>Arch</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th><th class="num">In stable</th><th>Progress</th><th class="num">Size</th><th>Last sync</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="provenance" hidden></p>
    <p class="sub" id="any" hidden></p>
  </section>

  <section>
    <div class="h2row"><h2>The pipeline, in numbers</h2><a class="more-link" href="/pipeline">Watch it run →</a></div>
    <p class="sub">The pool's own jobs, pulled by workers with a per-job credential; a snapshot every 30 minutes records what ran, what is running now and the worker minutes.</p>
    <div class="tiles" id="systiles"></div>
    <div class="charts">
      <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one worker each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
      <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, gc pulled by workers: done, failed, waiting</div><div id="c-jobs"></div></div>
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: contributors' builds staged, the project's published, failed</div><div id="c-builds"></div></div>
    </div>
    <div class="table-wrap"><table id="workflows"><thead><tr><th>Job</th><th>Last</th><th class="num">Runs 7d</th><th class="num">Failed</th><th class="num">Running</th><th class="num">Minutes 7d</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Incidents</h2>
    <p class="sub">Rollbacks, blocked gates and failed checks in the journal, newest first. An empty list is the goal.</p>
    <div class="table-wrap"><table id="incidents"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Summary</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonRows("#coverage", 9, 5); skeletonRows("#workflows", 7, 4); skeletonTiles("#systiles", 8);
__CHARTS__
  function renderSystem(d) {
    // Snapshots before v0.0.51 measured GitHub Actions ("actions"); now the pool's own jobs.
    var m = d.metrics, a = m && (m.jobs || m.actions), w = m && m.workers;
    var pool = d.pool, refAny = pool.referenced_by_any_release || {}, rec = pool.reclaimable || { objects: 0, bytes: 0 };
    var ringBytes = d.rings.reduce(function (x, r) { return x + (r.bytes || 0); }, 0);
    var pending = Math.max(0, (pool.objects || 0) - (refAny.objects || 0));
    var lastSyncEv = latest(d.events, "sync"), synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sec = d.security || {}, secEv = latest(d.latest, "security");
    var now = new Date(), utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    var nextRc = utcH < 6 ? 6 - utcH : 30 - utcH, nextStable = utcH < 9 ? 9 - utcH : 33 - utcH;
    var fmtH = function (h) { return h < 1 ? Math.round(h * 60) + " min" : Math.floor(h) + " h " + Math.round((h % 1) * 60) + " min"; };
    var tiles = [
      ["Jobs running now", a ? num(a.running) : "—", a ? "pool jobs leased or queued" + (w ? " · " + num(w.alive) + " worker(s) alive, " + num(w.busy) + " busy" : "") : "no metrics snapshot yet"],
      ["Jobs, 7 days", a ? num(a.runs) : "—", a ? num(a.failures) + " failed · " + num(a.runs - a.failures - a.running) + " succeeded" : ""],
      ["Worker minutes, 7 days", a ? num(a.minutes) : "—", "on the project's workers, both architectures"],
      ["Sources", synced + " / " + expected, lastSyncEv ? "last sync " + ago(lastSyncEv.created_at) + " · every 3 hours" : "no sync yet"],
      ["Next promotion", "edge → rc in " + fmtH(nextRc), "rc → stable in " + fmtH(nextStable) + " · 06:00 and 09:00 UTC daily"],
      ["Security data", sec.updated_at ? ago(sec.updated_at) : "never", num(sec.advisories) + " advisories · Arch + Debian trackers, KEV, EPSS · every 3 h" + (secEv && secEv.status !== "ok" ? " · last run " + secEv.status : "")],
      ["Stored once", bytes(pool.bytes), num(pool.objects) + " objects, one per sha256"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(rec.bytes), num(rec.objects) + " objects past retention" + (pending ? " · " + num(pending) + " awaiting a release" : "")],
      ["Snapshot", m ? ago(m.recorded_at) : "never", m ? "the pool measures itself every 30 minutes" : "no snapshot yet"],
      ["Estimated bill", "…", "Cloudflare, this month"]
    ];
    tiles.forEach(function (t, i) { var el = $("#systiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
    // The bill, estimated once a day from Cloudflare's analytics (cost.ts); the guard pauses writing jobs over budget.
    fetch("/api/v1/cost").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      var cell = $("#systiles").children[tiles.length - 1]; if (!cell) return;
      if (!c) { setTile(cell, '<div class="k">Estimated bill</div><div class="v num">—</div><div class="s">no estimate yet (daily, 06:30 UTC)</div>'); return; }
      var color = c.status === "error" ? "var(--red)" : c.status === "warn" ? "var(--amber)" : "inherit";
      setTile(cell, '<div class="k">Estimated bill</div><div class="v num" style="color:' + color + '">US$ ' + Number(c.projected_usd).toFixed(2) + '</div><div class="s">projected for ' + esc(c.month) + ' · US$ ' + Number(c.month_to_date_usd).toFixed(2) + ' so far · ' + ago(c.estimated_at) + (c.guard ? ' · <b>over budget: writing jobs paused</b>' : '') + '</div>');
    }).catch(function () {});

    var S = d.series || {};
    $("#c-pool").innerHTML = area((S.metrics || []).map(function (r) { return { t: Date.parse(r.created_at), v: Number(r.bytes || 0) }; }), bytes) +
      (S.metrics && S.metrics.length ? '<div class="legend"><span><i style="background:' + C.green + '"></i>' + num(S.metrics[S.metrics.length - 1].objects) + ' objects now</span></div>' : '');

    var days14 = lastDays(14), byDay = {};
    (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = bars(days14.map(function (dd) { var r = byDay[dd]; return { label: dd.slice(5), value: r ? Number(r.packages) : 0, title: dd + ": " + (r ? num(r.packages) + " packages, " + bytes(r.bytes) + " in " + r.runs + " run(s)" : "no sync") }; }), num);

    var RINGS = ["edge", "rc", "stable"], ARCHES = ["x86_64", "aarch64"], cells = {};
    (S.health || []).forEach(function (h) { var k = h.ring + "/" + h.arch + "/" + day(h.created_at); cells[k] = worst(cells[k], h.status); });
    var rows = []; RINGS.forEach(function (r) { ARCHES.forEach(function (ar) { rows.push({ key: r + "/" + ar, label: r + " " + ar }); }); });
    $("#c-health").innerHTML = heat(rows, days14, function (k, dd) { return cells[k + "/" + dd] || null; }) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>ok</span><span><i style="background:' + C.amber + '"></i>warn (nothing rendered)</span><span><i style="background:' + C.red + '"></i>error</span><span><i style="background:' + C.dim + ';opacity:.5"></i>no check</span></div>';

    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "ok" ? C.green : C.amber, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + num(r.uploaded) + " packages, " + bytes(r.bytes) + " in " + dur(r.duration_ms) + " → " + (Math.round(mbs * 10) / 10) + " MB/s" + (r.concurrency ? " with " + r.concurrency + " workers" : "") }; }), function (v) { return v + " MB/s"; });

    var jd = S.jobs_daily || [], byKind = {}, byD = {};
    jd.forEach(function (r) { var k = byKind[r.kind] = byKind[r.kind] || { done: 0, failed: 0, waiting: 0, ms: 0 }; if (r.status === "done") k.done += Number(r.n); else if (r.status === "failed" || r.status === "cancelled") k.failed += Number(r.n); else k.waiting += Number(r.n); k.ms += Number(r.ms || 0);
      var dd = byD[r.day] = byD[r.day] || { runs: 0, failures: 0, ms: 0 }; dd.runs += Number(r.n); if (r.status === "failed") dd.failures += Number(r.n); dd.ms += Number(r.ms || 0); });
    $("#c-jobs").innerHTML = hbars(Object.keys(byKind).sort(function (a, b) { return (byKind[b].done + byKind[b].failed) - (byKind[a].done + byKind[a].failed); }).map(function (k) { var v = byKind[k]; return { label: k, note: num(v.done + v.failed + v.waiting) + " · " + Math.round(v.ms / 60000) + " min", parts: [{ v: v.done, color: C.green, name: "done" }, { v: v.failed, color: C.red, name: "failed" }, { v: v.waiting, color: C.blue, name: "waiting" }] }; })) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>done</span><span><i style="background:' + C.red + '"></i>failed</span><span><i style="background:' + C.blue + '"></i>queued / running</span></div>';
    var bd = S.builds_daily || [], byDay = {};
    bd.forEach(function (r) { var d = byDay[r.day] = byDay[r.day] || { staged: 0, published: 0, failed: 0 }; if (r.status === "staged") d.staged += Number(r.n); else if (r.status === "done") d.published += Number(r.n); else if (r.status === "failed") d.failed += Number(r.n); });
    $("#c-builds").innerHTML = bars(lastDays(14).map(function (dd) { var d = byDay[dd] || { staged: 0, published: 0, failed: 0 }; var t = d.staged + d.published + d.failed; return { label: dd.slice(5), value: t, color: d.failed > d.published + d.staged ? C.red : C.green, title: dd + ": " + d.staged + " staged, " + d.published + " published, " + d.failed + " failed" }; }), function (v) { return v + " build(s)"; });
    $("#c-minutes").innerHTML = bars(lastDays(7).map(function (dd) { var r = byD[dd]; return { label: dd.slice(5), value: r ? Math.round(r.ms / 60000) : 0, color: C.blue, title: dd + ": " + (r ? Math.round(r.ms / 60000) + " min in " + r.runs + " jobs, " + r.failures + " failed" : "no jobs") }; }), function (v) { return v + " min"; });

    // One row per job kind: what the journal's latest entry says, and the week's totals.
    var kinds = Object.keys(byKind).sort().map(function (k) { var v = byKind[k], l = (d.latest || []).filter(function (e) { return e.kind === k; }).sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); })[0]; return { kind: k, last: l, runs: v.done + v.failed + v.waiting, failed: v.failed, running: v.waiting, minutes: Math.round(v.ms / 60000) }; });
    pager("#workflows", kinds, function (w) {
      var l = w.last, st = l ? l.status : "—", cls = st === "ok" ? "ok" : st === "error" ? "error" : st === "warn" ? "warn" : "";
      return '<tr><td>' + esc(w.kind) + '</td><td><span class="dot ' + cls + '"></span>' + esc(st) + (l ? ' <span class="when">' + ago(l.created_at) + '</span>' : '') + '</td><td class="num">' + num(w.runs) + '</td><td class="num">' + (w.failed ? '<span style="color:var(--red)">' + num(w.failed) + '</span>' : '0') + '</td><td class="num">' + (w.running ? '<span style="color:var(--blue)">' + num(w.running) + '</span>' : '0') + '</td><td class="num">' + num(w.minutes) + '</td></tr>';
    }, { empty: 'no jobs yet — the pool queues them on schedule and project workers pull them', n: 25 });
  }

  // OPR recipes by origin: the AUR-synced count in stable is the number to drive to zero.
  function renderProvenance(d) {
    var pv = d.provenance && d.provenance.stable; var el = $("#provenance"); if (!pv || !el || !pv.packages) return;
    el.hidden = false;
    el.innerHTML = '<b>OPR recipes in stable:</b> ' + num(pv.packages) + ' packages — ' + num(pv.local) + " Omarchy's own, <b>" + num(pv.aur) + ' still synced from the AUR</b>' + (pv.unknown ? ', ' + num(pv.unknown) + ' of unknown origin' : '') + ' (<a href="https://github.com/omacom/omarchy-pkgs/tree/master/pkgbuilds">omarchy-pkgs</a>, read daily; each package page says which). The AUR number is the one to drive to zero.';
  }
  // Architecture-independent packages stored once per architecture: Arch Linux ARM rebuilds and re-signs them.
  function renderAny(d) {
    var a = d.any && d.any.stable; var el = $("#any"); if (!a || !el || !a.names) return;
    el.hidden = false;
    el.innerHTML = '<b>Architecture-independent packages in stable:</b> ' + num(a.names) + ' (' + num(a.objects) + ' objects, ' + bytes(a.bytes) + ') — ' + num(a.twice) + ' of them stored twice, once per architecture, because Arch Linux ARM rebuilds and re-signs <code>any</code> packages: ' + bytes(a.extra_bytes) + ' the pool would not need if one signed object served both.';
  }
  function renderCoverage(d) {
    renderProvenance(d);
    renderAny(d);
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : (a.arch === "x86_64" ? -1 : 1); });
    var tot = cov.reduce(function (t, c) { t.up += c.upstream_total || 0; t.have += c.indexed; t.miss += c.missing || 0; t.bytes += c.bytes; t.pending += c.upstream_total == null ? 1 : 0; return t; }, { up: 0, have: 0, miss: 0, bytes: 0, pending: 0 });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    pager("#coverage", cov, function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? '<span class="pill none">not synced yet</span>' : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (c.last_status !== "ok" ? ' <span class="pill ' + c.last_status + '">' + c.last_status + '</span>' : '')) + '</td></tr>';
    }, { n: 25 });
  }


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
    renderCoverage(d); renderSystem(d); endSkeleton();
    tiles.forEach(function (t, i) { var el = $("#tiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
  }
  function renderService() {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var items = [
        ["ok", "API", "answering · " + esc(s.checked_at.replace("T", " ").slice(0, 19)) + " UTC"],
        [s.index.ok ? "ok" : "error", "index · D1", s.index.ok ? s.index.ms + " ms" : esc(s.index.error || "failed")],
        [s.pool.ok ? "ok" : "error", "pool · R2", s.pool.ok ? s.pool.ms + " ms" : esc(s.pool.error || "failed")],
        [s.signing ? "ok" : "warn", "signing", s.signing ? "the pool's key is loaded" : "no signing key"]
      ];
      $("#service").innerHTML = items.map(function (t) { return '<div><i class="led ' + t[0] + '"></i><b>' + t[1] + '</b><span>' + t[2] + '</span></div>'; }).join("");
    }).catch(function (e) {
      $("#service").innerHTML = '<div><i class="led error"></i><b>API</b><span>down · ' + esc(String(e)) + '</span></div>';
    });
  }
  renderService(); setInterval(renderService, 60000);
  liveStats(render, 60000);
`;

export function statusHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Status · omarchy-pool",
    description: "Is the pool serving, is it being fed, and did anything go wrong recently.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}
