/**
 * Get started: the exact pacman configuration for a ring and an architecture,
 * generated from what the ring serves right now, plus the database key and
 * the optional thin client. `?ring=stable&arch=x86_64` preselects.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>Get started</h1>
  <p class="lede">One command — or three steps by hand: trust the key that signs the databases, point pacman at a ring, upgrade. Packages keep the signatures of the project that built them (Arch, Arch Linux ARM, Omarchy) — the only new key you trust signs the databases and what the pool builds itself.</p>

  <div class="steps">
    <div class="step">
      <h3>1. Choose a ring and your architecture</h3>
      <p>Not sure? <b>stable</b> is the one to use on a machine you rely on.</p>
      <div class="choice" id="pick-ring"></div>
      <div class="choice" id="pick-arch"></div>
      <div id="ring-desc" class="muted" style="font-size:13.5px"></div>
    </div>

    <div class="step">
      <h3>The one command</h3>
      <p>Everything below, done for you — once per machine, on x86_64 or aarch64 (it finds out):</p>
      <pre><span class="copy" data-copy="setup">copy</span><span id="setup-cmd"></span></pre>
      <p>What it does, and nothing else: trusts the key that signs the pool's databases (step 2); writes <code>/etc/pacman.d/omarchy-pool.conf</code> with the repositories the ring serves right now (step 3 — asked to the pool at run time, so it is never stale); adds one line to <code>/etc/pacman.conf</code>, above <code>[core]</code>, once: <code>Include = /etc/pacman.d/omarchy-pool.conf</code>; runs <code>pacman -Sy</code> and tells you to run the upgrade — <code>omarchy update</code> on an Omarchy install (its pacman hook refuses a bare <code>pacman -Syu</code>), <code>sudo pacman -Syu</code> elsewhere. It keeps a backup (<code>pacman.conf.bak-omarchy-pool</code>), it never upgrades on its own, and it never touches your other repositories.</p>
      <p><b>Why an <code>Include</code>, above <code>[core]</code>.</b> pacman takes a package from the first repository that has it, in file order. What you keep above the line — an Asahi <code>[omarchy]</code> or <code>[asahi-alarm]</code> on a Mac, a repository of your own — keeps priority; the pool serves core, extra, multilib, alarm, the OPR and the factory's builds from the ring; Arch's own mirrors below the line stay as the fallback for the rare package the pool does not have yet, and for repositories it does not mirror (<code>[aur]</code> on Arch Linux ARM). Switching rings rewrites the include file only: <code>--ring rc</code>, <code>--ring edge</code>; <code>--remove</code> deletes it and takes the line out. <a href="/setup">The script, in full →</a></p>
      <p><b>The first upgrade.</b> Usually "nothing to do": <em>stable</em> is about two days behind upstream, and pacman never downgrades what a mirror already gave you. From then on the upgrades come through the ring when it promotes them.</p>
    </div>

    <div class="step">
      <h3>2. Trust the database key</h3>
      <p>Once per machine. The key signs the pacman databases and the packages the pool builds itself (source <em>factory</em>); every other package still carries its upstream signature.</p>
      <pre><span class="copy" data-copy="key">copy</span><span id="key-cmd"></span></pre>
    </div>

    <div class="step">
      <h3>3. Configure pacman, by hand</h3>
      <p>Save the sections below as <code>/etc/pacman.d/omarchy-pool.conf</code> (<code>sudo nvim</code>, or <code>curl -o</code> from <code>/api/v1/pacman.conf?ring=…&amp;arch=…</code>), then add <code>Include = /etc/pacman.d/omarchy-pool.conf</code> to <code>/etc/pacman.conf</code> above <code>[core]</code>. The list is generated from what the ring serves right now.</p>
      <div class="choice" id="optional"></div>
      <pre><span class="copy" data-copy="conf">copy</span><span id="conf"></span></pre>
      <p>Then:</p>
      <pre><span class="copy" data-copy="up">copy</span><span id="up-cmd">omarchy update</span>   <span class="c"># off Omarchy: sudo pacman -Syu</span></pre>
    </div>

    <div class="step">
      <h3>Optional: omarchy-cli</h3>
      <p>A thin client that knows about rings and releases: <code>status</code> shows what the ring would change on this machine, <code>check</code> runs the ABI safety check before an out-of-band install, <code>upgrade</code> drives pacman and pins the release you are on, <code>security</code> lists the advisories that apply here. A package of the factory, in every ring; not on your ring yet? Binaries for both architectures ship with every <a href="https://github.com/firemanxbr/omarchy-pool/releases">release</a>.</p>
      <pre><span class="copy" data-copy="cli">copy</span><span id="cli-cmd"></span></pre>
    </div>

    <div class="step">
      <h3>Switching rings, going back</h3>
      <p>Only the repository names change between rings (<code>omarchy-core-stable</code> → <code>omarchy-core-rc</code>); the packages are the same objects. A ring itself rolls back automatically when a promotion fails its health check — you do not have to do anything, the next <code>pacman -Syu</code> sees the restored release.</p>
    </div>
  </div>
`;

const SCRIPT = String.raw`
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
  var DESC = {
    stable: "Recommended. What rc served for a day without a failed check; about two days behind Arch, rolled back automatically if a promotion fails.",
    rc: "Yesterday's edge, promoted after a real pacman and an ABI check passed on both architectures. For testers.",
    edge: "What upstream published in the last hour, signature-verified only. For CI and developers."
  };
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var data = null, optional = {};

  function pick(id, values, current, onpick) {
    $("#" + id).innerHTML = values.map(function (v) { return '<button class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join("");
    $("#" + id).querySelectorAll("button").forEach(function (b) { b.onclick = function () { onpick(b.getAttribute("data-v")); }; });
  }
  function draw() {
    pick("pick-ring", RINGS, ring, function (v) { ring = v; history.replaceState(null, "", "?ring=" + ring + "&arch=" + arch); draw(); });
    pick("pick-arch", ARCHES, arch, function (v) { arch = v; history.replaceState(null, "", "?ring=" + ring + "&arch=" + arch); draw(); });
    $("#ring-desc").textContent = DESC[ring];
    $("#key-cmd").innerHTML = 'curl -O ' + POOL + '/omarchy-staging.pub.asc\nsudo pacman-key --add omarchy-staging.pub.asc &amp;&amp; sudo pacman-key --lsign-key staging@firemanxbr.org';
    $("#setup-cmd").innerHTML = 'curl -fsSL ' + location.origin + '/setup | sudo bash -s -- --ring ' + ring;
    var r = data ? data.rings.filter(function (x) { return x.ring === ring; })[0] : null;
    var cov = data ? data.coverage || [] : [];
    var optionalSources = cov.filter(function (c) { return c.optional && c.arch === arch; });
    $("#optional").innerHTML = optionalSources.map(function (c) {
      return '<button type="button" class="' + (optional[c.source] ? "on" : "") + '" data-v="' + esc(c.source) + '" title="' + esc(c.title || "") + '">' + (optional[c.source] ? "✓ " : "+ ") + esc(c.source) + '</button>';
    }).join("") + (optionalSources.length ? '<span class="muted" style="font-size:12.5px;align-self:center">optional repositories — off unless you switch them on</span>' : '');
    $("#optional").querySelectorAll("button").forEach(function (b) { b.onclick = function () { var v = b.getAttribute("data-v"); optional[v] = !optional[v]; draw(); }; });
    var dbs = r ? (r.artifacts || []).filter(function (a) {
      if (a.kind !== "db" || a.arch !== arch) return false;
      var src = a.repo.replace(/^omarchy-/, "").replace(new RegExp("-" + ring + "$"), "");
      var opt = cov.filter(function (c) { return c.source === src && c.arch === arch; })[0];
      return !(opt && opt.optional) || optional[src];
    }) : [];
    $("#conf").innerHTML = dbs.length
      ? dbs.map(function (a) { return "[<b>" + esc(a.repo) + "</b>]\nSigLevel = Required DatabaseRequired\nServer = " + POOL + "/$arch"; }).join("\n\n")
      : (data ? '<span class="c"># ' + ring + ' has no databases for ' + arch + ' yet — check the overview</span>' : '<span class="c"># loading what ' + ring + ' serves…</span>');
    $("#cli-cmd").innerHTML = 'curl -sL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/omarchy-pool-' + (data && data.version && data.version.version !== "dev" ? data.version.version : "vX.Y.Z") + '-' + arch + '-linux.tar.gz | tar xz\n' +
      'sudo install -m 755 omarchy-pool-*/omarchy-cli /usr/local/bin/\n' +
      'omarchy-cli --ring ' + ring + ' status';
  }
  document.querySelectorAll(".copy").forEach(function (b) {
    b.onclick = function () {
      var id = { setup: "#setup-cmd", key: "#key-cmd", conf: "#conf", up: "#up-cmd", cli: "#cli-cmd" }[b.getAttribute("data-copy")];
      navigator.clipboard.writeText($(id).textContent).then(function () { b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1500); });
    };
  });
  draw();
  liveStats(function (d) { data = d; draw(); }, 120000);
`;

export function getStartedHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Get started · omarchy-pool",
    description: "Point pacman at the omarchy-pool: the database key, the repository sections for a ring, and the optional omarchy-cli.",
    active: "docs",
    doc: "get-started",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
