/**
 * Packages: search within a ring, and one package's page — where it is in
 * every ring, what it declares, what its binaries actually load, who depends
 * on it, drawn as a graph — with the file list on demand.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const SEARCH_BODY = String.raw`
  <h1>Packages</h1>
  <p class="lede">Search what a ring serves by name or description. Every result links to the package's page: versions per ring, dependencies, what loads it, files.</p>
  <form id="search" class="searchbar" onsubmit="return false">
    <input id="q" type="search" placeholder="package name or words from its description" autofocus autocomplete="off">
    <div class="choice" id="pick-ring"></div>
    <div class="choice" id="pick-arch"></div>
  </form>
  <p class="sub" id="hint">Type at least two characters.</p>
  <div class="table-wrap"><table id="results"><thead><tr><th>Package</th><th>Version</th><th>Source</th><th>Description</th><th class="num">Size</th></tr></thead><tbody></tbody></table></div>
`;

const SEARCH_SCRIPT = String.raw`
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var timer = null, seq = 0;
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
    if (term.length < 2) { $("#hint").textContent = "Type at least two characters."; $("#results tbody").innerHTML = ""; return; }
    $("#hint").textContent = "Searching " + ring + " · " + arch + "…";
    fetch("/api/v1/search?q=" + encodeURIComponent(term) + "&ring=" + ring + "&arch=" + arch + "&limit=100").then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return;
      var rows = d.packages || [];
      $("#hint").textContent = rows.length ? rows.length + (rows.length === 100 ? "+" : "") + " package(s) in " + ring + " · " + arch : "Nothing in " + ring + " · " + arch + " matches “" + term + "”.";
      $("#results tbody").innerHTML = rows.map(function (p) {
        return '<tr><td><a href="/package/' + encodeURIComponent(p.name) + '?ring=' + ring + '&arch=' + arch + '"><b>' + esc(p.name) + '</b></a></td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source) + '</span></td><td class="muted">' + esc(p.description || "") + '</td><td class="num">' + bytes(p.size_download) + '</td></tr>';
      }).join("");
    }).catch(function (e) { $("#hint").textContent = "search failed: " + e; });
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
    $("#desc").textContent = m.description || "";
    $("#meta").innerHTML = [
      m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "",
      (m.licenses || []).length ? "license " + esc((m.licenses || []).join(", ")) : "",
      m.pkginfo && m.pkginfo.base && m.pkginfo.base !== d.name ? "base " + link(m.pkginfo.base) : "",
      "source <span class=\"src\">" + esc(p.source) + "</span>",
      p.has_signature ? "upstream signature ✓" : "no upstream signature",
      '<a href="' + esc(d.pool_url) + '">download</a> · <a href="' + esc(d.pool_url) + '.sig">.sig</a>',
      bytes(p.size_download) + " download · " + bytes(p.size_installed) + " installed",
      m.pkginfo && m.pkginfo.builddate ? "built " + new Date(m.pkginfo.builddate * 1000).toISOString().slice(0, 10) : "",
      m.pkginfo && m.pkginfo.packager ? "by " + esc(m.pkginfo.packager.replace(/<.*>/, "").trim()) : ""
    ].filter(Boolean).map(function (x) { return "<span>" + x + "</span>"; }).join('<span class="sep">·</span>');
    $("#rings tbody").innerHTML = ["stable", "rc", "edge"].map(function (r) {
      var row = (d.rings || []).filter(function (x) { return x.ring === r; })[0];
      if (!row) return '<tr><td>' + r + '</td><td colspan="5" class="muted">not in ' + r + ' for ' + arch + '</td></tr>';
      return '<tr' + (r === ring ? ' style="background:var(--panel-2)"' : '') + '><td>' + r + (r === ring ? ' <span class="pill ok">shown</span>' : ' <a class="run" href="?ring=' + r + '&arch=' + arch + '">show</a>') + '</td><td class="mono">' + esc(row.version) + '</td><td>#' + row.release_seq + '</td><td><span class="src">' + esc(row.source) + '</span></td><td class="mono" title="' + esc(row.sha256) + '">' + esc(row.sha256.slice(0, 16)) + '…</td><td class="num">' + bytes(row.size_download) + '</td></tr>';
    }).join("");
    graph(d);
    renderSecurity(d);
    $("#deps").innerHTML = d.depends.length ? '<ul class="plain">' + d.depends.map(function (x) { return '<li>' + (x.provider ? link(x.provider.name) + ' <span class="muted">' + esc(x.provider.version) + '</span>' + (x.provider.name !== x.name ? ' <span class="muted">provides ' + esc(x.name) + '</span>' : '') : esc(x.name) + ' <span class="muted">not in this ring</span>') + '</li>'; }).join("") + '</ul>' : '<div class="empty">no declared dependencies</div>';
    $("#links").innerHTML = d.links.length ? '<ul class="plain">' + d.links.map(function (x) { return '<li><span class="mono">' + esc(x.soname) + '</span> <span class="muted">← ' + (x.provider ? link(x.provider.name) : "not in this ring") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">no ELF binaries, or nothing dynamically linked</div>';
    $("#rb-count").textContent = d.required_by.length + (d.required_by.length >= 400 ? "+" : "");
    $("#rb").innerHTML = d.required_by.length ? '<ul class="plain cols">' + d.required_by.map(function (x) { return '<li>' + link(x.name) + ' <span class="muted" title="' + esc(x.sonames.join(", ")) + '">' + (x.declared ? "declared" : "") + (x.declared && x.sonames.length ? " + " : "") + (x.sonames.length ? "loads " + x.sonames.length + " lib" + (x.sonames.length > 1 ? "s" : "") : "") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">nothing in ' + ring + ' depends on it</div>';
    var prov = (m.provides || []).filter(function (x) { return x.split(/[<>=]/)[0] !== d.name; });
    $("#provides").innerHTML = prov.length ? '<ul class="plain cols">' + prov.map(function (x) { return '<li class="mono">' + esc(x) + '</li>'; }).join("") + '</ul>' : '<div class="empty">only itself</div>';
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

  $("#load-files").onclick = function () {
    $("#files").textContent = "loading…";
    fetch("/api/v1/package/" + encodeURIComponent(name) + "/files?ring=" + ring + "&arch=" + arch).then(function (r) { return r.json(); }).then(function (d) {
      var files = (d.files || []).filter(function (f) { return !/\/$/.test(f); });
      $("#files").className = ""; $("#files").textContent = files.length + " files\n" + files.join("\n");
      $("#load-files").style.display = "none";
    }).catch(function (e) { $("#files").textContent = "failed: " + e; });
  };

  // The index can be busy during a bulk import; a transient 5xx gets retried.
  function loadPackage(attempt) {
    fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch).then(function (r) {
      if (r.status >= 500) throw new Error("index busy (HTTP " + r.status + ")");
      return r.json();
    }).then(function (d) {
      if (d.error) { $("#desc").textContent = d.error; $("#graph").innerHTML = ""; return; }
      render(d);
    }).catch(function (e) {
      if (attempt < 4) { $("#desc").textContent = "The index is busy (" + e.message + "); retrying…"; setTimeout(function () { loadPackage(attempt + 1); }, 4000 * attempt); }
      else $("#desc").textContent = "Could not load this package right now: " + e.message + ". Reload to try again.";
    });
  }
  loadPackage(1);
  liveStats(function () {}, 120000);
`;

export function packagesHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Packages · omarchy-pool",
    description: "Search the packages a ring serves; versions per ring, dependencies, what loads them, files.",
    active: "packages",
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
    active: "packages",
    body: PACKAGE_BODY,
    script: PACKAGE_SCRIPT,
    poolUrl,
    version,
  });
}
