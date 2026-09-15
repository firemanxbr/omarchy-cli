/**
 * Review: staged community builds waiting for a maintainer. The evidence
 * (log, PKGBUILD, PKGINFO, audit) is public; approving needs a maintainer's
 * contributor token (the same sign-in as /contribute), never the owner's,
 * and copies nothing: the project builds the recipe a maintainer writes
 * from the evidence and merges into factory/pkgbuilds (docs/GOVERNANCE.md).
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Review</p>
    <h1>What contributors built, waiting for a maintainer</h1>
    <p class="lede">Each row is evidence, not a package: read the PKGBUILD, the log, the manifest, the gate's verdict and the audit, then <b>approve</b> or <b>reject</b> with a note the contributor sees. Nothing here is copied: an approval is the decision, and the project builds the recipe a maintainer writes from this evidence and merges into <code>factory/pkgbuilds/&lt;group&gt;/&lt;name&gt;/</code>. Never your own package. <a href="/docs/governance">Governance →</a></p>
  </div>
  <p class="sub" id="who"></p>

  <section>
    <h2>Staged builds</h2>
    <div class="table-wrap"><table id="staged"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Project</th><th>Detected</th><th>Built by</th><th>Evidence</th><th>Gate</th><th>Audit</th><th>Decision</th></tr></thead><tbody></tbody></table></div>
    <p class="sub">The audit column is the second agent (<a href="/docs/governance">Governance</a>): a project worker whose owner set an agent key reads the PKGBUILD, the log and the <code>.PKGINFO</code> and writes a report — supply chain, security, packaging practice, licence. It is evidence for you, never a decision: <span class="pill ok">ok</span> nothing worth a change · <span class="pill warn">warn</span> approve with the findings in mind · <span class="pill error">block</span> do not approve as is. <em>Waiting</em> means no project worker with a key has picked it up yet.</p>
  </section>

  <section>
    <h2>Trust</h2>
    <p class="sub">Workers the project trusts to run pool jobs and project builds, and the people who may approve. A maintainer promotes a worker with <code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>; maintainers themselves are named by <code>factory/MAINTAINERS.toml</code> — see <a href="/docs/governance">Governance</a>.</p>
    <div class="two"><div class="table-wrap"><table id="trust"><thead><tr><th>Worker</th><th>Owner</th><th>Arch</th><th>Trust</th><th>Granted by</th><th>Agent</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
    <div class="table-wrap"><table id="people"><thead><tr><th>Maintainer</th><th>Role</th><th>Areas</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section>
    <h2>Decisions</h2>
    <div class="table-wrap"><table id="decisions"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>By</th><th>Note</th><th>Project build</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", token = null, login = null, signedIn = false;
  try { token = localStorage.getItem("omc_token"); login = localStorage.getItem("omc_login"); } catch (e) {}
  // The sign-in cookie authenticates same-origin calls by itself; a token
  // from the fallback form travels as a bearer header instead.
  function headers() { var h = { "content-type": "application/json" }; if (token && !signedIn) h["authorization"] = "Bearer " + token; return h; }
  $("#who").innerHTML = 'Read-only until you <a href="/auth/github?next=/review">sign in with GitHub</a>; approving and rejecting need the maintainer role.';
  whoami(function (me) { if (me) { login = me.login; signedIn = true; $("#who").innerHTML = 'Signed in as <b>' + esc(me.login) + '</b> (' + esc(me.role) + (me.areas && me.areas.length ? ' of ' + esc(me.areas.join(", ")) : '') + ')' + (me.role === "contributor" ? ' — approving needs the maintainer role.' : '.'); load(); } });
  function person(l) { return l ? '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>' : ''; }
  function decide(id, what) {
    var note = what === "reject" ? prompt("Why? The contributor sees this.") : (prompt("Note for the record (optional)") || "");
    if (what === "reject" && !note) return;
    busy(fetch(API + "/tasks/" + id + "/" + what, { method: "POST", headers: headers(), body: JSON.stringify({ note: note }) })).then(function (r) { return r.json(); }).then(function (d) {
      alert(d.error ? d.error : (what === "approve" ? "Approved. Now the recipe: write " + d.recipe + " from the evidence and open the pull request — the project builds it once it is on main." : "Rejected"));
      load();
    });
  }
  // The second agent's column: its verdict and one line, the report behind it.
  // The gate: the worker's own checks on the build (factory/README.md *The gate*), pass with its warnings named, or none for a build older than the gate.
  function gate(t) {
    var v = t.vet;
    if (!v) return '<span class="dim" title="built before the gate existed">—</span>';
    if (v.verdict === "pass") return '<span class="pill ok">pass</span> <a class="run" href="' + t.evidence.tests + '" title="' + esc((v.warned || []).join(", ")) + '">' + (v.warnings ? v.warnings + ' warning' + (v.warnings === 1 ? '' : 's') : 'clean') + '</a>';
    return '<span class="pill error">' + esc(v.verdict) + '</span> <a class="run" href="' + t.evidence.tests + '">' + esc((v.failed || []).join(", ")) + '</a>';
  }
  function audit(t) {
    var a = t.audit || { status: "none" };
    if (a.status === "done" && a.verdict) {
      var cls = a.verdict === "ok" ? "ok" : a.verdict === "warn" ? "warn" : "error";
      return '<span class="pill ' + cls + '">' + esc(a.verdict) + '</span> <a class="run" href="' + t.evidence.audit + '" title="' + esc(a.summary || "") + '">' + (a.findings ? a.findings + ' finding' + (a.findings === 1 ? '' : 's') + (a.high ? ', ' + a.high + ' high' : '') : 'report') + '</a>';
    }
    if (a.status === "queued") return '<span class="muted">waiting</span>';
    if (a.status === "leased") return '<span class="muted">running</span>';
    if (a.status === "failed") return '<span class="pill none" title="' + esc(a.error || "") + '">failed</span>';
    if (a.status === "done") return '<span class="pill none">unreadable</span>';
    return '<span class="muted">—</span>';
  }
  function load() {
    skeletonRows("#staged", 9, 3); skeletonRows("#trust", 7, 2); skeletonRows("#people", 4, 1); skeletonRows("#decisions", 7, 2);
    busy(fetch(API + "/review")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#staged", (d.staged || []), function (t) {
        var det = t.detected || {};
        return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b> <span class="src">' + esc(t.group) + '</span>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td>' +
          '<td>' + (t.url ? '<a href="' + esc(t.url) + '">' + esc(t.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a>' : '—') + '</td><td>' + esc([det.build_system, det.license, det.latest_tag].filter(Boolean).join(" · ")) + '</td>' +
          '<td>' + person(t.owner) + ' <span class="muted">' + (t.duration_ms ? Math.round(t.duration_ms / 1000) + " s" : "") + '</span></td>' +
          '<td><a class="run" href="' + t.evidence.pkgbuild + '">PKGBUILD</a> <a class="run" href="' + t.evidence.log + '">log</a> <a class="run" href="' + t.evidence.pkginfo + '">PKGINFO</a> <span class="mono muted">' + esc((t.result_sha256 || "").slice(0, 12)) + '</span></td>' +
          '<td>' + gate(t) + '</td><td>' + audit(t) + '</td>' +
          '<td>' + (token || signedIn ? '<button type="button" data-approve="' + t.id + '">Approve</button> <button type="button" data-reject="' + t.id + '">Reject</button>' : '<span class="muted">sign in</span>') + '</td></tr>';
      }, { empty: 'nothing waiting for review' });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
    busy(fetch(API + "/trust")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#trust", (d.workers || []), function (w) {
        return '<tr><td>' + workerName(w) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : '') + '</td><td>' + (w.owner ? person(w.owner) : "project") + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.trust) + '</td><td>' + (w.trusted_by ? person(w.trusted_by) : "—") + '</td><td>' + agentCell(w) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
      }, { empty: 'no trusted worker yet' });
      pager("#people", (d.maintainers || []), function (p) {
        return '<tr><td><b>' + person(p.login) + '</b>' + (p.name ? ' <span class="muted">' + esc(p.name) + '</span>' : '') + '</td><td>' + esc(p.role) + '</td><td>' + esc((p.areas || []).join(", ") || "all") + '</td><td>' + ago(p.last_seen) + '</td></tr>';
      }, { empty: 'no maintainer named yet' });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
    busy(fetch(API + "/approvals")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#decisions", (d.approvals || []), function (a) {
        return '<tr><td>' + ago(a.created_at) + '</td><td><b>' + esc(a.name) + '</b>' + (a.version ? ' <span class="mono muted">' + esc(a.version) + '</span>' : '') + '</td><td>' + esc(a.arch) + '</td><td>' + esc(a.decision) + '</td><td>' + person(a.by) + '</td><td>' + esc(a.note || "") + '</td><td>' + (a.rebuild_task ? '#' + a.rebuild_task + ' ' + esc(a.rebuild_status || "") + (a.rebuild_result ? ' <span class="mono">' + esc(a.rebuild_result) + '</span>' : '') : (a.decision === "approved" ? '<span class="dim">waiting for the recipe on main</span>' : '—')) + '</td></tr>';
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
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
