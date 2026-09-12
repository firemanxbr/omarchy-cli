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
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); }
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
  footer .gh { font-size: 13px; }
  header .spacer { flex: 1; }
  .btn { background: var(--green); color: var(--green-ink); font-weight: 500; padding: 6px 14px; text-decoration: none; font-size: 14px; }
  .btn:hover { filter: brightness(1.08); }
  .ver { font-size: 12.5px; letter-spacing: .04em; color: var(--green); border: 1px solid var(--green); padding: 2px 8px; text-decoration: none; white-space: nowrap; }
  .ver:hover { background: var(--green); color: var(--green-ink); }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 64px; }
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
  // Live status: online when the API answers, the last sync is recent and no
  // ring's latest health check failed; degraded otherwise; offline when the
  // API does not answer. Refreshed with every load.
  function setStatus(state, title) { var el = $("#status"); if (!el) return; el.className = "status " + state; el.querySelector("span").textContent = state; el.title = title || ""; }
  function statusFrom(d) {
    var sync = latest(d.events || [], "sync"), why = [];
    if (!sync || Date.now() - Date.parse(sync.created_at) > 2 * 3600e3) why.push("last sync " + (sync ? ago(sync.created_at) : "never"));
    (d.latest || []).forEach(function (e) { if (e.kind === "health" && e.status === "error") why.push(e.ring + " " + (e.source || "x86_64") + " health failed"); });
    setStatus(why.length ? "degraded" : "online", why.join(" · ") || "API up, syncing, every ring healthy");
  }
  // Numbers that change between refreshes flash briefly, so the page reads as live.
  function setTile(el, html) { if (el.innerHTML !== html) { el.innerHTML = html; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); } }
  function liveStats(render, everyMs) {
    function load() {
      fetch("/api/v1/stats", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { statusFrom(d); render(d); })
        .catch(function (e) { setStatus("offline", "stats failed: " + e); });
    }
    load();
    setInterval(load, everyMs || 20000);
  }
`;

export interface PageOptions {
  title: string;
  description: string;
  /** Which nav entry is highlighted. */
  active: "overview" | "get-started" | "pipeline" | "how-it-works";
  body: string;
  script?: string;
  poolUrl: string;
  version: RunningVersion;
}

export const NAV: { key: PageOptions["active"]; href: string; label: string }[] = [
  { key: "overview", href: "/", label: "Overview" },
  { key: "get-started", href: "/get-started", label: "Get started" },
  { key: "pipeline", href: "/#pipeline", label: "Pipeline" },
  { key: "how-it-works", href: "https://github.com/firemanxbr/omarchy-pool/blob/main/docs/ARCHITECTURE.md", label: "How it works" },
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@500;600;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy-pool</a>
  ${chip}
  <nav>
    ${nav}
  </nav>
  <span class="spacer"></span>
  <span id="status" class="status" title="checking"><i class="led"></i><span>checking</span></span>
  <a class="gh" href="https://github.com/firemanxbr/omarchy-pool" title="Open source on GitHub (MIT)">${GITHUB_ICON} Open source</a>
</header>

<main>
${o.body}
</main>

<footer>
  <span>omarchy-pool</span><span class="sep">·</span>
  <a href="https://github.com/firemanxbr/omarchy-pool/blob/main/LICENSE">MIT license</a><span class="sep">·</span>
  <a class="gh" href="https://github.com/firemanxbr/omarchy-pool">${GITHUB_ICON} GitHub</a><span class="sep">·</span>
  <a href="/api/v1/stats">API</a><span class="sep">·</span>
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
