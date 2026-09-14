/**
 * Packages: search within a ring, and one package's page — where it is in
 * every ring, what it declares, what its binaries actually load, who depends
 * on it, drawn as a graph — with the file list on demand.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const SEARCH_BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Packages</p>
    <h1>Every package the pool serves, in every ring</h1>
    <p class="lede">Search by name or by words from the description. Open a package for its versions per ring, who made it, the dependency graph, the files and the seal.</p>
  </div>
  <form id="search" class="searchbar" onsubmit="return false">
    <input id="q" type="search" placeholder="package name or words from its description" autofocus autocomplete="off">
    <div class="choice" id="pick-ring"></div>
    <div class="choice" id="pick-arch"></div>
  </form>
  <p class="sub" id="hint">Type at least two characters.</p>
  <div class="table-wrap"><table id="results"><thead><tr><th>Package</th><th>Version</th><th>Source</th><th>By</th><th>Description</th><th class="num">Size</th></tr></thead><tbody></tbody></table></div>
`;

const SEARCH_SCRIPT = String.raw`
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var timer = null, seq = 0, OWNERS = {}, APPROVERS = {};
  // Who made the factory's packages: the contributor who registered it, the maintainer who approved it.
  fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).then(function (d) { (d.packages || []).forEach(function (p) { OWNERS[p.name] = p.owner; }); }).catch(function () {});
  fetch("/api/v1/factory/approvals").then(function (r) { return r.json(); }).then(function (d) { (d.approvals || []).forEach(function (a) { if (a.decision === "approved" && !APPROVERS[a.name]) APPROVERS[a.name] = a.by; }); }).catch(function () {});
  function byCell(p) {
    if (p.source === "factory") { var o = OWNERS[p.name], a = APPROVERS[p.name]; return '<span class="by">' + (o ? avatar(o, "contributor") : "") + (a ? avatar(a, "maintainer") : "") + '</span>' + (!o && !a ? '<span class="dim">the pool</span>' : ""); }
    return '<span class="dim" style="font-size:12px">' + (p.source === "alarm" ? "Arch Linux ARM" : p.source === "packages" ? "Omarchy" : p.source === "chaotic" ? "Chaotic-AUR" : "Arch Linux") + '</span>';
  }
  function pick(id, values, current, onpick) {
    $("#" + id).innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join("");
    $("#" + id).querySelectorAll("button").forEach(function (b) { b.onclick = function () { onpick(b.getAttribute("data-v")); }; });
  }
  function sync() {
    pick("pick-ring", RINGS, ring, function (v) { ring = v; sync(); run(); });
    pick("pick-arch", ARCHES, arch, function (v) { arch = v; sync(); run(); });
    var term = $("#q").value.trim();
    history.replaceState(null, "", "?q=" + encodeURIComponent(term) + "&ring=" + ring + "&arch=" + arch);
  }
  function run() {
    var term = $("#q").value.trim(), my = ++seq;
    if (term.length < 2) { $("#hint").textContent = "Type at least two characters."; pager("#results", [], function () { return ""; }, { empty: "type at least two characters" }); return; }
    $("#hint").textContent = "Searching " + ring + " · " + arch + "…";
    skeletonRows("#results", 5, 5);
    busy(fetch("/api/v1/search?q=" + encodeURIComponent(term) + "&ring=" + ring + "&arch=" + arch + "&limit=100")).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return;
      var rows = d.packages || [];
      $("#hint").textContent = rows.length ? rows.length + (rows.length === 100 ? "+" : "") + " package(s) in " + ring + " · " + arch : "Nothing in " + ring + " · " + arch + " matches “" + term + "”.";
      pager("#results", rows, function (p) {
        return '<tr><td><a class="pkname" href="/package/' + encodeURIComponent(p.name) + '?ring=' + ring + '&arch=' + arch + '" title="open the package page">' + esc(p.name) + ' <span class="go">→</span></a></td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source) + '</span></td><td>' + byCell(p) + '</td><td class="muted">' + esc(p.description || "") + '</td><td class="num">' + bytes(p.size_download) + '</td></tr>';
      }, { empty: "nothing matches", n: 25, text: function (p) { return p.name + " " + (p.description || "") + " " + p.source; } });
    }).catch(function (e) { $("#hint").textContent = "search failed: " + e; endSkeleton(); });
  }
  $("#q").value = q.get("q") || "";
  $("#q").addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { sync(); run(); }, 250); });
  sync(); run();
  liveStats(function () {}, 120000);
`;

const PACKAGE_BODY = String.raw`
  <p class="crumbs"><a href="/packages">Packages</a> / <span id="crumb"></span></p>
  <h1 id="title">…</h1>
  <p class="lede" id="desc"></p>
  <div class="meta" id="meta"></div>
  <p class="sub" id="maint" style="margin-top:6px" hidden></p>

  <section id="who-section">
    <div class="h2row"><h2>Who made it</h2><span class="hint">the work on the record</span></div>
    <div class="who" id="who"><div class="muted">…</div></div>
  </section>

  <section id="seal-section">
    <h2>Provenance <span id="seal-pill"></span></h2>
    <p class="sub">Where this exact object came from, and the proof. A synced package names its upstream project and the keyring its signature was checked against when it entered the pool; a package the factory built carries the whole chain — the contributor's build that was the evidence, the second agent's audit, the maintainer's approval, the project's rebuild — and an <b>attestation</b> next to the object in the pool, signed by the pool's key, that anyone can verify without this page.</p>
    <ul class="plain" id="seal"></ul>
  </section>

  <section id="sec-section">
    <h2>Security <span id="sec-badge"></span></h2>
    <p class="sub">Advisories on this version, and open advisories on what it depends on or loads (direct exposure). Confidence: <b>exact</b> = the tracker knows this distribution's version; <b>name-version</b> = Debian fixed it in a newer version than ours; <b>name-only</b> = still open upstream, possibly affected.</p>
    <div class="charts">
      <div class="chart"><h3>On this package</h3><div id="sec-own"></div></div>
      <div class="chart"><h3>Exposed through</h3><div id="sec-exposed"></div></div>
    </div>
  </section>

  <section>
    <h2>In the rings</h2>
    <p class="sub">The version each ring serves for <span id="arch-label"></span>. Same sha256 means the very same file.</p>
    <div class="table-wrap"><table id="rings"><thead><tr><th>Ring</th><th>Version</th><th>Release</th><th>Source</th><th>sha256</th><th class="num">Size</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Graph</h2>
    <p class="sub">Left: what depends on this package in <span class="ring-name"></span> — <span style="color:var(--blue)">declared</span> in its metadata, or a binary that <span style="color:var(--green)">actually loads</span> one of its libraries. Right: what this package declares and which libraries its own binaries load, each resolved to the package that provides it. Click a node to open it.</p>
    <div class="chart" id="graph-card"><div id="graph"></div><div class="legend"><span><i style="background:var(--blue)"></i>declared dependency</span><span><i style="background:var(--green)"></i>loads a library (soname)</span><span><i style="background:var(--dim)"></i>not provided in this ring (pacman resolves it elsewhere)</span></div></div>
  </section>

  <div class="charts">
    <div class="chart"><h3>Depends on</h3><div id="deps"></div></div>
    <div class="chart"><h3>Libraries it loads</h3><div id="links"></div></div>
    <div class="chart"><h3>Required by <span id="rb-count"></span></h3><div id="rb"></div></div>
    <div class="chart"><h3>Provides</h3><div id="provides"></div></div>
  </div>

  <section id="components-section" hidden>
    <h2>Embedded libraries <span id="components-count" class="muted"></span></h2>
    <p class="sub">What the package's statically linked binaries were built with — Go modules from the binary's build information, crates.io crates when the packager used <code>cargo-auditable</code>. No soname reveals these; the security layer matches advisories against them.</p>
    <div class="table-wrap"><table id="components"><thead><tr><th>Ecosystem</th><th>Name</th><th>Version</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Files <button class="choice-btn" id="load-files">show</button></h2>
    <pre id="files" class="muted">not loaded</pre>
  </section>
`;

const PACKAGE_SCRIPT = String.raw`
  var name = decodeURIComponent(location.pathname.split("/").pop());
  var q = new URLSearchParams(location.search);
  var ring = ["stable", "rc", "edge"].indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ["x86_64", "aarch64"].indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var data = null;
  $("#crumb").textContent = name; $("#title").textContent = name; $("#arch-label").textContent = arch;
  function link(n) { return '<a href="/package/' + encodeURIComponent(n) + '?ring=' + ring + '&arch=' + arch + '">' + esc(n) + '</a>'; }

  function graph(d) {
    var vulnProviders = {};
    ((d.security && d.security.exposed) || []).forEach(function (e) { vulnProviders[e.via] = vulnProviders[e.via] || []; vulnProviders[e.via].push(e.advisory); });
    var left = d.required_by.slice(0, 22), moreLeft = d.required_by.length - left.length;
    var right = {};
    d.depends.forEach(function (x) { var k = x.provider ? x.provider.name : x.name; right[k] = right[k] || { name: k, provided: !!x.provider, declared: false, sonames: [] }; right[k].declared = true; });
    d.links.forEach(function (x) { var k = x.provider ? x.provider.name : x.soname; right[k] = right[k] || { name: k, provided: !!x.provider, declared: false, sonames: [] }; right[k].sonames.push(x.soname); });
    var rightList = Object.keys(right).map(function (k) { return right[k]; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }).slice(0, 22), moreRight = Object.keys(right).length - rightList.length;
    var rows = Math.max(left.length + (moreLeft ? 1 : 0), rightList.length + (moreRight ? 1 : 0), 1), rh = 26, W = 1100, H = Math.max(rows * rh + 20, 120), colW = 300, cx = W / 2;
    var body = '<defs><marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker></defs>';
    function node(x, y, w, n, color, title, sub) {
      var href = '/package/' + encodeURIComponent(n) + '?ring=' + ring + '&arch=' + arch;
      var vuln = vulnProviders[n];
      var badge = vuln ? '<circle cx="' + (x + w - 4) + '" cy="' + (y - 8) + '" r="6" fill="#f7768e"><title>' + esc(vuln.length + " open advisor" + (vuln.length > 1 ? "ies" : "y") + ": " + vuln.map(function (a) { return a.cves.join(","); }).join("; ")) + '</title></circle><text x="' + (x + w - 4) + '" y="' + (y - 5) + '" fill="#0c0e10" font-size="9" text-anchor="middle" font-weight="700">!</text>' : '';
      return '<a href="' + href + '"><rect x="' + x + '" y="' + (y - 10) + '" width="' + w + '" height="21" rx="3" fill="#13141c" stroke="' + (vuln ? "#f7768e" : color) + '"/><text x="' + (x + 8) + '" y="' + (y + 4) + '" fill="#c0caf5" font-size="12">' + esc(n.length > 34 ? n.slice(0, 33) + "…" : n) + '</text>' + (sub ? '<text x="' + (x + w - 8) + '" y="' + (y + 4) + '" fill="#8b93b8" font-size="10" text-anchor="end">' + esc(sub) + '</text>' : '') + '<title>' + esc(title) + '</title></a>' + badge;
    }
    // centre: red when this version itself has an open advisory
    var cy = H / 2, ownOpen = ((d.security && d.security.advisories) || []).filter(function (a) { return a.status === "vulnerable"; }).length;
    body += '<rect x="' + (cx - 90) + '" y="' + (cy - 14) + '" width="180" height="29" rx="3" fill="' + (ownOpen ? "#f7768e" : "#9ece6a") + '"/><text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#0c0e10" font-size="13" font-weight="600">' + esc(d.name) + '</text>';
    left.forEach(function (n, i) {
      var y = 20 + i * rh, color = n.declared ? "#7aa2f7" : "#9ece6a";
      body += '<path d="M' + (20 + colW) + ' ' + y + ' C ' + (cx - 160) + ' ' + y + ', ' + (cx - 160) + ' ' + cy + ', ' + (cx - 92) + ' ' + cy + '" fill="none" stroke="' + color + '" stroke-opacity="0.45" marker-end="url(#m)"/>';
      body += node(20, y, colW, n.name, color, n.name + " " + n.version + (n.declared ? " declares " + d.name : "") + (n.sonames.length ? " · loads " + n.sonames.join(", ") : ""), n.sonames.length ? n.sonames[0] : "depends");
    });
    if (moreLeft > 0) body += '<text x="20" y="' + (20 + left.length * rh + 4) + '" fill="#8b93b8" font-size="11">+ ' + moreLeft + ' more (listed below)</text>';
    rightList.forEach(function (n, i) {
      var y = 20 + i * rh, color = !n.provided ? "#414868" : n.sonames.length ? "#9ece6a" : "#7aa2f7", x = W - 20 - colW;
      body += '<path d="M' + (cx + 92) + ' ' + cy + ' C ' + (cx + 160) + ' ' + cy + ', ' + (cx + 160) + ' ' + y + ', ' + x + ' ' + y + '" fill="none" stroke="' + color + '" stroke-opacity="0.45" marker-end="url(#m)"/>';
      body += node(x, y, colW, n.name, color, (n.provided ? n.name : n.name + " — not in this ring") + (n.declared ? " · declared" : "") + (n.sonames.length ? " · loads " + n.sonames.join(", ") : ""), n.sonames.length ? n.sonames[0] : "declared");
    });
    if (moreRight > 0) body += '<text x="' + (W - 20 - colW) + '" y="' + (20 + rightList.length * rh + 4) + '" fill="#8b93b8" font-size="11">+ ' + moreRight + ' more (listed below)</text>';
    $("#graph").innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" font-family="JetBrains Mono, ui-monospace, monospace" style="min-height:' + Math.min(H, 700) + 'px">' + body + '</svg>';
  }

  function render(d) {
    data = d; ring = d.shown_ring;
    document.querySelectorAll(".ring-name").forEach(function (e) { e.textContent = ring; });
    var m = d.manifest || {}, p = d.package;
    $("#desc").className = "lede"; $("#desc").textContent = m.description || "";
    $("#meta").innerHTML = [
      m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "",
      (m.licenses || []).length ? "license " + esc((m.licenses || []).join(", ")) : "",
      m.pkginfo && m.pkginfo.base && m.pkginfo.base !== d.name ? "base " + link(m.pkginfo.base) : "",
      "source <span class=\"src\">" + esc(p.source) + "</span>",
      p.has_signature ? "upstream signature ✓" : "no upstream signature",
      '<a href="' + esc(d.pool_url) + '">download</a> · <a href="' + esc(d.pool_url) + '.sig">.sig</a>',
      bytes(p.size_download) + " download · " + bytes(p.size_installed) + " installed",
      m.pkginfo && m.pkginfo.builddate ? "built " + new Date(m.pkginfo.builddate * 1000).toISOString().slice(0, 10) : "",
      m.pkginfo && m.pkginfo.packager && p.source !== "factory" ? "packaged by " + esc(m.pkginfo.packager.replace(/<.*>/, "").trim()) : ""
    ].filter(Boolean).map(function (x) { return "<span>" + x + "</span>"; }).join('<span class="sep">·</span>');
    // Who stands behind it: upstream's packager, or — for what the factory
    // built — the contributor who brought it, the group's maintainers and
    // the maintainer who approved it, each with a public page.
    var mt = d.maintenance || {}, f = mt.factory, person = function (l) { return '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>'; };
    if (f) {
      var parts = [];
      if (f.owner) parts.push("brought by " + person(f.owner));
      if (f.maintainers && f.maintainers.length) parts.push("maintained by " + f.maintainers.map(person).join(", ") + (f.group ? ' (<a href="/docs/governance">' + esc(f.group) + '</a>)' : ''));
      if (f.approved_by) parts.push("approved by " + person(f.approved_by) + (f.approved_version ? " at " + esc(f.approved_version) : "") + " " + ago(f.approved_at));
      $("#maint").innerHTML = parts.join(" · ") + ' · <span class="muted">built and signed by the project; the contributor\'s build was the evidence</span>';
    } else if (mt.packager) {
      $("#maint").innerHTML = 'Packaged upstream by ' + esc(mt.packager.replace(/<.*>/, "").trim()) + ' (' + esc(p.source) + '); the pool serves the file as built and signed there.';
    }
    renderWho(d, p);
    renderSeal(d.seal, p);
    // An OPR package: where its recipe comes from — Omarchy's own, or synced from the AUR.
    var pv = d.provenance;
    if (pv) {
      var origin = pv.source === "aur" ? '<span class="pill warn">AUR-synced</span> recipe' + (pv.upstream_commit ? ' tracking <a class="mono" href="' + esc(pv.aur) + '">' + esc(pv.upstream_commit.slice(0, 7)) + '</a>' : '') : pv.source === "local" ? "<span class=\"pill ok\">Omarchy's own</span> recipe" : '<span class="pill none">recipe of unknown origin</span>';
      $("#maint").innerHTML += (($("#maint").innerHTML) ? ' · ' : '') + origin + ' in <a href="' + esc(pv.pkgbuild) + '">omarchy-pkgs</a>' + (pv.pkgbuild_commit ? ', last changed <span class="mono">' + esc(pv.pkgbuild_commit.slice(0, 7)) + '</span> ' + ago(pv.pkgbuild_committed_at) : '') + (pv.release_ring === "fast" ? ' · <span class="muted">built natively for every channel</span>' : '') + (pv.pinned ? ' · <span class="muted">version pinned per release</span>' : '');
    }
    $("#rings tbody").innerHTML = ["stable", "rc", "edge"].map(function (r) {
      var row = (d.rings || []).filter(function (x) { return x.ring === r; })[0];
      if (!row) return '<tr><td>' + r + '</td><td colspan="5" class="muted">not in ' + r + ' for ' + arch + '</td></tr>';
      return '<tr' + (r === ring ? ' style="background:var(--panel-2)"' : '') + '><td>' + r + (r === ring ? ' <span class="pill ok">shown</span>' : ' <a class="run" href="?ring=' + r + '&arch=' + arch + '">show</a>') + '</td><td class="mono">' + esc(row.version) + '</td><td>#' + row.release_seq + '</td><td><span class="src">' + esc(row.source) + '</span></td><td class="mono" title="' + esc(row.sha256) + '">' + esc(row.sha256.slice(0, 16)) + '…</td><td class="num">' + bytes(row.size_download) + '</td></tr>';
    }).join("");
    graph(d);
    renderSecurity(d);
    renderComponents(d);
    $("#deps").innerHTML = d.depends.length ? '<ul class="plain">' + d.depends.map(function (x) { return '<li>' + (x.provider ? link(x.provider.name) + ' <span class="muted">' + esc(x.provider.version) + '</span>' + (x.provider.name !== x.name ? ' <span class="muted">provides ' + esc(x.name) + '</span>' : '') : esc(x.name) + ' <span class="muted">not in this ring</span>') + '</li>'; }).join("") + '</ul>' : '<div class="empty">no declared dependencies</div>';
    $("#links").innerHTML = d.links.length ? '<ul class="plain">' + d.links.map(function (x) { return '<li><span class="mono">' + esc(x.soname) + '</span> <span class="muted">← ' + (x.provider ? link(x.provider.name) : "not in this ring") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">no ELF binaries, or nothing dynamically linked</div>';
    $("#rb-count").textContent = d.required_by.length + (d.required_by.length >= 400 ? "+" : "");
    $("#rb").innerHTML = d.required_by.length ? '<ul class="plain cols">' + d.required_by.map(function (x) { return '<li>' + link(x.name) + ' <span class="muted" title="' + esc(x.sonames.join(", ")) + '">' + (x.declared ? "declared" : "") + (x.declared && x.sonames.length ? " + " : "") + (x.sonames.length ? "loads " + x.sonames.length + " lib" + (x.sonames.length > 1 ? "s" : "") : "") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">nothing in ' + ring + ' depends on it</div>';
    var prov = (m.provides || []).filter(function (x) { return x.split(/[<>=]/)[0] !== d.name; });
    $("#provides").innerHTML = prov.length ? '<ul class="plain cols">' + prov.map(function (x) { return '<li class="mono">' + esc(x) + '</li>'; }).join("") + '</ul>' : '<div class="empty">only itself</div>';
  }

  // Who made it — the people, always: the contributor who brought the recipe, the
  // maintainer who rebuilt and approved it, the agents that drafted and audited;
  // for an upstream package, who packaged it there and that the pool mirrors it as is.
  function renderWho(d, p) {
    var mt = d.maintenance || {}, f = mt.factory, c = (d.seal && d.seal.chain) || {}, cards = [];
    var card = function (av, k, b, s, href) { return (href ? '<a class="whoc" href="' + href + '">' : '<div class="whoc">') + av + '<div><div class="k">' + k + '</div><b>' + b + '</b><span>' + s + '</span></div>' + (href ? '</a>' : '</div>'); };
    if (f) {
      var sb = c.source_build || {};
      cards.push(f.owner ? card(avatar(f.owner, "contributor", "lg"), "contributor", esc(f.owner), "brought the recipe" + (sb.worker ? " · built it on " + esc(sb.worker) : ""), "/user/" + encodeURIComponent(f.owner)) : card('<span class="avatar lg">?</span>', "contributor", "unknown", "registered before the record kept owners"));
      cards.push(f.approved_by ? card(avatar(f.approved_by, "maintainer", "lg"), "maintainer", esc(f.approved_by), "rebuilt it from the recipe on a trusted worker, approved it " + ago(f.approved_at), "/user/" + encodeURIComponent(f.approved_by)) : '<div class="whoc wait"><span class="avatar lg" style="border-color:var(--amber);color:var(--amber)">?</span><div><div class="k">maintainer</div><b>waiting for review</b><span>a maintainer of ' + esc(f.group || "the group") + ' decides' + (f.maintainers && f.maintainers.length ? ": " + f.maintainers.map(esc).join(", ") : "") + '</span></div></div>');
      var au = c.audit;
      cards.push(card('<span class="avatar lg" style="border-color:var(--lilac);color:var(--lilac)">ai</span>', "agents", (sb.agent ? "drafted" : "no draft") + " · " + (au && au.verdict ? "audit " + esc(au.verdict) : au && au.status ? "audit " + esc(au.status) : "no audit"), (sb.agent ? "PKGBUILD drafted on the contributor\'s worker with " + esc(sb.agent) + "; " : "") + (au && au.agent ? "audit written on the review worker with " + esc(au.agent) + " — " : "") + "evidence, never a decision"));
    } else {
      var origin = p.source === "alarm" ? "Arch Linux ARM" : p.source === "packages" ? "Omarchy" : p.source === "chaotic" ? "Chaotic-AUR" : "Arch Linux";
      var who = mt.packager ? esc(mt.packager.replace(/<.*>/, "").trim()) : origin;
      cards.push(card('<span class="avatar lg">' + esc(origin.slice(0, 2)) + '</span>', "packaged by", who, "at " + origin + " — the packager field of .PKGINFO; upstream\'s own signature kept"));
      cards.push(card('<span class="avatar lg" style="border-color:var(--green)">▣</span>', "mirrored by", "the pool", "verified against " + origin + "\'s key, stored once, promoted on evidence — never rebuilt"));
      cards.push(card('<span class="avatar lg" style="border-color:var(--lilac);color:var(--lilac)">ai</span>', "agents", "none", "upstream packages are mirrored as they are; agents only touch the factory"));
    }
    $("#who").innerHTML = cards.join("");
  }
  // The seal: one pill, then the facts — each a link to the evidence it names.
  function renderSeal(seal, p) {
    if (!seal) { $("#seal-pill").innerHTML = ""; $("#seal").innerHTML = '<li class="muted">no seal for this object</li>'; return; }
    var person = function (l) { return '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>'; };
    var items = [];
    if (seal.origin === "factory") {
      $("#seal-pill").innerHTML = '<span class="pill rec">built by the Omarchy Pool</span>';
      var c = seal.chain || {};
      if (c.build) items.push('Rebuilt by the project on <span class="mono">' + esc((c.builder && c.builder.worker) || "a trusted worker") + '</span>' + (c.build.finished_at ? ' ' + ago(c.build.finished_at) : '') + (c.build.duration_ms ? ' in ' + Math.round(c.build.duration_ms / 60000) + ' min' : '') + ' — task #' + c.build.task + (c.build.attempts > 1 ? ' (attempt ' + c.build.attempts + ')' : ''));
      if (c.recipe) items.push('Recipe: ' + (c.recipe.commit ? '<a class="mono" href="' + esc(c.recipe.pkgbuild) + '">' + esc(c.recipe.path) + '</a> at <span class="mono">' + esc(c.recipe.commit.slice(0, 7)) + '</span>' : '<a href="' + esc(c.recipe.pkgbuild || '#') + '">the PKGBUILD</a> the contributor\'s build staged' + (c.recipe.from ? ' (<span class="mono">' + esc(c.recipe.from) + '</span>)' : '')));
      if (c.source_build) items.push('Evidence: build #' + c.source_build.task + (c.source_build.owner ? ' by ' + person(c.source_build.owner) : '') + ' on <span class="mono">' + esc(c.source_build.worker || '?') + '</span>' + (c.source_build.agent ? ' with <span class="mono">' + esc(c.source_build.agent) + '</span>' : '') + ' — <a href="' + esc(c.source_build.evidence.log) + '">log</a>, <a href="' + esc(c.source_build.evidence.pkginfo) + '">.PKGINFO</a>');
      if (c.audit) items.push('Audit: ' + (c.audit.verdict ? '<span class="pill ' + (c.audit.verdict === "pass" ? "ok" : c.audit.verdict === "fail" ? "error" : "warn") + '">' + esc(c.audit.verdict) + '</span> ' + esc(c.audit.summary || '') + (c.audit.agent ? ' <span class="muted">(' + esc(c.audit.agent) + ')</span>' : '') + (c.audit.report ? ' — <a href="' + esc(c.audit.report) + '">report</a>' : '') : '<span class="muted">' + esc(c.audit.status || c.audit.error || 'none') + '</span>'));
      if (c.approval) items.push('Approved by ' + person(c.approval.by) + ' ' + ago(c.approval.at) + (c.approval.note ? ' — “' + esc(c.approval.note) + '”' : ''));
      if (seal.signature) items.push('Signed by the pool, key <span class="mono">' + esc(seal.signature.fingerprint.slice(-16)) + '</span> — <a href="' + esc(seal.signature.object) + '">signature</a>');
      if (seal.attestation) items.push('<b>Attestation</b>: <a href="' + esc(seal.attestation.statement) + '">provenance.json</a>' + (seal.attestation.signature ? ' + <a href="' + esc(seal.attestation.signature) + '">.sig</a> — an in-toto statement about this exact object (sha256 ' + esc(seal.sha256.slice(0, 12)) + '…), the pool\'s detached signature beside it' : ''));
      else items.push('<span class="muted">No attestation yet: written when the project\'s build completes (builds before the seal existed have none).</span>');
    } else {
      $("#seal-pill").innerHTML = '<span class="pill ok">' + esc(seal.seal) + '</span>';
      var u = seal.upstream || {};
      items.push('Imported from <b>' + esc(u.project || seal.origin) + '</b> (repository <span class="mono">' + esc(seal.source) + '</span>) ' + ago(seal.indexed_at) + ', served as built and signed there — the pool never rebuilds upstream packages.');
      items.push(u.verified ? 'Upstream signature verified against the <span class="mono">' + esc(u.keyring) + '</span> keyring when it entered the pool, and served beside the object — <a href="' + esc(u.signature) + '">signature</a>' : '<span class="muted">No upstream signature stored for this object.</span>');
    }
    items.push('Object: <a class="mono" href="' + esc(seal.object) + '">' + esc(seal.filename) + '</a> · sha256 <span class="mono">' + esc(seal.sha256) + '</span> · <a href="/api/v1/packages/' + esc(seal.sha256) + '/provenance">this seal as JSON</a>');
    $("#seal").innerHTML = items.map(function (x) { return '<li>' + x + '</li>'; }).join('');
  }

  function sevPill(s) { var c = { critical: "var(--red)", high: "var(--red)", medium: "var(--amber)", low: "var(--blue)", unknown: "var(--dim)" }[s] || "var(--dim)"; return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + s + '</span>'; }
  function advLine(a) {
    return '<li>' + sevPill(a.severity) + ' <a class="run" href="' + esc(a.url) + '">' + esc(a.cves.join(", ") || a.id) + '</a> <span class="muted">' + esc(a.match) + (a.fixed ? ' · fixed in ' + esc(a.fixed) : '') + (a.kev ? ' · <span style="color:var(--red)">exploited in the wild</span>' : '') + (a.epss != null && a.epss >= 0.1 ? ' · EPSS ' + (a.epss * 100).toFixed(0) + '%' : '') + '</span>' + (a.summary ? '<div class="muted" style="font-size:12.5px">' + esc(a.summary.length > 160 ? a.summary.slice(0, 159) + "…" : a.summary) + '</div>' : '') + '</li>';
  }
  function renderSecurity(d) {
    var s = d.security || { advisories: [], exposed: [] };
    var open = s.advisories.filter(function (a) { return a.status === "vulnerable"; }), fixed = s.advisories.filter(function (a) { return a.status !== "vulnerable"; });
    $("#sec-badge").innerHTML = open.length ? '<span class="pill error">' + open.length + ' open</span>' : (s.exposed.length ? '<span class="pill warn">exposed via ' + s.exposed.length + '</span>' : '<span class="pill ok">no open advisory</span>');
    $("#sec-own").innerHTML = (open.length ? '<ul class="plain">' + open.map(advLine).join("") + '</ul>' : '<div class="empty">no open advisory on ' + esc(d.package.version) + '</div>') +
      (fixed.length ? '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12.5px">' + fixed.length + ' advisor' + (fixed.length > 1 ? "ies" : "y") + ' fixed in this version</summary><ul class="plain">' + fixed.map(advLine).join("") + '</ul></details>' : '');
    $("#sec-exposed").innerHTML = s.exposed.length ? '<ul class="plain">' + s.exposed.map(function (e) {
      return '<li>' + sevPill(e.advisory.severity) + ' ' + link(e.via) + ' <span class="muted">' + (e.declared ? "declared" : "") + (e.declared && e.sonames.length ? " + " : "") + (e.sonames.length ? "loads " + esc(e.sonames.join(", ")) : "") + ' · <a class="run" href="' + esc(e.advisory.url) + '">' + esc(e.advisory.cves.join(", ")) + '</a> · ' + esc(e.advisory.match) + '</span></li>';
    }).join("") + '</ul>' : '<div class="empty">nothing it depends on or loads has an open advisory</div>';
  }

  function renderComponents(d) {
    var c = (d.manifest && d.manifest.components) || []; if (!c.length) return;
    $("#components-section").hidden = false;
    $("#components-count").textContent = "(" + c.length + ")";
    pager("#components", c, function (x) {
      var href = x.ecosystem === "Go" ? "https://pkg.go.dev/" + x.name + "@" + x.version : x.ecosystem === "crates.io" ? "https://crates.io/crates/" + x.name + "/" + x.version : "";
      return '<tr><td>' + esc(x.ecosystem) + '</td><td>' + (href ? '<a href="' + esc(href) + '">' + esc(x.name) + '</a>' : esc(x.name)) + '</td><td class="mono">' + esc(x.version) + '</td></tr>';
    }, { n: 25 });
  }
  $("#load-files").onclick = function () {
    $("#files").textContent = "loading…";
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "/files?ring=" + ring + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      var files = (d.files || []).filter(function (f) { return !/\/$/.test(f); });
      $("#files").className = ""; $("#files").textContent = files.length + " files\n" + files.join("\n");
      $("#load-files").style.display = "none";
    }).catch(function (e) { $("#files").textContent = "failed: " + e; });
  };

  // The index can be busy during a bulk import; a transient 5xx gets retried.
  function loadPackage(attempt) {
    if (attempt === 1) { skeletonRows("#rings", 6, 3); skeletonText("#desc"); ["#graph", "#sec-own", "#sec-exposed"].forEach(function (id) { var el = $(id); if (el && !el.innerHTML.trim()) el.innerHTML = '<div class="empty loading skel">Resolving dependencies and advisories</div>'; }); }
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch)).then(function (r) {
      if (r.status >= 500) throw new Error("index busy (HTTP " + r.status + ")");
      return r.json();
    }).then(function (d) {
      if (d.error) { endSkeleton(); $("#desc").textContent = d.error; $("#graph").innerHTML = ""; $("#who-section").hidden = true; return; }
      render(d); endSkeleton();
    }).catch(function (e) {
      if (attempt < 4) { $("#desc").textContent = "The index is busy (" + e.message + "); retrying…"; setTimeout(function () { loadPackage(attempt + 1); }, 4000 * attempt); }
      else { endSkeleton(); $("#desc").textContent = "Could not load this package right now: " + e.message + ". Reload to try again."; }
    });
  }
  loadPackage(1);
  liveStats(function () {}, 120000);
`;

export function packagesHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Packages · omarchy-pool",
    description: "Search the packages a ring serves; versions per ring, dependencies, what loads them, files.",
    active: "none",
    body: SEARCH_BODY,
    script: SEARCH_SCRIPT,
    poolUrl,
    version,
  });
}

export function packageHtml(name: string, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `${name} · omarchy-pool`,
    description: `${name}: versions per ring, dependencies, what loads it, files.`,
    active: "none",
    body: PACKAGE_BODY,
    script: PACKAGE_SCRIPT,
    poolUrl,
    version,
  });
}
