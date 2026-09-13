/**
 * The overview: what the pool serves right now, which ring to use, how far
 * every upstream source is mirrored, and how the pipeline itself is doing.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>Arch, Arch Linux ARM and Omarchy packages, tested before they reach you</h1>
  <p class="lede">One repository for Omarchy on x86_64 and aarch64. Every upstream package is verified against its project's signing key, stored once, and served in three rings: <code>edge</code> follows upstream within three hours, <code>rc</code> is what passed a real pacman and an ABI check on both architectures, <code>stable</code> is what stayed healthy in <code>rc</code> for a day — and rolls back by itself if it stops being. One <code>Server =</code> line instead of a repository per project. <a href="/docs/get-started">Get started →</a></p>

  <div class="tiles" id="tiles"></div>

  <section id="rings-section">
    <h2>Rings</h2>
    <p class="sub">Pick the ring that matches how much risk you want. Each one is a complete, signed set of pacman databases; the packages behind them are the same objects.</p>
    <div class="rings" id="rings"></div>
  </section>

  <section>
    <h2>Coverage</h2>
    <p class="sub">Every upstream repository the pool mirrors: what upstream serves, what <code>edge</code> already pins, what <code>stable</code> pins. The target is all of it, on both architectures; nothing is stored twice (superseded versions stay in the pool until retention runs, so the size can exceed the upstream's).</p>
    <div class="table-wrap"><table id="coverage"><thead><tr><th>Source</th><th>Arch</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th><th class="num">In stable</th><th>Progress</th><th class="num">Size</th><th>Last sync</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="provenance" hidden></p>
  </section>

  <section id="pipeline">
    <h2>Pipeline <span id="pipeline-state" class="pill none" style="vertical-align:middle;margin-left:8px">checking</span></h2>
    <p class="sub">The pool is fed and promoted by its own jobs: the brain (a Cloudflare Worker with the index in D1) queues sync, promote, health, security and gc on schedule, project workers anywhere pull them with a per-job credential, and the packages are static objects on R2. A snapshot every 30 minutes records what ran, what is running now and the worker minutes.</p>
    <div class="tiles" id="systiles"></div>
    <div class="charts">
      <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one runner each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
      <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, gc pulled by workers: done, failed, waiting</div><div id="c-jobs"></div></div>
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: contributors' builds staged, the project's published, failed</div><div id="c-builds"></div></div>
    </div>
    <div class="table-wrap"><table id="workflows"><thead><tr><th>Job</th><th>Last</th><th class="num">Runs 7d</th><th class="num">Failed</th><th class="num">Running</th><th class="num">Minutes 7d</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Journal</h2>
    <p class="sub">Everything the pipeline did, newest first: syncs from upstream, gates, promotions, renders, health and ABI checks, rollbacks, deploys. Each line links to the run that produced it.</p>
    <div class="table-wrap"><table id="events"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Ring history</h2>
    <p class="sub">A ring's history is append-only: every row is an immutable selection of packages (a release), <em>head</em> is the one being served, <em>parent</em> the previous head of the same ring, <em>from</em> the release a promotion or rollback copied. Pointing a ring at an earlier row is how a rollback works — <em>diff</em> shows what a row changed against its parent; a signed-in maintainer can <em>roll back</em> a ring to any earlier row still inside retention (a job a project worker runs: the index write, both architectures re-rendered, health-checked).</p>
    <p class="sub" id="rb-state" hidden></p>
    <div class="table-wrap"><table id="releases"><thead><tr><th>Release</th><th>Ring</th><th>Seq</th><th class="num">Packages</th><th>Parent</th><th>From</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 5); skeletonRows("#coverage", 9, 5); skeletonRows("#workflows", 7, 4); skeletonRows("#events", 7, 6); skeletonRows("#releases", 8, 4);
__CHARTS__
  var RING_INFO = {
    stable: { title: "Recommended for daily use", text: "What <b>rc</b> served for a day without a failed check. About two days behind Arch; health-checked on both architectures after every promotion and rolled back automatically if that fails." },
    rc: { title: "For testers", text: "Yesterday's <b>edge</b>, promoted only after a real pacman synced it and an ABI check found no blockers on x86_64 and aarch64. See problems before stable does." },
    edge: { title: "For CI and developers", text: "What upstream published in the last hour, signature-verified and rendered, nothing else checked yet. The same packages Arch serves, one hour later." }
  };

  var LAST = null;
  // The roll back buttons depend on who is signed in, which arrives on its own: draw the history again then.
  whoami(function (me) { if (me && LAST) render(LAST); });
  function render(d) {
    LAST = d;
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0] || {};
    var byArch = function (r, arch) { return (r.sources || []).filter(function (s) { return s.arch === arch; }).reduce(function (n, s) { return n + s.packages; }, 0); };
    var lastSync = latest(d.events, "sync");
    var synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sh = latest(d.latest, "health", "stable", "x86_64"), sha = latest(d.latest, "health", "stable", "aarch64");
    var tiles = [
      ["Packages in stable", num(stable.package_count), num(byArch(stable, "x86_64")) + " x86_64 · " + num(byArch(stable, "aarch64")) + " aarch64"],
      ["Stable release", stable.release ? "#" + stable.release.seq : "—", stable.release ? ago(stable.release.created_at) + " · health " + (sh ? sh.status : "n/a") + " / " + (sha ? sha.status : "n/a") : "no release yet"],
      ["Sources mirrored", synced + " / " + expected, "Arch · Arch Linux ARM · Omarchy (OPR)"],
      ["In the pool", num(d.pool.objects), bytes(d.pool.bytes) + ", each package stored once"],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : "waiting for the first run"]
    ];
    tiles.forEach(function (t, i) { var el = $("#tiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });

    var ARCHES = ["x86_64", "aarch64"];
    $("#rings").innerHTML = ["stable", "rc", "edge"].map(function (name) {
      var r = d.rings.filter(function (x) { return x.ring === name; })[0] || { ring: name, sources: [], artifacts: [] };
      var rel = r.release, info = RING_INFO[name];
      var archBlocks = ARCHES.map(function (arch) {
        var srcs = (r.sources || []).filter(function (s) { return s.arch === arch; });
        var dbs = (r.artifacts || []).filter(function (a) { return a.kind === "db" && a.arch === arch; });
        if (!srcs.length && !dbs.length) return "";
        var health = latest(d.latest, "health", r.ring, arch);
        return '<div class="arch"><div class="archhead"><span class="archname">' + arch + '</span>' +
          (health ? '<span class="pill ' + health.status + '">health ' + health.status + ' · ' + ago(health.created_at) + '</span>' : '<span class="pill none">no health check yet</span>') + '</div>' +
          '<div class="sources">' + srcs.map(function (s) { return '<span class="src">' + esc(s.source) + ' <span class="muted">' + num(s.packages) + '</span></span>'; }).join("") +
          (dbs.length ? '' : ' <span class="muted">no database rendered yet</span>') + '</div></div>';
      }).join("");
      return '<div class="ring">' +
        '<div class="head"><span class="name">' + name + (name === "stable" ? ' <span class="pill rec">recommended</span>' : '') + '</span><span class="rel">' + num(r.package_count) + ' pkgs · ' + bytes(r.bytes) + '</span></div>' +
        '<div class="desc"><b>' + info.title + '.</b> ' + info.text + '</div>' +
        (rel ? '<div class="rel">release <b>#' + rel.seq + '</b> · ' + ago(rel.created_at) + (rel.note ? ' · ' + esc(rel.note) : '') + '</div>' : '<div class="rel">no release yet</div>') +
        (archBlocks || '<div class="muted">empty</div>') +
        '<div class="cta"><a href="/docs/get-started?ring=' + name + '">Use ' + name + ' →</a></div>' +
      '</div>';
    }).join("");

    pager("#events", d.events, function (e) {
      var run = e.payload && e.payload.ci && e.payload.ci.run_url;
      // A promotion or rollback made a release: link what it changed.
      var rid = e.payload && e.payload.release_id, diff = "";
      if (rid && e.ring && (e.kind === "promote" || e.kind === "rollback" || e.kind === "sync" || e.kind === "fast-track")) diff = ' <a class="run" href="/diff?ring=' + esc(e.ring) + '&to=' + rid + '" title="what release ' + rid + ' changed">diff</a>';
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '" title="open the run">' + esc(e.summary) + '</a>' : esc(e.summary)) + diff + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
    }, { empty: 'nothing yet' });

    var heads = {}; (d.releases || []).forEach(function (r) { if (r.is_head) heads[r.ring] = r.id; });
    pager("#releases", d.releases, function (r) {
      var diff = r.parent_id ? '<a class="run" href="/diff?ring=' + r.ring + '&from=' + r.parent_id + '&to=' + r.id + '">diff</a>' : '';
      var rb = ME && ME.role === "maintainer" && !r.is_head && heads[r.ring] ? ' <button type="button" class="small" data-rollback="' + r.id + '" data-ring="' + r.ring + '" title="point ' + r.ring + ' back at release ' + r.id + '">roll back</button>' : '';
      return '<tr><td>' + r.id + (r.is_head ? ' <span class="pill ok">head</span>' : '') + '</td><td>' + r.ring + '</td><td>#' + r.seq + '</td><td class="num">' + num(r.package_count) + '</td><td>' + (r.parent_id || '—') + '</td><td>' + (r.source_id || '—') + '</td><td>' + esc(r.note || '') + '</td><td class="when" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td><td>' + diff + rb + '</td></tr>';
    }, { empty: 'no releases yet' });

    renderCoverage(d);
    renderSystem(d);
  }

  // A rollback is a job like the scheduler's: queued here with the maintainer's session, run by a project worker.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-rollback]") : null; if (!b) return;
    var ring = b.getAttribute("data-ring"), to = b.getAttribute("data-rollback");
    var note = prompt("Roll " + ring + " back to release " + to + "? Say why, for the journal:"); if (!note) return;
    b.disabled = true;
    busy(fetch("/api/v1/factory/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "rollback", params: { ring: ring, to: to, note: note } }) })).then(function (r) { return r.json(); }).then(function (j) {
      var el = $("#rb-state"); el.hidden = false;
      el.innerHTML = j.error ? '<span class="pill error">refused</span> ' + esc(j.error) : '<span class="pill ok">queued</span> rollback of <b>' + esc(ring) + '</b> to release ' + esc(to) + ' is task #' + j.task + '; a project worker will run it within a minute — the <a href="/factory">Factory</a> page follows it, the journal above records the result.';
      b.disabled = false;
    }).catch(function (e) { b.disabled = false; alert("failed: " + e); });
  });
  liveStats(render, 60000);
`;

export function overviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "omarchy-pool",
    description: "One package repository for Omarchy: Arch, Arch Linux ARM and Omarchy packages, verified, served in rings and rolled back automatically.",
    active: "overview",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

const CHARTS = String.raw`  // ---- tiny SVG charts (no library; the page has no build step) ----
  var C = { green: "#9ece6a", amber: "#e0af68", red: "#f7768e", blue: "#7aa2f7", dim: "#414868", grid: "#2a2e3f", text: "#8b93b8" };
  // The viewBox is the drawing; the SVG scales uniformly with its column
  // (no preserveAspectRatio="none": stretched text overflowed its space).
  function svg(w, h, body) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="display:block;height:auto" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" fill="' + C.text + '">' + body + '</svg>'; }
  // Labels get the room they have, not more: cut with an ellipsis, full text in the tooltip.
  function fit(t, n) { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  function day(iso) { return iso.slice(0, 10); }
  function lastDays(n) { var out = [], t = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10)); return out; }
  function bars(items, fmt) { // vertical bars, items: [{label, value, color, title}]
    if (!items.length || !items.some(function (i) { return i.value > 0; })) return '<div class="empty">nothing yet</div>';
    var W = 360, H = 150, top = 16, bottom = 22, left = 6, max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    var bw = (W - left * 2) / items.length, body = '';
    body += '<line x1="0" y1="' + (H - bottom) + '" x2="' + W + '" y2="' + (H - bottom) + '" stroke="' + C.grid + '"/>';
    items.forEach(function (it, i) {
      var h = (H - top - bottom) * it.value / max, x = left + i * bw, y = H - bottom - h;
      body += '<rect x="' + (x + bw * 0.15) + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + h + '" fill="' + (it.color || C.green) + '"><title>' + esc(it.title || it.label + ": " + fmt(it.value)) + '</title></rect>';
      var step = items.length > 8 ? 2 : 1;
      if (i % step === 0) body += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10">' + esc(it.label) + '</text>';
    });
    body += '<text x="' + left + '" y="11" font-size="10">max ' + esc(fmt(max)) + '</text>';
    return svg(W, H, body);
  }
  function area(points, fmt) { // points: [{t: ms, v}]
    if (points.length < 2) return '<div class="empty">' + (points.length ? 'one snapshot so far — the line needs two' : 'collecting snapshots') + '</div>';
    var W = 360, H = 150, top = 16, bottom = 20, left = 6, right = 6;
    var vs = points.map(function (p) { return p.v; }), max = Math.max.apply(null, vs) || 1, min = Math.min.apply(null, vs);
    var t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    var lo = min === max ? 0 : min;
    var X = function (t) { return left + (W - left - right) * (t - t0) / (t1 - t0 || 1); }, Y = function (v) { return H - bottom - (H - top - bottom) * (v - lo) / (max - lo || 1); };
    var pts = points.map(function (p) { return X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var body = '<polygon points="' + X(t0).toFixed(1) + ',' + (H - bottom) + ' ' + pts + ' ' + X(t1).toFixed(1) + ',' + (H - bottom) + '" fill="' + C.green + '" fill-opacity="0.15"/>';
    body += '<polyline points="' + pts + '" fill="none" stroke="' + C.green + '" stroke-width="1.5"/>';
    body += '<text x="' + left + '" y="11" font-size="10">' + esc(fmt(max)) + '</text><text x="' + left + '" y="' + (H - bottom - 3) + '" font-size="10">' + esc(fmt(lo)) + '</text>';
    body += '<text x="' + left + '" y="' + (H - 6) + '" font-size="10">' + esc(new Date(t0).toUTCString().slice(5, 16)) + '</text><text x="' + (W - right) + '" y="' + (H - 6) + '" text-anchor="end" font-size="10">' + esc(new Date(t1).toUTCString().slice(5, 16)) + '</text>';
    return svg(W, H, body);
  }
  function heat(rows, days, cell) { // rows: [{key,label}], cell(key, day) -> status|null
    if (!rows.length) return '<div class="empty">no health checks yet</div>';
    var W = 360, labelW = 110, rh = 18, H = rows.length * rh + 22, cw = (W - labelW) / days.length, body = '';
    rows.forEach(function (r, ri) {
      body += '<text x="0" y="' + (ri * rh + 13) + '" font-size="10.5"><title>' + esc(r.label) + '</title>' + esc(fit(r.label, 17)) + '</text>';
      days.forEach(function (dd, di) {
        var st = cell(r.key, dd), col = st === "error" ? C.red : st === "warn" ? C.amber : st === "ok" ? C.green : C.dim;
        body += '<rect x="' + (labelW + di * cw + 1) + '" y="' + (ri * rh + 2) + '" width="' + (cw - 2) + '" height="' + (rh - 4) + '" fill="' + col + '" fill-opacity="' + (st ? 1 : 0.35) + '"><title>' + esc(r.label + " " + dd + ": " + (st || "no check")) + '</title></rect>';
      });
    });
    body += '<text x="' + labelW + '" y="' + (H - 4) + '" font-size="10">' + esc(days[0].slice(5)) + '</text><text x="' + W + '" y="' + (H - 4) + '" text-anchor="end" font-size="10">' + esc(days[days.length - 1].slice(5)) + '</text>';
    return svg(W, H, body);
  }
  function hbars(items) { // items: [{label, parts: [{v, color}], note}]
    if (!items.length) return '<div class="empty">no snapshot yet</div>';
    var W = 360, labelW = 112, noteW = 66, rh = 20, H = items.length * rh + 4, body = '';
    var max = Math.max.apply(null, items.map(function (i) { return i.parts.reduce(function (a, p) { return a + p.v; }, 0); })) || 1;
    items.forEach(function (it, i) {
      var x = labelW, y = i * rh + 2;
      body += '<text x="0" y="' + (y + 12) + '" font-size="10.5"><title>' + esc(it.label) + '</title>' + esc(fit(it.label, 17)) + '</text>';
      it.parts.forEach(function (p) { var w = (W - labelW - noteW - 10) * p.v / max; if (w > 0) { body += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (rh - 6) + '" fill="' + p.color + '"><title>' + esc(it.label + ": " + p.v + " " + p.name) + '</title></rect>'; x += w; } });
      body += '<text x="' + (W) + '" y="' + (y + 12) + '" text-anchor="end" font-size="10">' + esc(it.note) + '</text>';
    });
    return svg(W, H, body);
  }
  function worst(a, b) { var rank = { error: 3, warn: 2, ok: 1 }; return (rank[b] || 0) > (rank[a] || 0) ? b : a; }

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
  function renderCoverage(d) {
    renderProvenance(d);
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : (a.arch === "x86_64" ? -1 : 1); });
    var tot = cov.reduce(function (t, c) { t.up += c.upstream_total || 0; t.have += c.indexed; t.miss += c.missing || 0; t.bytes += c.bytes; t.pending += c.upstream_total == null ? 1 : 0; return t; }, { up: 0, have: 0, miss: 0, bytes: 0, pending: 0 });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    pager("#coverage", cov, function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? '<span class="pill none">not synced yet</span>' : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (c.last_status !== "ok" ? ' <span class="pill ' + c.last_status + '">' + c.last_status + '</span>' : '')) + '</td></tr>';
    }, { n: 25 });
  }

`;
