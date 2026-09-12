/**
 * The public dashboard: one HTML page, no build step, styled after omarchy.org
 * (Tokyo Night palette, JetBrains Mono body, Geist headings, square corners).
 * It renders /api/v1/stats and refreshes every minute.
 */

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omarchy packaging staging</title>
<meta name="description" content="Live view of the Omarchy package pool, pinned releases and generated pacman databases.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@500;600;700&display=swap">
<style>
  :root {
    --bg: #1a1b26; --bg-deep: #0e0e14; --panel: #1f2230; --panel-2: #13141c; --line: #2a2e3f;
    --text: #c0caf5; --muted: #a9b1d6; --dim: #8b93b8; --green: #9ece6a; --green-ink: #0c0e10;
    --amber: #e0af68; --red: #f7768e; --blue: #7aa2f7;
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--text); }
  h1, h2, h3 { font-family: Geist, "JetBrains Mono", sans-serif; letter-spacing: -0.02em; margin: 0; }
  h1 { font-size: 30px; font-weight: 600; }
  h2 { font-size: 22px; font-weight: 600; }
  h3 { font-size: 16px; font-weight: 600; }
  code, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
  .num { font-variant-numeric: tabular-nums; }

  header { display: flex; align-items: center; gap: 28px; padding: 14px 32px; border-bottom: 1px solid var(--line); background: var(--bg-deep); }
  header .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; color: var(--text); text-decoration: none; }
  header .brand .mark { width: 22px; height: 22px; background: var(--green); display: grid; place-items: center; color: var(--green-ink); font-size: 12px; font-weight: 700; }
  header nav { display: flex; gap: 22px; font-size: 14px; }
  header nav a { color: var(--muted); text-decoration: none; }
  header nav a:hover { color: var(--text); }
  header .spacer { flex: 1; }
  .btn { background: var(--green); color: var(--green-ink); font-weight: 500; padding: 6px 14px; text-decoration: none; font-size: 14px; }
  .btn:hover { filter: brightness(1.08); }
  .ver { font-size: 12.5px; letter-spacing: .04em; color: var(--green); border: 1px solid var(--green); padding: 2px 8px; text-decoration: none; white-space: nowrap; }
  .ver:hover { background: var(--green); color: var(--green-ink); }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 64px; }
  .notice { border: 1px solid var(--line); background: var(--panel-2); padding: 12px 16px; font-size: 13.5px; color: var(--muted); margin: 0 0 32px; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
  .notice b { color: var(--amber); font-weight: 600; }
  .lede { color: var(--muted); margin: 8px 0 0; max-width: 78ch; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 28px 0 40px; }
  .tile { background: var(--panel); padding: 18px 20px; }
  .tile .k { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .tile .v { font-family: Geist, sans-serif; font-size: 30px; font-weight: 600; margin-top: 4px; }
  .tile .s { font-size: 13px; color: var(--muted); margin-top: 2px; }

  section { margin: 0 0 44px; }
  section > h2 { margin-bottom: 4px; }
  section > p.sub { color: var(--muted); margin: 0 0 16px; font-size: 14px; }

  .rings { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .ring { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
  .ring .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .ring .name { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; }
  .ring .rel { color: var(--muted); font-size: 13px; }
  .pill { display: inline-block; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 8px; border: 1px solid var(--line); color: var(--muted); }
  .pill.ok { color: var(--green); border-color: var(--green); }
  .pill.warn { color: var(--amber); border-color: var(--amber); }
  .pill.error { color: var(--red); border-color: var(--red); }
  .pill.none { color: var(--dim); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13.5px; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; }
  .sources { display: flex; flex-wrap: wrap; gap: 6px; }
  .arch { border-top: 1px solid var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .archhead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .archname { font-family: "JetBrains Mono", monospace; font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  pre .c { color: var(--dim); }
  .howto { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
  .howto .arch { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; }
  .src { border: 1px solid var(--line); padding: 2px 8px; font-size: 12.5px; background: var(--panel-2); }
  pre { margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; overflow-x: auto; color: var(--muted); }
  pre b { color: var(--green); font-weight: 500; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: middle; background: var(--dim); }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--amber); } .dot.error { background: var(--red); }
  .kind { display: inline-block; min-width: 68px; color: var(--blue); }
  .when { color: var(--dim); white-space: nowrap; }
  .muted { color: var(--muted); }
  footer { border-top: 1px solid var(--line); background: var(--bg-deep); padding: 22px 32px; font-size: 13px; color: var(--dim); display: flex; gap: 24px; flex-wrap: wrap; }
  footer a { color: var(--muted); text-decoration: none; }
  #status { font-size: 13px; color: var(--dim); }

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; margin: 16px 0; }
  .chart { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; min-width: 0; }
  .chart h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .chart h3 span { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 400; color: var(--dim); }
  .chart .sub { font-size: 12.5px; color: var(--dim); margin: 2px 0 8px; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .chart .empty { color: var(--dim); font-size: 13px; padding: 24px 0; text-align: center; }
  .bar { display: inline-block; height: 8px; background: var(--panel-2); border: 1px solid var(--line); width: 140px; vertical-align: middle; position: relative; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .bar i.partial { background: var(--amber); }
  .pct { font-size: 12px; color: var(--muted); margin-left: 8px; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: middle; }
  a.run { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--dim); }
  a.run:hover { color: var(--text); }
  @media (max-width: 720px) { header { flex-wrap: wrap; gap: 12px 18px; } main { padding: 24px 18px 48px; } }
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy-pool <span class="muted">/ staging</span></a>
  __VERSION_CHIP__
  <nav>
    <a href="/api/v1/stats">API</a>
    <a href="https://github.com/firemanxbr/omarchy-pool">Source</a>
    <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/docs/POC-RESULTS.md">POC results</a>
  </nav>
  <span class="spacer"></span>
  <span id="status">loading…</span>
  <a class="btn" href="https://github.com/firemanxbr/omarchy-pool/blob/main/docs/ARCHITECTURE.md">How it works</a>
</header>

<main>
  <h1>One pool, three rings, zero copies</h1>
  <p class="lede">Packages are uploaded once into an immutable pool. <code>edge</code>, <code>rc</code> and <code>stable</code> are pinned selections in an index; promotion is an index write and the pacman databases are rendered from it. This page shows the pipeline running on the real Arch <code>core</code>/<code>extra</code>/<code>multilib</code> (x86_64), Arch Linux ARM (aarch64) and Omarchy (OPR) packages.</p>
  <div class="notice"><b>Evidence environment.</b> Databases are signed with a staging key; packages keep their upstream signatures. No SLA, may be reset. Use it on test machines.</div>

  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Rings</h2>
    <p class="sub">What each ring serves right now. A ring's databases are plain objects beside the packages at <code>__POOL_URL__/x86_64/</code>.</p>
    <div class="rings" id="rings"></div>
  </section>

  <section>
    <h2>Coverage</h2>
    <p class="sub">Every upstream repository the pool mirrors: what upstream serves, what is already in the pool, what <code>stable</code> pins. The target is all of it, on both architectures; nothing is stored twice.</p>
    <div class="table-wrap"><table id="coverage"><thead><tr><th>Source</th><th>Arch</th><th class="num">Upstream</th><th class="num">In the pool</th><th class="num">Missing</th><th class="num">In stable</th><th>Progress</th><th class="num">Size</th><th>Last sync</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>How it is running</h2>
    <p class="sub">The pipeline is GitHub Actions workflows writing to the index through the API. A <code>metrics</code> snapshot every 30 minutes records the runs, what is executing right now and the runner minutes; syncs, health checks and gates record themselves.</p>
    <div class="tiles" id="systiles"></div>
    <div class="charts">
      <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>GitHub Actions <span>7 days</span></h3><div class="sub">runs per workflow: succeeded, failed, running now</div><div id="c-actions"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one runner each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Runner minutes <span>per day</span></h3><div class="sub">GitHub-hosted runner time consumed</div><div id="c-minutes"></div></div>
    </div>
    <div class="table-wrap"><table id="workflows"><thead><tr><th>Workflow</th><th>Last run</th><th class="num">Took</th><th class="num">Runs 7d</th><th class="num">Failed</th><th class="num">Running</th><th class="num">Minutes 7d</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Try it</h2>
    <p class="sub">Point a test machine or a container at <code>stable</code>. It is an evidence environment — expect resets.</p>
    <div class="howto" id="howto"></div>
  </section>

  <section>
    <h2>Activity</h2>
    <p class="sub">Syncs from the upstream mirror, promotions, renders and health checks, newest first.</p>
    <div class="table-wrap"><table id="events"><thead><tr><th>Status</th><th>Kind</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Releases</h2>
    <p class="sub">Append-only. <em>parent</em> is the previous head of the same ring; <em>from</em> is the release a promotion or rollback copied its selection from.</p>
    <div class="table-wrap"><table id="releases"><thead><tr><th>Id</th><th>Ring</th><th>Seq</th><th class="num">Packages</th><th>Parent</th><th>From</th><th>Note</th><th>Created</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<footer>
  <span>omarchy-pool staging · __VERSION_LINE__</span>
  <a href="__POOL_URL__/x86_64/">pool</a>
  <a href="/api/v1/events">events</a>
  <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/docs/TESTING.md">reproduce</a>
  <span id="generated"></span>
</footer>

<script>
(function () {
  var POOL = "__POOL_URL__";
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bytes(n) { n = Number(n || 0); var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + " " + u[i]; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function ago(iso) { if (!iso) return "—"; var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
  function dur(ms) { if (ms == null) return ""; if (ms < 1000) return ms + " ms"; if (ms < 60000) return (ms / 1000).toFixed(1) + " s"; return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; }
  function latest(list, kind, ring, source) {
    for (var i = 0; i < list.length; i++) { var e = list[i]; if (e.kind === kind && (ring == null || e.ring === ring) && (source == null || e.source === source)) return e; }
    // Events recorded before the architecture was tracked have no source; they were x86_64.
    if (source === "x86_64") for (var j = 0; j < list.length; j++) { var f = list[j]; if (f.kind === kind && (ring == null || f.ring === ring) && !f.source) return f; }
    return null;
  }

  // ---- tiny SVG charts (no library; the page has no build step) ----
  var C = { green: "#9ece6a", amber: "#e0af68", red: "#f7768e", blue: "#7aa2f7", dim: "#414868", grid: "#2a2e3f", text: "#8b93b8" };
  function svg(w, h, body) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" height="' + h + '" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" fill="' + C.text + '">' + body + '</svg>'; }
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
      if (i % step === 0 || i === items.length - 1) body += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10">' + esc(it.label) + '</text>';
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
      body += '<text x="0" y="' + (ri * rh + 13) + '" font-size="10.5">' + esc(r.label) + '</text>';
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
    var W = 360, labelW = 84, noteW = 60, rh = 20, H = items.length * rh + 4, body = '';
    var max = Math.max.apply(null, items.map(function (i) { return i.parts.reduce(function (a, p) { return a + p.v; }, 0); })) || 1;
    items.forEach(function (it, i) {
      var x = labelW, y = i * rh + 2;
      body += '<text x="0" y="' + (y + 12) + '" font-size="10.5">' + esc(it.label) + '</text>';
      it.parts.forEach(function (p) { var w = (W - labelW - noteW) * p.v / max; if (w > 0) { body += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (rh - 6) + '" fill="' + p.color + '"><title>' + esc(it.label + ": " + p.v + " " + p.name) + '</title></rect>'; x += w; } });
      body += '<text x="' + (W) + '" y="' + (y + 12) + '" text-anchor="end" font-size="10">' + esc(it.note) + '</text>';
    });
    return svg(W, H, body);
  }
  function worst(a, b) { var rank = { error: 3, warn: 2, ok: 1 }; return (rank[b] || 0) > (rank[a] || 0) ? b : a; }

  function renderSystem(d) {
    var m = d.metrics, a = m && m.actions;
    var tiles = [
      ["Running now", a ? num(a.running) : "—", a ? "workflow jobs executing or queued" : "no metrics snapshot yet"],
      ["Runs, 7 days", a ? num(a.runs) : "—", a ? num(a.failures) + " failed · " + num(a.runs - a.failures - a.running) + " succeeded" : ""],
      ["Runner minutes, 7 days", a ? num(a.minutes) : "—", "GitHub-hosted, x86_64 and arm64"],
      ["Snapshot", m ? ago(m.recorded_at) : "never", m ? "metrics every 30 minutes" : "the Metrics workflow has not run"],
      ["Running", esc(d.version.version), d.version.deployed_at ? "deployed " + ago(d.version.deployed_at) : "local build"]
    ];
    $("#systiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");

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

    var wfs = (a && a.workflows ? a.workflows.slice() : []).sort(function (x, y) { return y.runs - x.runs; });
    $("#c-actions").innerHTML = hbars(wfs.map(function (w) { return { label: w.name, note: num(w.runs) + " · " + num(w.minutes) + " min", parts: [{ v: w.success, color: C.green, name: "succeeded" }, { v: w.failure, color: C.red, name: "failed" }, { v: w.running, color: C.blue, name: "running" }, { v: Math.max(0, w.runs - w.success - w.failure - w.running), color: C.dim, name: "other" }] }; })) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>succeeded</span><span><i style="background:' + C.red + '"></i>failed</span><span><i style="background:' + C.blue + '"></i>running</span><span><i style="background:' + C.dim + '"></i>cancelled / skipped</span></div>';

    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "ok" ? C.green : C.amber, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + num(r.uploaded) + " packages, " + bytes(r.bytes) + " in " + dur(r.duration_ms) + " → " + (Math.round(mbs * 10) / 10) + " MB/s" + (r.concurrency ? " with " + r.concurrency + " workers" : "") }; }), function (v) { return v + " MB/s"; });

    var daily = a && a.daily ? a.daily : [], byD = {}; daily.forEach(function (r) { byD[r.day] = r; });
    $("#c-minutes").innerHTML = bars(lastDays(7).map(function (dd) { var r = byD[dd]; return { label: dd.slice(5), value: r ? Number(r.minutes) : 0, color: C.blue, title: dd + ": " + (r ? r.minutes + " min in " + r.runs + " runs, " + r.failures + " failed" : "no runs") }; }), function (v) { return v + " min"; });

    $("#workflows tbody").innerHTML = wfs.map(function (w) {
      var l = w.last || {}, st = l.conclusion || l.status || "—", cls = st === "success" ? "ok" : st === "failure" ? "error" : (st === "in_progress" || st === "queued") ? "warn" : "";
      return '<tr><td>' + esc(w.name) + '</td><td><span class="dot ' + cls + '"></span>' + (l.url ? '<a class="run" href="' + esc(l.url) + '">' + esc(st) + '</a>' : esc(st)) + (l.created_at ? ' <span class="when">' + ago(l.created_at) + '</span>' : '') + '</td><td class="num">' + (l.seconds ? dur(l.seconds * 1000) : "") + '</td><td class="num">' + num(w.runs) + '</td><td class="num">' + (w.failure ? '<span style="color:var(--red)">' + num(w.failure) + '</span>' : '0') + '</td><td class="num">' + (w.running ? '<span style="color:var(--blue)">' + num(w.running) + '</span>' : '0') + '</td><td class="num">' + num(w.minutes) + '</td></tr>';
    }).join("") || '<tr><td colspan="7" class="muted">no metrics snapshot yet — the Metrics workflow records one every 30 minutes</td></tr>';
  }

  function renderCoverage(d) {
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : (a.arch === "x86_64" ? -1 : 1); });
    var tot = cov.reduce(function (t, c) { t.up += c.upstream_total || 0; t.have += c.indexed; t.miss += c.missing || 0; t.bytes += c.bytes; t.pending += c.upstream_total == null ? 1 : 0; return t; }, { up: 0, have: 0, miss: 0, bytes: 0, pending: 0 });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    $("#coverage tbody").innerHTML = cov.map(function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? '<span class="pill none">not synced yet</span>' : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (c.last_status !== "ok" ? ' <span class="pill ' + c.last_status + '">' + c.last_status + '</span>' : '')) + '</td></tr>';
    }).join("") + (cov.length ? '<tr><th>total</th><th></th><th class="num">' + num(tot.up) + (tot.pending ? '+' : '') + '</th><th class="num">' + num(tot.have) + '</th><th class="num">' + num(tot.miss) + '</th><th></th><th>' + pctOf(tot.have, tot.up) + '% of the synced sources' + (tot.pending ? ' · ' + tot.pending + ' not synced yet' : '') + '</th><th class="num">' + bytes(tot.bytes) + '</th><th></th></tr>' : '<tr><td colspan="9" class="muted">no sync recorded yet</td></tr>');
  }

  function render(d) {
    var pool = d.pool, refHeads = pool.referenced_by_heads || {}, refAny = pool.referenced_by_any_release || {};
    var ringBytes = d.rings.reduce(function (a, r) { return a + (r.bytes || 0); }, 0);
    var lastSync = latest(d.events, "sync");
    var rec = pool.reclaimable || { objects: 0, bytes: 0 };
    var pending = Math.max(0, (pool.objects || 0) - (refAny.objects || 0));
    var tiles = [
      ["Pool objects", num(pool.objects), num(pool.names) + " package names, uploaded once"],
      ["Stored once", bytes(pool.bytes), "keyed by sha256 in one bucket"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(rec.bytes), num(rec.objects) + " objects past retention" + (pending ? " · " + num(pending) + " awaiting a release" : "")],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : "waiting for the first run"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");

    var ARCHES = ["x86_64", "aarch64"];
    $("#rings").innerHTML = d.rings.map(function (r) {
      var rel = r.release;
      var archBlocks = ARCHES.map(function (arch) {
        var srcs = (r.sources || []).filter(function (s) { return s.arch === arch; });
        var dbs = (r.artifacts || []).filter(function (a) { return a.kind === "db" && a.arch === arch; });
        if (!srcs.length && !dbs.length) return "";
        var health = latest(d.latest, "health", r.ring, arch);
        var conf = dbs.length
          ? dbs.map(function (a) { return "[<b>" + esc(a.repo) + "</b>]\nServer = " + POOL + "/$arch"; }).join("\n\n")
          : "# no database rendered yet";
        return '<div class="arch"><div class="archhead"><span class="archname">' + arch + '</span>' +
          (health ? '<span class="pill ' + health.status + '">health ' + health.status + ' · ' + ago(health.created_at) + '</span>' : '<span class="pill none">no health check yet</span>') + '</div>' +
          '<div class="sources">' + srcs.map(function (s) { return '<span class="src">' + esc(s.source) + ' <span class="muted">' + num(s.packages) + '</span></span>'; }).join("") + '</div>' +
          '<pre>' + conf + '</pre></div>';
      }).join("");
      return '<div class="ring">' +
        '<div class="head"><span class="name">' + r.ring + '</span><span class="rel">' + num(r.package_count) + ' pkgs · ' + bytes(r.bytes) + '</span></div>' +
        (rel ? '<div class="rel">release <b>#' + rel.seq + '</b> (id ' + rel.id + ') · ' + ago(rel.created_at) + (rel.note ? ' · ' + esc(rel.note) : '') + '</div>' : '<div class="rel">no release yet</div>') +
        (archBlocks || '<div class="muted">empty</div>') +
      '</div>';
    }).join("");

    // How to use: whatever stable serves right now, per architecture.
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0];
    $("#howto").innerHTML = ARCHES.map(function (arch) {
      var dbs = stable ? (stable.artifacts || []).filter(function (a) { return a.kind === "db" && a.arch === arch; }) : [];
      if (!dbs.length) return "";
      return '<div class="arch"><div class="archhead"><span class="archname">' + arch + '</span></div><pre>' +
        '<span class="c"># 1. trust the staging database key (packages keep their upstream signatures)</span>\n' +
        'curl -O ' + POOL + '/omarchy-staging.pub.asc\n' +
        'sudo pacman-key --add omarchy-staging.pub.asc &amp;&amp; sudo pacman-key --lsign-key staging@firemanxbr.org\n\n' +
        '<span class="c"># 2. /etc/pacman.conf — put these above [core]/[extra], or replace them</span>\n' +
        dbs.map(function (a) { return "[<b>" + esc(a.repo) + "</b>]\nSigLevel = Required DatabaseRequired\nServer = " + POOL + "/$arch"; }).join("\n\n") +
        '\n\n<span class="c"># 3.</span>\nsudo pacman -Syu</pre></div>';
    }).join("") || '<p class="muted">stable has no rendered databases yet.</p>';

    $("#events tbody").innerHTML = d.events.map(function (e) {
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + esc(e.summary) + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="7" class="muted">nothing yet</td></tr>';

    $("#releases tbody").innerHTML = d.releases.map(function (r) {
      return '<tr><td>' + r.id + (r.is_head ? ' <span class="pill ok">head</span>' : '') + '</td><td>' + r.ring + '</td><td>#' + r.seq + '</td><td class="num">' + num(r.package_count) + '</td><td>' + (r.parent_id || '—') + '</td><td>' + (r.source_id || '—') + '</td><td>' + esc(r.note || '') + '</td><td class="when" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted">no releases yet</td></tr>';

    renderCoverage(d);
    renderSystem(d);
    $("#generated").textContent = "generated " + new Date(d.generated_at).toUTCString();
    $("#status").textContent = "live · refreshed " + new Date().toLocaleTimeString();
  }

  function load() {
    fetch("/api/v1/stats").then(function (r) { return r.json(); }).then(render).catch(function (e) { $("#status").textContent = "failed to load stats: " + e; });
  }
  load();
  setInterval(load, 60000);
})();
</script>
</body>
</html>`;

export interface RunningVersion {
  version: string;
  commit: string | null;
  deployed_at: string | null;
  release_url: string | null;
  commit_url: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function dashboardHtml(poolUrl: string, v: RunningVersion): string {
  const tag = escapeHtml(v.version);
  const chip = v.release_url
    ? `<a class="ver" href="${escapeHtml(v.release_url)}" title="running release">${tag}</a>`
    : `<span class="ver" title="local build">${tag}</span>`;
  const commit = v.commit && v.commit_url ? ` · <a href="${escapeHtml(v.commit_url)}">${escapeHtml(v.commit.slice(0, 7))}</a>` : "";
  const deployed = v.deployed_at ? ` · deployed <time datetime="${escapeHtml(v.deployed_at)}">${escapeHtml(v.deployed_at.replace("T", " ").replace(/\.\d+Z$/, "Z"))}</time>` : "";
  const line = `running ${v.release_url ? `<a href="${escapeHtml(v.release_url)}">${tag}</a>` : tag}${commit}${deployed}`;
  return HTML.split("__POOL_URL__").join(poolUrl.replace(/\/$/, "")).replace("__VERSION_CHIP__", chip).replace("__VERSION_LINE__", line);
}
