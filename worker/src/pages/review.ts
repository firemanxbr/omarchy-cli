/**
 * Review: staged community builds waiting for a maintainer. The evidence
 * (log, PKGBUILD, PKGINFO) is public; approving needs a maintainer's
 * contributor token (the same sign-in as /contribute) and queues a project
 * rebuild of the same PKGBUILD — what users get is what the project built.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>Review</h1>
  <p class="lede">What contributors built, waiting for a maintainer. Each row is one build in a contributor's staging workspace: read the PKGBUILD and the log, then <b>approve</b> — the project rebuilds the same PKGBUILD on a trusted worker, signs it and publishes it into <code>edge</code>, where it takes the usual 48-hour path to <code>stable</code> — or <b>reject</b> with a note the contributor sees. Approvals are recorded with your name.</p>
  <p class="sub" id="who"></p>

  <section>
    <h2>Staged builds</h2>
    <div class="table-wrap"><table id="staged"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Project</th><th>Detected</th><th>Built by</th><th>Evidence</th><th>Decision</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Trust</h2>
    <p class="sub">Workers the project trusts to run pool jobs and project builds, and the people who may approve. A maintainer promotes a worker with <code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>; maintainers themselves are named by <code>factory/MAINTAINERS.toml</code> — see <a href="/governance">Governance</a>.</p>
    <div class="table-wrap"><table id="trust"><thead><tr><th>Worker</th><th>Owner</th><th>Arch</th><th>Trust</th><th>Granted by</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
    <div class="table-wrap" style="margin-top:12px"><table id="people"><thead><tr><th>Maintainer</th><th>Role</th><th>Areas</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Decisions</h2>
    <div class="table-wrap"><table id="decisions"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>By</th><th>Note</th><th>Rebuild</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", token = null, login = null;
  try { token = localStorage.getItem("omc_token"); login = localStorage.getItem("omc_login"); } catch (e) {}
  function headers() { var h = { "content-type": "application/json" }; if (token) h["authorization"] = "Bearer " + token; return h; }
  $("#who").innerHTML = 'Read-only until you <a href="/auth/github?next=/review">sign in with GitHub</a>; approving and rejecting need the maintainer role.';
  whoami(function (me) { if (me) { login = me.login; token = token || "cookie"; $("#who").innerHTML = 'Signed in as <b>' + esc(me.login) + '</b> (' + esc(me.role) + (me.areas && me.areas.length ? ' of ' + esc(me.areas.join(", ")) : '') + ')' + (me.role === "contributor" ? ' — approving needs the maintainer role.' : '.'); load(); } });
  function decide(id, what) {
    var note = what === "reject" ? prompt("Why? The contributor sees this.") : (prompt("Note for the record (optional)") || "");
    if (what === "reject" && !note) return;
    busy(fetch(API + "/tasks/" + id + "/" + what, { method: "POST", headers: headers(), body: JSON.stringify({ note: note }) })).then(function (r) { return r.json(); }).then(function (d) {
      alert(d.error ? d.error : (what === "approve" ? "Approved — project rebuild queued as task #" + d.rebuild_task : "Rejected"));
      load();
    });
  }
  function load() {
    skeletonRows("#staged", 8, 3); skeletonRows("#trust", 6, 2); skeletonRows("#people", 4, 1); skeletonRows("#decisions", 7, 2);
    busy(fetch(API + "/review")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#staged", (d.staged || []), function (t) {
        var det = t.detected || {};
        return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b> <span class="src">' + esc(t.group) + '</span>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td>' +
          '<td>' + (t.url ? '<a href="' + esc(t.url) + '">' + esc(t.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a>' : '—') + '</td><td>' + esc([det.build_system, det.license, det.latest_tag].filter(Boolean).join(" · ")) + '</td>' +
          '<td>' + esc(t.owner || "") + ' <span class="muted">' + (t.duration_ms ? Math.round(t.duration_ms / 1000) + " s" : "") + '</span></td>' +
          '<td><a class="run" href="' + t.evidence.pkgbuild + '">PKGBUILD</a> <a class="run" href="' + t.evidence.log + '">log</a> <a class="run" href="' + t.evidence.pkginfo + '">PKGINFO</a> <span class="mono muted">' + esc((t.result_sha256 || "").slice(0, 12)) + '</span></td>' +
          '<td>' + (token ? '<button type="button" data-approve="' + t.id + '">Approve</button> <button type="button" data-reject="' + t.id + '">Reject</button>' : '<span class="muted">sign in</span>') + '</td></tr>';
      }, { empty: 'nothing waiting for review' });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
    busy(fetch(API + "/trust")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#trust", (d.workers || []), function (w) {
        return '<tr><td class="mono">' + esc(w.id) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : '') + '</td><td>' + esc(w.owner || "project") + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.trust) + '</td><td>' + esc(w.trusted_by || "—") + '</td><td>' + ago(w.last_seen) + '</td></tr>';
      }, { empty: 'no trusted worker yet' });
      pager("#people", (d.maintainers || []), function (p) {
        return '<tr><td><b>' + esc(p.login) + '</b>' + (p.name ? ' <span class="muted">' + esc(p.name) + '</span>' : '') + '</td><td>' + esc(p.role) + '</td><td>' + esc((p.areas || []).join(", ") || "all") + '</td><td>' + ago(p.last_seen) + '</td></tr>';
      }, { empty: 'no maintainer named yet' });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
    busy(fetch(API + "/approvals")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#decisions", (d.approvals || []), function (a) {
        return '<tr><td>' + ago(a.created_at) + '</td><td><b>' + esc(a.name) + '</b>' + (a.version ? ' <span class="mono muted">' + esc(a.version) + '</span>' : '') + '</td><td>' + esc(a.arch) + '</td><td>' + esc(a.decision) + '</td><td>' + esc(a.by) + '</td><td>' + esc(a.note || "") + '</td><td>' + (a.rebuild_task ? '#' + a.rebuild_task + ' ' + esc(a.rebuild_status || "") + (a.rebuild_result ? ' <span class="mono">' + esc(a.rebuild_result) + '</span>' : '') : '—') + '</td></tr>';
      }, { empty: 'no decision yet' });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-approve],button[data-reject]") : null; if (!b) return;
    decide(b.getAttribute("data-approve") || b.getAttribute("data-reject"), b.hasAttribute("data-approve") ? "approve" : "reject");
  });
  load();
  liveStats(function () {}, 120000);
`;

export function reviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Review · omarchy-pool",
    description: "Staged contributor builds waiting for a maintainer; trust; the record of decisions.",
    active: "review",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
