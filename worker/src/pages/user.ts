/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="profile-head">
    <span class="avatar lg" id="avatar">…</span>
    <div><p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p><h1 id="title">…</h1><p class="line" id="line"></p></div>
    <span id="share-btn"></span>
  </div>
  <div class="tiles" id="tiles"></div>
  <section id="share" hidden>
    <div class="h2row"><h2>Share it</h2><span class="hint">this page is public — everything on it is on the record anyway</span></div>
    <div class="share"><p><b style="color:var(--text)">You are part of open source.</b> Copy the link and post it wherever you like — your GitHub profile, LinkedIn, a blog. What it shows is what the pool recorded: packages, builds, decisions.</p><pre><span class="copy" id="copy-link">copy</span><span id="share-url"></span></pre><div class="row"><a class="btn ghost" href="/factory#workspace">Your workspace →</a><a class="btn ghost" href="/auth/logout">Sign out</a></div></div>
  </section>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">Per group, from the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number per group, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Group</th><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

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
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Arch</th><th>Trust</th><th>Mode</th><th>Agent</th><th>Last seen</th><th>Done / failed</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 6, 2); skeletonRows("#builds", 7, 3); skeletonRows("#workers", 7, 1);
  function pill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", approved: "var(--green)", rejected: "var(--red)", unmaintained: "var(--red)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min"; }
  busy(fetch("/api/v1/users/" + encodeURIComponent(login))).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); }).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").innerHTML = esc(d.name || d.login) + ' <span class="dim" style="font-weight:500">@' + esc(d.login) + '</span>';
    // An icon, never a photo: two letters, green for a maintainer.
    $("#avatar").textContent = d.login.slice(0, 2); if (d.role === "maintainer") $("#avatar").classList.add("m");
    $("#line").innerHTML = '<span class="pill ' + (d.role === "maintainer" ? "rec" : "ok") + '">' + esc(d.role) + '</span>' +
      (d.groups.length ? d.groups.map(function (g) { return '<a class="pill none" href="/docs/governance" style="text-decoration:none">' + esc(g.name) + '</a>'; }).join("") : '') +
      '<span>since ' + esc(String(d.since).slice(0, 10)) + '</span><span class="dim">·</span><span>last seen ' + ago(d.last_seen) + '</span><span class="dim">·</span><a href="' + esc(d.github) + '" style="color:var(--muted);text-decoration:none">github.com/' + esc(d.login) + ' ↗</a>';
    var c = d.build_counts;
    var tiles = [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      ["Approvals", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(d.workers.filter(function (w) { return !w.revoked_at; }).length), num(d.workers.filter(function (w) { return w.alive; }).length) + " alive now"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");
    if ((d.record || []).length) {
      $("#record-section").hidden = false;
      pager("#record", d.record, function (r) {
        var c = r.contributed, m = r.maintained;
        var contributed = [c.approved ? num(c.approved) + " let in" : "", c.staged ? num(c.staged) + " staged" : "", c.bumps ? num(c.bumps) + " bump" + (c.bumps === 1 ? "" : "s") : "", c.donated ? num(c.donated) + " for others" : "", c.rejected ? num(c.rejected) + " rejected" : ""].filter(Boolean).join(" · ") || "—";
        var maintained = [m.approvals ? num(m.approvals) + " approval" + (m.approvals === 1 ? "" : "s") : "", m.rejections ? num(m.rejections) + " rejection" + (m.rejections === 1 ? "" : "s") : "", m.rebuilds_failed ? num(m.rebuilds_failed) + " rebuild" + (m.rebuilds_failed === 1 ? "" : "s") + " failed" : ""].filter(Boolean).join(" · ") || "—";
        return '<tr><td><a href="/docs/governance"><b>' + esc(r.group) + '</b></a></td><td>' + contributed + '</td><td>' + maintained + '</td><td class="num">' + num(r.score) + '</td></tr>';
      });
    }
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
      return '<tr><td class="mono">' + esc(w.id) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.trust) + '</td><td>' + esc(w.mode) + '</td><td>' + agentCell(w) + '</td><td class="when">' + ago(w.last_seen) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td></tr>';
    }, { empty: "no worker registered" });
    endSkeleton();
    // Your own page: the place to sign out, and to get a token for the command line.
    whoami(function (me) {
      if (!me || me.login !== d.login) return;
      var url = location.origin + "/user/" + encodeURIComponent(d.login);
      $("#share").hidden = false; $("#share-url").textContent = url; $("#share-btn").innerHTML = '<a class="btn" href="#share">Share your profile</a>';
      $("#copy-link").onclick = function () { navigator.clipboard.writeText(url).then(function () { $("#copy-link").textContent = "copied"; setTimeout(function () { $("#copy-link").textContent = "copy"; }, 1500); }); };
    });
  }).catch(function (e) { $("#line").textContent = "could not load: " + e; endSkeleton(); });
  liveStats(function () {}, 120000);
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
