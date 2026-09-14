/**
 * The Factory: the door for contributors. How a package gets in (drawn as the
 * assembly line it is), the three ways to bring one, what landed lately —
 * and, signed in, the contributor's own workspace: packages, workers,
 * builds. Everything here is the public API (`/api/v1/factory/*`) called
 * with the contributor token, kept in this browser only.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";
import { GITHUB_ICON } from "./layout";
import { CHARTS } from "./charts";
import { factoryDiagram } from "./diagrams";

const BODY = String.raw`
  <div class="hero">
    <p class="eyebrow">For contributors</p>
    <h1>Package what you love. The factory builds it, a maintainer checks it.</h1>
    <p class="lede">Register a project, build it on your own worker or on the ones the community shares, and a maintainer rebuilds it from <em>your</em> recipe before it enters the rings. A GitHub account is the only thing asked.</p>
    <div class="cta-row" id="signin">
      <a class="btn" id="oauth-link" href="/auth/github?next=/factory">${GITHUB_ICON} Sign in with GitHub</a>
      <a class="btn ghost" href="#ways">Request a package</a>
      <span class="hint">No permission needed. A worker of your own is optional.</span>
    </div>
    <details id="token-alt"><summary class="sub" style="cursor:pointer">Without a browser sign-in (scripts, CI): a GitHub token, used once</summary>
      <p class="sub">Paste a <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token</a> with <b>no permissions</b> (or the output of <code>gh auth token</code>): the pool reads your login with it and never stores it; you get a contributor token for the API, kept in this browser.</p>
      <form class="searchbar" id="signin-form" onsubmit="return false">
        <input type="password" id="gh-token" placeholder="github_pat_… or gho_…" autocomplete="off" style="flex:1;min-width:280px">
        <button type="submit" id="signin-btn" class="btn ghost">Sign in with a token</button>
      </form>
    </details>
    <p class="sub" id="signin-state"></p>
  </div>

  <div class="tiles" id="tiles"></div>

  <section>
    <div class="h2row"><h2>How a package gets in</h2><a class="more-link" href="/docs/governance">Governance: contributors and maintainers →</a></div>
    <p class="sub">Nobody knows better than you how your software should be built. The maintainer learns it from you — and rebuilds it from scratch.</p>
    <figure class="diagram">${factoryDiagram()}<figcaption>Your build is evidence, never what users install: the project builds it again from your PKGBUILD, signs it, and your name goes on the record. The agents draft and audit — their keys stay with whoever runs the worker.</figcaption></figure>
  </section>

  <section id="ways">
    <h2>Three ways to bring one</h2>
    <p class="sub">Pick the one that matches how much you want to do.</p>
    <div class="ways">
      <div class="way"><div class="tag"><span>Request</span><span>no account</span></div><h3>Just ask for it</h3><p>A project URL is enough. The factory drafts the PKGBUILD, builds it as a dry run on both architectures and opens a pull request for a maintainer.</p><div class="go"><a class="btn ghost" href="${REPO_URL}/issues/new?template=package-request.yml">Request a package</a></div></div>
      <div class="way"><div class="tag"><span>Recipe</span><span>GitHub sign-in</span></div><h3>Bring your PKGBUILD</h3><p>Register the repository and say where the PKGBUILD lives. Shared workers build it; you follow the builds and the review here.</p><div class="go"><a class="btn ghost" href="/auth/github?next=/factory">Register a package</a></div></div>
      <div class="way"><div class="tag"><span>Worker</span><span>optional</span></div><h3>Bring a worker</h3><p>You never need one — the shared workers build for everyone. Run the signed image anyway and your builds skip the queue; one flag shares it with the community.</p><div class="go"><a class="btn ghost" href="/docs/workers">Write my run command →</a></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Landed lately</h2><a class="more-link" href="/review">Every decision →</a></div>
    <p class="sub">Contributed by people like you, rebuilt and approved by a maintainer.</p>
    <div class="landed" id="landed"><div class="muted">loading…</div></div>
  </section>

  <section>
    <div class="charts">
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: contributors' builds staged, the project's published, failed</div><div id="c-builds"></div></div>
      <div class="chart"><h3>Decisions <span>per week</span></h3><div class="sub">what maintainers approved and what they sent back</div><div id="c-decisions"></div></div>
    </div>
  </section>

  <div id="signed" hidden>
    <div class="private-head" id="workspace"><span class="lock">private</span><h2>Your workspace</h2><span class="muted" id="ws-who"></span><span class="right"><a class="more-link" href="/pipeline#throughput">Where your builds sit in the queue →</a><a class="more-link" id="ws-profile" href="/factory">Your public profile →</a></span></div>
    <div class="two">
      <div class="panel"><h3>Your packages <button type="button" id="reg-toggle">+ register one</button></h3>
        <form id="pkg-form" class="form" onsubmit="return false" hidden>
          <label>Project URL <input type="url" id="pkg-url" placeholder="https://github.com/you/project" required></label>
          <label>Package name <input type="text" id="pkg-name" placeholder="(repository name)" pattern="[a-z0-9@._+-]+"></label>
          <label>Group <select id="pkg-group"><option value="community">community</option></select></label>
          <label>Architectures <span class="choice"><label><input type="checkbox" id="pkg-x86" checked> x86_64</label> <label><input type="checkbox" id="pkg-arm" checked> aarch64</label></span></label>
          <label>Release tag <input type="text" id="pkg-release" placeholder="(latest)"></label>
          <label>PKGBUILD in your repo <input type="text" id="pkg-path" placeholder="(none — drafted) e.g. packaging/PKGBUILD"></label>
          <button type="submit" id="pkg-btn">Register</button>
        </form>
        <p class="sub" id="pkg-state"></p>
        <div class="table-wrap" style="border:0"><table id="my-packages"><thead><tr><th>Package</th><th>Project</th><th>Arches</th><th>Detected</th><th>Stage</th><th>Detail</th><th></th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="panel"><h3>Your workers <button type="button" id="w-toggle">+ register one</button></h3>
        <p class="sub" style="margin:0 0 10px;font-size:12.5px">Optional: builds happen on the shared workers otherwise. Register one, run the signed image with the token it gives you — shown once — and your builds skip the queue. <code>WORKER_SHARED=1</code> donates it to everyone's. <a href="/docs/workers">Run a worker →</a></p>
        <form id="worker-form" class="form" onsubmit="return false" hidden>
          <label>Name <input type="text" id="w-name" placeholder="laptop" required></label>
          <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label>
          <button type="submit" id="w-btn">Register worker</button>
        </form>
        <div id="w-new" hidden><p class="sub">Your worker token, shown once. Run one of these wherever the worker lives (podman or docker):</p><pre id="w-cmd"></pre></div>
        <div class="table-wrap" style="border:0"><table id="my-workers"><thead><tr><th>Worker</th><th>Arch</th><th>Mode</th><th>Agent</th><th>Last seen</th><th>Building</th><th>Done / failed</th><th></th></tr></thead><tbody></tbody></table></div>
        <p class="sub" style="margin:12px 0 0;font-size:12.5px">Scripts and CI use a contributor token (<code>Authorization: Bearer omc_…</code>): <button type="button" class="small-btn" id="cli-token">Generate a token</button> <span class="dim">shown once; it replaces the previous one, your workers keep theirs</span></p>
        <pre id="cli-token-out" hidden></pre>
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><h3>Your builds <span class="dim" id="quota" style="font-size:12px;font-weight:400"></span></h3>
      <div class="table-wrap" style="border:0"><table id="my-tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Worker</th><th>Took</th><th>Evidence</th><th>Error</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>
`;

const SCRIPT = String.raw`
__CHARTS__
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
    $("#signin-state").innerHTML = 'Signed in as <a href="/user/' + encodeURIComponent(login) + '"><b>' + esc(login) + '</b></a>' + (role ? ' · ' + esc(role) + (areas.length ? ' of ' + esc(areas.join(", ")) : '') : '') + ' · <a href="#" id="signout">sign out</a>' + (role === "maintainer" ? ' · <a href="/review">Review</a>' : '');
    $("#oauth-link").hidden = true; $("#token-alt").hidden = true; $("#signed").hidden = false;
    $("#ws-who").textContent = login + (role ? " · " + role : ""); $("#ws-profile").href = "/user/" + encodeURIComponent(login);
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
    skeletonRows("#my-packages", 7, 2); skeletonRows("#my-workers", 8, 1); skeletonRows("#my-tasks", 8, 2);
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
        return '<tr><td class="mono">' + esc(w.id) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.mode) + (w.packages && w.packages.length ? ' <span class="muted">' + esc(w.packages.join(", ")) + '</span>' : '') + '</td><td>' + agentCell(w) + '</td><td>' + ago(w.last_seen) + '</td>' +
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
        "# keep it running: one task per container, the restart brings the next (docker works the same)\n" +
        "podman run -d --name omarchy-worker --restart unless-stopped -e OMARCHY_WORKER_TOKEN=" + d.token + " \\\n  ghcr.io/firemanxbr/omarchy-worker:latest\n\n" +
        "# or with compose (" + REPO + "/blob/main/factory/image/compose.yml)\n" +
        "OMARCHY_WORKER_TOKEN=" + d.token + " podman compose -f compose.yml up -d\n\n" +
        "# add -e WORKER_SHARED=1 to build anyone's packages; -e ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY: your key) for agent-drafted PKGBUILDs";
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
  $("#reg-toggle").onclick = function () { $("#pkg-form").hidden = !$("#pkg-form").hidden; };
  $("#w-toggle").onclick = function () { $("#worker-form").hidden = !$("#worker-form").hidden; };
  if (token && login) showSigned();
  else whoami(function (me) { if (me) { login = me.login; role = me.role; areas = me.areas || []; showSigned(); } });

  // The public part: tiles, what landed, the charts — all from the factory's own records.
  skeletonTiles("#tiles", 5);
  function publicLoad() {
    Promise.all([
      busy(fetch("/api/v1/factory")).then(function (r) { return r.json(); }),
      fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
      fetch("/api/v1/factory/approvals").then(function (r) { return r.json(); }).catch(function () { return { approvals: [] }; }),
      fetch("/api/v1/factory/review").then(function (r) { return r.json(); }).catch(function () { return { staged: [] }; })
    ]).then(function (res) {
      var f = res[0], pkgs = res[1].packages || [], apps = res[2].approvals || [], staged = res[3].staged || [];
      var shared = f.workers.filter(function (w) { return w.alive && (w.side === "omarchy" || w.mode === "shared"); });
      var owners = {}; pkgs.forEach(function (p) { owners[p.name] = p.owner; });
      var week = Date.now() - 7 * 86400000;
      var builds7 = f.tasks.filter(function (t) { return t.kind === "build" && Date.parse(t.created_at) > week; });
      var approved = apps.filter(function (a) { return a.decision === "approved"; });
      var waits = staged.map(function (s) { return Date.now() - Date.parse(s.finished_at || s.created_at || 0); }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
      setTiles("#tiles", [
        ["Community packages", num(pkgs.filter(function (p) { return p.status === "approved"; }).length), "approved into the rings, from " + num(Object.keys(pkgs.reduce(function (o, p) { o[p.owner] = 1; return o; }, {})).length) + " contributors"],
        ["Waiting for review", num(staged.length), waits.length ? "oldest " + ago(new Date(Date.now() - waits[waits.length - 1]).toISOString()).replace(" ago", "") : "nothing staged right now", staged.length ? "warn" : ""],
        ["Shared workers online", num(shared.length), num(shared.filter(function (w) { return w.side === "community"; }).length) + " community · " + num(shared.filter(function (w) { return w.side === "omarchy"; }).length) + " project — for everyone", shared.length ? "ok" : ""],
        ["Builds this week", num(builds7.length), num(builds7.filter(function (t) { return t.status === "staged"; }).length) + " staged · " + num(builds7.filter(function (t) { return t.status === "done"; }).length) + " published · " + num(builds7.filter(function (t) { return t.status === "failed"; }).length) + " failed"],
        ["Open requests", num(f.requests.filter(function (r) { return r.status === "requested"; }).length), "a URL each, no account needed"]
      ]);
      document.querySelectorAll('[data-live="shared-online"]').forEach(function (el) { el.textContent = num(shared.length) + " online now"; });
      $("#landed").innerHTML = approved.slice(0, 6).map(function (a) {
        var owner = owners[a.name];
        return '<div class="land">' + (owner ? avatar(owner, "contributor") : '<span class="avatar">?</span>') + '<div class="n"><span>' + esc(a.name) + ' <span class="v">' + esc(a.version || "") + '</span></span><span class="pill ' + (a.rebuild_status === "done" ? "ok" : "blue") + '">' + (a.rebuild_status === "done" ? "in the rings" : "rebuilding") + '</span></div><div class="b">by ' + (owner ? '<a href="/user/' + encodeURIComponent(owner) + '">' + esc(owner) + '</a>' : "—") + ' · approved by <a href="/user/' + encodeURIComponent(a.by) + '">' + esc(a.by) + '</a> · ' + ago(a.created_at) + ' · ' + esc(a.arch) + '</div></div>';
      }).join("") || '<div class="muted">nothing approved yet — <a href="/auth/github?next=/factory">be the first</a></div>';
      // Decisions per week, from the approvals list.
      var weeks = [], now = Date.now(); for (var i = 7; i >= 0; i--) weeks.push(new Date(now - i * 7 * 86400000).toISOString().slice(0, 10));
      var ap = weeks.map(function () { return 0; }), rj = weeks.map(function () { return 0; });
      apps.forEach(function (a) { var t = Date.parse(a.created_at); for (var i = weeks.length - 1; i >= 0; i--) { if (t >= Date.parse(weeks[i])) { if (a.decision === "approved") ap[i]++; else rj[i]++; break; } } });
      $("#c-decisions").innerHTML = stacked(weeks.map(function (w) { return w.slice(5); }), [{ name: "approved", color: C.green, values: ap }, { name: "sent back", color: C.amber, values: rj }], { label: "Decisions per week over eight weeks", full: true, empty: "no decision yet" });
      endSkeleton();
    }).catch(function () { endSkeleton(); });
  }
  publicLoad();
  liveStats(function (d) {
    var bd = (d.series || {}).builds_daily || [], byDay = {};
    bd.forEach(function (r) { var x = byDay[r.day] = byDay[r.day] || { staged: 0, published: 0, failed: 0 }; if (r.status === "staged") x.staged += Number(r.n); else if (r.status === "done") x.published += Number(r.n); else if (r.status === "failed") x.failed += Number(r.n); });
    var days = lastDays(14);
    $("#c-builds").innerHTML = stacked(days, [{ name: "staged", color: C.blue, values: days.map(function (x) { return (byDay[x] || {}).staged || 0; }) }, { name: "published", color: C.green, values: days.map(function (x) { return (byDay[x] || {}).published || 0; }) }, { name: "failed", color: C.red, values: days.map(function (x) { return (byDay[x] || {}).failed || 0; }) }], { label: "Factory builds per day over fourteen days", empty: "no build yet" });
  }, 120000);
`;

export function factoryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Factory · omarchy-pool",
    description: "Bring a package: register it, build it on your worker or the community's, follow it to a maintainer's approval.",
    active: "factory",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}
