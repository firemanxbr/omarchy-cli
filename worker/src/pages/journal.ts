/**
 * The Journal: everything the pipeline did, newest first, and every ring's
 * history — append-only, each row an immutable release. Filters by kind
 * and status; a signed-in maintainer rolls a ring back from here.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Journal</p>
    <h1>Everything the pipeline did, newest first</h1>
    <p class="lede">Syncs, gates, promotions, renders, health and ABI checks, rollbacks, deploys. Each line links to the run that produced it; a ring's history is append-only.</p>
  </div>
  <form class="searchbar" onsubmit="return false"><input type="search" id="q" placeholder="filter — a package, a source, a word…" aria-label="filter the journal"><div class="choice" id="pick-kind"></div><div class="choice" id="pick-status"></div></form>
  <section>
    <div class="table-wrap"><table id="events"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="count" style="margin-top:8px;font-size:12.5px"></p>
  </section>
  <section>
    <div class="h2row"><h2>Ring history</h2><span class="hint">head is what is served · parent the previous head · from what a promotion or rollback copied</span></div>
    <p class="sub">Pointing a ring at an earlier row is how a rollback works: a job a project worker runs — the index write, both architectures re-rendered, health-checked. A signed-in maintainer can roll back to any row still inside retention.</p>
    <p class="sub" id="rb-state" hidden></p>
    <div class="table-wrap"><table id="releases"><thead><tr><th>Release</th><th>Ring</th><th>Seq</th><th class="num">Packages</th><th>Parent</th><th>From</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonRows("#events", 7, 8); skeletonRows("#releases", 9, 4);
  var KINDS = ["all", "sync", "promote", "health", "security", "fast-track", "build", "render", "rollback", "gc", "deploy", "cost"], STATUSES = ["all", "ok", "warn", "error"];
  var kind = "all", status = "all", q = "", EVENTS = [], LAST = null;
  function pick(id, values, current, on) { var el = $("#" + id); el.innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join(""); el.querySelectorAll("button").forEach(function (b) { b.onclick = function () { on(b.getAttribute("data-v")); }; }); }
  function drawEvents() {
    pick("pick-kind", KINDS, kind, function (v) { kind = v; drawEvents(); });
    pick("pick-status", STATUSES, status, function (v) { status = v; drawEvents(); });
    var ql = q.toLowerCase(), rows = EVENTS.filter(function (e) { return (kind === "all" || e.kind === kind) && (status === "all" || e.status === status) && (!ql || [e.kind, e.ring, e.source, e.summary].join(" ").toLowerCase().indexOf(ql) >= 0); });
    pager("#events", rows, function (e) {
      var run = e.payload && e.payload.ci && e.payload.ci.run_url, rid = e.payload && e.payload.release_id, diff = "";
      if (rid && e.ring && (e.kind === "promote" || e.kind === "rollback" || e.kind === "sync" || e.kind === "fast-track")) diff = ' <a class="run" href="/diff?ring=' + esc(e.ring) + '&to=' + rid + '" title="what release ' + rid + ' changed">diff</a>';
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '" title="open the run">' + esc(e.summary) + '</a>' : esc(e.summary)) + diff + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
    }, { empty: "nothing matches", n: 25 });
    $("#count").textContent = rows.length + " of " + EVENTS.length + " events on this page · the API keeps more: /api/v1/events?limit=200&kind=…";
  }
  $("#q").oninput = function () { q = this.value; drawEvents(); };
  function loadEvents() {
    busy(fetch("/api/v1/events?limit=200", { cache: "no-store" })).then(function (r) { return r.json(); }).then(function (d) { EVENTS = (d.events || []).filter(function (e) { return e.kind !== "metrics"; }); drawEvents(); endSkeleton(); }).catch(function () { endSkeleton(); });
  }
  function drawReleases(d) {
    var heads = {}; (d.releases || []).forEach(function (r) { if (r.is_head) heads[r.ring] = r.id; });
    pager("#releases", d.releases, function (r) {
      var diff = r.parent_id ? '<a class="run" href="/diff?ring=' + r.ring + '&from=' + r.parent_id + '&to=' + r.id + '">diff</a>' : '';
      var rb = ME && ME.role === "maintainer" && !r.is_head && heads[r.ring] ? ' <button type="button" class="small-btn" data-rollback="' + r.id + '" data-ring="' + r.ring + '" title="point ' + r.ring + ' back at release ' + r.id + '" style="margin-left:8px">roll back</button>' : '';
      return '<tr><td>' + r.id + (r.is_head ? ' <span class="pill ok">head</span>' : '') + '</td><td><span style="color:var(--' + r.ring + ')">' + r.ring + '</span></td><td>#' + r.seq + '</td><td class="num">' + num(r.package_count) + '</td><td class="dim">' + (r.parent_id || '—') + '</td><td class="dim">' + (r.source_id || '—') + '</td><td class="muted">' + esc(r.note || '') + '</td><td class="when" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td><td style="white-space:nowrap">' + diff + rb + '</td></tr>';
    }, { empty: 'no releases yet', n: 25 });
  }
  whoami(function (me) { if (me && LAST) drawReleases(LAST); });
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-rollback]") : null; if (!b) return;
    var ring = b.getAttribute("data-ring"), to = b.getAttribute("data-rollback");
    var note = prompt("Roll " + ring + " back to release " + to + "? Say why, for the journal:"); if (!note) return;
    b.disabled = true;
    busy(fetch("/api/v1/factory/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "rollback", params: { ring: ring, to: to, note: note } }) })).then(function (r) { return r.json(); }).then(function (j) {
      var el = $("#rb-state"); el.hidden = false;
      el.innerHTML = j.error ? '<span class="pill error">refused</span> ' + esc(j.error) : '<span class="pill ok">queued</span> rollback of <b>' + esc(ring) + '</b> to release ' + esc(to) + ' is task #' + esc(j.task || "?") + ' — a project worker runs it, the journal records it';
      b.disabled = false;
    }).catch(function (e) { b.disabled = false; alert("failed: " + e); });
  });
  loadEvents(); setInterval(loadEvents, 60000);
  liveStats(function (d) { LAST = d; drawReleases(d); }, 60000);
`;

export function journalHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Journal · omarchy-pool",
    description: "Everything the pipeline did, newest first, and every ring's append-only history.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
