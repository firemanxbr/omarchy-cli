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
  .src { border: 1px solid var(--line); padding: 2px 8px; font-size: 12.5px; background: var(--panel-2); }
  pre { margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; overflow-x: auto; color: var(--muted); }
  pre b { color: var(--green); font-weight: 500; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
  td.num, th.num { text-align: right; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: middle; background: var(--dim); }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--amber); } .dot.error { background: var(--red); }
  .kind { display: inline-block; min-width: 68px; color: var(--blue); }
  .when { color: var(--dim); white-space: nowrap; }
  .muted { color: var(--muted); }
  footer { border-top: 1px solid var(--line); background: var(--bg-deep); padding: 22px 32px; font-size: 13px; color: var(--dim); display: flex; gap: 24px; flex-wrap: wrap; }
  footer a { color: var(--muted); text-decoration: none; }
  #status { font-size: 13px; color: var(--dim); }
  @media (max-width: 720px) { header { flex-wrap: wrap; gap: 12px 18px; } main { padding: 24px 18px 48px; } }
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy packaging <span class="muted">/ staging</span></a>
  <nav>
    <a href="/api/v1/stats">API</a>
    <a href="https://github.com/firemanxbr/omarchy-cli">Source</a>
    <a href="https://github.com/firemanxbr/omarchy-cli/blob/main/docs/POC-RESULTS.md">POC results</a>
  </nav>
  <span class="spacer"></span>
  <span id="status">loading…</span>
  <a class="btn" href="https://github.com/firemanxbr/omarchy-cli/blob/main/docs/ARCHITECTURE.md">How it works</a>
</header>

<main>
  <h1>One pool, three rings, zero copies</h1>
  <p class="lede">Packages are uploaded once into an immutable pool. <code>edge</code>, <code>rc</code> and <code>stable</code> are pinned selections in an index; promotion is an index write and the pacman databases are rendered from it. This page shows the pipeline running on the real Arch <code>core</code>/<code>extra</code>/<code>multilib</code> packages.</p>
  <div class="notice"><b>Evidence environment.</b> Throwaway signing key, no SLA, may be reset at any time. Do not point a real machine's pacman here.</div>

  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Rings</h2>
    <p class="sub">What each ring serves right now. A ring's databases are plain objects beside the packages at <code>__POOL_URL__/x86_64/</code>.</p>
    <div class="rings" id="rings"></div>
  </section>

  <section>
    <h2>Activity</h2>
    <p class="sub">Syncs from the upstream mirror, promotions, renders and health checks, newest first.</p>
    <div class="table-wrap"><table id="events"><thead><tr><th>Status</th><th>Kind</th><th>Ring</th><th>Source</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Releases</h2>
    <p class="sub">Append-only. <em>parent</em> is the previous head of the same ring; <em>from</em> is the release a promotion or rollback copied its selection from.</p>
    <div class="table-wrap"><table id="releases"><thead><tr><th>Id</th><th>Ring</th><th>Seq</th><th class="num">Packages</th><th>Parent</th><th>From</th><th>Note</th><th>Created</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<footer>
  <span>Omarchy packaging staging · pool + index proof of concept</span>
  <a href="__POOL_URL__/x86_64/">pool</a>
  <a href="/api/v1/events">events</a>
  <a href="https://github.com/firemanxbr/omarchy-cli/blob/main/docs/TESTING.md">reproduce</a>
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
  function latest(list, kind, ring, source) { for (var i = 0; i < list.length; i++) { var e = list[i]; if (e.kind === kind && (ring == null || e.ring === ring) && (source == null || e.source === source)) return e; } return null; }

  function render(d) {
    var pool = d.pool, refHeads = pool.referenced_by_heads || {}, refAny = pool.referenced_by_any_release || {};
    var ringBytes = d.rings.reduce(function (a, r) { return a + (r.bytes || 0); }, 0);
    var lastSync = latest(d.events, "sync");
    var reclaimable = Math.max(0, (pool.bytes || 0) - (refAny.bytes || 0));
    var tiles = [
      ["Pool objects", num(pool.objects), num(pool.names) + " package names, uploaded once"],
      ["Stored once", bytes(pool.bytes), "keyed by sha256 in one bucket"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(reclaimable), num((pool.objects || 0) - (refAny.objects || 0)) + " objects no release references"],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : "waiting for the first run"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");

    $("#rings").innerHTML = d.rings.map(function (r) {
      var rel = r.release;
      var health = latest(d.latest, "health", r.ring);
      var rendered = (r.artifacts || []).filter(function (a) { return a.kind === "db"; });
      var conf = rendered.length
        ? rendered.map(function (a) { return "[<b>" + esc(a.repo) + "</b>]\nServer = " + POOL + "/$arch"; }).join("\n\n")
        : "# no database rendered yet";
      var srcs = (r.sources || []).map(function (s) { return '<span class="src">' + esc(s.source) + ' <span class="muted">' + num(s.packages) + '</span></span>'; }).join("");
      return '<div class="ring">' +
        '<div class="head"><span class="name">' + r.ring + '</span>' +
          (health ? '<span class="pill ' + health.status + '">health ' + health.status + ' · ' + ago(health.created_at) + '</span>' : '<span class="pill none">no health check yet</span>') + '</div>' +
        (rel ? '<div class="rel">release <b>#' + rel.seq + '</b> (id ' + rel.id + ') · ' + ago(rel.created_at) + (rel.note ? ' · ' + esc(rel.note) : '') + '</div>' : '<div class="rel">no release yet</div>') +
        '<dl class="kv"><dt>packages</dt><dd class="num">' + num(r.package_count) + '</dd><dt>size</dt><dd class="num">' + bytes(r.bytes) + '</dd>' +
        '<dt>databases</dt><dd>' + (rendered.length ? rendered.map(function (a) { return esc(a.repo) + '.db <span class="muted">(' + ago(a.created_at) + ')</span>'; }).join('<br>') : '<span class="muted">not rendered</span>') + '</dd></dl>' +
        '<div class="sources">' + (srcs || '<span class="muted">empty</span>') + '</div>' +
        '<pre>' + conf + '</pre>' +
      '</div>';
    }).join("");

    $("#events tbody").innerHTML = d.events.map(function (e) {
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + esc(e.summary) + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="7" class="muted">nothing yet</td></tr>';

    $("#releases tbody").innerHTML = d.releases.map(function (r) {
      return '<tr><td>' + r.id + (r.is_head ? ' <span class="pill ok">head</span>' : '') + '</td><td>' + r.ring + '</td><td>#' + r.seq + '</td><td class="num">' + num(r.package_count) + '</td><td>' + (r.parent_id || '—') + '</td><td>' + (r.source_id || '—') + '</td><td>' + esc(r.note || '') + '</td><td class="when" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted">no releases yet</td></tr>';

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

export function dashboardHtml(poolUrl: string): string {
  return HTML.split("__POOL_URL__").join(poolUrl.replace(/\/$/, ""));
}
