/**
 * The Pipeline: the same page for users, contributors and maintainers — only
 * the buttons differ. A living picture of what is being verified, promoted
 * and checked right now (the journal, as it happens); how fast maintainers
 * decide and where a contributor's build sits in the queue; and, for the
 * people who run it, the operations: the queue, the workers by role, the
 * charts, the ring heads, the journal, what it costs — and how to help.
 */
import { page } from "./layout";
import { CHARTS } from "./charts";
import { archDiagram, liveDiagram } from "./diagrams";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">For everyone</p>
    <h1>The pipeline, as it runs right now</h1>
    <p class="lede">What is being verified, promoted and checked for you this very minute; how fast maintainers decide; who is building what, and what it costs. The same page for users, contributors and maintainers — only the buttons differ.</p>
  </div>
  <div class="state-row" id="state"><span class="pill none">checking…</span></div>

  <section id="live">
    <div class="h2row"><h2>A living system</h2><a class="more-link" href="/docs#security/feeds">What each security feed contributes →</a></div>
    <p class="sub">Every three hours: packages are verified and promoted, five security feeds are matched against what every ring serves, and a confident fix does not wait for the soak.</p>
    <figure class="diagram live-diagram">${liveDiagram()}<figcaption>Green marks are packages on their way to <code>stable</code>; amber marks are advisories being matched against each ring. The dashed arc is the fast-track. The numbers are the pool's own.</figcaption></figure>
    <div class="live-grid" style="margin-top:16px">
      <div class="ticker"><div class="head"><span class="live"><i></i>live</span><span>the journal, as it happens · every 20 s</span></div><div id="feed"><div class="muted">loading…</div></div></div>
      <div><div class="counters" id="counters"></div><p class="sub" style="margin:14px 0 0;font-size:13px">Nothing here is a promise: every line links to the run that produced it, and every decision carries a name. <a href="/journal">The whole journal →</a></p></div>
    </div>
  </section>

  <section id="throughput">
    <div class="h2row"><h2>Review throughput</h2><a class="more-link" href="/docs/governance">How a decision is made →</a></div>
    <p class="sub">How fast new packages arrive and how fast maintainers decide. A wait is a queue, not a verdict.</p>
    <div class="flow" id="flow"></div>
    <div class="charts" style="margin-top:16px">
      <div class="chart"><h3>Decisions per week <span>8 weeks</span></h3><div class="sub">what maintainers approved and what they sent back</div><div id="c-decisions"></div></div>
      <div class="chart"><h3>Arrivals vs decisions <span>8 weeks</span></h3><div class="sub">packages registered, packages decided — the gap is the queue</div><div id="c-arrivals"></div></div>
      <div class="chart"><h3>Who is deciding <span>on the record</span></h3><div class="sub">approvals per maintainer</div><div class="maint-list" id="deciders" style="margin-top:8px"></div><div id="queue-pos"></div></div>
    </div>
  </section>

  <div class="h2row" id="operations" style="border-top:1px solid var(--line);padding-top:28px;margin-bottom:4px"><h2>Operations</h2><span class="hint" id="ops-who">read-only — approving, trusting and rolling back need the maintainer role</span></div>
  <div class="tiles six" id="tiles"></div>

  <section>
    <div class="h2row"><h2>How it runs</h2><a class="more-link" href="${REPO_URL}/blob/main/factory/README.md">The factory in detail →</a></div>
    <p class="sub">One brain queues, workers claim with a lease, objects land on R2, rings are rendered and signed. Live numbers on the mechanism.</p>
    <figure class="diagram">${archDiagram()}<figcaption>Every job runs on a registered worker. Contributors' builds are evidence; the review worker rebuilds what a maintainer approves. A lease that expires puts the task back in the queue.</figcaption></figure>
  </section>

  <section>
    <div class="h2row"><h2>Review queue</h2><a class="more-link" href="/review">Decisions, trust, the audit →</a></div>
    <p class="sub">Evidence, not packages. Approve queues a rebuild on the review worker; reject sends a note back.</p>
    <p class="sub" id="rq-state" hidden></p>
    <div class="table-wrap"><table id="staged"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Built by</th><th>Evidence</th><th>Audit</th><th>Waiting</th><th>Decision</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Workers by role</h2><a class="more-link" href="/docs/workers">The three roles →</a></div>
    <p class="sub">One image, four kinds of worker. Alive means seen in the last ten minutes; building means holding a lease right now. <label style="margin-left:8px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></p>
    <div class="roles-grid" id="roles"></div>
    <div class="charts" style="margin-top:16px">
      <div class="chart"><h3>Load per worker <span>24 h</span></h3><div class="sub">share of the last day each worker spent holding a lease — the tooltip has what it did</div><div id="c-perworker"></div></div>
      <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
    </div>
    <div class="two" style="margin-top:16px">
      <div class="panel"><h3>Omarchy workers <span class="dim" style="font-size:12px;font-weight:400">the project's host</span></h3><div class="table-wrap" style="border:0"><table id="workers"><thead><tr><th>Worker</th><th>Role</th><th>Arch</th><th>Where</th><th>Trust</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
      <div class="panel"><h3>Community workers <span class="dim" style="font-size:12px;font-weight:400">contributors' own</span></h3><div class="table-wrap" style="border:0"><table id="cworkers"><thead><tr><th>Worker</th><th>Role</th><th>Owner</th><th>Arch</th><th>Mode</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>The last two weeks</h2><a class="more-link" href="/status">Every chart on the Status page →</a></div>
    <div class="charts">
      <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, security, gc: done, failed, waiting</div><div id="c-jobs"></div></div>
      <div class="chart"><h3>Promotions <span>14 days</span></h3><div class="sub">edge → rc and rc → stable: promoted, blocked by a check, rolled back</div><div id="c-promos"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one worker each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">staged, published, failed</div><div id="c-builds"></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Build tasks</h2><span class="hint">leased first, then queued, then the most recent finished; three attempts, then failed</span></div>
    <div class="table-wrap"><table id="tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Reason</th><th>Worker</th><th>Took</th><th>Result</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Requested packages</h2><a class="more-link" href="/factory">Request one →</a></div>
    <p class="sub">Every package a contributor asked for — each request written once to the record and signed by the pool — and where it stands.</p>
    <div class="table-wrap"><table id="registry"><thead><tr><th>Package</th><th>Project</th><th>Owner</th><th>Arches</th><th>Version · licence</th><th>Stage</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Rings and the journal</h2><a class="more-link" href="/journal">Ring history, diffs, rollback →</a></div>
    <div class="heads" id="heads"></div>
    <p class="sub" id="rb-state" hidden style="margin-top:10px"></p>
    <div class="table-wrap" style="margin-top:16px"><table id="events"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Cost, in the open</h2><span class="hint">Cloudflare, estimated once a day from its analytics</span></div>
    <p class="sub">D1 rows read and written are most of the bill. The guard pauses the jobs that write at US$ 25 of a US$ 30 cap; the daily report says why.</p>
    <div class="budget" id="budget"><div><div class="k">this month</div><b>…</b></div><div><div class="k">projected</div><b>…</b></div><div class="bar"><i style="width:0"></i><em style="left:83.3%"></em></div></div>
    <div class="sponsor"><div><p><b>Help keep it running.</b> The pool runs on one pocket: the brain on Cloudflare, one machine building for both architectures, and the agent tokens that draft and audit PKGBUILDs. More hardware means shorter queues; more tokens mean every build gets an audit.</p><div class="needs"><span class="pill lilac">an aarch64 builder</span><span class="pill lilac">an x86_64 builder</span><span class="pill lilac">agent tokens</span><span class="pill lilac">a mirror in another region</span></div></div>
    <div class="side"><a class="mail" href="mailto:sponsor@firemanxbr.org">sponsor@firemanxbr.org</a><span class="promise">Every contribution shows up on this page, and the code stays open source — that is the deal.</span></div></div>
  </section>
