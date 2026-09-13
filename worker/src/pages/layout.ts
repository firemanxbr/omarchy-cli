/**
 * Shared page frame of the dashboard: styles (omarchy.org's Tokyo Night look),
 * the header with navigation, live status and running version, the footer,
 * and the small helpers every page script uses. No build step: each page is a
 * string with a <script> that reads /api/v1/stats.
 */
import type { RunningVersion } from "../meta";

export const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const CSS = String.raw`
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
  header nav a { color: var(--muted); text-decoration: none; padding-bottom: 2px; border-bottom: 1px solid transparent; }
  header nav a:hover { color: var(--text); }
  header nav a.active { color: var(--text); border-bottom-color: var(--green); }
  .gh { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); text-decoration: none; font-size: 13.5px; }
  .gh:hover { color: var(--text); }
  .gh svg { width: 18px; height: 18px; fill: currentColor; }
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); text-decoration: none; }
  .status .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 0 rgba(158,206,106,0); }
  .status.online .led { background: var(--green); animation: pulse 2.4s ease-out infinite; }
  .status.online { color: var(--green); }
  .status.degraded .led { background: var(--amber); } .status.degraded { color: var(--amber); }
  .status.offline .led { background: var(--red); } .status.offline { color: var(--red); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(158,206,106,.55); } 70% { box-shadow: 0 0 0 7px rgba(158,206,106,0); } 100% { box-shadow: 0 0 0 0 rgba(158,206,106,0); } }
  .v.bump { animation: bump .5s ease-out; } @keyframes bump { 0% { color: var(--green); } 100% { color: inherit; } }
  .ring .desc { font-size: 13px; color: var(--muted); line-height: 1.5; }
  .ring .cta { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .ring .cta a { font-size: 13px; color: var(--green); text-decoration: none; }
  .ring .cta a:hover { text-decoration: underline; }
  .pill.rec { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .steps { display: grid; gap: 16px; max-width: 900px; }
  .step { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; }
  .step h3 { margin-bottom: 6px; }
  .step p { color: var(--muted); font-size: 14px; margin: 0 0 10px; }
  .choice { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
  .choice button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .choice button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .step pre { position: relative; padding-right: 76px; white-space: pre-wrap; word-break: break-all; }
  .copy { position: absolute; right: 8px; top: 8px; font-size: 12px; color: var(--dim); cursor: pointer; border: 1px solid var(--line); padding: 1px 8px; background: var(--panel); }
  .copy:hover { color: var(--text); }
  footer .sep { color: var(--line); }
  .searchbar { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
  .searchbar input { flex: 1 1 380px; font: inherit; font-size: 15px; padding: 9px 12px; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
  .searchbar input:focus { outline: none; border-color: var(--green); }
  .searchbar .choice { margin: 0; }
  .crumbs { color: var(--dim); font-size: 13px; margin: 0 0 6px; } .crumbs a { color: var(--muted); text-decoration: none; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; color: var(--muted); margin: 10px 0 36px; }
  .meta .sep { color: var(--line); }
  ul.plain { list-style: none; margin: 0; padding: 0; font-size: 13.5px; line-height: 1.8; }
  ul.plain.cols { columns: 2; column-gap: 24px; } ul.plain li { break-inside: avoid; }
  ul.plain a { text-decoration: none; color: var(--text); border-bottom: 1px dotted var(--dim); } ul.plain a:hover { color: var(--green); }
  #graph svg { width: 100%; height: auto; display: block; } #graph a { cursor: pointer; } #graph a:hover rect { stroke-width: 2; }
  .choice-btn { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; vertical-align: middle; margin-left: 8px; }
  #files { max-height: 420px; overflow: auto; }
  footer .gh { font-size: 13px; }
  header .spacer { flex: 1; }
  .btn { background: var(--green); color: var(--green-ink); font-weight: 500; padding: 6px 14px; text-decoration: none; font-size: 14px; }
  .btn:hover { filter: brightness(1.08); }
  .ver { font-size: 12.5px; letter-spacing: .04em; color: var(--green); border: 1px solid var(--green); padding: 2px 8px; text-decoration: none; white-space: nowrap; }
  .ver:hover { background: var(--green); color: var(--green-ink); }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 64px; }
  .lede { color: var(--muted); margin: 8px 0 0; max-width: 78ch; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 28px 0 40px; }
  .tile { background: var(--panel); padding: 18px 20px; }
  .tile .k { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .tile .v { font-family: Geist, sans-serif; font-size: 30px; font-weight: 600; margin-top: 4px; }
  .tile .s { font-size: 13px; color: var(--muted); margin-top: 2px; }

  section { margin: 0 0 44px; }
  section > h2 { margin-bottom: 4px; }
  section > p.sub { color: var(--muted); margin: 0 0 16px; font-size: 14px; }

  .rings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; }
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
  .howto { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 16px; }
  .howto .arch { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; }
  .src { border: 1px solid var(--line); padding: 2px 8px; font-size: 12.5px; background: var(--panel-2); }
  pre { margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; overflow-x: auto; color: var(--muted); }
  pre b { color: var(--green); font-weight: 500; }

  /* Loading: a thin bar at the top while any request is in flight, and
     skeleton rows/tiles so a page never looks frozen or jumps in from nothing. */
  #progress { position: fixed; top: 0; left: 0; height: 2px; width: 0; background: var(--green); z-index: 50; opacity: 0; transition: opacity .2s; }
  #progress.on { opacity: 1; animation: progress 1.6s ease-in-out infinite; }
  @keyframes progress { 0% { width: 0; margin-left: 0 } 50% { width: 60%; margin-left: 20% } 100% { width: 0; margin-left: 100% } }
  /* .skl is the shimmering bar; .skel marks a placeholder row or tile (removed when data lands). */
  .skl { display: inline-block; height: 12px; width: 70%; border-radius: 2px; background: linear-gradient(90deg, var(--line) 25%, var(--panel-2) 50%, var(--line) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; vertical-align: middle; }
  tr.skel td:nth-child(2n) .skl { width: 45%; } tr.skel td:nth-child(3n) .skl { width: 30%; }
  .tile.skel .v .skl { height: 26px; width: 55%; } .tile.skel .s .skl { width: 80%; }
  @keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
  .empty.loading { color: var(--dim); }
  .empty.loading::after { content: "…"; animation: dots 1.2s steps(4, end) infinite; }
  @keyframes dots { 0% { content: "" } 25% { content: "." } 50% { content: ".." } 75% { content: "..." } }

  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px 18px; align-items: end; margin: 14px 0; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  .form label .choice label { flex-direction: row; text-transform: none; letter-spacing: 0; font-size: 13.5px; color: var(--text); align-items: center; gap: 6px; }
  .form input[type="text"], .form input[type="url"], .form select, .searchbar input[type="password"] { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 8px 10px; font: inherit; font-size: 13.5px; }
  .form button, .searchbar button, table button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 8px 14px; font: inherit; font-size: 13.5px; cursor: pointer; }
  .form button:hover, .searchbar button:hover, table button:hover { border-color: var(--green); }
  table button { padding: 3px 9px; font-size: 12.5px; }

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

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 16px; margin: 16px 0; }
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
  #graph { overflow-x: auto; } #graph svg { min-width: 720px; }
  @media (max-width: 720px) {
    header { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "brand chip" "nav nav" "status status"; gap: 10px 12px; padding: 12px 16px; align-items: center; }
    header .brand { grid-area: brand; } header .ver { grid-area: chip; justify-self: end; } header .spacer { display: none; }
    header nav { grid-area: nav; display: flex; gap: 18px; overflow-x: auto; white-space: nowrap; padding-bottom: 4px; margin: 0 -16px; padding-left: 16px; padding-right: 16px; scrollbar-width: none; }
    header nav::-webkit-scrollbar { display: none; }
    header #status { grid-area: status; }
    main { padding: 20px 16px 40px; }
    h1 { font-size: 22px; line-height: 1.25; } h2 { font-size: 19px; }
    .lede { font-size: 14px; }
    .tile .v { font-size: 24px; }
    .searchbar input { flex-basis: 100%; }
    .meta { margin-bottom: 24px; }
    ul.plain.cols { columns: 1; }
    .step pre { padding-right: 12px; padding-top: 34px; } .copy { top: 6px; }
    footer { padding: 18px 16px; gap: 10px 14px; }
    section { margin-bottom: 32px; }
  }
`;

