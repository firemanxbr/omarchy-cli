/**
 * How it works: where the packages come from, what happens to each one, how
 * the rings move, what a user trusts, and why one Server= line is enough.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

/** Flow diagram in the page's own palette (inline SVG, scales with the column). */
const DIAGRAM = String.raw`
<svg viewBox="0 0 1320 470" xmlns="http://www.w3.org/2000/svg" font-family="JetBrains Mono, ui-monospace, monospace" font-size="12">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker></defs>
  <style>
    .box{fill:#1f2230;stroke:#2a2e3f;stroke-width:1.2}.src{fill:#13141c;stroke:#2a2e3f}.green{stroke:#9ece6a}.blue{stroke:#7aa2f7}.amber{stroke:#e0af68}
    .t{fill:#c0caf5;font-family:Geist,sans-serif;font-weight:600;font-size:15px}.s{fill:#a9b1d6}.d{fill:#8b93b8;font-size:11px}.g{fill:#9ece6a}
    .ln{fill:none;stroke:#8b93b8;stroke-width:1.4;marker-end:url(#a)}
  </style>
  <!-- sources -->
  <rect class="box src" x="20" y="30" width="300" height="66" rx="3"/><text class="t" x="34" y="52">Arch Linux · x86_64</text><text class="s" x="34" y="72">core · extra · multilib</text><text class="d" x="34" y="88">mirror.omarchy.org · Arch keyring</text>
  <rect class="box src" x="20" y="110" width="300" height="66" rx="3"/><text class="t" x="34" y="132">Arch Linux ARM · aarch64</text><text class="s" x="34" y="152">core · extra · alarm</text><text class="d" x="34" y="168">os.archlinuxarm.org · ALARM keyring</text>
  <rect class="box src" x="20" y="190" width="300" height="66" rx="3"/><text class="t" x="34" y="212">Omarchy (OPR) · both</text><text class="s" x="34" y="232">edge / rc / stable channels</text><text class="d" x="34" y="248">pkgs.omarchy.org · Omarchy key</text>
  <rect class="box src" x="20" y="270" width="300" height="66" rx="3"/><text class="t" x="34" y="292">chaotic-aur · x86_64 <tspan class="d">optional</tspan></text><text class="s" x="34" y="312">prebuilt AUR, unclaimed names only</text><text class="d" x="34" y="328">builds.garudalinux.org · chaotic key</text>
  <text class="d" x="20" y="366">upstream repositories, read every hour</text>
  <path class="ln" d="M320 63 L350 63 L350 140 L378 140"/><path class="ln" d="M320 143 L350 143 L350 140 L378 140"/><path class="ln" d="M320 223 L350 223 L350 140 L378 140"/><path class="ln" d="M320 303 L350 303 L350 140 L378 140"/>
  <!-- verify -->
  <rect class="box amber" x="380" y="98" width="230" height="84" rx="3"/><text class="t" x="394" y="124">Verify</text><text class="s" x="394" y="146">sha256 from the upstream db</text><text class="s" x="394" y="164">signature by the project's key</text>
  <path class="ln" d="M610 140 L658 140"/>
  <!-- pool + index -->
  <rect class="box green" x="660" y="34" width="330" height="96" rx="3"/><text class="t" x="674" y="58">Pool · R2</text><text class="s" x="674" y="80">one object per sha256, immutable</text><text class="s" x="674" y="98">the package and its upstream .sig</text><text class="d" x="674" y="118">pool.firemanxbr.org/&lt;arch&gt;/</text>
  <rect class="box blue" x="660" y="150" width="330" height="104" rx="3"/><text class="t" x="674" y="174">Index · D1</text><text class="s" x="674" y="196">manifests, dependencies, provides,</text><text class="s" x="674" y="214">loaded sonames, file lists</text><text class="d" x="674" y="240">pkgs.firemanxbr.org/api/v1</text>
  <!-- rings -->
  <path class="ln" d="M990 202 L1015 202 L1015 189 L1038 189"/>
  <rect class="box" x="1040" y="40" width="260" height="58" rx="3"/><text class="t" x="1054" y="62">edge</text><text class="s" x="1054" y="84">follows upstream, hourly</text>
  <rect class="box" x="1040" y="120" width="260" height="58" rx="3"/><text class="t" x="1054" y="142">rc</text><text class="s" x="1054" y="164">daily · health + ABI checks</text>
  <rect class="box green" x="1040" y="200" width="260" height="58" rx="3"/><text class="t" x="1054" y="222">stable <tspan class="g" font-size="11">recommended</tspan></text><text class="s" x="1054" y="244">one-day soak · auto rollback</text>
  <path class="ln" d="M1170 98 L1170 118"/><path class="ln" d="M1170 178 L1170 198"/>
  <text class="d" x="1040" y="284">a ring = a pinned selection;</text><text class="d" x="1040" y="298">promotion = index write, no bytes copied</text>
  <!-- render -->
  <rect class="box" x="660" y="300" width="330" height="70" rx="3"/><text class="t" x="674" y="324">Render + sign</text><text class="s" x="674" y="344">omarchy-&lt;source&gt;-&lt;ring&gt;.db + .files</text><text class="s" x="674" y="360">per arch, beside the packages</text>
  <path class="ln" d="M1040 229 L1015 229 L1015 335 L992 335"/>
  <text class="d" x="660" y="396">GitHub Actions runs every step; each run is linked from the journal</text>
  <!-- user -->
  <path class="ln" d="M660 335 L640 335 L640 421 L632 421"/>
  <rect class="box green" x="330" y="388" width="300" height="66" rx="3"/><text class="t" x="344" y="410">Your machine · pacman</text><text class="s" x="344" y="430">[omarchy-core-stable] → pool/$arch</text><text class="d" x="344" y="446">plain HTTP, static files, any pacman</text>
  <text class="d" x="20" y="412">one Server = line,</text><text class="d" x="20" y="427">both architectures,</text><text class="d" x="20" y="442">the ring you choose</text>
</svg>`;

