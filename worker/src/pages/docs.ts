/**
 * Documentation: one interactive hub. Chapters in a sidebar, a search that
 * crosses them all, and a widget per chapter that answers the usual question
 * before a paragraph is read — which ring, which run command, which stage,
 * which role, which feed, which endpoint. Every chapter links to its full
 * page (layout.ts DOCS), which stays as it is.
 */
import { page } from "./layout";
import { ringsDiagram, type Stage } from "./diagrams";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const IMG = "ghcr.io/firemanxbr/omarchy-worker";
const STAGES: Stage[] = ["sync", "pin", "promote", "render", "serve"];

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Documentation</p>
    <h1>Everything that left the three pages, one search away</h1>
    <p class="lede">Pick a chapter or type what you are looking for. Each chapter answers its usual question first and links to the full text. The deeper material — architecture, runbook, testing, migration — lives in the repository's <a href="${REPO_URL}/tree/main/docs"><code>docs/</code></a>.</p>
  </div>
  <div class="docs">
    <aside class="docs-side">
      <input type="search" id="docs-q" placeholder="search the docs…" aria-label="search the docs" autocomplete="off">
      <nav class="docs-nav" id="docs-nav" aria-label="Chapters"></nav>
      <div class="docs-hint">Packages, Security, Status, Journal, Review and the API are pages of their own — linked from the footer.</div>
    </aside>
    <div class="docs-main" id="docs-main"></div>
  </div>
  <div hidden id="stage-art">${STAGES.map((s) => `<div data-stage="${s}">${ringsDiagram(s)}</div>`).join("")}</div>
