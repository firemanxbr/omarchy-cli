/**
 * Run a worker: the two container images on GitHub Packages and how to run
 * them with Docker Desktop or Podman — as a contributor building your own
 * packages (and donating your machine, if you like), or as a maintainer
 * running the project's work.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const IMG_PKG = "ghcr.io/firemanxbr/omarchy-packaging";
const IMG_POOL = "ghcr.io/firemanxbr/omarchy-pool-worker";

const BODY = String.raw`
  <h1>Run a worker</h1>
  <p class="lede">Every build for the pool happens on a worker somebody runs: a contributor's laptop for their own packages, a machine a maintainer trusts for the project's work. Both come as container images on GitHub Packages, built for <b>x86_64 and aarch64</b> and signed, and run the same way with <a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a> or <a href="https://podman.io/">Podman</a>. Nothing you run holds a key: the pool signs what it publishes, and your worker's token only asks for work.</p>

  <section>
    <h2>Which image</h2>
    <div class="table-wrap"><table><thead><tr><th>Image</th><th>Who runs it</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>${IMG_PKG}</code><br><span class="sub">Omarchy Packaging</span></td><td>a <b>contributor</b> — anyone who signed in</td><td>builds <em>your</em> registered packages, one task per container, into your staging workspace as evidence for a maintainer. With <code>WORKER_SHARED=1</code> it also builds other contributors' packages: donated compute, and your agent if you run one.</td></tr>
      <tr><td><code>${IMG_POOL}</code><br><span class="sub">Omarchy Pool Worker</span></td><td>a machine a <b>maintainer</b> trusts</td><td>the project's work: the pool's own jobs (sync, promote, health, security, gc, the PKGBUILD reconcile) and the rebuild of packages maintainers approved — what users actually get. Never a build that has no evidence and no review yet.</td></tr>
    </tbody></table></div>
    <p class="sub">Tags: <code>latest</code> is a multi-architecture manifest (your machine pulls its own); <code>x86_64</code> and <code>aarch64</code> pin one; the pool worker also carries the pool's release as a tag (<code>v0.0.66</code>). Every image is signed keyless with cosign; verify before trusting it:</p>
    <div class="steps"><div class="step"><pre>cosign verify ${IMG_PKG}:latest \
  --certificate-identity-regexp 'github.com/firemanxbr/omarchy-pool' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div></div>
  </section>

  <section>
    <h2>Before you start</h2>
    <div class="steps">
      <div class="step"><h3>A container runtime</h3><p><b>Docker Desktop</b> on macOS, Windows or Linux, or <b>Podman</b> — the <code>podman</code> command, or <a href="https://podman-desktop.io/">Podman Desktop</a> with its graphical window. Every command below is shown for both; they differ only in the first word. Give the runtime at least 2 CPUs and 4 GB of memory (Docker Desktop: <em>Settings → Resources</em>; Podman: <code>podman machine set --cpus 4 --memory 8192</code> on macOS); a browser-class package needs far more.</p></div>
      <div class="step"><h3>Which architecture you build</h3><p>A worker builds for its own architecture: an Apple silicon Mac or a Raspberry Pi builds <code>aarch64</code>, an Intel or AMD machine <code>x86_64</code>. Podman on Apple silicon can also build x86_64 through emulation (slow, but it works — the pool's own Mac does it).</p></div>
      <div class="step"><h3>An account, a worker registration</h3><p>Sign in with GitHub (top right), open <a href="/contribute">Contributors</a> and register a worker: a name and its architecture. You get a <b>worker id</b> and a <b>token</b>, shown once. The token is that machine's identity; revoke it on the same page if the machine is lost.</p></div>
    </div>
  </section>

  <section id="contributor">
    <h2>A contributor's worker: your own packages</h2>
    <div class="steps">
      <div class="step"><h3>1. Start it</h3><p>One container is one task: it asks the pool for a build of yours, builds it, uploads the package, the PKGBUILD and the log to your staging workspace, and exits. The restart policy starts the next one.</p>
<pre># Docker Desktop
docker run -d --name omarchy-worker --restart unless-stopped \
  -e WORKER_ID=&lt;your worker id&gt; -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG_PKG}:latest

# Podman
podman run -d --name omarchy-worker --restart unless-stopped \
  -e WORKER_ID=&lt;your worker id&gt; -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG_PKG}:latest</pre>
      <p>Or keep the settings in a file with <a href="${REPO_URL}/blob/main/factory/image/compose.yml">compose.yml</a>: <code>WORKER_ID=… OMARCHY_WORKER_TOKEN=… docker compose up -d</code> (<code>podman compose</code> works the same).</p></div>
      <div class="step"><h3>2. Give it work</h3><p>On <a href="/contribute">Contributors</a>, register a package (the project's URL) and press <b>Build</b>. Your worker picks it up within a minute; the <em>Your builds</em> table follows it, and the <em>A worker of yours</em> table shows it alive. When the build is staged, a maintainer of the group sees it on <a href="/review">Review</a>.</p></div>
      <div class="step"><h3>3. Donate the machine, bring your agent</h3><p>Two switches, both yours to flip:</p>
<pre># also build other contributors' packages (their bumps after 14 days, package requests at once)
  -e WORKER_SHARED=1

# an agent drafts and corrects PKGBUILDs on this machine, with your key — the pool never holds one
  -e ANTHROPIC_API_KEY=sk-…</pre>
      <p>A shared worker with an agent is what turns a <em>package request</em> (a GitHub issue) into a first PKGBUILD and a first build; without one, requests wait. What your agent produces is evidence like any other build: a maintainer reads it before anything reaches users.</p></div>
      <div class="step"><h3>4. Watch it</h3><p>In <b>Docker Desktop</b>, <em>Containers</em> lists <code>omarchy-worker</code> with its state and a <em>Logs</em> tab; in <b>Podman Desktop</b>, the same under <em>Containers</em>. On the command line: <code>docker logs -f omarchy-worker</code> / <code>podman logs -f omarchy-worker</code>. The container exits after each task (that is by design) and the restart policy brings it back.</p>
      <div class="shot">Screenshot to add: Docker Desktop → Containers, the running <code>omarchy-worker</code> and its Logs tab; Podman Desktop → Containers, the same.</div></div>
    </div>
  </section>

  <section id="project">
    <h2>A project worker: the pool's jobs and approved rebuilds</h2>
    <p class="sub">For machines a maintainer trusts. It runs <code>pkg-repo work</code>; every build and every check it does still happens in a <em>fresh</em> Arch container, which it starts as a sibling through your container runtime — so it needs the runtime's socket, and a working directory that has the <b>same path</b> on your machine and inside the container (the sibling containers mount subdirectories of it).</p>
    <div class="steps">
      <div class="step"><h3>1. Register, get trusted</h3><p>Register the worker on <a href="/contribute">Contributors</a> like any other. A maintainer promotes it to project trust (<code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>; the <em>Trust</em> table on <a href="/review">Review</a> lists it). Until then it claims nothing.</p></div>
      <div class="step"><h3>2. Start it — Docker Desktop</h3>
<pre>mkdir -p "$HOME/omarchy-worker"
docker run -d --name omarchy-pool-worker --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG_POOL}:latest --arch aarch64 --labels '{"where":"my-machine"}'</pre>
      <p>Use <code>--arch x86_64</code> on an Intel/AMD machine. On Windows, use a path Docker Desktop shares (under your user profile) for the working directory, with the same spelling on both sides of the <code>-v</code>.</p></div>
      <div class="step"><h3>3. Start it — Podman</h3>
<pre># Linux (rootless): the socket is your user's — enable it once
systemctl --user enable --now podman.socket
podman run -d --name omarchy-pool-worker --restart unless-stopped --security-opt label=disable \
  -v /run/user/$UID/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG_POOL}:latest --arch x86_64

# macOS (podman machine, rootful by default): the socket lives inside the VM
podman run -d --name omarchy-pool-worker --restart unless-stopped --security-opt label=disable \
  -v /run/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG_POOL}:latest --arch aarch64</pre>
      <p><code>--security-opt label=disable</code> lets the container use the socket on SELinux hosts (Fedora, the podman machine). Mounting the socket path you see on macOS (<code>…/podman-machine-default-api.sock</code>) fails with <em>operation not supported</em>: it belongs to the host, not the VM — use the VM's path above.</p></div>
      <div class="step"><h3>4. Or without a container</h3><p>On a Linux host with podman or docker, the release binaries do the same: download <code>omarchy-pool-&lt;version&gt;-&lt;arch&gt;-linux.tar.gz</code> from the <a href="${REPO_URL}/releases/latest">latest release</a> and run <code>pkg-repo work --worker-token omw_… --arch aarch64</code>. Same options as below.</p></div>
      <div class="step"><h3>5. Options</h3>
<pre>--arch aarch64|x86_64     what this machine builds and checks for
--kind build --kind health   only these kinds (default: everything a project worker may run)
--idle-exit 300           exit after five minutes without work (a fallback worker)
--once                    one task, then exit
--labels '{"where":"…"}'  shown on the Factory page</pre>
      <p>A project worker never builds a contributor's package: those run on the contributor's worker, or on a worker somebody donated with <code>WORKER_SHARED=1</code>. What it builds is the rebuild a maintainer approved, and the pool signs the result.</p></div>
    </div>
  </section>

  <section>
    <h2>Keeping it running</h2>
    <div class="steps">
      <div class="step"><h3>Update</h3><p>Images follow the pool's releases. <code>docker pull ${IMG_POOL}:latest</code> (or <code>podman pull</code>), then remove and recreate the container with the same command; a contributor's worker only needs the pull, the next container starts from the new image.</p></div>
      <div class="step"><h3>Stop, remove, revoke</h3><p><code>docker rm -f omarchy-worker</code> stops and removes it. The registration stays until you revoke it on <a href="/contribute">Contributors</a> (or a maintainer does); a revoked token claims nothing, immediately.</p></div>
      <div class="step"><h3>Disk</h3><p>Every task builds in a fresh container that is removed afterwards; images and package caches stay. <code>docker system prune</code> / <code>podman system prune</code> reclaims them. The pool worker's working directory holds the upstream keyrings, a checkout of the repository and the last builds — safe to delete when the worker is stopped.</p></div>
      <div class="step"><h3>Something is off</h3><p><em>permission denied … docker.sock</em>: add <code>--security-opt label=disable</code> (Podman) or check the socket path. <em>No task for a while</em>: a contributor's worker only sees its owner's tasks unless started shared; a project worker only claims once a maintainer trusted it. The Factory page shows every queued task and every worker the pool has heard from.</p></div>
    </div>
  </section>
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Run a worker · omarchy-pool",
    description: "The container images on GitHub Packages and how to run them with Docker Desktop or Podman, as a contributor or a maintainer.",
    active: "docs",
    doc: "workers",
    body: BODY,
    poolUrl,
    version,
  });
}