/** Helpers shared by every page script; runs before the page's own script. */
const HELPERS = String.raw`
  var POOL = "__POOL_URL__";
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bytes(n) { n = Number(n || 0); var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + " " + u[i]; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function ago(iso) { if (!iso) return "—"; var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
  function dur(ms) { if (ms == null) return ""; if (ms < 1000) return ms + " ms"; if (ms < 60000) return (ms / 1000).toFixed(1) + " s"; return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; }
  function latest(list, kind, ring, source) {
    for (var i = 0; i < list.length; i++) { var e = list[i]; if (e.kind === kind && (ring == null || e.ring === ring) && (source == null || e.source === source)) return e; }
    if (source === "x86_64") for (var j = 0; j < list.length; j++) { var f = list[j]; if (f.kind === kind && (ring == null || f.ring === ring) && !f.source) return f; }
    return null;
  }
  // Header pill = the service: online when the API answers and it can reach
  // the index and the pool right now (/api/v1/status measures both), degraded
  // when one of them fails, offline when the API itself does not answer.
  // Whether the pipeline is keeping up is a different question (problemsOf).
  function setStatus(state, title) { var el = $("#status"); if (!el) return; el.className = "status " + state; el.querySelector("span").textContent = state; el.title = title || ""; }
  function serviceStatus() {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var why = [];
      if (!s.index.ok) why.push("index: " + (s.index.error || "failed"));
      if (!s.pool.ok) why.push("pool: " + (s.pool.error || "failed"));
      setStatus(s.ok ? "online" : "degraded", s.ok ? "API, index (" + s.index.ms + " ms) and pool (" + s.pool.ms + " ms) answering" : why.join(" · "));
    }).catch(function (e) { setStatus("offline", "API not answering: " + e); });
  }
  // What is wrong, if anything: no sync for two hours, a source not synced
  // for six (a long import holds the pipeline's queue, so small sources wait),
  // or a ring whose latest health check failed. The header pill and the
  // status page use the same list.
  function problemsOf(d) {
    var sync = latest(d.events || [], "sync"), why = [];
    if (!sync || Date.now() - Date.parse(sync.created_at) > 2 * 3600e3) why.push("no sync for " + (sync ? ago(sync.created_at).replace(" ago", "") : "ever"));
    var late = (d.coverage || []).filter(function (c) { return c.last_sync && Date.now() - Date.parse(c.last_sync) > 6 * 3600e3; });
    if (late.length) why.push(late.length + " source(s) not synced for 6 h");
    (d.latest || []).forEach(function (e) { if (e.kind === "health" && e.status === "error") why.push(e.ring + " " + (e.source || "x86_64") + " failed its health check"); });
    return why;
  }
  // Pipeline pill (where a page has one): keeping up, or what is behind.
  function pipelineFrom(d) {
    var el = $("#pipeline-state"); if (!el) return;
    var why = problemsOf(d);
    el.className = "pill " + (why.length ? "warn" : "ok");
    el.textContent = why.length ? "pipeline behind: " + why.join(" · ") : "pipeline keeping up";
  }
  // Every fetch a page starts goes through busy(): the bar at the top stays
  // on while at least one is in flight.
  function busy(p) {
    var el = $("#progress"); busy.n = (busy.n || 0) + 1; if (el) el.classList.add("on");
    return p.finally(function () { busy.n = Math.max(0, (busy.n || 1) - 1); if (!busy.n && el) el.classList.remove("on"); });
  }
  // Placeholders until the first data arrives: rows for a table, cells for
  // tiles. A render replaces a placeholder's content and drops the mark;
  // endSkeleton() removes whatever placeholders are left over.
  function skeletonRows(tableSel, cols, rows) {
    var tb = document.querySelector(tableSel + " tbody"); if (!tb || tb.children.length) return;
    var row = '<tr class="skel">' + new Array(cols + 1).join('<td><span class="skl"></span></td>') + '</tr>';
    tb.innerHTML = new Array((rows || 4) + 1).join(row);
  }
  function skeletonTiles(sel, n) {
    var el = $(sel); if (!el || el.children.length) return;
    el.innerHTML = new Array((n || 4) + 1).join('<div class="tile skel"><div class="k"><span class="skl"></span></div><div class="v"><span class="skl"></span></div><div class="s"><span class="skl"></span></div></div>');
  }
  function skeletonText(sel) { var el = $(sel); if (el && !el.textContent.trim()) { el.classList.add("empty", "loading"); el.textContent = "Loading"; } }
  function endSkeleton() { document.querySelectorAll(".skel").forEach(function (el) { el.remove(); }); document.querySelectorAll(".empty.loading").forEach(function (el) { el.classList.remove("empty", "loading"); if (el.textContent === "Loading") el.textContent = ""; }); }
  // Numbers that change between refreshes flash briefly, so the page reads as live.
  function setTile(el, html) { el.classList.remove("skel"); if (el.innerHTML !== html) { el.innerHTML = html; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); } }
  function liveStats(render, everyMs) {
    function load() {
      serviceStatus();
      busy(fetch("/api/v1/stats")).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { pipelineFrom(d); render(d); endSkeleton(); })
        .catch(function () {});
    }
    load();
    setInterval(load, everyMs || 20000);
  }
`;