const BODY = String.raw`
  <h1>How it works</h1>
  <p class="lede">Packages come from the projects that build them, are verified, stored once, and served in rings that only move forward on evidence. Nothing is rebuilt or re-signed; what changes is <em>when</em> a package reaches you and <em>what was checked</em> before it did.</p>

  <div class="chart" style="padding:18px">${DIAGRAM}</div>

  <section>
    <h2>Where the packages come from</h2>
    <p class="sub">The pool mirrors the repositories below. Every package must carry a signature by a key in that project's keyring; unsigned or mismatching packages never enter.</p>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Architecture</th><th>Repositories</th><th>Verified against</th></tr></thead><tbody>
      <tr><td>Arch Linux (via the Omarchy mirror)</td><td>x86_64</td><td><code>core</code> <code>extra</code> <code>multilib</code></td><td><code>archlinux-keyring</code></td></tr>
      <tr><td>Arch Linux ARM</td><td>aarch64</td><td><code>core</code> <code>extra</code> <code>alarm</code></td><td><code>archlinuxarm-keyring</code></td></tr>
      <tr><td>Omarchy Package Repository (OPR)</td><td>x86_64 · aarch64</td><td><code>omarchy</code> — the OPR's own <code>edge</code> / <code>rc</code> / <code>stable</code> channel goes into the matching ring</td><td>Omarchy's signing key</td></tr>
      <tr><td>chaotic-aur <span class="muted">(optional)</span></td><td>x86_64</td><td><code>chaotic-aur</code>: prebuilt AUR packages; only names no other source provides, so Arch and the OPR always win</td><td><code>chaotic-keyring</code></td></tr>
      <tr><td>The factory</td><td>x86_64 · aarch64</td><td><code>factory</code>: what no source above ships — built from PKGBUILDs reviewed in the repository by ephemeral workers that pull tasks from the pool; today, the OPR names that exist only for x86_64, built for aarch64 (<a href="/factory">Factory</a>)</td><td>the pool's own key</td></tr>
    </tbody></table></div>
  </section>

  <section>
    <h2>What happens to a package</h2>
    <div class="steps">
      <div class="step"><h3>1. Sync</h3><p>Every hour the upstream database is read and compared with the index by sha256; only what is missing is downloaded. Each file is checked against the upstream checksum and signature, its <code>.PKGINFO</code>, dependencies, <code>provides</code>, file list and the sonames its binaries load are extracted, and the archive plus its <code>.sig</code> are stored in the pool under <code>&lt;arch&gt;/&lt;filename&gt;</code>. A file is never stored twice and never modified.</p></div>
      <div class="step"><h3>2. Pin</h3><p>The sync then creates a new <b>edge</b> release: an immutable list of exactly which objects the ring serves. Releases are append-only; every ring has a history you can point it back to.</p></div>
      <div class="step"><h3>3. Promote on evidence</h3><p>Once a day a real pacman syncs the source ring in a container on x86_64 and on aarch64, and <code>omarchy-cli check</code> runs the ELF-level safety check on every upgrade the ring would apply to a reference system. A gate reads that evidence: the latest checks must be green, nothing may have failed inside the soak window and the content must have been there that long (one day for stable), a recent ABI check must have no blockers. Only then is the selection copied to the next ring — an index write, no bytes move.</p></div>
      <div class="step"><h3>4. Render and verify</h3><p>The ring's pacman databases (<code>omarchy-&lt;source&gt;-&lt;ring&gt;.db</code> and <code>.files</code>) are generated from the index, signed with the pool's database key and placed beside the packages. The target ring is health-checked again on both architectures; if that fails, the ring is pointed back at its previous release and re-rendered automatically.</p></div>
    </div>
  </section>

  <section>
    <h2>Security, with the graph</h2>
    <p class="sub">Every three hours the objects the rings serve are matched against the Arch Security Tracker (exact, Arch's own versions), the Debian Security Tracker (same upstream projects, for what Arch has not triaged yet — with a confidence level, never as a certainty), CISA KEV and EPSS. Because the index knows what every binary loads, an advisory on a library also marks what <em>uses</em> it: the <a href="/security">Security page</a> shows the ring, the package page shows the chain, the graph marks the nodes.</p>
  </section>

  <section>
    <h2>Why one <code>Server =</code> is enough</h2>
    <p class="sub">Today an Omarchy machine talks to several repositories, each with its own mirror, cadence and failure modes. Here they are one set of databases per ring, generated from the same index, on both architectures.</p>
    <div class="howto">
      <div class="arch"><div class="archhead"><span class="archname">before</span></div><pre>[omarchy]
Server = https://pkgs.omarchy.org/$repo/$arch

[core]
Include = /etc/pacman.d/mirrorlist
[extra]
Include = /etc/pacman.d/mirrorlist
[multilib]
Include = /etc/pacman.d/mirrorlist</pre></div>
      <div class="arch"><div class="archhead"><span class="archname">with the pool</span></div><pre>[omarchy-packages-stable]
Server = https://pool.firemanxbr.org/$arch
[omarchy-core-stable]
Server = https://pool.firemanxbr.org/$arch
[omarchy-extra-stable]
Server = https://pool.firemanxbr.org/$arch
[omarchy-multilib-stable]
Server = https://pool.firemanxbr.org/$arch
<span class="c"># same host for every repo and both architectures;
# change "stable" to "rc" or "edge" to change rings</span></pre></div>
    </div>
  </section>

  <section>
    <h2>What you trust</h2>
    <p class="sub">Two things, and only two.</p>
    <div class="steps">
      <div class="step"><h3>The projects' own keys — unchanged</h3><p>Packages are the exact files Arch, Arch Linux ARM and Omarchy built and signed. pacman verifies each package with the keyring you already have (<code>archlinux-keyring</code>, <code>archlinuxarm-keyring</code>, Omarchy's key). The pool cannot alter a package without breaking its signature.</p></div>
      <div class="step"><h3>The pool's database key — one import</h3><p>The pacman databases are generated here, so they are signed here. That key signs nothing else, its public part is in the repository and at the pool root, and with <code>SigLevel = Required DatabaseRequired</code> pacman refuses a database it did not sign.</p></div>
    </div>
  </section>

  <section>
    <h2>The pieces</h2>
    <p class="sub">All of it is open source (MIT), released on every merge, and shows its version in the header.</p>
    <div class="table-wrap"><table><thead><tr><th>Piece</th><th>What it is</th></tr></thead><tbody>
      <tr><td>Pool</td><td>A Cloudflare R2 bucket with a custom domain. pacman reads packages and databases from it as plain static files; nothing runs in front of them.</td></tr>
      <tr><td>Index</td><td>A D1 (SQLite) database: one row per package object with its manifest, dependency edges, sonames; releases and ring heads; every event the pipeline records.</td></tr>
      <tr><td>API + this site</td><td>One Cloudflare Worker serving <code>/api/v1</code> and these pages.</td></tr>
      <tr><td>Pipeline</td><td>GitHub Actions workflows: sync (hourly), promote (daily, evidence-gated), health (daily), GC (weekly), metrics (every 30 min), release (every merge). Their runs are linked from the journal.</td></tr>
      <tr><td>Factory</td><td>The build queue lives in the index (requests, tasks, leases); workers are containers anywhere — a laptop, a GitHub-hosted runner — that claim a task, build it in a fresh Arch container, sign, publish into <code>edge</code> and report. A lease that expires goes back to the queue.</td></tr>
      <tr><td>Tools</td><td><code>pkg-repo</code> (publisher: sync, promote, gate, render), <code>pkg-extract</code> (manifests), <code>omarchy-cli</code> (thin client) — Rust, built for both architectures on every release.</td></tr>
    </tbody></table></div>
  </section>
`;

export function howItWorksHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "How it works · omarchy-pool",
    description: "Where the packages come from, how they are verified and stored, how the rings move on evidence, and what a user trusts.",
    active: "how-it-works",
    body: BODY,
    script: "liveStats(function () {}, 120000);",
    poolUrl,
    version,
  });
}