`;

const SCRIPT = String.raw`
__CHARTS__

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
  function loadRegistry() {
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#registry", d.packages || [], function (p) {
        var det = p.detected || {};
        var home = p.project || p.url;
        return '<tr><td><b>' + esc(p.name) + '</b>' + (p.request_id ? ' <a class="src" href="' + esc(POOL + "/factory/" + p.name + "/" + p.request_id + "/request.json") + '" title="the request, on the record">#' + p.request_id + '</a>' : '') + '</td><td><a href="' + esc(home) + '">' + esc(home.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a></td><td>' + esc(p.owner) + '</td><td>' + esc((p.arches || []).join(", ")) + '</td>' +
          '<td>' + esc([p.release || det.latest_tag, p.license || det.license].filter(Boolean).join(" · ")) + '</td><td>' + statusPill(p.status) + (p.staged_builds ? ' <span class="muted">' + p.staged_builds + ' staged</span>' : '') + '</td><td>' + esc(p.detail || "") + '</td><td>' + ago(p.updated_at) + '</td></tr>';
      }, { empty: 'no package requested yet — <a href="/factory">be the first</a>', text: function (p) { return [p.name, p.group, p.owner, p.url, p.status].join(" "); } });
    }).catch(function () { $("#registry tbody").innerHTML = ""; });
  }
  function renderTables(d) {
    loadRegistry();
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
  }
  var API = "/api/v1/factory", REPO = "__REPO_URL__";
  var ME_ROLE = null, ME_LOGIN = null, FACTORY = null, STATS = null, STAGED = [];
  function can() { return ME_ROLE === "maintainer"; }
  function live(key, text) { document.querySelectorAll('[data-live="' + key + '"]').forEach(function (el) { el.textContent = text; }); }
  function roleOf(w) { var r = w.labels && w.labels.role; if (r === "pool" || r === "review" || r === "community") return r; return w.trust === "project" ? "pool" : "community"; }
  skeletonTiles("#tiles", 6); skeletonRows("#staged", 8, 2); skeletonRows("#events", 7, 6); skeletonRows("#tasks", 8, 4); skeletonRows("#workers", 9, 2); skeletonRows("#cworkers", 9, 2); skeletonRows("#registry", 8, 2); // ---- the state row: the service (measured now) and the pipeline (from the journal)
  function renderState(d) {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (st) { live("api", "API up · index " + (st.index.ok ? st.index.ms + " ms" : "down") + " · pool " + (st.pool.ok ? st.pool.ms + " ms" : "down")); }).catch(function () { live("api", "API not answering"); });
    // A ring's pill is the worse of its two architectures' latest health checks.
    var why = problemsOf(d), heads = ["stable", "rc", "edge"].map(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; var hs = ["x86_64", "aarch64"].map(function (a) { return latest(d.latest, "health", n, a); }).filter(Boolean); var worst = hs.reduce(function (w, h) { return { error: 3, warn: 2, ok: 1 }[h.status] > ({ error: 3, warn: 2, ok: 1 }[w] || 0) ? h.status : w; }, null); var bad = hs.filter(function (h) { return h.status !== "ok"; }); return r && r.release ? '<span class="pill ' + (worst || "none") + '">' + n + ' #' + r.release.seq + (worst ? ' · ' + (worst === "ok" ? "healthy" : bad.map(function (h) { return (h.source || "x86_64") + " " + h.status; }).join(", ")) : "") + '</span>' : ""; }).join("");
    $("#state").innerHTML = '<span class="pill ' + (why.length ? "warn" : "ok") + '">' + (why.length ? "pipeline behind: " + esc(why.join(" · ")) : "pipeline keeping up") + '</span>' + heads + '<span class="pill none">running ' + esc(d.version && d.version.version || "") + '</span>';
  }

  // ---- the living system: the diagram's numbers, the feed, the counters — all from the journal
  var seen = {};
  function feedRow(e, fresh) {
    var run = e.payload && e.payload.ci && e.payload.ci.run_url;
    return '<div class="row"' + (fresh ? "" : ' style="animation:none"') + '><span><span class="dot ' + e.status + '"></span>' + e.status + '</span><span class="what">' + esc(e.kind) + '</span><span><span class="where">' + esc([e.ring, e.source].filter(Boolean).join(" · ")) + '</span> ' + (run ? '<a class="run" href="' + esc(run) + '">' + esc(e.summary) + '</a>' : esc(e.summary)) + '</span><span class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</span></div>';
  }
  function loadFeed() {
    fetch("/api/v1/events?limit=12", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      var rows = (d.events || []).filter(function (e) { return e.kind !== "metrics"; }).slice(0, 9);
      var first = !Object.keys(seen).length;
      $("#feed").innerHTML = rows.map(function (e) { var fresh = !first && !seen[e.id]; seen[e.id] = 1; return feedRow(e, fresh); }).join("") || '<div class="muted">nothing yet</div>';
      if (first) rows.forEach(function (e) { seen[e.id] = 1; });
    }).catch(function () {});
  }
  function renderLive(d) {
    var today = new Date().toISOString().slice(0, 10), S = d.series || {};
    var imp = (S.imports_daily || []).filter(function (r) { return r.day === today; }).reduce(function (n, r) { return n + Number(r.packages || 0); }, 0);
    var lastSync = latest(d.events, "sync"), fast = (d.events || []).filter(function (e) { return e.kind === "fast-track"; }), rb = (d.events || []).filter(function (e) { return e.kind === "rollback"; });
    var promos = (d.events || []).filter(function (e) { return e.kind === "promote" && e.status === "ok" && e.created_at.slice(0, 10) === today; });
    live("verified-today", "verified today: " + num(imp)); live("stored-once", "stored once: " + num(d.pool.objects));
    live("advisories", "advisories known: " + num((d.security || {}).advisories || 0));
    live("last-sync", "synced " + (lastSync ? ago(lastSync.created_at) : "never") + " · every 3 h");
    live("pool-size", num(d.pool.objects) + " objects · " + bytes(d.pool.bytes));
    ["edge", "rc", "stable"].forEach(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; if (r && r.release) live(n + "-head", "release #" + r.release.seq + " · " + ago(r.release.created_at)); });
    live("heads", ["edge", "rc", "stable"].map(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; return n + (r && r.release ? " #" + r.release.seq : " —"); }).join(" · "));
    var aud = d.audience || [], y = aud[aud.length - 1];
    var cells = [
      ["packages verified today", num(imp), "ok"], ["advisories known", num((d.security || {}).advisories || 0), ""], ["exploited in stable", "<span data-live=\"kev\">…</span>", "ok"],
      y ? ["machines on the pool, " + y.day, "≈ " + num(y.machines), "ok"] : ["promotions today", num(promos.length), ""], ["fast-tracks, recent journal", num(fast.length), ""], ["rollbacks, recent journal", num(rb.length), rb.length ? "warn" : "ok"]
    ];
    $("#counters").innerHTML = cells.map(function (c) { return '<div><b class="' + c[2] + '">' + c[1] + '</b><span>' + c[0] + '</span></div>'; }).join("");
    fetch("/api/v1/security?ring=stable&arch=x86_64").then(function (r) { return r.json(); }).then(function (s) { var t = s.totals || {}; live("open-stable", "open in stable: " + num(t.packages || 0) + " · exploited: " + num(t.kev || 0)); live("kev", num(t.kev || 0)); }).catch(function () { live("open-stable", "open in stable: no scan yet"); live("kev", "—"); });
  }

  // ---- review throughput: arrivals, decisions, who decides, and a contributor's place in the queue
  function weeksBack(n) { var out = [], now = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(new Date(now - i * 7 * 86400000).toISOString().slice(0, 10)); return out; }
  function bucket(weeks, items, at) { var v = weeks.map(function () { return 0; }); items.forEach(function (x) { var t = Date.parse(at(x)); for (var i = weeks.length - 1; i >= 0; i--) { if (t >= Date.parse(weeks[i])) { v[i]++; break; } } }); return v; }
  function renderThroughput(f, pkgs, apps, staged, me) {
    var week = Date.now() - 7 * 86400000, weeks = weeksBack(8);
    var arrived = pkgs.filter(function (p) { return Date.parse(p.created_at || p.updated_at) > week; }).length;
    var building = f.tasks.filter(function (t) { return t.kind === "build" && t.status === "leased" && t.trust === "community"; }).length;
    var approved7 = apps.filter(function (a) { return a.decision === "approved" && Date.parse(a.created_at) > week; }).length, back7 = apps.filter(function (a) { return a.decision !== "approved" && Date.parse(a.created_at) > week; }).length;
    var waits = staged.map(function (s) { return Date.now() - Date.parse(s.finished_at || 0); }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    var fmt = function (ms) { return ms < 3600e3 ? Math.round(ms / 60000) + " min" : ms < 86400e3 ? Math.round(ms / 3600e3) + " h" : Math.round(ms / 86400e3) + " d"; };
    $("#flow").innerHTML =
      '<div class="st"><span class="k">arrived this week</span><b>' + num(arrived) + '</b><span class="s">packages registered</span></div><div class="ar">→</div>' +
      '<div class="st"><span class="k">building</span><b>' + num(building) + '</b><span class="s">on contributors\' and shared workers</span></div><div class="ar">→</div>' +
      '<div class="st hum"><span class="k">in review</span><b>' + num(staged.length) + '</b><span class="s">' + (waits.length ? "oldest " + fmt(waits[waits.length - 1]) + " · median " + fmt(waits[Math.floor(waits.length / 2)]) : "nothing waiting") + '</span></div><div class="ar">→</div>' +
      '<div class="st"><span class="k">approved this week</span><b>' + num(approved7) + '</b><span class="s">' + num(back7) + ' sent back with a note</span></div><div class="ar">→</div>' +
      '<div class="st you"><span class="k">in the rings</span><b>' + num(pkgs.filter(function (p) { return p.status === "approved"; }).length) + '</b><span class="s">community packages, total</span></div>';
    var ap = bucket(weeks, apps.filter(function (a) { return a.decision === "approved"; }), function (a) { return a.created_at; }), rj = bucket(weeks, apps.filter(function (a) { return a.decision !== "approved"; }), function (a) { return a.created_at; });
    var labels = weeks.map(function (w) { return w.slice(5); });
    $("#c-decisions").innerHTML = stacked(labels, [{ name: "approved", color: C.green, values: ap }, { name: "sent back", color: C.amber, values: rj }], { label: "Decisions per week over eight weeks", full: true, empty: "no decision yet" });
    $("#c-arrivals").innerHTML = lines(labels, [{ name: "arrived", color: C.blue, values: bucket(weeks, pkgs, function (p) { return p.created_at || p.updated_at; }) }, { name: "decided", color: C.green, values: ap.map(function (v, i) { return v + rj[i]; }) }], "packages", "Packages arrived and decided per week over eight weeks");
    var by = {}; apps.forEach(function (a) { by[a.by] = (by[a.by] || 0) + 1; });
    var names = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }), max = names.length ? by[names[0]] : 1;
    $("#deciders").innerHTML = names.map(function (n) { return '<div class="m">' + avatar(n, "maintainer") + '<div><a class="run" href="/user/' + encodeURIComponent(n) + '">' + esc(n) + '</a><div class="bar" style="margin-top:4px"><i style="width:' + (100 * by[n] / max) + '%"></i></div></div><b class="num">' + num(by[n]) + '</b></div>'; }).join("") || '<div class="muted">no decision on the record yet</div>';
    // A signed-in contributor: where their staged builds sit, oldest first.
    if (me && me.login) {
      var order = staged.slice().sort(function (a, b) { return Date.parse(a.finished_at || 0) - Date.parse(b.finished_at || 0); });
      var mine = order.map(function (s, i) { return { s: s, pos: i + 1 }; }).filter(function (x) { return x.s.owner === me.login; });
      $("#queue-pos").innerHTML = mine.length ? mine.slice(0, 2).map(function (x) { return '<div class="queue-pos" style="margin-top:14px"><span class="dim" style="font-size:11.5px;letter-spacing:.06em;text-transform:uppercase">your build in the queue</span><b>' + esc(x.s.name) + ' ' + esc(x.s.version || "") + ' · position ' + x.pos + ' of ' + order.length + '</b><span>' + esc(x.s.arch) + ' · audit ' + esc((x.s.audit && (x.s.audit.verdict || x.s.audit.status)) || "none") + ' · staged ' + ago(x.s.finished_at) + '</span></div>'; }).join("") : '<p class="sub" style="margin:14px 0 0;font-size:12.5px">None of your builds is waiting for a decision right now.</p>';
    } else $("#queue-pos").innerHTML = '<p class="sub" style="margin:14px 0 0;font-size:12.5px">Signed-in contributors see where their own builds sit in this queue.</p>';
  }

  // ---- the review queue: what is staged, with the audit; maintainers decide here or on /review
  function auditPill(a) {
    if (!a || a.status === "none") return '<span class="pill none">none</span>';
    if (a.status !== "done") return '<span class="pill none">' + esc(a.status) + '</span>';
    var v = a.verdict === "pass" ? "ok" : a.verdict === "fail" ? "error" : "warn";
    return '<span class="pill ' + v + '" title="' + esc(a.summary || "") + '">' + esc(a.verdict || "done") + '</span>' + (a.high ? ' <span class="muted">' + a.high + ' high</span>' : '');
  }
  function renderStaged(staged) {
    pager("#staged", staged, function (s) {
      var ev = s.evidence || {};
      return '<tr><td class="dim">' + s.id + '</td><td><b>' + esc(s.name) + '</b> <span class="dim">' + esc(s.version || "") + '</span></td><td>' + esc(s.arch) + '</td><td>' + (s.owner ? avatar(s.owner) + ' <a class="run" href="/user/' + encodeURIComponent(s.owner) + '">' + esc(s.owner) + '</a>' : "—") + '</td>' +
        '<td><a class="run" href="' + esc(ev.pkgbuild || "#") + '">PKGBUILD</a> · <a class="run" href="' + esc(ev.log || "#") + '">log</a> · <a class="run" href="' + esc(ev.pkginfo || "#") + '">.PKGINFO</a></td><td>' + auditPill(s.audit) + '</td><td class="when">' + ago(s.finished_at) + '</td>' +
        '<td style="white-space:nowrap">' + (can() ? '<button type="button" class="ok" data-approve="' + s.id + '">approve</button> <button type="button" class="no" data-reject="' + s.id + '">reject</button>' : '<span class="dim">a maintainer decides</span>') + '</td></tr>';
    }, { empty: "nothing staged — every contributor build has been decided", n: 10 });
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-approve],button[data-reject]") : null; if (!b) return;
    var id = b.getAttribute("data-approve") || b.getAttribute("data-reject"), approve = b.hasAttribute("data-approve");
    var note = prompt(approve ? "Approve build #" + id + "? A note for the record (optional):" : "Reject build #" + id + "? The note the contributor will read:", "");
    if (note === null || (!approve && !note)) return;
    b.disabled = true;
    busy(fetch(API + "/tasks/" + id + "/" + (approve ? "approve" : "reject"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: note }) })).then(function (r) { return r.json(); }).then(function (j) {
      var el = $("#rq-state"); el.hidden = false; el.innerHTML = j.error ? '<span class="pill error">refused</span> ' + esc(j.error) : '<span class="pill ok">' + (approve ? "approved" : "rejected") + '</span> build #' + id + (approve && j.rebuild ? ' — the project rebuilds it as task #' + j.rebuild : '');
      loadAll();
    }).catch(function (e) { b.disabled = false; alert("failed: " + e); });
  });

  // ---- operations: tiles, the diagram's numbers, workers by role
  function renderOps(d) {
    var count = function (st, arch) { return d.counts.filter(function (c) { return c.status === st && (!arch || c.arch === arch); }).reduce(function (n, c) { return n + c.n; }, 0); };
    var alive = d.workers.filter(function (w) { return w.alive; }), busyW = alive.filter(function (w) { return w.current_task; });
    var failed24 = d.tasks.filter(function (t) { return t.status === "failed" && Date.now() - Date.parse(t.finished_at || t.created_at) < 86400e3; });
    var m = STATS && STATS.metrics, a = m && (m.jobs || m.actions);
    setTiles("#tiles", [
      ["Queued", num(count("queued")), num(count("queued", "x86_64")) + " x86_64 · " + num(count("queued", "aarch64")) + " aarch64", count("queued") ? "warn" : ""],
      ["Building", num(count("leased")), "lease " + d.lease_minutes + " min, extended by heartbeats"],
      ["Workers alive", num(alive.length) + " / " + num(d.workers.length), num(alive.filter(function (w) { return w.side === "omarchy"; }).length) + " omarchy · " + num(alive.filter(function (w) { return w.side === "community"; }).length) + " community", alive.length ? "ok" : "warn"],
      ["Waiting for review", num(STAGED.length), STAGED.length ? "oldest " + ago(STAGED.slice().sort(function (x, y) { return Date.parse(x.finished_at || 0) - Date.parse(y.finished_at || 0); })[0].finished_at).replace(" ago", "") : "nothing staged", STAGED.length ? "warn" : ""],
      ["Failed · 24 h", num(failed24.length), failed24.length ? esc(failed24[0].name || failed24[0].kind) + " " + esc(failed24[0].arch || "") : "nothing failed"],
      ["Worker minutes · 7 d", a ? num(a.minutes) : "—", a ? "≈ " + num(Math.round(a.minutes / 7)) + " per day, the project's workers" : "no metrics snapshot yet"]
    ]);
    live("queue", "queued " + num(count("queued")) + " · leased " + num(count("leased")) + " · per-job tokens · an expired lease goes back in the queue");
    var roles = { pool: [], review: [], shared: [], own: [] };
    d.workers.forEach(function (w) { var r = roleOf(w); if (w.side === "omarchy") roles[r === "review" ? "review" : "pool"].push(w); else roles[w.mode === "shared" ? "shared" : "own"].push(w); });
    var sum = function (ws, k) { return ws.reduce(function (n, w) { return n + Number(w[k] || 0); }, 0); };
    var line = function (ws) { var al = ws.filter(function (w) { return w.alive; }), bz = al.filter(function (w) { return w.current_task; }); return num(al.length) + " alive · " + num(bz.length) + " building" + (ws.length > al.length ? " · " + num(ws.length - al.length) + " gone" : ""); };
    live("w-pool", line(roles.pool)); live("w-review", line(roles.review)); live("w-community", line(roles.shared.concat(roles.own)));
    // The load: what each worker did in the last day, from the stats series (finished tasks by duration, a running one by its start).
    var LOAD = {}; ((STATS && STATS.series && STATS.series.workers_daily) || []).forEach(function (r) { LOAD[r.worker] = { ms: Number(r.ms || 0) + Number(r.running_ms || 0), done: Number(r.done || 0) }; });
    var busyOf = function (w) { var l = LOAD[w.id]; return l ? Math.min(100, Math.round(100 * l.ms / 86400000)) : 0; };
    var card = function (cls, name, ws, blurb) {
      var al = ws.filter(function (w) { return w.alive; }), bz = al.filter(function (w) { return w.current_task; }), col = { pool: "var(--green)", review: "var(--blue)", shared: "var(--lilac)", own: "var(--dim)" }[cls];
      var busy = al.length ? Math.round(al.reduce(function (n, w) { return n + busyOf(w); }, 0) / al.length) : 0;
      return '<div class="role ' + cls + '"><h3>' + name + '<span>' + num(ws.length) + (ws.length === 1 ? " worker" : " workers") + '</span></h3><p>' + blurb + '</p><div class="u"><span class="dim">busy · 24 h</span><div class="bar" style="height:10px;background:var(--panel-2);border:1px solid var(--line);position:relative;display:block" data-tip="' + esc(name + ": " + busy + "% of the last day with a lease, across " + al.length + " alive worker(s) · " + bz.length + " building now") + '"><i style="position:absolute;left:0;top:0;bottom:0;width:' + busy + '%;background:' + col + '"></i></div><b class="num">' + busy + '%</b></div>' +
        '<dl class="kv"><dt>alive</dt><dd>' + num(al.length) + ' of ' + num(ws.length) + '</dd><dt>done · failed</dt><dd>' + num(sum(ws, "builds_done")) + ' · ' + num(sum(ws, "builds_failed")) + '</dd><dt>x86_64 · aarch64</dt><dd>' + num(al.filter(function (w) { return w.arch === "x86_64"; }).length) + ' · ' + num(al.filter(function (w) { return w.arch === "aarch64"; }).length) + '</dd><dt>with an agent</dt><dd>' + num(ws.filter(function (w) { return w.agent; }).length) + '</dd></dl></div>';
    };
    $("#roles").innerHTML = card("pool", "Pool", roles.pool, "The pool's own jobs: sync, promote, health, security, gc. Trusted, on the host the community keeps.") + card("review", "Review", roles.review, "Rebuilds what maintainers approve and writes the audit. Holds the agent key.") + card("shared", "Community · shared", roles.shared, "Contributors' machines donated to everyone's community builds.") + card("own", "Community · own", roles.own, "A contributor's machine building only their packages. Their own queue, no waiting.");
    var ranked = d.workers.filter(function (w) { return w.alive || LOAD[w.id]; }).sort(function (a, b) { return busyOf(b) - busyOf(a); }).slice(0, 10);
    $("#c-perworker").innerHTML = ranked.length ? '<div class="hrows">' + ranked.map(function (w) { var role = roleOf(w) === "review" ? "review" : w.side === "omarchy" ? "pool" : (w.mode === "shared" ? "shared" : "own"), col = { pool: "var(--green)", review: "var(--blue)", shared: "var(--lilac)", own: "var(--dim)" }[role], l = LOAD[w.id] || { ms: 0, done: 0 }; return '<div class="hrow" style="grid-template-columns:150px 1fr 56px"><div class="l">' + esc(w.id) + ' <small>' + role + ' · ' + esc(w.arch) + '</small></div><div class="bar" data-tip="' + esc(w.id + ": " + busyOf(w) + "% of the last day with a lease · " + num(l.done) + " task(s) finished, " + Math.round(l.ms / 60000) + " min" + (w.current_task ? " · building #" + w.current_task + " now" : "") + " · " + num(w.builds_done) + " done / " + num(w.builds_failed) + " failed all time") + '"><i style="width:' + busyOf(w) + '%;background:' + col + '"></i></div><div class="p num">' + busyOf(w) + '%</div></div>'; }).join("") + '</div><div class="legend"><span><i style="background:var(--green)"></i>pool</span><span><i style="background:var(--blue)"></i>review</span><span><i style="background:var(--lilac)"></i>community · shared</span><span><i style="background:var(--dim)"></i>community · own</span></div>' : '<div class="empty">no worker alive, nothing leased in the last day</div>';
    $("#ops-who").textContent = can() ? ME_LOGIN + " · you can approve, trust and roll back" : "read-only — approving, trusting and rolling back need the maintainer role";
  }

  // ---- ring heads, the journal, rollback (a job a project worker runs)
  function renderRings(d) {
    var heads = {}; (d.releases || []).forEach(function (r) { if (r.is_head) heads[r.ring] = r; });
    $("#heads").innerHTML = ["stable", "rc", "edge"].map(function (n) {
      var r = d.rings.filter(function (x) { return x.ring === n; })[0] || {}, rel = r.release, h = ["x86_64", "aarch64"].map(function (a) { var e = latest(d.latest, "health", n, a); return a + " " + (e ? e.status : "—"); }).join(" · ");
      var prev = (d.releases || []).filter(function (x) { return x.ring === n && !x.is_head; })[0];
      return '<div class="headc ' + n + '"><div class="n"><b>' + n + '</b><span class="dim">' + (rel ? "#" + rel.seq + " · " + ago(rel.created_at) : "no release") + '</span></div><div class="m">' + num(r.package_count || 0) + ' packages · ' + bytes(r.bytes || 0) + ' · ' + h + '</div><div class="acts">' + (rel && rel.parent_id ? '<a class="small-btn" href="/diff?ring=' + n + '&from=' + rel.parent_id + '&to=' + rel.id + '">diff</a>' : "") + (can() && prev ? '<button type="button" class="small-btn" data-rollback="' + prev.id + '" data-ring="' + n + '" title="point ' + n + ' back at release ' + prev.id + '">roll back to #' + prev.seq + '</button>' : "") + '</div></div>';
    }).join("");
    pager("#events", d.events, function (e) {
      var run = e.payload && e.payload.ci && e.payload.ci.run_url, rid = e.payload && e.payload.release_id, diff = "";
      if (rid && e.ring && (e.kind === "promote" || e.kind === "rollback" || e.kind === "sync" || e.kind === "fast-track")) diff = ' <a class="run" href="/diff?ring=' + esc(e.ring) + '&to=' + rid + '" title="what release ' + rid + ' changed">diff</a>';
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '">' + esc(e.summary) + '</a>' : esc(e.summary)) + diff + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
    }, { empty: "nothing yet", n: 10 });
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-rollback]") : null; if (!b) return;
    var ring = b.getAttribute("data-ring"), to = b.getAttribute("data-rollback");
    var note = prompt("Roll " + ring + " back to release " + to + "? Say why, for the journal:"); if (!note) return;
    b.disabled = true;
    busy(fetch(API + "/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "rollback", params: { ring: ring, to: to, note: note } }) })).then(function (r) { return r.json(); }).then(function (j) {
      var el = $("#rb-state"); el.hidden = false;
      el.innerHTML = j.error ? '<span class="pill error">refused</span> ' + esc(j.error) : '<span class="pill ok">queued</span> rollback of <b>' + esc(ring) + '</b> to release ' + esc(to) + ' is task #' + esc(j.task || "?") + ' — a project worker runs it, the journal records it';
      b.disabled = false;
    }).catch(function (e) { b.disabled = false; alert("failed: " + e); });
  });

  // ---- the charts, from /api/v1/stats
  function renderCharts(d) {
    var S = d.series || {}, days14 = lastDays(14), days7 = lastDays(7);
    var jd = S.jobs_daily || [], byD = {}, minutes = {};
    jd.forEach(function (r) { var x = byD[r.day] = byD[r.day] || { done: 0, failed: 0, waiting: 0 }; if (r.status === "done") x.done += Number(r.n); else if (r.status === "failed" || r.status === "cancelled") x.failed += Number(r.n); else x.waiting += Number(r.n); minutes[r.day] = (minutes[r.day] || 0) + Number(r.ms || 0) / 60000; });
    $("#c-jobs").innerHTML = stacked(days7, [{ name: "done", color: C.green, values: days7.map(function (x) { return (byD[x] || {}).done || 0; }) }, { name: "waiting", color: C.amber, values: days7.map(function (x) { return (byD[x] || {}).waiting || 0; }) }, { name: "failed", color: C.red, values: days7.map(function (x) { return (byD[x] || {}).failed || 0; }) }], { label: "Pool jobs per day over seven days", empty: "no job yet — the pool queues them on schedule and project workers pull them" });
    $("#c-minutes").innerHTML = stacked(days7, [{ name: "minutes", color: C.blue, values: days7.map(function (x) { return Math.round(minutes[x] || 0); }) }], { label: "Worker minutes per day over seven days", empty: "no job yet" });
    $("#c-health").innerHTML = heatGrid(S.health);
    var byDay = {}; (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = stacked(days14, [{ name: "imported", color: C.green, values: days14.map(function (x) { return byDay[x] ? Number(byDay[x].packages) : 0; }) }], { label: "Packages imported per day over fourteen days", empty: "no sync yet" });
    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "error" ? C.red : C.blue, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + (Math.round(mbs * 10) / 10) + " MB/s, " + bytes(r.bytes) + " in " + dur(r.duration_ms) }; }), function (v) { return v + " MB/s"; });
    var bd = S.builds_daily || [], bb = {};
    bd.forEach(function (r) { var x = bb[r.day] = bb[r.day] || { staged: 0, published: 0, failed: 0 }; if (r.status === "staged") x.staged += Number(r.n); else if (r.status === "done") x.published += Number(r.n); else if (r.status === "failed") x.failed += Number(r.n); });
    $("#c-builds").innerHTML = stacked(days14, [{ name: "staged", color: C.blue, values: days14.map(function (x) { return (bb[x] || {}).staged || 0; }) }, { name: "published", color: C.green, values: days14.map(function (x) { return (bb[x] || {}).published || 0; }) }, { name: "failed", color: C.red, values: days14.map(function (x) { return (bb[x] || {}).failed || 0; }) }], { label: "Factory builds per day over fourteen days", empty: "no build yet" });
  }

  // ---- promotions per day: what the promote, rollback and fast-track jobs recorded
  function renderPromos() {
    Promise.all(["promote", "rollback", "fast-track"].map(function (k) { return fetch("/api/v1/events?kind=" + k + "&limit=200").then(function (r) { return r.json(); }).then(function (d) { return d.events || []; }).catch(function () { return []; }); })).then(function (lists) {
      var days = lastDays(14), by = {}; days.forEach(function (d) { by[d] = { promoted: 0, blocked: 0, rolled: 0 }; });
      lists[0].forEach(function (e) { var d = e.created_at.slice(0, 10); if (!by[d]) return; if (e.status === "ok") by[d].promoted++; else by[d].blocked++; });
      lists[2].forEach(function (e) { var d = e.created_at.slice(0, 10); if (by[d] && e.status === "ok") by[d].promoted++; });
      lists[1].forEach(function (e) { var d = e.created_at.slice(0, 10); if (by[d]) by[d].rolled++; });
      $("#c-promos").innerHTML = stacked(days, [{ name: "promoted", color: C.green, values: days.map(function (d) { return by[d].promoted; }) }, { name: "blocked", color: C.amber, values: days.map(function (d) { return by[d].blocked; }) }, { name: "rolled back", color: C.red, values: days.map(function (d) { return by[d].rolled; }) }], { label: "Promotions per day over fourteen days: promoted, blocked, rolled back", empty: "no promotion yet" });
    });
  }

  // ---- the bill, estimated once a day from Cloudflare's analytics (cost.ts)
  function renderCost() {
    fetch("/api/v1/cost").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      var el = $("#budget"); if (!c) { el.innerHTML = '<div><div class="k">this month</div><b>—</b> <span class="dim">no estimate yet (daily, 06:30 UTC)</span></div>'; return; }
      var cap = 30, color = c.status === "error" ? "var(--red)" : c.status === "warn" ? "var(--amber)" : "var(--green)";
      el.innerHTML = '<div><div class="k">' + esc(c.month) + ', so far</div><b style="color:' + color + '">US$ ' + Number(c.month_to_date_usd).toFixed(2) + '</b> <span class="dim">of a US$ ' + cap + ' hard cap</span></div><div><div class="k">projected</div><b>US$ ' + Number(c.projected_usd).toFixed(2) + '</b> <span class="dim">' + (c.guard ? "over the guard: jobs that write are paused" : "guard at US$ 25") + '</span></div><div class="bar"><i style="width:' + Math.min(100, 100 * Number(c.projected_usd) / cap) + '%;background:' + color + '"></i><em style="left:83.3%"></em></div>';
    }).catch(function () {});
  }

  // ---- everything, together: stats every minute, the factory every 30 s, the feed every 20 s
  function loadAll() {
    Promise.all([
      busy(fetch(API + "?limit=100")).then(function (r) { return r.json(); }),
      fetch(API + "/packages").then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
      fetch(API + "/approvals").then(function (r) { return r.json(); }).catch(function () { return { approvals: [] }; }),
      fetch(API + "/review", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { staged: [] }; })
    ]).then(function (res) {
      var f = res[0]; STAGED = res[3].staged || [];
      FACTORY = f; renderOps(f); renderStaged(STAGED); renderThroughput(f, res[1].packages || [], res[2].approvals || [], STAGED, ME);
      renderTables(f);
      endSkeleton();
    }).catch(function () { endSkeleton(); });
  }
  whoami(function (me) { if (me) { ME_ROLE = me.role; ME_LOGIN = me.login; } loadAll(); });
  setInterval(loadAll, 30000);
  loadFeed(); setInterval(loadFeed, 20000);
  renderCost(); renderPromos(); setInterval(renderPromos, 300000);
  liveStats(function (d) { STATS = d; renderState(d); renderLive(d); renderRings(d); renderCharts(d); if (FACTORY) renderOps(FACTORY); }, 60000);
  $("#all-workers").onchange = function () { if (FACTORY) renderTables(FACTORY); };
`;

export function pipelineHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Pipeline · omarchy-pool",
    description: "The pipeline as it runs: what is verified, promoted and checked right now, how fast maintainers decide, the workers, the charts, the cost.",
    active: "pipeline",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS).replace("__REPO_URL__", REPO_URL),
    poolUrl,
    version,
  });
}
