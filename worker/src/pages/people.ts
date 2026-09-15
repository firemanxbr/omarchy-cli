/**
 * The people and the machines: every maintainer named in
 * factory/MAINTAINERS.toml, every contributor with a registered package or a
 * worker, every worker registration that is not revoked. Linked from the
 * Pool's "Made in the open" numbers; each name leads to its profile.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="h2row"><h1>People</h1><a class="more-link" href="/docs/governance">How one becomes a maintainer →</a></div>
  <p class="sub">Everyone on the pool's record — and the machines that build. No accounts beyond a GitHub login, nothing kept that the pool does not need.</p>
  <div class="tiles" id="tiles"></div>

  <section id="maintainers">
    <div class="h2row"><h2>Maintainers</h2><span class="hint">named in <code>factory/MAINTAINERS.toml</code>, per group</span></div>
    <p class="sub">They approve what contributors stage, trust workers, and review the recipes in their groups. The green icon is theirs everywhere on the dashboard.</p>
    <div class="people" id="maintainers-list"><span class="muted">loading…</span></div>
  </section>

  <section id="contributors">
    <div class="h2row"><h2>Contributors</h2><a class="more-link" href="/factory">Bring a package →</a></div>
    <p class="sub">Anyone who registered a package or a worker. Their builds are evidence; a maintainer decides.</p>
    <div class="people" id="contributors-list"><span class="muted">loading…</span></div>
  </section>

  <section id="workers">
    <div class="h2row"><h2>Workers</h2><a class="more-link" href="/docs/workers">Run one →</a></div>
    <p class="sub">The machines that build: the project's (trusted by a maintainer) and contributors' own. <em>Ready</em> means a heartbeat in the last ten minutes and, for a worker that builds or audits, an agent that answered its last probe — a key set is not an agent that works.</p>
    <div class="table-wrap"><table id="workers-table"><thead><tr><th>Worker</th><th>Arch</th><th>Side</th><th>Owner</th><th>Agent</th><th>Ready</th><th>Now</th><th>Last seen</th><th>Done / failed</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 4);
  Promise.all([
    busy(fetch("/api/v1/factory/groups")).then(function (r) { return r.json(); }).catch(function () { return { groups: [] }; }),
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
    busy(fetch("/api/v1/factory")).then(function (r) { return r.json(); }).catch(function () { return { workers: [] }; })
  ]).then(function (res) {
    var groups = res[0].groups || [], pkgs = res[1].packages || [], workers = res[2].workers || [];
    // Maintainers: per login, the groups they maintain.
    var maint = {};
    groups.forEach(function (g) { (g.maintainers || []).forEach(function (m) { (maint[m] = maint[m] || []).push(g.name); }); });
    // Contributors: per login, packages registered and workers run — a maintainer is listed once, above.
    var contrib = {};
    pkgs.forEach(function (p) { if (p.owner && !maint[p.owner]) { var c = contrib[p.owner] = contrib[p.owner] || { packages: 0, landed: 0, workers: 0 }; c.packages++; if (p.status === "approved" || p.status === "published") c.landed++; } });
    workers.forEach(function (w) { if (w.owner && !maint[w.owner]) { var c = contrib[w.owner] = contrib[w.owner] || { packages: 0, landed: 0, workers: 0 }; c.workers++; } });
    var online = workers.filter(function (w) { return w.alive; }), ready = workers.filter(function (w) { return w.ready; });
    setTiles("#tiles", [
      ["Maintainers", num(Object.keys(maint).length), groups.length + " group" + (groups.length === 1 ? "" : "s")],
      ["Contributors", num(Object.keys(contrib).length), num(pkgs.length) + " packages requested"],
      ["Workers ready", num(ready.length), num(online.length) + " online · " + num(workers.length) + " registered · " + num(ready.filter(function (w) { return w.side === "omarchy"; }).length) + " the project's", ready.length < online.length ? "warn" : ""],
      ["Community packages", num(pkgs.filter(function (p) { return p.status === "approved" || p.status === "published"; }).length), "approved by a maintainer, built by the project"]
    ]);
    $("#maintainers-list").innerHTML = Object.keys(maint).sort().map(function (m) { return personChip(m, "maintainer", esc(maint[m].join(", "))); }).join("") || '<span class="muted">none yet</span>';
    $("#contributors-list").innerHTML = Object.keys(contrib).sort().map(function (c) {
      var x = contrib[c], bits = [];
      if (x.packages) bits.push(x.packages + " package" + (x.packages === 1 ? "" : "s") + (x.landed ? " · " + x.landed + " landed" : ""));
      if (x.workers) bits.push(x.workers + " worker" + (x.workers === 1 ? "" : "s"));
      return personChip(c, "contributor", esc(bits.join(" · ")));
    }).join("") || '<span class="muted">be the first — <a href="/factory">bring a package</a></span>';
    // Ready means: alive, and — for a worker that builds or audits — an
    // agent that answered the last probe. A key set is not an agent that
    // works; a worker whose agent is down is shown, and gets no agent work.
    var tb = $("#workers-table tbody");
    tb.innerHTML = workers.map(function (w) {
      var where = w.labels && w.labels.where ? ' <span class="dim">· ' + esc(String(w.labels.where)) + '</span>' : '';
      var kinds = w.kinds || [], needsAgent = kinds.indexOf("audit") >= 0 || (kinds.indexOf("build") >= 0 && w.side !== "omarchy");
      var agent = !w.agent ? '<span class="dim">none</span>' : '<span class="mono" style="font-size:12px">' + esc(w.agent) + '</span>' +
        (w.agent_status === "ok" ? ' <span class="pill ok" title="answered the probe ' + esc(w.agent_checked_at ? ago(w.agent_checked_at) : "") + '">answers</span>' :
         w.agent_status === "error" ? ' <span class="pill error" title="' + esc(w.agent_error || "") + '">not answering</span>' : ' <span class="pill none">not probed</span>');
      var readyCell = !w.alive ? '<span class="pill none">offline</span>' : w.ready ? '<span class="pill ok">ready</span>' : '<span class="pill error" title="' + esc(w.agent_error || (needsAgent ? "builds and audits need an agent that answers" : "")) + '">not ready</span>';
      var now = !w.alive ? '<span class="dim">—</span>' : w.current_task ? '<span class="pill warn">building #' + esc(String(w.current_task)) + '</span>' : '<span class="dim">idle · ' + esc(kinds.length ? kinds.join(", ") : (w.side === "omarchy" ? "jobs" : "builds")) + '</span>';
      return '<tr><td><span class="mono">' + esc(w.id) + '</span>' + where + '</td><td>' + esc(w.arch) + '</td><td>' + (w.side === "omarchy" ? '<span class="pill ok">project</span>' : '<span class="pill none">community</span>') + '</td>' +
        '<td>' + (w.owner ? '<a href="/user/' + encodeURIComponent(w.owner) + '">' + esc(w.owner) + '</a>' : '<span class="dim">—</span>') + '</td>' +
        '<td>' + agent + '</td><td>' + readyCell + '</td><td>' + now + '</td>' +
        '<td class="dim">' + ago(w.last_seen) + '</td><td class="num">' + num(w.builds_done || 0) + ' / ' + num(w.builds_failed || 0) + '</td></tr>';
    }).join("") || '<tr><td colspan="9" class="muted">no worker registered yet</td></tr>';
  });
`;

export function peopleHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "People · omarchy-pool",
    description: "The maintainers, contributors and workers of the Omarchy pool — everyone on the record.",
    active: "pool",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
