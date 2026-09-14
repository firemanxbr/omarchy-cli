/**
 * What changed between two releases of a ring: added, removed, upgraded —
 * the page the ring history's "diff" links open, and what a promotion or
 * rollback line in the journal points at. Reads GET /releases/:ring/diff.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/">Overview</a> / <span id="crumb">diff</span></p>
  <h1 id="title">Release diff</h1>
  <p class="lede" id="line">Loading…</p>
  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Upgraded</h2>
    <p class="sub">Same name and architecture, another object — a downgrade shows here too, the versions tell.</p>
    <div class="table-wrap"><table id="upgraded"><thead><tr><th>Package</th><th>Arch</th><th>From</th><th>To</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Added</h2>
    <div class="table-wrap"><table id="added"><thead><tr><th>Package</th><th>Arch</th><th>Version</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Removed</h2>
    <div class="table-wrap"><table id="removed"><thead><tr><th>Package</th><th>Arch</th><th>Version</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var q = new URLSearchParams(location.search);
  var ring = q.get("ring") || "stable", from = q.get("from"), to = q.get("to"), arch = q.get("arch");
  skeletonTiles("#tiles", 4); skeletonRows("#upgraded", 5, 4); skeletonRows("#added", 4, 2); skeletonRows("#removed", 4, 2);
  var url = "/api/v1/releases/" + encodeURIComponent(ring) + "/diff?" + (from ? "from=" + encodeURIComponent(from) + "&" : "") + (to ? "to=" + encodeURIComponent(to) + "&" : "") + (arch ? "arch=" + encodeURIComponent(arch) : "");
  var pkg = function (p) { return '<a href="/package/' + encodeURIComponent(p.name) + '"><b>' + esc(p.name) + '</b></a>'; };
  busy(fetch(url)).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); }).then(function (d) {
    if (d.__status !== 200) { $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    var f = d.from ? "release " + d.from.id + " (#" + d.from.seq + ")" : "nothing";
    document.title = ring + " " + (d.from ? d.from.id : "") + " → " + d.to.id + " · omarchy-pool";
    $("#crumb").textContent = ring + ": " + (d.from ? d.from.id : "∅") + " → " + d.to.id;
    $("#title").textContent = ring + ": " + f + " → release " + d.to.id + " (#" + d.to.seq + ")" + (arch ? " · " + arch : "");
    $("#line").innerHTML = 'Created ' + ago(d.to.created_at) + (d.to.note ? ' — <em>' + esc(d.to.note) + '</em>' : '') + (d.from ? '; the older one ' + ago(d.from.created_at) + (d.from.note ? ' — <em>' + esc(d.from.note) + '</em>' : '') : '') + '. <a class="run" href="' + esc(url) + '">JSON</a>';
    var c = d.counts;
    $("#tiles").innerHTML = [["Upgraded", c.upgraded, "same name, another object"], ["Added", c.added, "new (name, arch) pairs"], ["Removed", c.removed, "gone from the selection"], ["Packages", num(c.after), "was " + num(c.before)]]
      .map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + num(t[1]) + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");
    pager("#upgraded", d.upgraded, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.from) + '</td><td class="mono">' + esc(p.to) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing upgraded" });
    pager("#added", d.added, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing added" });
    pager("#removed", d.removed, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing removed" });
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = "failed: " + e; endSkeleton(); });
  liveStats(function () {}, 120000);
`;

export function diffHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Release diff · omarchy-pool",
    description: "What changed between two releases of a ring: added, removed, upgraded packages.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
