/**
 * Contribute: the contributor's own page. Sign in with a GitHub identity,
 * register a package, run a worker for it, follow the builds. Everything
 * here is the public API (`/api/v1/factory/*`) called with the contributor
 * token, kept in this browser only.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <h1>Contribute a package</h1>
  <p class="lede">You have something to package for Omarchy. Register it here — no permission needed, nothing spent by the project — then run the project's signed worker image on your own machine: it builds your package and puts the result in your staging workspace, where a maintainer of the group approves it. After that, new upstream releases are built without you. <a href="/how-it-works#factory">How the factory works →</a></p>

  <section id="signin">
    <h2>1. Who you are</h2>
    <p class="sub">A GitHub account is your identity — nothing else is asked. <a class="button" id="oauth-link" href="/auth/github?next=/contribute"><b>Sign in with GitHub →</b></a></p>
    <details id="token-alt"><summary class="sub">Without a browser sign-in (scripts, CI): a GitHub token, used once</summary>
      <p class="sub">Paste a <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token</a> with <b>no permissions</b> (or the output of <code>gh auth token</code>): the pool reads your login with it and never stores it; you get a contributor token for the API, kept in this browser.</p>
      <form class="searchbar" id="signin-form" onsubmit="return false">
        <input type="password" id="gh-token" placeholder="github_pat_… or gho_…" autocomplete="off" style="flex:1;min-width:280px">
        <button type="submit" id="signin-btn">Sign in with a token</button>
      </form>
    </details>
    <p class="sub" id="signin-state"></p>
  </section>

  <div id="signed" hidden>
    <section>
      <h2>2. Register a package</h2>
      <p class="sub">A GitHub repository with releases. The pool refuses names that Arch, Arch Linux ARM or the OPR already ship (install those from the pool), detects the build system and reserves the name for you. If your repository carries a <code>PKGBUILD</code>, say where; otherwise one is drafted on your worker.</p>
      <form id="pkg-form" class="form" onsubmit="return false">
        <label>Project URL <input type="url" id="pkg-url" placeholder="https://github.com/you/project" required></label>
        <label>Package name <input type="text" id="pkg-name" placeholder="(repository name)" pattern="[a-z0-9@._+-]+"></label>
        <label>Group <select id="pkg-group"><option value="community">community</option></select> <span class="sub">who reviews it — <a href="/governance">Governance</a></span></label>
        <label>Architectures <span class="choice"><label><input type="checkbox" id="pkg-x86" checked> x86_64</label> <label><input type="checkbox" id="pkg-arm" checked> aarch64</label></span></label>
        <label>Release tag <input type="text" id="pkg-release" placeholder="(latest)"></label>
        <label>PKGBUILD in your repo <input type="text" id="pkg-path" placeholder="(none — drafted) e.g. packaging/PKGBUILD"></label>
        <button type="submit" id="pkg-btn">Register</button>
      </form>
      <p class="sub" id="pkg-state"></p>
    </section>

    <section>
      <h2>3. Your packages</h2>
      <div class="table-wrap"><table id="my-packages"><thead><tr><th>Package</th><th>Project</th><th>Arches</th><th>Detected</th><th>Stage</th><th>Detail</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>

    <section>
      <h2>4. A worker of yours</h2>
      <p class="sub">Builds happen on your machine, with your resources (and your agent's key, if you want PKGBUILDs drafted and corrected for you — the pool never holds one). Register a worker, then run the signed image with the token it gives you — shown once. It builds <b>your</b> packages; start it with <code>WORKER_SHARED=1</code> to donate it to anyone's.</p>
      <form id="worker-form" class="form" onsubmit="return false">
        <label>Name <input type="text" id="w-name" placeholder="laptop" required></label>
        <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label>
        <button type="submit" id="w-btn">Register worker</button>
      </form>
      <div id="w-new" hidden>
        <p class="sub">Your worker token, shown once. Run one of these wherever the worker lives (podman or docker):</p>
        <pre id="w-cmd"></pre>
        <p class="sub">Each container is one task; <code>restart: unless-stopped</code> (or a loop) gives you the next. Add <code>-e ANTHROPIC_API_KEY=…</code> for an agent-drafted PKGBUILD. Verify the image: <code>cosign verify ghcr.io/firemanxbr/omarchy-packaging:latest --certificate-identity-regexp github.com/firemanxbr/omarchy-pool --certificate-oidc-issuer https://token.actions.githubusercontent.com</code></p>
      </div>
      <div class="table-wrap"><table id="my-workers"><thead><tr><th>Worker</th><th>Arch</th><th>Mode</th><th>Last seen</th><th>Building</th><th>Done / failed</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>

    <section>
      <h2>5. On the command line</h2>
      <p class="sub">Scripts and <code>pkg-repo</code> use a contributor token (<code>Authorization: Bearer omc_…</code>), separate from this browser session. <button type="button" id="cli-token">Generate a token</button> <span class="sub">— shown once; it replaces the previous one, your workers keep theirs.</span></p>
      <pre id="cli-token-out" hidden></pre>
    </section>

    <section>
      <h2>6. Your builds</h2>
      <p class="sub" id="quota"></p>
      <div class="table-wrap"><table id="my-tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Worker</th><th>Took</th><th>Evidence</th><th>Error</th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", REPO = "${REPO_URL}";
  var token = null, login = null;
  try { token = localStorage.getItem("omc_token"); login = localStorage.getItem("omc_login"); } catch (e) {}
  // The cookie from "Sign in with GitHub" authenticates same-origin calls; a
  // token from the fallback form is sent as a bearer header.
  function auth() { var h = { "content-type": "application/json" }; if (token) h["authorization"] = "Bearer " + token; return h; }
  function call(method, path, body) {
    return busy(fetch(API + path, { method: method, headers: auth(), body: body ? JSON.stringify(body) : undefined })).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); });
  }
  function statusPill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", approved: "var(--green)", rejected: "var(--dim)", unmaintained: "var(--dim)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  var role = null, areas = [];
  function showSigned() {
    $("#signin-state").innerHTML = 'Signed in as <b>' + esc(login) + '</b>' + (role ? ' · ' + esc(role) + (areas.length ? ' of ' + esc(areas.join(", ")) : '') : '') + ' · <a href="#" id="signout">sign out</a>' + (role === "maintainer" ? ' · <a href="/review">Review</a>' : '');
    $("#oauth-link").hidden = true; $("#token-alt").hidden = true; $("#signed").hidden = false;
    $("#signout").onclick = function () { try { localStorage.removeItem("omc_token"); localStorage.removeItem("omc_login"); } catch (e) {} location.href = "/auth/logout"; return false; };
    refresh();
  }
  $("#signin-form").onsubmit = function () {
    var gh = $("#gh-token").value.trim(); if (!gh) return false;
    $("#signin-state").textContent = "Asking GitHub who you are…";
    busy(fetch(API + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ github_token: gh }) })).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.token) { $("#signin-state").textContent = d.error || "sign-in failed"; return; }
      token = d.token; login = d.login; try { localStorage.setItem("omc_token", token); localStorage.setItem("omc_login", login); } catch (e) {}
      $("#gh-token").value = ""; showSigned();
    }).catch(function (e) { $("#signin-state").textContent = "sign-in failed: " + e; });
    return false;
  };
  function refresh() {
    skeletonRows("#my-packages", 7, 2); skeletonRows("#my-workers", 7, 1); skeletonRows("#my-tasks", 8, 2);
    call("GET", "/me").then(function (d) {
      if (d.contributor && d.contributor.role && d.contributor.role !== role) { role = d.contributor.role; areas = d.contributor.areas || []; showSigned(); return; }
      if (d.__status === 401) { $("#signin-state").textContent = "Your contributor token is no longer valid; sign in again."; $("#signin-form").hidden = false; $("#signed").hidden = true; endSkeleton(); return; }
      pager("#my-packages", (d.packages || []), function (p) {
        var det = {}; try { det = JSON.parse(p.detected || "{}"); } catch (e) {}
        return '<tr><td><b>' + esc(p.name) + '</b> <span class="src">' + esc(p.group) + '</span></td><td><a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a></td><td>' + esc(JSON.parse(p.arches || "[]").join(", ")) + '</td>' +
          '<td>' + esc([det.build_system, det.license, det.latest_tag].filter(Boolean).join(" · ")) + '</td><td>' + statusPill(p.status) + '</td><td>' + esc(p.detail || "") + '</td>' +
          '<td style="white-space:nowrap"><button type="button" data-build="' + esc(p.name) + '">Build</button> <button type="button" data-remove="' + esc(p.name) + '" title="remove the registration">✕</button></td></tr>';
      }, { empty: 'no package registered yet' });
      pager("#my-workers", (d.workers || []), function (w) {
        var alive = w.last_seen && (Date.now() - Date.parse(w.last_seen)) < 600000;
        return '<tr><td class="mono">' + esc(w.id) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.mode) + (w.packages && w.packages.length ? ' <span class="muted">' + esc(w.packages.join(", ")) + '</span>' : '') + '</td><td>' + ago(w.last_seen) + '</td>' +
          '<td>' + (w.current_task ? '#' + w.current_task : '<span class="muted">idle</span>') + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + (w.revoked_at ? '' : '<button type="button" data-revoke="' + esc(w.id) + '">Revoke</button>') + '</td></tr>';
      }, { empty: 'no worker yet — register one above' });
      pager("#my-tasks", (d.tasks || []), function (t) {
        var ev = t.status === "staged" ? '<a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/build.log">log</a> <a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>' : (t.status === "failed" ? '<a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/build.log">log</a>' : '');
        return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + statusPill(t.status) + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '</span>' : '') + '</td><td class="mono">' + esc(t.lease_owner || "") + '</td><td>' + took(t.duration_ms) + '</td><td>' + ev + '</td><td class="muted">' + esc((t.error || "").slice(0, 100)) + '</td></tr>';
      }, { empty: 'nothing built yet' });
      var st = d.staging || {};
      $("#quota").textContent = "Staging: " + (st.bytes / 1048576).toFixed(1) + " MB of " + (st.quota_bytes / 1073741824).toFixed(0) + " GB used · objects expire after 30 days · a task waits until a worker of its architecture (yours, or a shared one) picks it up.";
      endSkeleton();
    }).catch(function (e) { $("#signin-state").textContent = "could not load your data: " + e; endSkeleton(); });
  }
  $("#pkg-form").onsubmit = function () {
    var arches = []; if ($("#pkg-x86").checked) arches.push("x86_64"); if ($("#pkg-arm").checked) arches.push("aarch64");
    var body = { url: $("#pkg-url").value.trim(), group: $("#pkg-group").value, arches: arches };
    if ($("#pkg-name").value.trim()) body.name = $("#pkg-name").value.trim();
    if ($("#pkg-release").value.trim()) body.release = $("#pkg-release").value.trim();
    if ($("#pkg-path").value.trim()) body.pkgbuild_path = $("#pkg-path").value.trim();
    $("#pkg-btn").disabled = true; $("#pkg-state").textContent = "Checking the pool and the repository…";
    call("POST", "/packages", body).then(function (d) {
      $("#pkg-btn").disabled = false;
      if (d.error) { $("#pkg-state").textContent = d.error; return; }
      var det = {}; try { det = JSON.parse(d.package.detected || "{}"); } catch (e) {}
      $("#pkg-state").innerHTML = '<b>' + esc(d.package.name) + '</b> registered: ' + esc([det.build_system, det.language, det.license, det.latest_tag].filter(Boolean).join(" · ")) + (d.skipped && d.skipped.length ? ' — ' + esc(d.skipped.map(function (s) { return s.arch + " skipped (" + s.source + " ships it)"; }).join(", ")) : '') + '. Press <b>Build</b> below, then run your worker.';
      $("#pkg-form").reset(); refresh();
    }).catch(function (e) { $("#pkg-btn").disabled = false; $("#pkg-state").textContent = "failed: " + e; });
    return false;
  };
  $("#worker-form").onsubmit = function () {
    var body = { name: $("#w-name").value.trim(), arch: $("#w-arch").value };
    $("#w-btn").disabled = true;
    call("POST", "/workers", body).then(function (d) {
      $("#w-btn").disabled = false;
      if (d.error) { $("#pkg-state").textContent = d.error; return; }
      $("#w-new").hidden = false;
      $("#w-cmd").textContent =
        "# one task, then exit (repeat to build the next)\n" +
        "podman run --rm -e WORKER_ID=" + d.worker + " -e OMARCHY_WORKER_TOKEN=" + d.token + " \\\n  ghcr.io/firemanxbr/omarchy-packaging:" + d.arch + "\n\n" +
        "# or keep it running with compose (" + REPO + "/blob/main/factory/image/compose.yml)\n" +
        "WORKER_ID=" + d.worker + " OMARCHY_WORKER_TOKEN=" + d.token + " podman compose -f compose.yml up -d\n\n" +
        "# add WORKER_SHARED=1 to build anyone's packages, ANTHROPIC_API_KEY=… (your key) for agent-drafted PKGBUILDs";
      $("#worker-form").reset(); refresh();
    }).catch(function (e) { $("#w-btn").disabled = false; $("#pkg-state").textContent = "failed: " + e; });
    return false;
  };
  // Buttons inside paged tables: one delegated handler survives re-renders.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) { b.disabled = true; call("POST", "/packages/" + encodeURIComponent(b.getAttribute("data-build")) + "/build", {}).then(function (r) { $("#pkg-state").textContent = r.error || ("queued " + (r.tasks || []).length + " build(s): " + (r.arches || []).join(", ") + " — start your worker if it is not running"); refresh(); }); }
    else if (b.hasAttribute("data-remove")) { if (!confirm("Remove the registration of " + b.getAttribute("data-remove") + "?")) return; call("DELETE", "/packages/" + encodeURIComponent(b.getAttribute("data-remove"))).then(function (r) { $("#pkg-state").textContent = r.error || ("removed " + r.deleted); refresh(); }); }
    else if (b.hasAttribute("data-revoke")) { call("DELETE", "/workers/" + encodeURIComponent(b.getAttribute("data-revoke"))).then(refresh); }
  });
  // The groups a package can register into, from factory/MAINTAINERS.toml.
  fetch(API + "/groups").then(function (r) { return r.json(); }).then(function (d) {
    var sel = $("#pkg-group"); sel.innerHTML = (d.groups || []).map(function (g) { return '<option value="' + esc(g.name) + '"' + (g.name === "community" ? " selected" : "") + '>' + esc(g.name) + ' — ' + esc(g.description) + '</option>'; }).join("") || '<option value="community">community</option>';
  }).catch(function () {});
  $("#cli-token").onclick = function () {
    $("#cli-token").disabled = true;
    call("POST", "/token", {}).then(function (d) { $("#cli-token").disabled = false; if (d.error) { $("#pkg-state").textContent = d.error; return; } $("#cli-token-out").hidden = false; $("#cli-token-out").textContent = "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token + "\n# " + d.note; })
      .catch(function (e) { $("#cli-token").disabled = false; $("#pkg-state").textContent = "failed: " + e; });
  };
  if (token && login) showSigned();
  else whoami(function (me) { if (me) { login = me.login; role = me.role; areas = me.areas || []; showSigned(); } });
  liveStats(function () {}, 120000);
`;

export function contributeHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Contributors · omarchy-pool",
    description: "Register a package, run your own worker, follow your builds to a maintainer's approval.",
    active: "contribute",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
