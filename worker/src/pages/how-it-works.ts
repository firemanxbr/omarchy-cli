/**
 * How it works: where the packages come from, what happens to each one, how
 * the rings move, what a user trusts, and why one Server= line is enough.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

/** Flow diagram in the page's own palette (inline SVG, scales with the column). */
const DIAGRAM = String.raw`
<svg viewBox="0 0 1180 470" xmlns="http://www.w3.org/2000/svg" font-family="JetBrains Mono, ui-monospace, monospace" font-size="12.5">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker></defs>
  <style>
    .box{fill:#1f2230;stroke:#2a2e3f;stroke-width:1.2}.src{fill:#13141c;stroke:#2a2e3f}.green{stroke:#9ece6a}.blue{stroke:#7aa2f7}.amber{stroke:#e0af68}
    .t{fill:#c0caf5;font-family:Geist,sans-serif;font-weight:600;font-size:15px}.s{fill:#a9b1d6}.d{fill:#8b93b8;font-size:11.5px}.g{fill:#9ece6a}.b{fill:#7aa2f7}
    .ln{fill:none;stroke:#8b93b8;stroke-width:1.4;marker-end:url(#a)}
  </style>
  <!-- sources -->
  <rect class="box src" x="20" y="30" width="230" height="64" rx="3"/><text class="t" x="34" y="54">Arch Linux · x86_64</text><text class="s" x="34" y="76">core · extra · multilib</text><text class="d" x="34" y="90">mirror.omarchy.org · archlinux keyring</text>
  <rect class="box src" x="20" y="110" width="230" height="64" rx="3"/><text class="t" x="34" y="134">Arch Linux ARM · aarch64</text><text class="s" x="34" y="156">core · extra · alarm</text><text class="d" x="34" y="170">os.archlinuxarm.org · ALARM keyring</text>
  <rect class="box src" x="20" y="190" width="230" height="64" rx="3"/><text class="t" x="34" y="214">Omarchy (OPR) · both</text><text class="s" x="34" y="236">edge / rc / stable channels</text><text class="d" x="34" y="250">pkgs.omarchy.org · Omarchy key</text>
  <rect class="box src" x="20" y="270" width="230" height="64" rx="3"/><text class="t" x="34" y="294">chaotic-aur · x86_64 <tspan class="d">optional</tspan></text><text class="s" x="34" y="316">prebuilt AUR, only unclaimed names</text><text class="d" x="34" y="330">builds.garudalinux.org · chaotic key</text>
  <path class="ln" d="M250 302 L318 302 L318 142 L340 142"/>
  <text class="d" x="20" y="362">upstream repositories, read every hour</text>
  <!-- verify -->
  <path class="ln" d="M250 62 L318 62 L318 142 L340 142"/><path class="ln" d="M250 142 L340 142"/><path class="ln" d="M250 222 L318 222 L318 142 L340 142"/>
  <rect class="box amber" x="342" y="104" width="190" height="76" rx="3"/><text class="t" x="356" y="130">Verify</text><text class="s" x="356" y="150">sha256 from the upstream db</text><text class="s" x="356" y="166">signature by the project's key</text>
  <!-- pool + index -->
  <path class="ln" d="M532 142 L600 142"/>
  <rect class="box green" x="602" y="34" width="280" height="96" rx="3"/><text class="t" x="616" y="60">Pool · R2</text><text class="s" x="616" y="80">one object per sha256, immutable</text><text class="s" x="616" y="96">the package and its upstream .sig</text><text class="d" x="616" y="118">pool.firemanxbr.org/&lt;arch&gt;/</text>
  <rect class="box blue" x="602" y="150" width="280" height="100" rx="3"/><text class="t" x="616" y="176">Index · D1</text><text class="s" x="616" y="196">manifests, dependencies, provides,</text><text class="s" x="616" y="212">sonames each binary loads, file lists</text><text class="d" x="616" y="236">pkgs.firemanxbr.org/api/v1</text>
  <!-- rings -->
  <path class="ln" d="M882 194 L938 194"/>
  <rect class="box" x="940" y="40" width="228" height="58" rx="3"/><text class="t" x="954" y="62">edge</text><text class="s" x="954" y="82">follows upstream, hourly</text>
  <rect class="box" x="940" y="120" width="228" height="58" rx="3"/><text class="t" x="954" y="142">rc</text><text class="s" x="954" y="162">daily · health + ABI checks</text>
  <rect class="box green" x="940" y="200" width="228" height="58" rx="3"/><text class="t" x="954" y="222">stable <tspan class="g" font-size="11">recommended</tspan></text><text class="s" x="954" y="242">3-day soak · automatic rollback</text>
  <path class="ln" d="M1054 98 L1054 118"/><path class="ln" d="M1054 178 L1054 198"/>
  <text class="d" x="940" y="284">a ring is a pinned selection in the index;</text><text class="d" x="940" y="298">promotion = index write, no bytes copied</text>
  <!-- render -->
  <rect class="box" x="602" y="300" width="280" height="70" rx="3"/><text class="t" x="616" y="324">Render + sign</text><text class="s" x="616" y="344">omarchy-&lt;source&gt;-&lt;ring&gt;.db and .files</text><text class="s" x="616" y="360">per arch, stored beside the packages</text>
  <path class="ln" d="M940 229 L910 229 L910 335 L882 335"/>
  <text class="d" x="602" y="396">GitHub Actions runs every step; each run is linked from the journal</text>
  <!-- user -->
  <path class="ln" d="M602 335 L580 335 L580 421 L562 421"/>
  <rect class="box green" x="270" y="388" width="290" height="66" rx="3"/><text class="t" x="284" y="412">Your machine · pacman</text><text class="s" x="284" y="432">[omarchy-core-stable] → pool/$arch</text><text class="d" x="284" y="447">plain HTTP, static files, any pacman</text>
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
    </tbody></table></div>
  </section>

  <section>
    <h2>What happens to a package</h2>
    <div class="steps">
      <div class="step"><h3>1. Sync</h3><p>Every hour the upstream database is read and compared with the index by sha256; only what is missing is downloaded. Each file is checked against the upstream checksum and signature, its <code>.PKGINFO</code>, dependencies, <code>provides</code>, file list and the sonames its binaries load are extracted, and the archive plus its <code>.sig</code> are stored in the pool under <code>&lt;arch&gt;/&lt;filename&gt;</code>. A file is never stored twice and never modified.</p></div>
      <div class="step"><h3>2. Pin</h3><p>The sync then creates a new <b>edge</b> release: an immutable list of exactly which objects the ring serves. Releases are append-only; every ring has a history you can point it back to.</p></div>
      <div class="step"><h3>3. Promote on evidence</h3><p>Once a day a real pacman syncs the source ring in a container on x86_64 and on aarch64, and <code>omarchy-cli check</code> runs the ELF-level safety check on every upgrade the ring would apply to a reference system. A gate reads that evidence: the latest checks must be green, nothing may have failed inside the soak window (three days for stable), a recent ABI check must have no blockers. Only then is the selection copied to the next ring — an index write, no bytes move.</p></div>
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
    script: "liveStats(function () {}, 30000);",
    poolUrl,
    version,
  });
}
