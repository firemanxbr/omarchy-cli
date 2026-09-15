/**
 * The Pool: the door for Omarchy users. What the pool serves right now, how a
 * package reaches stable (drawn, and moving), which ring to use, the three
 * steps of pacman, coverage, and the people behind it. No account is ever
 * needed here; the details live one link away (Status, Journal, Packages).
 */
import { page } from "./layout";
import { CHARTS } from "./charts";
import { ringsDiagram } from "./diagrams";
import type { RunningVersion } from "../meta";

const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

const BODY = String.raw`
  <div class="hero">
    <p class="eyebrow">For Omarchy users</p>
    <h1>Arch, Arch Linux ARM and Omarchy packages, tested before they reach you</h1>
    <p class="lede">One <code>Server =</code> line. Every package is verified against its project's key, stored once, and promoted through three rings on evidence — a real <code>pacman</code>, an ABI check, a day of health — never on a promise.</p>
    <div class="cta-row">
      <a class="btn" href="#get-started">Get started</a>
      <span class="hint">No account, no sign-up. Just your Omarchy.</span>
    </div>
    <form class="searchbar" action="/packages" method="get" style="margin:6px 0 0">
      <div class="pool-search"><input type="search" name="q" id="pool-q" placeholder="find a package — pacman, ghostty, openssl…" aria-label="find a package">${SEARCH_ICON}</div>
      <button type="submit" class="btn">Search</button>
      <span class="hint">every ring, both architectures</span>
    </form>
  </div>

  <div class="tiles six" id="tiles"></div>

  <section id="how">
    <div class="h2row"><h2>From upstream to your machine</h2><a class="more-link" href="/docs/how-it-works">The full story, stage by stage →</a></div>
    <p class="sub">Same packages, three levels of proof. A ring that fails a health check rolls back on its own.</p>
    <figure class="diagram">${ringsDiagram()}<figcaption>Packages keep the signature of the project that built them; the only key you add signs the databases and what the factory builds.</figcaption></figure>
  </section>

  <section id="rings-section">
    <div class="h2row"><h2>Pick a ring</h2><a class="more-link" href="/docs#get-started/switching">Switching rings, going back →</a></div>
    <p class="sub">Each ring is a complete, signed set of pacman databases over the same packages.</p>
    <div class="rings" id="rings"></div>
  </section>

  <section>
    <h2>Why the pool</h2>
    <p class="sub">Open source, in the open: every decision, build and rollback is on the record.</p>
    <div class="features">
      <div class="feature"><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></div><h3>Verified, then signed</h3><p>Every upstream package checked against its project's own key before it is stored.</p><div class="proof" id="proof-verified">…</div></div>
      <div class="feature"><div class="ic"><svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/><path d="M7 15h10"/></svg></div><h3>Tested before you</h3><p>A real pacman sync and an ABI check on x86_64 and aarch64, then a day in <code>rc</code>.</p><div class="proof" id="proof-tested">…</div></div>
      <div class="feature"><div class="ic"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/></svg></div><h3>Rolls back by itself</h3><p>A promotion that fails its health check is undone before your next <code>pacman -Syu</code>.</p><div class="proof" id="proof-rollback">…</div></div>
      <div class="feature"><div class="ic"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><path d="M15 15c2.5 0 5 1.5 5 4"/></svg></div><h3>Made by the community</h3><p>Packages nobody ships come from contributors' recipes, rebuilt and approved by maintainers. Open source, on GitHub.</p><a href="/factory">Bring a package →</a></div>
    </div>
  </section>

  <section id="get-started">
    <div class="h2row"><h2>Get started</h2><a class="more-link" href="/docs#get-started/which-ring">Which ring is for me? →</a></div>
    <p class="sub">One command, once per machine. <a href="/docs/get-started">What it does, how to switch rings, how to undo it →</a></p>
    <div class="start-grid">
      <div class="step start-cmd">
        <h3>Point pacman at a ring <span class="dim" style="font-size:12px;font-weight:400">x86_64 · aarch64</span></h3>
        <div class="choice" id="pick-ring"></div>
        <p id="ring-desc" style="margin:0 0 12px;font-size:13.5px"></p>
        <pre><span class="copy" data-copy="setup">copy</span><span id="setup-cmd"></span></pre>
        <p style="margin:10px 0 0;font-size:13px">Then <code>sudo pacman -Syu</code>. <a href="/setup">Read the script first →</a></p>
      </div>
      <aside class="cli-card">
        <h3>omarchy-cli <span class="dim" style="font-size:12px;font-weight:400">optional</span></h3>
        <p>Upgrades explained, installs checked, advisories for this machine.</p>
        <pre><span class="copy" data-copy="cli">copy</span><span id="cli-cmd">sudo pacman -S omarchy-cli</span></pre>
        <p style="font-size:13px"><a href="/docs/get-started#cli">status · check · upgrade · security →</a></p>
        <p id="cli-note" class="dim" style="font-size:12px"></p>
      </aside>
    </div>
    <div class="charts three">
      <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div><div class="mini" id="c-pool-mini"></div></div>
      <div class="chart"><h3>Security in stable <span id="sec-when">now</span></h3><div class="sub">open advisories matched against what stable serves</div><div id="c-sec"></div></div>
      <div class="chart"><h3><span class="live"><i></i>machines on the pool</span><span id="mc-days">14 days</span></h3><div class="sub">distinct addresses that fetched a ring database, once a day · no accounts, no cookies</div><div id="mc-spark"><div class="empty loading">Loading</div></div><div class="mini five" id="mc-split"></div><div class="people-row" id="cc-people"><span class="dim">the people, from what the pool recorded…</span></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Coverage</h2><a class="more-link" href="/status">Every source, every number →</a></div>
    <p class="sub">Share of what each upstream serves that edge already pins, on both architectures.</p>
    <div class="coverage-box"><div class="cov" id="c-coverage"></div></div>
  </section>

  <section>
    <h2>Made in the open</h2>
    <p class="sub">The pool is a project, not a service you rent. Everything it does is on the record.</p>
    <div class="tiles four" id="open-stats"></div>
    <div class="open-grid">
      <div class="box feed-box">
        <div class="feed-head"><b>The last things the pipeline did</b><span class="live"><i></i>live · every minute</span></div>
        <div class="feed" id="open-journal"><div class="muted">loading…</div></div>
        <p class="sub" style="margin:10px 0 0"><a href="/journal">Full journal →</a></p>
      </div>
      <div class="box feed-box">
        <div class="feed-head"><b>The rings</b><span class="dim" style="font-size:11.5px;letter-spacing:.06em;text-transform:uppercase">head · last releases</span></div>
        <div class="ring-heads" id="open-heads"></div>
        <div class="feed" id="open-releases"><div class="muted">loading…</div></div>
        <p class="sub" style="margin:10px 0 0"><a href="/journal#releases">Ring history, every release →</a></p>
      </div>
    </div>
    <div class="sponsor compact"><p><b>Help keep it running.</b> Hardware, compute and agent tokens are what the pool needs. Everything it gets shows up on the <a href="/pipeline">Pipeline</a> page — open source, in the open.</p><a class="mail" href="mailto:sponsor@firemanxbr.org">sponsor@firemanxbr.org</a></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 6);
__CHARTS__
  var RING_INFO = {
    stable: { title: "Recommended for daily use", text: "What <b>rc</b> served for a day without a failed check.", lag: "≈ 2 days behind Arch" },
    rc: { title: "For testers", text: "Yesterday's <b>edge</b>, after a real pacman and an ABI check on both architectures.", lag: "≈ 1 day behind Arch" },
    edge: { title: "For CI and developers", text: "What upstream published in the last three hours, signature-verified.", lag: "≤ 3 hours behind Arch" }
  };
  var DESC = {
    stable: "Recommended. What rc served for a day without a failed check — about two days behind Arch.",
    rc: "Yesterday's edge, after a real pacman and an ABI check on both architectures. For testers.",
    edge: "What upstream published in the last three hours, signature-verified. For CI and developers."
  };
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var data = null, optional = {};
  function pick(id, values, current, onpick) {
    $("#" + id).innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join("");
    $("#" + id).querySelectorAll("button").forEach(function (b) { b.onclick = function () { onpick(b.getAttribute("data-v")); }; });
  }
  // The pacman configuration, generated from what the ring serves right now (the same as /docs/get-started).
  function drawStart() {
    pick("pick-ring", RINGS, ring, function (v) { ring = v; drawStart(); });
    $("#ring-desc").textContent = DESC[ring];
    $("#setup-cmd").innerHTML = 'curl -fsSL ' + location.origin + '/setup | sudo bash -s -- --ring ' + ring;
    $("#cli-cmd").innerHTML = 'sudo pacman -S omarchy-cli\nomarchy-cli --ring ' + ring + ' status';
    $("#cli-note").innerHTML = 'Not on your ring yet? <a href="/docs/get-started#cli">The release tarball →</a>';
  }
  document.querySelectorAll(".copy").forEach(function (b) {
    b.onclick = function () {
      var id = { setup: "#setup-cmd", cli: "#cli-cmd" }[b.getAttribute("data-copy")];
      navigator.clipboard.writeText($(id).textContent).then(function () { b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1500); });
    };
  });
  drawStart();

  function render(d) {
    data = d;
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0] || {};
    var byArch = function (r, arch) { return (r.sources || []).filter(function (s) { return s.arch === arch; }).reduce(function (n, s) { return n + s.packages; }, 0); };
    var lastSync = latest(d.events, "sync");
    var synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sh = latest(d.latest, "health", "stable", "x86_64"), sha = latest(d.latest, "health", "stable", "aarch64");
    // The audience (audience.ts): yesterday's distinct addresses that fetched a ring database — no accounts, no cookies, nothing kept per request.
    var aud = d.audience || [], y = aud.length ? aud[aud.length - 1] : null;
    setTiles("#tiles", [
      ["Packages in stable", num(stable.package_count), num(byArch(stable, "x86_64")) + " x86_64 · " + num(byArch(stable, "aarch64")) + " aarch64"],
      ["Stable release", stable.release ? "#" + stable.release.seq : "—", stable.release ? ago(stable.release.created_at) + " · health " + (sh ? sh.status : "n/a") + " / " + (sha ? sha.status : "n/a") : "no release yet"],
      ["Sources mirrored", synced + " / " + expected, "Arch · Arch Linux ARM · Omarchy · Asahi"],
      ["Open advisories in stable", '<span id="t-sec">…</span>', '<span id="t-sec-s">matching the five feeds…</span>'],
      ["Machines on the pool", y ? "≈ " + num(y.machines) + (y.machines >= 10000 ? "+" : "") : "—", y ? "yesterday · " + ["stable", "rc", "edge"].map(function (r) { return r + " " + num((y.by_ring || {})[r] || 0); }).join(" · ") + " · " + num(y.requests) + " fetches" : "counted once a day"],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : "waiting for the first run"]
    ]);
    drawStart();

    $("#rings").innerHTML = RINGS.map(function (name) {
      var r = d.rings.filter(function (x) { return x.ring === name; })[0] || { ring: name, sources: [], artifacts: [] };
      var rel = r.release, info = RING_INFO[name];
      var health = ARCHES.map(function (a) { var h = latest(d.latest, "health", name, a); return h ? '<span class="pill ' + h.status + '">' + a + ' · ' + h.status + '</span>' : '<span class="pill none">' + a + ' · no check yet</span>'; }).join("");
      return '<div class="ring ' + name + '"><div class="head"><span class="name">' + name + (name === "stable" ? ' <span class="pill rec">recommended</span>' : '') + '</span><span class="rel">' + num(r.package_count) + ' pkgs · ' + bytes(r.bytes) + '</span></div>' +
        '<div class="desc"><b>' + info.title + '.</b> ' + info.text + '</div><div class="health">' + health + '</div>' +
        '<div class="cta"><span class="lag">' + (rel ? 'release #' + rel.seq + ' · ' + ago(rel.created_at) : 'no release yet') + ' · ' + info.lag + '</span><a href="#get-started" data-ring="' + name + '">Use ' + name + ' →</a></div></div>';
    }).join("");
    $("#rings").querySelectorAll("a[data-ring]").forEach(function (a) { a.onclick = function () { ring = a.getAttribute("data-ring"); drawStart(); }; });

    // The proofs under "why": numbers the pool recorded, not claims.
    var rollbacks = (d.events || []).filter(function (e) { return e.kind === "rollback"; });
    $("#proof-verified").innerHTML = '<b>' + num(d.pool.objects) + '</b> objects verified · <b>' + num(d.pool.names || 0) + '</b> package names';
    $("#proof-tested").innerHTML = stable.release ? '<b>' + num(stable.release.seq) + '</b> stable releases so far · health ' + (sh ? sh.status : "n/a") + ' / ' + (sha ? sha.status : "n/a") : 'no stable release yet';
    $("#proof-rollback").innerHTML = rollbacks.length ? 'last rollback <b>' + ago(rollbacks[0].created_at) + '</b> · ' + esc(rollbacks[0].ring || "") + ' · automatic' : 'none in the recent journal — <b>0</b> of the last ' + (d.events || []).length + ' events';

    // Coverage: one row per source, the sources both architectures serve first, so core is core on either side.
    var covBy = {}; (d.coverage || []).filter(function (c) { return !c.optional; }).forEach(function (c) { covBy[c.source] = covBy[c.source] || {}; covBy[c.source][c.arch] = c; });
    var covNames = Object.keys(covBy).sort(function (a, b) { var na = Object.keys(covBy[a]).length, nb = Object.keys(covBy[b]).length; return nb - na || (a < b ? -1 : 1); });
    var covCell = function (c, a) {
      if (!c) return '<div class="bar none" data-tip="not served on ' + a + '"></div><div class="p num dim">—</div>';
      var up = c.upstream_total, pct = up ? Math.min(100, Math.round(1000 * c.indexed / up) / 10) : 0, label = up == null ? "—" : pct + "%";
      return '<div class="bar" data-tip="' + esc(c.source + " " + a + " · " + num(c.indexed) + " of " + num(up || 0) + " · " + label) + '"><i class="' + (pct >= 100 ? "" : "partial") + '" style="width:' + pct + '%"></i></div><div class="p num">' + label + '</div>';
    };
    $("#c-coverage").innerHTML = '<div class="cov-row head"><div></div><div class="k">x86_64</div><div></div><div class="k">aarch64</div><div></div></div>' +
      covNames.map(function (n) { return '<div class="cov-row"><div class="l">' + esc(n) + '</div>' + covCell(covBy[n].x86_64, "x86_64") + covCell(covBy[n].aarch64, "aarch64") + '</div>'; }).join("");
    var S = d.series || {};
    $("#c-pool").innerHTML = area((S.metrics || []).map(function (r) { return { t: Date.parse(r.created_at), v: Number(r.bytes || 0) }; }), bytes, 200);
    var m0 = (S.metrics || [])[0], m1 = (S.metrics || [])[(S.metrics || []).length - 1];
    $("#c-pool-mini").innerHTML = '<div><b>' + num(d.pool.objects) + '</b>objects</div><div><b>' + (m0 && m1 ? "+" + num(Math.max(0, Number(m1.objects) - Number(m0.objects))) : "—") + '</b>this week</div><div><b>' + bytes(d.pool.bytes) + '</b>stored once</div>';

    var fast = (d.events || []).filter(function (e) { return e.kind === "fast-track" && e.status === "ok"; }).slice(0, 3);
    if (!$("#c-sec").innerHTML) $("#c-sec").innerHTML = '<div class="empty loading">Loading</div>';
    busy(fetch("/api/v1/security?ring=stable&arch=x86_64")).then(function (r) { return r.json(); }).then(function (s) {
      var t = s.totals || {};
      $("#sec-when").textContent = s.updated_at ? ago(s.updated_at) : "no scan yet";
      var ts = $("#t-sec"), tss = $("#t-sec-s");
      if (ts) { ts.textContent = num(t.packages || 0); ts.parentElement.classList.toggle("ok", !(t.kev || 0) && !(t.critical || 0) && !(t.high || 0)); ts.parentElement.classList.toggle("warn", !!((t.kev || 0) + (t.critical || 0) + (t.high || 0))); }
      if (tss) tss.textContent = num(t.kev || 0) + " exploited in the wild · " + num((t.critical || 0) + (t.high || 0)) + " high · " + num(t.medium || 0) + " medium" + (s.updated_at ? " · " + ago(s.updated_at) : "");
      var rows = [["exploited in the wild (KEV)", t.kev || 0, "var(--red)"], ["critical + high", (t.critical || 0) + (t.high || 0), "var(--red)"], ["medium", t.medium || 0, "var(--amber)"], ["low / unknown", (t.low || 0) + (t.unknown || 0), "var(--dim)"]];
      var max = Math.max.apply(null, rows.map(function (r) { return r[1]; })) || 1;
      $("#c-sec").innerHTML = hrows(rows.map(function (r) { return [r[0], "", Math.round(100 * r[1] / max), r[2], num(r[1])]; }), 190) +
        (fast.length ? '<div class="mini-list"><div class="k">latest fast-tracks</div>' + fast.map(function (e) { return '<div><span class="dot ok"></span><b>' + esc(e.summary) + '</b> <span class="dim">· ' + ago(e.created_at) + '</span></div>'; }).join("") + '</div>' : '') +
        '<p class="sub" style="margin:10px 0 0;font-size:12px">Arch and Debian trackers, OSV, CISA KEV, EPSS — every three hours. <a href="/pipeline">Watch it happen →</a> · <a href="/security">Every advisory →</a></p>';
    }).catch(function () { $("#c-sec").innerHTML = '<div class="empty">no security data yet</div>'; });

    var m14 = aud.slice(-14);
    $("#mc-spark").innerHTML = m14.length >= 2 ? area(m14.map(function (a) { return { t: Date.parse(a.day + "T12:00:00Z"), v: a.machines }; }), function (v) { return num(Math.round(v)); }) : '<div class="empty">counted once a day — the line needs two days</div>';
    if (y) {
      $("#mc-days").textContent = m14.length + " days" + (y.sampled ? " · sampled" : "");
      $("#mc-split").innerHTML = RINGS.map(function (r) { return '<div><b style="color:var(--' + r + ')">' + num((y.by_ring || {})[r] || 0) + '</b>' + r + '</div>'; }).join("") + ARCHES.map(function (a) { return '<div><b>' + num((y.by_arch || {})[a] || 0) + '</b>' + a + '</div>'; }).join("");
    }
    drawFeed(d.events || []);
    drawRings(d);
  }

  // The rings: what each one serves right now, then the last releases across all three — a promotion, a sync, a rollback each make one.
  function drawRings(d) {
    $("#open-heads").innerHTML = RINGS.map(function (name) {
      var r = d.rings.filter(function (x) { return x.ring === name; })[0] || {}, rel = r.release;
      return '<a href="/diff?ring=' + name + '" class="ring-head"><span class="k" style="color:var(--' + name + ')">' + name + '</span><b>' + (rel ? "#" + rel.seq : "—") + '</b><span class="s">' + (rel ? ago(rel.created_at) + " · " + num(r.package_count) + " pkgs" : "no release yet") + '</span></a>';
    }).join("");
    var rows = (d.releases || []).slice(0, 6);
    $("#open-releases").innerHTML = rows.map(function (r) {
      var what = (r.source_id ? "promoted · " : "") + (r.note || "release " + r.id);
      return '<a class="row" href="/diff?ring=' + esc(r.ring) + '&to=' + r.id + '" title="' + esc(what) + '"><span class="when">' + ago(r.created_at) + '</span><span class="kind"><span style="color:var(--' + esc(r.ring) + ')">' + esc(r.ring) + '</span> #' + r.seq + '</span><span class="what">' + esc(what) + '</span></a>';
    }).join("") || '<div class="muted">no releases yet</div>';
  }

  // The feed: eight lines, the newest on top, each cut at the box's edge with
  // the whole text a click away. The stats poll (once a minute) brings new
  // events; those slide in, the rest stay put.
  var seenEvents = null;
  function drawFeed(events) {
    var rows = events.slice(0, 8), fresh = {};
    if (seenEvents) rows.forEach(function (e) { if (!seenEvents[e.id]) fresh[e.id] = true; });
    $("#open-journal").innerHTML = rows.map(function (e) {
      return '<div class="row' + (fresh[e.id] ? " new" : "") + '" data-id="' + e.id + '" title="' + esc(e.summary) + '"><span class="when">' + ago(e.created_at) + '</span><span class="kind"><span class="dot ' + esc(e.status) + '"></span>' + esc(e.kind) + '</span><span class="what">' + esc(e.summary) + '</span></div>';
    }).join("") || '<div class="muted">nothing yet</div>';
    seenEvents = {}; rows.forEach(function (e) { seenEvents[e.id] = true; });
  }
  $("#open-journal").addEventListener("click", function (ev) { var r = ev.target.closest ? ev.target.closest(".row") : null; if (r) r.classList.toggle("open"); });

  // The people: every contributor with a registered package or a worker, every maintainer named in factory/MAINTAINERS.toml.
  Promise.all([
    fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
    fetch("/api/v1/factory/groups").then(function (r) { return r.json(); }).catch(function () { return { groups: [] }; }),
    fetch("/api/v1/factory").then(function (r) { return r.json(); }).catch(function () { return { workers: [] }; })
  ]).then(function (res) {
    var pkgs = res[0].packages || [], groups = res[1].groups || [], workers = res[2].workers || [];
    var maintainers = {}; groups.forEach(function (g) { (g.maintainers || []).forEach(function (m) { maintainers[m] = true; }); });
    var contributors = {}; pkgs.forEach(function (p) { if (p.owner && !maintainers[p.owner]) contributors[p.owner] = true; });
    workers.forEach(function (w) { if (w.owner && !maintainers[w.owner]) contributors[w.owner] = true; });
    var landed = pkgs.filter(function (p) { return p.status === "approved" || p.status === "published"; }).length;
    var people = Object.keys(maintainers).map(function (m) { return [m, "maintainer"]; }).concat(Object.keys(contributors).map(function (c) { return [c, "contributor"]; }));
    var chips = people.map(function (p) { return personChip(p[0], p[1]); }).join("");
    $("#cc-people").innerHTML = (chips || '<span class="muted">be the first</span>') + '<span class="dim">' + num(workers.filter(function (w) { return w.alive; }).length) + ' workers online</span><a href="/factory">Bring a package →</a>';
    var t = function (href, k, v, s) { return '<a class="tile" href="' + href + '"><div class="k">' + k + '</div><div class="v num">' + v + '</div><div class="s">' + s + '</div></a>'; };
    $("#open-stats").innerHTML =
      t("/people#contributors", "Contributors", num(Object.keys(contributors).length), "anyone with a package or a worker") +
      t("/people#maintainers", "Maintainers", num(Object.keys(maintainers).length), "named in MAINTAINERS.toml") +
      t("/people#workers", "Workers online", num(workers.filter(function (w) { return w.alive; }).length), num(workers.length) + " registered") +
      t("/packages?q=factory", "Community packages", num(landed), "approved, built by the project");
  });
  liveStats(render, 60000);
`;

export function overviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "omarchy-pool",
    description: "One package repository for Omarchy: Arch, Arch Linux ARM and Omarchy packages, verified, served in rings and rolled back automatically.",
    active: "pool",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}