`;

const SCRIPT = String.raw`
  var REPO = "${REPO_URL}", IMG = "${IMG}";
  var CHAPTERS = [
    { key: "get-started", label: "Get started", href: "/docs/get-started", secs: [["which-ring", "Which ring is for me?", "stable for a machine you rely on, rc to see problems first, edge for CI and throwaway machines"], ["one-command", "The one command", "curl the setup script, pick a ring: the key, the Include line, then pacman -Syu — --ring switches, --remove undoes"], ["three-steps", "By hand, three steps", "trust the database key, add the Server lines, pacman -Syu"], ["cli", "omarchy-cli", "sudo pacman -S omarchy-cli — status, check, upgrade, security; the release tarball until it lands on your ring"], ["switching", "Switching rings, going back", "only the repository names change; a ring rolls back by itself"]] },
    { key: "workers", label: "Run a worker", href: "/docs/workers", secs: [["configure", "Write my run command", "docker or podman, what it builds, an optional agent key"], ["claude-code", "A Claude subscription as the agent", "claude setup-token, Claude Code in print mode, no tools — your subscription, your terms"], ["roles", "The three roles", "pool, review, community — the registration decides, not the image"], ["verify", "Verify the image", "cosign, the certificate identity, the OIDC issuer"]] },
    { key: "how-it-works", label: "How it works", href: "/docs/how-it-works", secs: [["stages", "The five stages", "sync from upstream, pin in edge, promote on evidence, render and verify, serve"], ["trust", "What you trust", "the projects' own keys unchanged, one database key from the pool"]] },
    { key: "governance", label: "Governance", href: "/docs/governance", secs: [["roles", "What each role does", "contributor, maintainer of a group, the project's workers"], ["becoming", "Becoming a maintainer", "contribute first, a maintainer proposes you, another approves — one pull request"], ["record", "The record and the score", "one number per group from what the pool keeps anyway"]] },
    { key: "security", label: "Security", href: "/security", secs: [["feeds", "The five feeds", "Arch Security Tracker, Debian Security Tracker, OSV, CISA KEV, EPSS"], ["confidence", "How sure we are", "exact, name-version, name-only"], ["fast-track", "The fast-track", "a confident advisory with a clean newer version in edge skips the soak"]] },
    { key: "api", label: "API", href: "/api", secs: [["explore", "Endpoint explorer", "public reads, contributor and maintainer writes, what a worker calls"]] },
    { key: "glossary", label: "Glossary", href: "/docs/how-it-works", secs: [["terms", "Terms", "ring, release, head, lease, evidence, staging workspace, soak, fast-track, OPR, ABI check, trust, group, track record"]] }
  ];
  var GLOSS = { ring: "A complete, signed set of pacman databases over the same packages: edge, rc, stable.", release: "One immutable selection of packages for a ring; a ring's history is the list of its releases.", head: "The release a ring serves right now. Pointing the ring at an earlier release is a rollback.", lease: "A worker's claim on a task: it holds the lease while it builds and heartbeats; an expired lease puts the task back in the queue.", evidence: "A contributor's build — PKGBUILD, log, manifest — kept in their staging workspace for a maintainer to read. Never what users install.", "staging workspace": "Where a contributor's builds land: theirs, public, evidence.", soak: "The day a package spends in rc before stable takes it, with health checks on both architectures.", "fast-track": "A confident advisory with a clean newer version already in edge is pulled into rc and stable without waiting for the soak — with the usual health check and rollback.", OPR: "The Omarchy Package Repository: Omarchy's own packages, mirrored as a source.", "ABI check": "Before a promotion: does anything the ring serves load a library whose soname the promotion would change? If so, the promotion is blocked.", trust: "A maintainer's one-time grant that lets a worker run the project's jobs and rebuilds.", group: "A set of packages with its own maintainers, named in factory/MAINTAINERS.toml.", "track record": "One number per group, from what the pool records anyway: what you brought that a maintainer let in, what you built, what you decided." };
  var API = [
    ["GET", "/api/v1/stats", "public", "Everything the dashboard shows: rings, coverage, events, releases, pool size, the series behind the charts."],
    ["GET", "/api/v1/status", "public", "Is the API, the index and the pool answering, and how fast — what online in the header means."],
    ["GET", "/api/v1/search?q=&ring=", "public", "Packages by name or description, in a ring."],
    ["GET", "/api/v1/package/:name?ring=&arch=", "public", "One package: versions per ring, what it depends on, what loads it, who made it, the seal."],
    ["GET", "/api/v1/packages/:sha256/provenance", "public", "The seal of one object: where it came from and the proof, as JSON."],
    ["GET", "/api/v1/security?ring=&arch=", "public", "Open advisories matched against what the ring serves, with confidence, exposure and fixed-in."],
    ["GET", "/api/v1/releases/:ring/history", "public", "The ring's releases, newest first, with parent and from."],
    ["GET", "/api/v1/releases/:ring/diff?from=&to=", "public", "What a release changed against another: added, removed, upgraded."],
    ["GET", "/api/v1/events?limit=&kind=", "public", "The journal."],
    ["GET", "/api/v1/users/:login", "public", "A contributor's or maintainer's public record."],
    ["GET", "/api/v1/factory", "public", "The factory: workers, tasks, requests, counts."],
    ["GET", "/api/v1/factory/{packages,review,approvals,groups,trust}", "public", "The registry, what is staged for review, every decision, the groups and their maintainers, the trusted workers."],
    ["GET", "/api/v1/cost", "public", "The month's estimated Cloudflare bill against the guard and the cap."],
    ["POST", "/api/v1/factory/register", "contributor", "Sign in once with a GitHub token that has no permissions; a contributor token comes back."],
    ["POST", "/api/v1/factory/packages", "contributor", "Request a package: the project's URL (a GitHub repository or release tarball; a home page plus source and version otherwise), name, one-line description, SPDX licence, architectures, and the checklist confirmed. Written once to the record (factory/<name>/<id>/request.json in the pool bucket, signed)."],
    ["POST", "/api/v1/factory/packages/:name/build", "contributor", "Queue a build of a requested package for its architectures."],
    ["POST", "/api/v1/factory/workers", "contributor", "Register a worker; its token comes back once."],
    ["POST", "/api/v1/factory/token", "contributor", "A new contributor token for scripts; it replaces the previous one."],
    ["POST", "/api/v1/factory/claim", "worker", "Claim the next task of the worker's architecture and role; a lease and a per-job token come back."],
    ["POST", "/api/v1/factory/tasks/:id/heartbeat", "worker", "Keep the lease while building."],
    ["POST", "/api/v1/factory/tasks/:id/complete", "worker", "Report the build with its evidence, or the published object for a project build."],
    ["POST", "/api/v1/factory/tasks/:id/fail", "worker", "Report a failed attempt; after three the task is marked failed."],
    ["POST", "/api/v1/factory/tasks/:id/approve", "maintainer", "Approve a staged build — never your own. The decision is recorded and nothing is copied: the project builds the recipe a maintainer merges into factory/pkgbuilds."],
    ["POST", "/api/v1/factory/tasks/:id/reject", "maintainer", "Send it back with a note the contributor sees."],
    ["POST", "/api/v1/factory/trust", "maintainer", "Trust a worker for the project's jobs."],
    ["POST", "/api/v1/factory/jobs", "maintainer", "Queue a pool job by hand — a rollback, a re-render."],
    ["POST", "/api/v1/releases", "release", "Create a release for a ring (the promotion job's write)."]
  ];
  var st = { chapter: "get-started", q: "", quiz: {}, stage: "sync", role: "contributor", feed: 0, term: "ring", cli: "status", who: "all", cfg: { rt: "podman", mode: "mine", agent: "none" }, ring: "stable", arch: "x86_64" };
  var CLI_OUT = { status: "$ omarchy-cli --ring stable status\n# what the ring would change on this machine, and the release you are pinned to\nring     stable  release #<seq>\npinned   #<seq-1> on this machine\nupgrade  <n> packages · <size> · no ABI change", check: "$ omarchy-cli check ./some-1.0-1-x86_64.pkg.tar.zst\n# the ABI safety check before an out-of-band install\nlib<x>  <old> → <new>   <n> packages on this machine load it\n         blocked: this install would break <them>", upgrade: "$ omarchy-cli --ring stable upgrade\n# drives pacman and pins the release you are on\n:: pacman -Syu against release #<seq> … done\n:: pinned #<seq>", security: "$ omarchy-cli security\n# what applies to this machine, from the pool's advisories\nstable #<seq> on this machine: <n> packages\n  <n> exploited in the wild      (CISA KEV)\n  <n> medium   … fixed in edge → fast-track" };
  var DESC = { stable: "Recommended. What rc served for a day without a failed check; about two days behind Arch, rolled back automatically if a promotion fails.", rc: "Yesterday's edge, promoted after a real pacman and an ABI check passed on both architectures. For testers.", edge: "What upstream published in the last three hours, signature-verified only. For CI and developers." };
  var STAGE_TEXT = { sync: ["Sync", "every 3 h", "Every upstream repository is read, every new package downloaded and verified against that project's signing key, then stored once on R2. Superseded versions stay until retention runs, so a rollback always has its bytes."], pin: ["Pin", "→ edge", "A sync that changed something makes a new edge release: an immutable list of the exact objects the ring serves. Edge is signature-verified and nothing else — the same packages Arch serves, one to three hours later."], promote: ["Promote", "on evidence", "Yesterday's edge becomes rc only after a real pacman synced it and the ABI check found no soname a promotion would break, on x86_64 and aarch64. What stayed healthy in rc for a day becomes stable. A failed health check rolls the ring back on its own."], render: ["Render & verify", "signed DBs", "Each release is rendered into pacman databases per architecture and signed with the pool's key; a real pacman then syncs them before they are served."], serve: ["Serve", "pacman -Syu", "Static objects behind an edge cache: the databases, the packages, the signatures. One Server line, the ring's name in it."] };
  var ROLES = { contributor: [["register any package, no permission needed", "build on the community's shared workers — a worker of your own is optional, it only speeds things up and helps everyone", "get every build as evidence, publicly", "a public profile and a score per group"], ["ship bytes to users directly", "approve anything, including your own"]], maintainer: [["approve or send back staged builds of their group", "write the project's recipe from the evidence and open the pull request that adds it to factory/pkgbuilds", "trust a worker for the project's jobs", "roll a ring back to an earlier release", "propose a new maintainer — by pull request"], ["use anything a contributor built — not the package, not the PKGBUILD: the project builds what a maintainer wrote", "approve their own package, even as the group's only maintainer", "be named anywhere but factory/MAINTAINERS.toml"]], workers: [["claim tasks of their role and architecture with a lease", "build the recipes on main on a trusted machine", "write the audit when they hold an agent key"], ["build from a contributor's staged artifact", "decide anything — the audit is evidence, never a verdict", "hold the pool's signing key: signing happens in the brain"]] };
  var FEEDS = [["Arch Security Tracker", "Exact matches on Arch's own versions: the tracker knows this distribution's package and version.", "exact"], ["Debian Security Tracker", "The same upstream projects where Arch has no advisory yet; Debian's fixed version compared to ours.", "name-version"], ["OSV", "The Go modules and crates.io crates a statically linked binary embeds — no soname reveals those; the build information does.", "exact"], ["CISA KEV", "What is exploited in the wild right now. A KEV match is fast-tracked whatever its score.", "priority"], ["EPSS", "How likely exploitation is in the next 30 days, per CVE. Orders the list; never hides a match.", "priority"]];
  var GROUPS = null;
  fetch("/api/v1/factory/groups").then(function (r) { return r.json(); }).then(function (d) { GROUPS = d.groups || []; if (st.chapter === "governance") render(); }).catch(function () {});

  function nav() {
    $("#docs-nav").innerHTML = CHAPTERS.map(function (c) { return '<button type="button" data-ch="' + c.key + '" class="' + (c.key === st.chapter && !st.q ? "on" : "") + '"><span>' + c.label + '</span><small>' + c.secs.length + '</small></button>'; }).join("");
    $("#docs-nav").querySelectorAll("button").forEach(function (b) { b.onclick = function () { st.q = ""; $("#docs-q").value = ""; go(b.getAttribute("data-ch")); }; });
  }
  function go(ch, sec) { st.chapter = ch; history.replaceState(null, "", "#" + ch + (sec ? "/" + sec : "")); render(); if (sec) { var t = document.getElementById("sec-" + sec); if (t) t.scrollIntoView(); } }
  function hl(t, q) { if (!q) return esc(t); var i = t.toLowerCase().indexOf(q); return i < 0 ? esc(t) : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length)); }
  function link(c) { return '<p style="margin-top:14px"><a href="' + c.href + '" style="color:var(--green);text-decoration:none">Read the full chapter →</a></p>'; }
  function pick(id, values, current, on) { var el = $("#" + id); if (!el) return; el.innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join(""); el.querySelectorAll("button").forEach(function (b) { b.onclick = function () { on(b.getAttribute("data-v")); }; }); }
  function confFor(ring, arch) {
    var repos = arch === "x86_64" ? ["core", "extra", "multilib", "packages", "factory"] : ["core", "extra", "alarm", "packages", "factory"];
    return '<span class="c"># the exact list for what the ring serves right now is on the Pool page</span>\n' + repos.map(function (r) { return "[<b>omarchy-" + r + "-" + ring + "</b>]\nSigLevel = Required DatabaseRequired\nServer = " + POOL + "/$arch"; }).join("\n\n");
  }
  function render() {
    nav(); var main = $("#docs-main"), q = st.q.trim().toLowerCase();
    if (q) {
      var hits = [];
      CHAPTERS.forEach(function (c) { c.secs.forEach(function (s) { if ((c.label + " " + s[1] + " " + s[2]).toLowerCase().indexOf(q) >= 0) hits.push([c, s]); }); });
      Object.keys(GLOSS).forEach(function (k) { if ((k + " " + GLOSS[k]).toLowerCase().indexOf(q) >= 0) hits.push([CHAPTERS[6], ["terms", k, GLOSS[k]]]); });
      API.forEach(function (e) { if ((e[1] + " " + e[3]).toLowerCase().indexOf(q) >= 0) hits.push([CHAPTERS[5], ["explore", e[0] + " " + e[1], e[3]]]); });
      main.innerHTML = '<h2>' + hits.length + ' result' + (hits.length === 1 ? "" : "s") + ' for “' + esc(st.q) + '”</h2><p>Click one to open its chapter.</p><div class="hits">' + hits.map(function (h) { return '<div class="hit" data-ch="' + h[0].key + '" data-sec="' + h[1][0] + '"><span class="ch">' + esc(h[0].label) + '</span><b>' + hl(h[1][1], q) + '</b><span>' + hl(h[1][2], q) + '</span></div>'; }).join("") + (hits.length ? "" : '<p class="dim">Nothing — try “ring”, “lease”, “cosign”, “fast-track”.</p>') + '</div>';
      main.querySelectorAll(".hit").forEach(function (h) { h.onclick = function () { st.q = ""; $("#docs-q").value = ""; go(h.getAttribute("data-ch"), h.getAttribute("data-sec")); }; });
      return;
    }
    var ch = st.chapter, c = CHAPTERS.filter(function (x) { return x.key === ch; })[0], html = "";
    if (ch === "get-started") {
      var qz = st.quiz, rec = qz.ci ? "edge" : qz.early ? "rc" : "stable";
      html += '<h2>Get started</h2><p>One command, once per machine, on x86_64 or aarch64. No account.</p>' +
        '<div class="doc-sec" id="sec-which-ring"><h3>Which ring is for me?</h3><div class="quiz">' + [["rely", "This machine matters to me — I cannot afford a broken morning."], ["early", "I want to see problems before everyone else does."], ["ci", "This is a CI runner or a throwaway VM."]].map(function (r) { return '<div class="q"><span>' + r[1] + '</span><span class="yn"><button type="button" data-q="' + r[0] + '" data-v="1" class="' + (qz[r[0]] === true ? "on" : "") + '">yes</button><button type="button" data-q="' + r[0] + '" data-v="0" class="' + (qz[r[0]] === false ? "on" : "") + '">no</button></span></div>'; }).join("") + '</div><div class="verdict" style="margin-top:12px"><b style="color:var(--' + rec + ')">' + rec + '</b> — ' + DESC[rec] + '</div></div>' +
        '<div class="doc-sec" id="sec-one-command"><h3>The one command</h3><div class="choice" id="doc-ring"></div><pre style="white-space:pre-wrap" id="doc-setup"></pre><p style="margin-top:10px">It trusts the key that signs the pool\'s databases, writes <code>/etc/pacman.d/omarchy-pool.conf</code> with what the ring serves right now, and adds one <code>Include</code> line to <code>/etc/pacman.conf</code> above <code>[core]</code> — your own repositories keep their place. Then <code>sudo pacman -Syu</code>. <code>--ring rc</code> switches, <code>--remove</code> undoes it. <a href="/setup">Read the script →</a> · <a href="/docs/get-started">Every step, explained →</a></p></div>' +
        '<div class="doc-sec" id="sec-three-steps"><h3>By hand, three steps</h3><div class="choice" id="doc-arch"></div><p><b>1.</b> Trust the database key — it signs the databases and what the factory builds; every other package keeps its upstream signature.</p><pre style="white-space:pre-wrap">curl -O ' + POOL + '/omarchy-staging.pub.asc\nsudo pacman-key --add omarchy-staging.pub.asc &amp;&amp; sudo pacman-key --lsign-key staging@firemanxbr.org</pre><p style="margin-top:10px"><b>2.</b> Add these above <code>[core]</code>/<code>[extra]</code> in <code>/etc/pacman.conf</code>, or in their place:</p><pre style="white-space:pre-wrap" id="doc-conf"></pre><p style="margin-top:10px"><b>3.</b> <code>sudo pacman -Syu</code></p></div>' +
        '<div class="doc-sec" id="sec-cli"><h3>omarchy-cli</h3><p>A thin client that knows about rings and releases — a package of the factory, in every ring: <code>sudo pacman -S omarchy-cli</code>. Not on your ring yet? Binaries for both architectures ship with every <a href="https://github.com/firemanxbr/omarchy-pool/releases">release</a>. Pick a command to see what it says (examples; the live output depends on the machine):</p><div class="tabs">' + Object.keys(CLI_OUT).map(function (k) { return '<button type="button" data-cli="' + k + '" class="' + (st.cli === k ? "on" : "") + '">' + k + '</button>'; }).join("") + '</div><pre>' + esc(CLI_OUT[st.cli]) + '</pre></div>' +
        '<div class="doc-sec" id="sec-switching"><h3>Switching rings, going back</h3><p>Only the repository names change between rings (<code>omarchy-core-stable</code> → <code>omarchy-core-rc</code>); the packages are the same objects. A ring rolls back by itself when a promotion fails its health check — the next <code>pacman -Syu</code> sees the restored release.</p></div>' + link(c);
    } else if (ch === "workers") {
      var cf = st.cfg, env = ["-e OMARCHY_WORKER_TOKEN=<omw_…>"]; if (cf.mode === "shared") env.push("-e WORKER_SHARED=1"); if (cf.mode === "pool" || cf.mode === "review") env.push("-e OMARCHY_WORKER_ROLE=" + cf.mode);
      if (cf.agent === "claude-code") env.push("-e CLAUDE_CODE_OAUTH_TOKEN=<from: claude setup-token>");
      else if (cf.agent !== "none") env.push("-e " + { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", xai: "XAI_API_KEY" }[cf.agent] + "=<your key>");
      var cmd = cf.rt + " run -d --name omarchy-worker --restart unless-stopped \\\n  " + env.join(" \\\n  ") + " \\\n  " + IMG + ":latest";
      html += '<h2>Run a worker</h2><p>One signed image on GitHub Packages. What it does is decided by the registration and the role, not by the image.</p>' +
        '<div class="doc-sec" id="sec-configure"><h3>Write my run command</h3><div class="form" style="margin-bottom:12px"><label>Runtime <select data-cfg="rt"><option value="podman">podman</option><option value="docker">docker</option></select></label><label>It builds <select data-cfg="mode"><option value="mine">my packages only</option><option value="shared">anyone\'s community packages</option><option value="pool">the project\'s pool jobs (trusted)</option><option value="review">the project\'s rebuilds and audits (trusted)</option></select></label><label>Agent key <select data-cfg="agent"><option value="none">none — no drafting, no audit</option><option value="anthropic">Anthropic</option><option value="claude-code">Claude subscription (Claude Code)</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="xai">xAI</option></select></label></div><pre style="white-space:pre-wrap">' + esc(cmd) + '</pre>' +
        '<p style="margin-top:10px">' + (cf.mode === "pool" || cf.mode === "review" ? "A project role needs a maintainer to trust the worker once after it registers. " : cf.mode === "shared" ? "Shared: it takes anyone's community builds when yours are done. " : "Yours: it builds your packages and nothing else. ") + (cf.agent === "none" ? "Without an agent key the worker builds what it is given; a PKGBUILD is drafted by another worker with a key." : "The key never leaves this machine — the pool only learns the model's name.") + ' The token comes from <a href="/factory">the Factory</a> when you register the worker.</p></div>' +
        '<div class="doc-sec" id="sec-claude-code"><h3>A Claude subscription as the agent</h3><p>Instead of an API key, a Claude Pro or Max subscription: on your machine, <code>claude setup-token</code> prints a long-lived token; give it to the worker as <code>CLAUDE_CODE_OAUTH_TOKEN</code>. The worker installs Claude Code at start and runs it in print mode — no tools, no session, the report as JSON — for the drafts and the audits it does for you. Your subscription pays, your rate limits apply (the same five-hour windows as your own use), and your agreement with Anthropic is what allows it: read their consumer terms on automated use before you switch a shared or a project worker to it; an API key is the plain path. Full steps: <a href="/docs/workers#claude-code">Run a worker → A Claude subscription</a>.</p></div>' +
        '<div class="doc-sec" id="sec-roles"><h3>The three roles</h3><div class="table-wrap" style="border:0"><table><thead><tr><th>Role</th><th>Registered by</th><th>Takes</th><th>Needs trust</th></tr></thead><tbody><tr><td><span class="pill ok">pool</span></td><td>a maintainer</td><td>sync, promote, health, security, gc</td><td>yes</td></tr><tr><td><span class="pill blue">review</span></td><td>a maintainer</td><td>rebuilds of approved recipes, audits</td><td>yes</td></tr><tr><td><span class="pill lilac">community</span></td><td>any contributor</td><td>their own builds — or everyone\'s, if shared</td><td>no</td></tr></tbody></table></div></div>' +
        '<div class="doc-sec" id="sec-verify"><h3>Verify the image</h3><pre style="white-space:pre-wrap">cosign verify ' + IMG + ':latest \\\n  --certificate-identity-regexp github.com/firemanxbr/omarchy-pool \\\n  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div>' + link(c);
    } else if (ch === "how-it-works") {
      var t = STAGE_TEXT[st.stage], art = document.querySelector('#stage-art [data-stage="' + st.stage + '"]');
      html += '<h2>How it works</h2><p>Click a stage — the picture lights it up.</p><div class="doc-sec" id="sec-stages"><div class="stepper">' + Object.keys(STAGE_TEXT).map(function (k) { return '<button type="button" data-stage="' + k + '" class="' + (st.stage === k ? "on" : "") + '">' + STAGE_TEXT[k][0] + '<small>' + STAGE_TEXT[k][1] + '</small></button>'; }).join("") + '</div><figure class="diagram">' + (art ? art.innerHTML : "") + '<figcaption><b style="color:var(--text)">' + t[0] + '.</b> ' + t[2] + '</figcaption></figure></div>' +
        '<div class="doc-sec" id="sec-trust"><h3>What you trust</h3><div class="cando"><div><h4>unchanged</h4><ul class="yes"><li>Arch Linux\'s packager keys</li><li>Arch Linux ARM\'s keys</li><li>Omarchy\'s OPR key</li></ul></div><div><h4>one import</h4><ul class="yes"><li>the pool\'s database key — signs the pacman databases</li><li>the same key signs what the factory builds</li></ul></div></div></div>' + link(c);
    } else if (ch === "governance") {
      var rr = ROLES[st.role];
      html += '<h2>Governance</h2><p>Nobody knows better than you how your software should be built. The maintainer learns it from you — and writes the recipe the project builds. Two maintainers at least: nobody approves their own.</p>' +
        '<div class="doc-sec" id="sec-roles"><h3>What each role does</h3><div class="tabs">' + [["contributor", "Contributor"], ["maintainer", "Maintainer of a group"], ["workers", "The project\'s workers"]].map(function (r) { return '<button type="button" data-role="' + r[0] + '" class="' + (st.role === r[0] ? "on" : "") + '">' + r[1] + '</button>'; }).join("") + '</div><div class="cando"><div><h4>does</h4><ul class="yes">' + rr[0].map(function (x) { return "<li>" + x + "</li>"; }).join("") + '</ul></div><div><h4>never</h4><ul class="no">' + rr[1].map(function (x) { return "<li>" + x + "</li>"; }).join("") + '</ul></div></div></div>' +
        '<div class="doc-sec" id="sec-becoming"><h3>Becoming a maintainer</h3><div class="timeline"><div><b>1. Contribute first</b>packages that reached the rings, builds on your worker, a track record in the group</div><div><b>2. A maintainer proposes you</b>a pull request adding you to <code>factory/MAINTAINERS.toml</code>, with the record as the argument</div><div><b>3. Another maintainer approves</b>the merge is the decision; the dashboard reads the file — there is no other way in</div></div>' +
        (GROUPS ? '<div class="table-wrap" style="border:0;margin-top:14px"><table><thead><tr><th>Group</th><th>Maintainers</th><th>What</th></tr></thead><tbody>' + GROUPS.map(function (g) { return '<tr><td><b>' + esc(g.name) + '</b></td><td>' + (g.maintainers || []).map(function (m) { return avatar(m, "maintainer") + ' <a class="run" href="/user/' + encodeURIComponent(m) + '">' + esc(m) + '</a>'; }).join(" &nbsp; ") + '</td><td class="muted">' + esc(g.description || "") + '</td></tr>'; }).join("") + '</tbody></table></div>' : '<p class="dim" style="margin-top:12px">loading the groups…</p>') + '</div>' +
        '<div class="doc-sec" id="sec-record"><h3>The record and the score</h3><p>Everything the pool keeps anyway — what you brought that a maintainer let in, what you built, what you decided — becomes one number per group. It says where the work was done, not who someone is. The formula is on the <a href="/docs/governance">Governance</a> page and on every profile.</p></div>' + link(c);
    } else if (ch === "security") {
      var f = FEEDS[st.feed];
      html += '<h2>Security</h2><p>Public advisories matched against what each ring serves, every three hours. A package with an open advisory also <em>exposes</em> what depends on it.</p>' +
        '<div class="doc-sec" id="sec-feeds"><h3>The five feeds</h3><div class="srcs">' + FEEDS.map(function (x, i) { return '<button type="button" data-feed="' + i + '" class="' + (st.feed === i ? "on" : "") + '">' + x[0] + '</button>'; }).join("") + '</div><p><b style="color:var(--text)">' + f[0] + '.</b> ' + f[1] + ' <span class="pill none">' + f[2] + '</span></p></div>' +
        '<div class="doc-sec" id="sec-confidence"><h3>How sure we are</h3><div class="table-wrap" style="border:0"><table><thead><tr><th>Confidence</th><th>Means</th></tr></thead><tbody><tr><td><span class="pill error">exact</span></td><td>the tracker knows this distribution\'s version, or the build information names the embedded module\'s version</td></tr><tr><td><span class="pill warn">name-version</span></td><td>Debian fixed it in a version newer than ours</td></tr><tr><td><span class="pill none">name-only</span></td><td>still open upstream, no version to compare — possibly affected</td></tr></tbody></table></div></div>' +
        '<div class="doc-sec" id="sec-fast-track"><h3>The fast-track</h3><p>Fixes do not wait for the soak. When <code>edge</code> serves a clean newer version of a package with a confident advisory — medium or worse, or exploited in the wild — the fast-track pulls it into <code>rc</code> and <code>stable</code> with the usual health check and rollback. <code>omarchy-cli security</code> shows what applies to a machine.</p></div>' + '<p style="margin-top:14px"><a href="/security" style="color:var(--green);text-decoration:none">Every advisory, per ring →</a></p>';
    } else if (ch === "api") {
      html += '<h2>API</h2><p>Every endpoint the dashboard and the tools use. Reads are public; writes carry a token — a contributor\'s, a maintainer\'s, a worker\'s, or a job\'s per-task one. The full reference, with request and response shapes, is on <a href="/api">/api</a>.</p><div class="doc-sec" id="sec-explore"><h3>Endpoint explorer</h3><div class="tabs">' + ["all", "public", "contributor", "maintainer", "worker"].map(function (w) { return '<button type="button" data-who="' + w + '" class="' + (st.who === w ? "on" : "") + '">' + w + '</button>'; }).join("") + '</div>' +
        API.filter(function (e) { return st.who === "all" || e[2] === st.who; }).map(function (e) { return '<details class="ep"><summary><span class="m ' + e[0].toLowerCase() + '">' + e[0] + '</span><code>' + esc(e[1]) + '</code><span class="who">' + e[2] + '</span></summary><div class="body"><p>' + esc(e[3]) + '</p><pre>curl ' + (e[0] === "POST" ? "-X POST " : "") + (e[2] !== "public" ? '-H "Authorization: Bearer ' + (e[2] === "worker" ? "omw_…" : "omc_…") + '" ' : "") + location.origin + esc(e[1].replace(/\{[^}]*\}/, "packages")) + '</pre></div></details>'; }).join("") + '</div>';
    } else if (ch === "glossary") {
      html += '<h2>Glossary</h2><p>The words on these pages, one line each.</p><div class="doc-sec" id="sec-terms"><div class="gloss">' + Object.keys(GLOSS).map(function (k) { return '<button type="button" data-term="' + esc(k) + '" class="' + (st.term === k ? "on" : "") + '">' + esc(k) + '</button>'; }).join("") + '</div><p><b style="color:var(--text)">' + esc(st.term) + '.</b> ' + esc(GLOSS[st.term]) + '</p></div>';
    }
    main.innerHTML = html;
    main.querySelectorAll("[data-q]").forEach(function (b) { b.onclick = function () { st.quiz[b.getAttribute("data-q")] = b.getAttribute("data-v") === "1"; render(); }; });
    main.querySelectorAll("[data-cli]").forEach(function (b) { b.onclick = function () { st.cli = b.getAttribute("data-cli"); render(); }; });
    main.querySelectorAll("[data-stage]").forEach(function (b) { b.onclick = function () { st.stage = b.getAttribute("data-stage"); render(); }; });
    main.querySelectorAll("[data-role]").forEach(function (b) { b.onclick = function () { st.role = b.getAttribute("data-role"); render(); }; });
    main.querySelectorAll("[data-feed]").forEach(function (b) { b.onclick = function () { st.feed = Number(b.getAttribute("data-feed")); render(); }; });
    main.querySelectorAll("[data-term]").forEach(function (b) { b.onclick = function () { st.term = b.getAttribute("data-term"); render(); }; });
    main.querySelectorAll("[data-who]").forEach(function (b) { b.onclick = function () { st.who = b.getAttribute("data-who"); render(); }; });
    main.querySelectorAll("[data-cfg]").forEach(function (s) { s.value = st.cfg[s.getAttribute("data-cfg")]; s.onchange = function () { st.cfg[s.getAttribute("data-cfg")] = s.value; render(); }; });
    if (ch === "get-started") { pick("doc-ring", ["stable", "rc", "edge"], st.ring, function (v) { st.ring = v; render(); }); $("#doc-setup").textContent = "curl -fsSL " + location.origin + "/setup | sudo bash -s -- --ring " + st.ring; pick("doc-arch", ["x86_64", "aarch64"], st.arch, function (v) { st.arch = v; render(); }); $("#doc-conf").innerHTML = confFor(st.ring, st.arch); }
  }
  $("#docs-q").oninput = function () { st.q = this.value; render(); };
  var h = location.hash.slice(1).split("/");
  if (CHAPTERS.some(function (c) { return c.key === h[0]; })) st.chapter = h[0];
  render();
  if (h[1]) { var t0 = document.getElementById("sec-" + h[1]); if (t0) t0.scrollIntoView(); }
`;

export function docsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Documentation · omarchy-pool",
    description: "How to use the pool, how to build for it, how it works and who decides what — one search away.",
    active: "docs",
    doc: "index",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

