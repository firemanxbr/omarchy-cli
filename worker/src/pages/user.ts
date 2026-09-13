/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/contribute">Contributors</a> / <span id="crumb"></span></p>
  <div id="who" style="display:flex;gap:18px;align-items:center;margin-bottom:8px">
    <img id="avatar" alt="" width="64" height="64" style="border-radius:8px;background:var(--panel-2)" hidden>
    <div><h1 id="title" style="margin:0">…</h1><p class="sub" id="line" style="margin:4px 0 0"></p></div>
  </div>
  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Packages</h2>
    <p class="sub">Registered by this contributor: the name is theirs, their worker builds it, a maintainer of the group reviews it.</p>
    <div class="table-wrap"><table id="packages"><thead><tr><th>Package</th><th>Group</th><th>Project</th><th>Arches</th><th>Stage</th><th>Detail</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="approvals-section" hidden>
    <h2>Approvals</h2>
    <p class="sub">Decisions this maintainer signed: what they let into the pool, and what they sent back.</p>
    <div class="table-wrap"><table id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Builds</h2>
    <p class="sub">On this contributor's workers — evidence for a maintainer, never what users get directly.</p>
    <div class="table-wrap"><table id="builds"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Why</th><th>Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Workers</h2>
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Arch</th><th>Trust</th><th>Mode</th><th>Last seen</th><th>Done / failed</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 6, 2); skeletonRows("#builds", 7, 3); skeletonRows("#workers", 6, 1);
  function pill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", approved: "var(--green)", rejected: "var(--red)", unmaintained: "var(--red)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min"; }
  busy(fetch("/api/v1/users/" + encodeURIComponent(login))).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); }).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").textContent = d.name ? d.name + " (" + d.login + ")" : d.login;
    if (d.avatar_url) { $("#avatar").src = d.avatar_url; $("#avatar").hidden = false; }
    $("#line").innerHTML = '<a href="' + esc(d.github) + '">github.com/' + esc(d.login) + '</a> · <b>' + esc(d.role) + '</b>' +
      (d.groups.length ? ' of ' + d.groups.map(function (g) { return '<a href="/docs/governance">' + esc(g.name) + '</a>'; }).join(", ") : '') +
      ' · since ' + esc(String(d.since).slice(0, 10)) + ' · last seen ' + ago(d.last_seen);
    var c = d.build_counts;
    var tiles = [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      ["Approvals", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(d.workers.filter(function (w) { return !w.revoked_at; }).length), num(d.workers.filter(function (w) { return w.alive; }).length) + " alive now"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");
    pager("#packages", d.packages, function (p) {
      var arches = []; try { arches = JSON.parse(p.arches || "[]"); } catch (e) {}
      return '<tr><td><a href="/package/' + encodeURIComponent(p.name) + '"><b>' + esc(p.name) + '</b></a></td><td>' + esc(p.group) + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a>' : '') + '</td><td>' + esc(arches.join(", ")) + '</td><td>' + pill(p.status) + '</td><td>' + esc(p.detail || "") + '</td></tr>';
    }, { empty: "no package registered" });
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      pager("#approvals", d.approvals, function (a) {
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="/package/' + encodeURIComponent(a.name) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span> <span class="src">' + esc(a.group) + '</span></td><td>' + esc(a.arch) + '</td><td>' + pill(a.decision) + '</td><td>' + esc(a.note || "") + '</td></tr>';
      }, { empty: "no decision yet" });
    }
    pager("#builds", d.builds, function (t) {
      return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + pill(t.status) + '</td><td>' + esc(t.reason || "") + '</td><td>' + took(t.duration_ms) + '</td><td class="when">' + ago(t.finished_at || t.created_at) + '</td></tr>';
    }, { empty: "nothing built yet" });
    pager("#workers", d.workers, function (w) {
      return '<tr><td class="mono">' + esc(w.id) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.trust) + '</td><td>' + esc(w.mode) + '</td><td class="when">' + ago(w.last_seen) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td></tr>';
    }, { empty: "no worker registered" });
    endSkeleton();
    // Your own page: the place to sign out, and to get a token for the command line.
    whoami(function (me) { if (me && me.login === d.login) $("#line").insertAdjacentHTML("beforeend", ' · <a href="/contribute">your workspace</a> · <a href="/auth/logout">sign out</a>'); });
  }).catch(function (e) { $("#line").textContent = "could not load: " + e; endSkeleton(); });
  liveStats(function () {}, 120000);
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "contribute",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
