/**
 * The dashboard's charts: small inline SVG with no library (the pages have no
 * build step). A page that draws includes CHARTS in its script; every helper
 * takes the numbers /api/v1/stats already returns. Bars carry their value in
 * data-tip; the layout's tooltip shows it.
 */
export const CHARTS = String.raw`  // ---- tiny SVG charts (no library; the page has no build step) ----
  var C = { green: "#9ece6a", amber: "#e0af68", red: "#f7768e", blue: "#7aa2f7", dim: "#414868", grid: "#2a2e3f", text: "#8b93b8" };
  // The viewBox is the drawing; the SVG scales uniformly with its column
  // (no preserveAspectRatio="none": stretched text overflowed its space).
  function svg(w, h, body) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="display:block;height:auto" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" fill="' + C.text + '">' + body + '</svg>'; }
  // Labels get the room they have, not more: cut with an ellipsis, full text in the tooltip.
  function fit(t, n) { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  function day(iso) { return iso.slice(0, 10); }
  function lastDays(n) { var out = [], t = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10)); return out; }
  function bars(items, fmt) { // vertical bars, items: [{label, value, color, title}]
    if (!items.length || !items.some(function (i) { return i.value > 0; })) return '<div class="empty">nothing yet</div>';
    var W = 360, H = 150, top = 16, bottom = 22, left = 6, max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    var bw = (W - left * 2) / items.length, body = '';
    body += '<line x1="0" y1="' + (H - bottom) + '" x2="' + W + '" y2="' + (H - bottom) + '" stroke="' + C.grid + '"/>';
    items.forEach(function (it, i) {
      var h = (H - top - bottom) * it.value / max, x = left + i * bw, y = H - bottom - h;
      body += '<rect x="' + (x + bw * 0.15) + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + h + '" fill="' + (it.color || C.green) + '"><title>' + esc(it.title || it.label + ": " + fmt(it.value)) + '</title></rect>';
      var step = items.length > 8 ? 2 : 1;
      if (i % step === 0) body += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10">' + esc(it.label) + '</text>';
    });
    body += '<text x="' + left + '" y="11" font-size="10">max ' + esc(fmt(max)) + '</text>';
    return svg(W, H, body);
  }
  function area(points, fmt) { // points: [{t: ms, v}]
    if (points.length < 2) return '<div class="empty">' + (points.length ? 'one snapshot so far — the line needs two' : 'collecting snapshots') + '</div>';
    var W = 360, H = 150, top = 16, bottom = 20, left = 6, right = 6;
    var vs = points.map(function (p) { return p.v; }), max = Math.max.apply(null, vs) || 1, min = Math.min.apply(null, vs);
    var t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    var lo = min === max ? 0 : min;
    var X = function (t) { return left + (W - left - right) * (t - t0) / (t1 - t0 || 1); }, Y = function (v) { return H - bottom - (H - top - bottom) * (v - lo) / (max - lo || 1); };
    var pts = points.map(function (p) { return X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var body = '<polygon points="' + X(t0).toFixed(1) + ',' + (H - bottom) + ' ' + pts + ' ' + X(t1).toFixed(1) + ',' + (H - bottom) + '" fill="' + C.green + '" fill-opacity="0.15"/>';
    body += '<polyline points="' + pts + '" fill="none" stroke="' + C.green + '" stroke-width="1.5"/>';
    body += '<text x="' + left + '" y="11" font-size="10">' + esc(fmt(max)) + '</text><text x="' + left + '" y="' + (H - bottom - 3) + '" font-size="10">' + esc(fmt(lo)) + '</text>';
    body += '<text x="' + left + '" y="' + (H - 6) + '" font-size="10">' + esc(new Date(t0).toUTCString().slice(5, 16)) + '</text><text x="' + (W - right) + '" y="' + (H - 6) + '" text-anchor="end" font-size="10">' + esc(new Date(t1).toUTCString().slice(5, 16)) + '</text>';
    return svg(W, H, body);
  }
  function heat(rows, days, cell) { // rows: [{key,label}], cell(key, day) -> status|null
    if (!rows.length) return '<div class="empty">no health checks yet</div>';
    var W = 360, labelW = 110, rh = 18, H = rows.length * rh + 22, cw = (W - labelW) / days.length, body = '';
    rows.forEach(function (r, ri) {
      body += '<text x="0" y="' + (ri * rh + 13) + '" font-size="10.5"><title>' + esc(r.label) + '</title>' + esc(fit(r.label, 17)) + '</text>';
      days.forEach(function (dd, di) {
        var st = cell(r.key, dd), col = st === "error" ? C.red : st === "warn" ? C.amber : st === "ok" ? C.green : C.dim;
        body += '<rect x="' + (labelW + di * cw + 1) + '" y="' + (ri * rh + 2) + '" width="' + (cw - 2) + '" height="' + (rh - 4) + '" fill="' + col + '" fill-opacity="' + (st ? 1 : 0.35) + '"><title>' + esc(r.label + " " + dd + ": " + (st || "no check")) + '</title></rect>';
      });
    });
    body += '<text x="' + labelW + '" y="' + (H - 4) + '" font-size="10">' + esc(days[0].slice(5)) + '</text><text x="' + W + '" y="' + (H - 4) + '" text-anchor="end" font-size="10">' + esc(days[days.length - 1].slice(5)) + '</text>';
    return svg(W, H, body);
  }
  function hbars(items) { // items: [{label, parts: [{v, color}], note}]
    if (!items.length) return '<div class="empty">no snapshot yet</div>';
    var W = 360, labelW = 112, noteW = 66, rh = 20, H = items.length * rh + 4, body = '';
    var max = Math.max.apply(null, items.map(function (i) { return i.parts.reduce(function (a, p) { return a + p.v; }, 0); })) || 1;
    items.forEach(function (it, i) {
      var x = labelW, y = i * rh + 2;
      body += '<text x="0" y="' + (y + 12) + '" font-size="10.5"><title>' + esc(it.label) + '</title>' + esc(fit(it.label, 17)) + '</text>';
      it.parts.forEach(function (p) { var w = (W - labelW - noteW - 10) * p.v / max; if (w > 0) { body += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (rh - 6) + '" fill="' + p.color + '"><title>' + esc(it.label + ": " + p.v + " " + p.name) + '</title></rect>'; x += w; } });
      body += '<text x="' + (W) + '" y="' + (y + 12) + '" text-anchor="end" font-size="10">' + esc(it.note) + '</text>';
    });
    return svg(W, H, body);
  }
  function worst(a, b) { var rank = { error: 3, warn: 2, ok: 1 }; return (rank[b] || 0) > (rank[a] || 0) ? b : a; }

  function renderSystem(d) {
    // Snapshots before v0.0.51 measured GitHub Actions ("actions"); now the pool's own jobs.
    var m = d.metrics, a = m && (m.jobs || m.actions), w = m && m.workers;
    var pool = d.pool, refAny = pool.referenced_by_any_release || {}, rec = pool.reclaimable || { objects: 0, bytes: 0 };
    var ringBytes = d.rings.reduce(function (x, r) { return x + (r.bytes || 0); }, 0);
    var pending = Math.max(0, (pool.objects || 0) - (refAny.objects || 0));
    var lastSyncEv = latest(d.events, "sync"), synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sec = d.security || {}, secEv = latest(d.latest, "security");
    var now = new Date(), utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    var nextRc = utcH < 6 ? 6 - utcH : 30 - utcH, nextStable = utcH < 9 ? 9 - utcH : 33 - utcH;
    var fmtH = function (h) { return h < 1 ? Math.round(h * 60) + " min" : Math.floor(h) + " h " + Math.round((h % 1) * 60) + " min"; };
    var tiles = [
      ["Jobs running now", a ? num(a.running) : "—", a ? "pool jobs leased or queued" + (w ? " · " + num(w.alive) + " worker(s) alive, " + num(w.busy) + " busy" : "") : "no metrics snapshot yet"],
      ["Jobs, 7 days", a ? num(a.runs) : "—", a ? num(a.failures) + " failed · " + num(a.runs - a.failures - a.running) + " succeeded" : ""],
      ["Worker minutes, 7 days", a ? num(a.minutes) : "—", "on the project's workers, both architectures"],
      ["Sources", synced + " / " + expected, lastSyncEv ? "last sync " + ago(lastSyncEv.created_at) + " · every 3 hours" : "no sync yet"],
      ["Next promotion", "edge → rc in " + fmtH(nextRc), "rc → stable in " + fmtH(nextStable) + " · 06:00 and 09:00 UTC daily"],
      ["Security data", sec.updated_at ? ago(sec.updated_at) : "never", num(sec.advisories) + " advisories · Arch + Debian trackers, KEV, EPSS · every 3 h" + (secEv && secEv.status !== "ok" ? " · last run " + secEv.status : "")],
      ["Stored once", bytes(pool.bytes), num(pool.objects) + " objects, one per sha256"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(rec.bytes), num(rec.objects) + " objects past retention" + (pending ? " · " + num(pending) + " awaiting a release" : "")],
      ["Snapshot", m ? ago(m.recorded_at) : "never", m ? "the pool measures itself every 30 minutes" : "no snapshot yet"],
      ["Estimated bill", "…", "Cloudflare, this month"]
    ];
    tiles.forEach(function (t, i) { var el = $("#systiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
    // The bill, estimated once a day from Cloudflare's analytics (cost.ts); the guard pauses writing jobs over budget.
    fetch("/api/v1/cost").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      var cell = $("#systiles").children[tiles.length - 1]; if (!cell) return;
      if (!c) { setTile(cell, '<div class="k">Estimated bill</div><div class="v num">—</div><div class="s">no estimate yet (daily, 06:30 UTC)</div>'); return; }
      var color = c.status === "error" ? "var(--red)" : c.status === "warn" ? "var(--amber)" : "inherit";
      setTile(cell, '<div class="k">Estimated bill</div><div class="v num" style="color:' + color + '">US$ ' + Number(c.projected_usd).toFixed(2) + '</div><div class="s">projected for ' + esc(c.month) + ' · US$ ' + Number(c.month_to_date_usd).toFixed(2) + ' so far · ' + ago(c.estimated_at) + (c.guard ? ' · <b>over budget: writing jobs paused</b>' : '') + '</div>');
    }).catch(function () {});

    var S = d.series || {};
    $("#c-pool").innerHTML = area((S.metrics || []).map(function (r) { return { t: Date.parse(r.created_at), v: Number(r.bytes || 0) }; }), bytes) +
      (S.metrics && S.metrics.length ? '<div class="legend"><span><i style="background:' + C.green + '"></i>' + num(S.metrics[S.metrics.length - 1].objects) + ' objects now</span></div>' : '');

    var days14 = lastDays(14), byDay = {};
    (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = bars(days14.map(function (dd) { var r = byDay[dd]; return { label: dd.slice(5), value: r ? Number(r.packages) : 0, title: dd + ": " + (r ? num(r.packages) + " packages, " + bytes(r.bytes) + " in " + r.runs + " run(s)" : "no sync") }; }), num);

    var RINGS = ["edge", "rc", "stable"], ARCHES = ["x86_64", "aarch64"], cells = {};
    (S.health || []).forEach(function (h) { var k = h.ring + "/" + h.arch + "/" + day(h.created_at); cells[k] = worst(cells[k], h.status); });
    var rows = []; RINGS.forEach(function (r) { ARCHES.forEach(function (ar) { rows.push({ key: r + "/" + ar, label: r + " " + ar }); }); });
    $("#c-health").innerHTML = heat(rows, days14, function (k, dd) { return cells[k + "/" + dd] || null; }) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>ok</span><span><i style="background:' + C.amber + '"></i>warn (nothing rendered)</span><span><i style="background:' + C.red + '"></i>error</span><span><i style="background:' + C.dim + ';opacity:.5"></i>no check</span></div>';

    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "ok" ? C.green : C.amber, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + num(r.uploaded) + " packages, " + bytes(r.bytes) + " in " + dur(r.duration_ms) + " → " + (Math.round(mbs * 10) / 10) + " MB/s" + (r.concurrency ? " with " + r.concurrency + " workers" : "") }; }), function (v) { return v + " MB/s"; });

    var jd = S.jobs_daily || [], byKind = {}, byD = {};
    jd.forEach(function (r) { var k = byKind[r.kind] = byKind[r.kind] || { done: 0, failed: 0, waiting: 0, ms: 0 }; if (r.status === "done") k.done += Number(r.n); else if (r.status === "failed" || r.status === "cancelled") k.failed += Number(r.n); else k.waiting += Number(r.n); k.ms += Number(r.ms || 0);
      var dd = byD[r.day] = byD[r.day] || { runs: 0, failures: 0, ms: 0 }; dd.runs += Number(r.n); if (r.status === "failed") dd.failures += Number(r.n); dd.ms += Number(r.ms || 0); });
    $("#c-jobs").innerHTML = hbars(Object.keys(byKind).sort(function (a, b) { return (byKind[b].done + byKind[b].failed) - (byKind[a].done + byKind[a].failed); }).map(function (k) { var v = byKind[k]; return { label: k, note: num(v.done + v.failed + v.waiting) + " · " + Math.round(v.ms / 60000) + " min", parts: [{ v: v.done, color: C.green, name: "done" }, { v: v.failed, color: C.red, name: "failed" }, { v: v.waiting, color: C.blue, name: "waiting" }] }; })) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>done</span><span><i style="background:' + C.red + '"></i>failed</span><span><i style="background:' + C.blue + '"></i>queued / running</span></div>';
    var bd = S.builds_daily || [], byDay = {};
    bd.forEach(function (r) { var d = byDay[r.day] = byDay[r.day] || { staged: 0, published: 0, failed: 0 }; if (r.status === "staged") d.staged += Number(r.n); else if (r.status === "done") d.published += Number(r.n); else if (r.status === "failed") d.failed += Number(r.n); });
    $("#c-builds").innerHTML = bars(lastDays(14).map(function (dd) { var d = byDay[dd] || { staged: 0, published: 0, failed: 0 }; var t = d.staged + d.published + d.failed; return { label: dd.slice(5), value: t, color: d.failed > d.published + d.staged ? C.red : C.green, title: dd + ": " + d.staged + " staged, " + d.published + " published, " + d.failed + " failed" }; }), function (v) { return v + " build(s)"; });
    $("#c-minutes").innerHTML = bars(lastDays(7).map(function (dd) { var r = byD[dd]; return { label: dd.slice(5), value: r ? Math.round(r.ms / 60000) : 0, color: C.blue, title: dd + ": " + (r ? Math.round(r.ms / 60000) + " min in " + r.runs + " jobs, " + r.failures + " failed" : "no jobs") }; }), function (v) { return v + " min"; });

    // One row per job kind: what the journal's latest entry says, and the week's totals.
    var kinds = Object.keys(byKind).sort().map(function (k) { var v = byKind[k], l = (d.latest || []).filter(function (e) { return e.kind === k; }).sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); })[0]; return { kind: k, last: l, runs: v.done + v.failed + v.waiting, failed: v.failed, running: v.waiting, minutes: Math.round(v.ms / 60000) }; });
    pager("#workflows", kinds, function (w) {
      var l = w.last, st = l ? l.status : "—", cls = st === "ok" ? "ok" : st === "error" ? "error" : st === "warn" ? "warn" : "";
      return '<tr><td>' + esc(w.kind) + '</td><td><span class="dot ' + cls + '"></span>' + esc(st) + (l ? ' <span class="when">' + ago(l.created_at) + '</span>' : '') + '</td><td class="num">' + num(w.runs) + '</td><td class="num">' + (w.failed ? '<span style="color:var(--red)">' + num(w.failed) + '</span>' : '0') + '</td><td class="num">' + (w.running ? '<span style="color:var(--blue)">' + num(w.running) + '</span>' : '0') + '</td><td class="num">' + num(w.minutes) + '</td></tr>';
    }, { empty: 'no jobs yet — the pool queues them on schedule and project workers pull them', n: 25 });
  }

  // OPR recipes by origin: the AUR-synced count in stable is the number to drive to zero.
  function renderProvenance(d) {
    var pv = d.provenance && d.provenance.stable; var el = $("#provenance"); if (!pv || !el || !pv.packages) return;
    el.hidden = false;
    el.innerHTML = '<b>OPR recipes in stable:</b> ' + num(pv.packages) + ' packages — ' + num(pv.local) + " Omarchy's own, <b>" + num(pv.aur) + ' still synced from the AUR</b>' + (pv.unknown ? ', ' + num(pv.unknown) + ' of unknown origin' : '') + ' (<a href="https://github.com/omacom/omarchy-pkgs/tree/master/pkgbuilds">omarchy-pkgs</a>, read daily; each package page says which). The AUR number is the one to drive to zero.';
  }
  // Architecture-independent packages stored once per architecture: Arch Linux ARM rebuilds and re-signs them.
  function renderAny(d) {
    var a = d.any && d.any.stable; var el = $("#any"); if (!a || !el || !a.names) return;
    el.hidden = false;
    el.innerHTML = '<b>Architecture-independent packages in stable:</b> ' + num(a.names) + ' (' + num(a.objects) + ' objects, ' + bytes(a.bytes) + ') — ' + num(a.twice) + ' of them stored twice, once per architecture, because Arch Linux ARM rebuilds and re-signs <code>any</code> packages: ' + bytes(a.extra_bytes) + ' the pool would not need if one signed object served both.';
  }
  function renderCoverage(d) {
    renderProvenance(d);
    renderAny(d);
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : (a.arch === "x86_64" ? -1 : 1); });
    var tot = cov.reduce(function (t, c) { t.up += c.upstream_total || 0; t.have += c.indexed; t.miss += c.missing || 0; t.bytes += c.bytes; t.pending += c.upstream_total == null ? 1 : 0; return t; }, { up: 0, have: 0, miss: 0, bytes: 0, pending: 0 });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    pager("#coverage", cov, function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? '<span class="pill none">not synced yet</span>' : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (c.last_status !== "ok" ? ' <span class="pill ' + c.last_status + '">' + c.last_status + '</span>' : '')) + '</td></tr>';
    }, { n: 25 });
  }


  // ---- v2 charts: stacked bars, several lines on one axis, html bars, a 14-day heat grid ----
  function nice(max) { var p = Math.pow(10, Math.floor(Math.log10(max || 1))), n = max / p; var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10; return s * p; }
  function shortDay(l) { return String(l).length === 10 ? l.slice(5) : String(l).replace(/^\w+ /, ""); }
  // series: [{name, color, values}] over labels; every bar carries a data-tip with all its parts.
  function stacked(labels, series, opts) {
    opts = opts || {}; var W = 520, H = 170, L = 36, R = 6, T = 8, B = 24, n = labels.length || 1, iw = (W - L - R) / n, bw = Math.max(2, iw - 3);
    var sums = labels.map(function (_, i) { return series.reduce(function (a, s) { return a + (Number(s.values[i]) || 0); }, 0); });
    if (!labels.length || !sums.some(function (v) { return v > 0; })) return '<div class="empty">' + (opts.empty || "nothing yet") + '</div>';
    var max = nice(Math.max.apply(null, sums)); var ys = function (v) { return T + (H - T - B) * (1 - v / max); };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || "") + '">';
    [0, .5, 1].forEach(function (f) { var y = ys(max * f); out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + num(Math.round(max * f)) + '</text>'; });
    labels.forEach(function (lab, i) {
      var y0 = ys(0), x = L + i * iw + 1.5, tip = lab + series.map(function (s) { return " · " + s.name + " " + num(s.values[i] || 0); }).join("");
      series.forEach(function (s) { var v = Number(s.values[i]) || 0; if (!v) return; var y1 = ys(v); var h = y0 - y1; out += '<rect class="mark" x="' + x + '" y="' + (y0 - h) + '" width="' + bw + '" height="' + Math.max(0, h - 2) + '" fill="' + s.color + '" data-tip="' + esc(tip) + '"/>'; y0 -= h; });
      if (n <= 8 || i % 2 === 1) out += '<text class="ax" x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opts.full ? lab : shortDay(lab)) + '</text>';
    });
    out += '</svg>';
    if (series.length > 1) out += '<div class="legend">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '</div>';
    return out;
  }
  function lines(labels, series, unit, label) {
    var W = 520, H = 170, L = 36, R = 10, T = 12, B = 24, n = labels.length, all = [];
    series.forEach(function (s) { all = all.concat(s.values.map(Number)); });
    if (n < 2 || !all.some(function (v) { return v > 0; })) return '<div class="empty">nothing yet</div>';
    var max = nice(Math.max.apply(null, all)), xs = function (i) { return L + (W - L - R) * i / (n - 1); }, ys = function (v) { return T + (H - T - B) * (1 - v / max); };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label || "") + '">';
    [0, .5, 1].forEach(function (f) { var y = ys(max * f); out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + num(Math.round(max * f)) + '</text>'; });
    series.forEach(function (s) {
      out += '<polyline points="' + s.values.map(function (v, i) { return xs(i) + "," + ys(Number(v) || 0); }).join(" ") + '" fill="none" stroke="' + s.color + '" stroke-width="2"/>';
      s.values.forEach(function (v, i) { out += '<circle class="mark" cx="' + xs(i) + '" cy="' + ys(Number(v) || 0) + '" r="' + (i === n - 1 ? 4.5 : 3) + '" fill="' + s.color + '" stroke="#1f2230" stroke-width="2" data-tip="' + esc(labels[i] + " · " + s.name + " " + num(v) + (unit ? " " + unit : "")) + '"/>'; });
    });
    labels.forEach(function (lab, i) { if (n <= 8 || i % 2 === 1) out += '<text class="ax" x="' + xs(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(shortDay(lab)) + '</text>'; });
    return out + '</svg><div class="legend">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '</div>';
  }
  // rows: [[label, small, percent, color?]] — a labelled bar per row, percent of a full bar.
  function hrows(rows, w) {
    if (!rows.length) return '<div class="empty">nothing yet</div>';
    return '<div class="hrows">' + rows.map(function (r) { var full = r[2] >= 100; return '<div class="hrow"' + (w ? ' style="grid-template-columns:' + w + 'px 1fr 52px"' : "") + '><div class="l">' + esc(r[0]) + (r[1] ? ' <small>' + esc(r[1]) + '</small>' : "") + '</div><div class="bar" data-tip="' + esc(r[0] + (r[1] ? " " + r[1] : "") + " · " + (r[4] || r[2] + "%")) + '"><i class="' + (full ? "" : "partial") + '" style="width:' + Math.min(100, r[2]) + '%' + (r[3] ? ";background:" + r[3] : "") + '"></i></div><div class="p num">' + (r[4] || r[2] + "%") + '</div></div>'; }).join("") + '</div>';
  }
  // Fourteen days of health per ring and architecture, worst result per day, as html cells.
  function heatGrid(health) {
    var days = lastDays(14), cells = {}, RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
    (health || []).forEach(function (h) { var k = h.ring + "/" + h.arch + "/" + day(h.created_at); cells[k] = worst(cells[k], h.status); });
    if (!Object.keys(cells).length) return '<div class="empty">no health checks yet</div>';
    var rows = []; RINGS.forEach(function (r) { ARCHES.forEach(function (a) { rows.push([r + " " + a, r + "/" + a]); }); });
    var names = { ok: "healthy", warn: "warning", error: "failed" };
    return '<div class="heat">' + rows.map(function (r) { return '<div class="r"><span class="l">' + esc(r[0]) + '</span>' + days.map(function (dd) { var st = cells[r[1] + "/" + dd]; return '<span class="c ' + (st || "") + '" data-tip="' + esc(dd + " · " + r[0] + " · " + (names[st] || "no check")) + '"></span>'; }).join("") + '</div>'; }).join("") +
      '<div class="days"><span></span>' + days.map(function (d, i) { return '<span>' + (i % 2 ? esc(d.slice(5)) : "") + '</span>'; }).join("") + '</div></div>';
  }
`;