export interface PageOptions {
  title: string;
  description: string;
  /** Which nav entry is highlighted. */
  active: "overview" | "packages" | "security" | "factory" | "contribute" | "review" | "get-started" | "pipeline" | "how-it-works";
  body: string;
  script?: string;
  poolUrl: string;
  version: RunningVersion;
}

export const NAV: { key: PageOptions["active"]; href: string; label: string }[] = [
  { key: "packages", href: "/packages", label: "Packages" },
  { key: "security", href: "/security", label: "Security" },
  { key: "factory", href: "/factory", label: "Factory" },
  { key: "contribute", href: "/contribute", label: "Contribute" },
  { key: "review", href: "/review", label: "Review" },
  { key: "get-started", href: "/get-started", label: "Get started" },
  { key: "how-it-works", href: "/how-it-works", label: "How it works" },
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function page(o: PageOptions): string {
  const v = o.version;
  const tag = escapeHtml(v.version);
  const chip = v.release_url
    ? `<a class="ver" href="${escapeHtml(v.release_url)}" title="running release">${tag}</a>`
    : `<span class="ver" title="local build">${tag}</span>`;
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === o.active ? ' class="active"' : ""}>${n.label}</a>`).join("\n    ");
  const pool = o.poolUrl.replace(/\/$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%239ece6a'/%3E%3Crect x='9' y='9' width='14' height='14' rx='1.5' fill='%230c0e10'/%3E%3Crect x='13' y='13' width='6' height='6' fill='%239ece6a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@500;600;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<div id="progress"></div>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy-pool</a>
  ${chip}
  <nav>
    ${nav}
  </nav>
  <span class="spacer"></span>
  <a id="status" class="status" href="/status" title="checking"><i class="led"></i><span>checking</span></a>
</header>

<main>
${o.body}
</main>

<footer>
  <span>omarchy-pool</span><span class="sep">·</span>
  <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/LICENSE">MIT license</a><span class="sep">·</span>
  <a class="gh" href="https://github.com/firemanxbr/omarchy-pool">${GITHUB_ICON} GitHub</a><span class="sep">·</span>
  <a href="/api">API</a><span class="sep">·</span>
  <a href="/status">Status</a><span class="sep">·</span>
  <span>running ${v.release_url ? `<a href="${escapeHtml(v.release_url)}">${tag}</a>` : tag}${v.commit && v.commit_url ? ` · <a href="${escapeHtml(v.commit_url)}">${escapeHtml(v.commit.slice(0, 7))}</a>` : ""}</span>
</footer>

<script>
(function () {
${HELPERS.split("__POOL_URL__").join(pool)}
${o.script ?? ""}
})();
</script>
</body>
</html>`;
}
