/**
 * Run a worker: the two container images on GitHub Packages and how to run
 * them with Docker Desktop or Podman — as a contributor building your own
 * packages (and donating your machine, if you like), or as a maintainer
 * running the project's work.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const IMG = "ghcr.io/firemanxbr/omarchy-worker";

const BODY = String.raw`
  <h1>Run a worker</h1>
  <p class="lede">Every build for the pool happens on a worker somebody runs — a contributor's laptop for their own packages, a machine a maintainer trusts for the project's work — and every worker runs the <b>same image</b>: <code>${IMG}</code>, Arch Linux, built for x86_64 and aarch64 on GitHub Packages and signed. There is no technical difference between a contributor's container and a maintainer's; the <b>registration behind the token</b> decides what it may do. Nothing you run holds a key: the pool signs what it publishes, and your token only asks for work.</p>

  <section>
    <h2>What the registration decides</h2>
    <div class="table-wrap"><table><thead><tr><th>Your registration</th><th>What the container does</th><th>What it needs</th></tr></thead><tbody>
      <tr><td><b>community</b> trust — every registration starts here</td><td>builds <em>your</em> registered packages, one task per container, right inside it, into your staging workspace as evidence for a maintainer. With <code>WORKER_SHARED=1</code> it also builds other contributors' packages (donated compute), with your agent key (<code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code> or <code>XAI_API_KEY</code>) your agent drafts and corrects PKGBUILDs. It never sees a package in review or approved.</td><td>the token</td></tr>
      <tr><td><b>project</b> trust — a maintainer trusted the registration</td><td>the project's work: the pool's own jobs (sync, promote, health, security, gc, the PKGBUILD reconcile) and the rebuild of packages maintainers approved — what users actually get. Each build and check runs in a <em>fresh</em> Arch container it starts as a sibling. With an agent key it also <b>audits</b> staged builds for the maintainers (the second agent). Never a contributor's build.</td><td>the token, the runtime's socket, a working directory at the same path on both sides</td></tr>
    </tbody></table></div>
    <p class="sub">A maintainer who also contributes packages registers a second worker and leaves it untrusted: one registration per role of a machine. Tags: <code>latest</code> is a multi-architecture manifest (your machine pulls its own), <code>x86_64</code> and <code>aarch64</code> pin one, and every pool release is a tag (<code>v0.0.70</code>). Verify before trusting it:</p>
    <div class="steps"><div class="step"><pre>cosign verify ${IMG}:latest \
  --certificate-identity-regexp 'github.com/firemanxbr/omarchy-pool' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div></div>
  </section>

  <section id="roles">
    <h2>The three roles</h2>
    <p class="sub">The project runs its workers as three kinds of container, and anyone donating a machine can run the same. A role is set with <code>OMARCHY_WORKER_ROLE</code>; it narrows what the registration allows, never widens it, and the container refuses to start under a registration that does not match (a <em>pool</em> or <em>review</em> role needs project trust, a <em>community</em> role a community registration). The Factory page shows each worker's role.</p>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th>Registration</th><th>What it does</th><th>Agent key</th></tr></thead><tbody>
      <tr><td><b>pool</b></td><td>project trust</td><td>the pool's own jobs and nothing else: sync, render, promote, rollback, health, security, enqueue, gc, verify. Never a build, never an audit.</td><td>none</td></tr>
      <tr><td><b>review</b></td><td>project trust</td><td>the maintainers' work and nothing else: the rebuild of approved packages in fresh sibling containers, and the audit of every staged build (the second agent). Never a pool job.</td><td>wanted — without one, audits wait</td></tr>
      <tr><td><b>community</b></td><td>community registration</td><td>a shared community worker (<code>WORKER_SHARED=1</code> implied): builds anyone's registered packages and drafts PKGBUILDs for package requests, one task per container.</td><td>wanted — without one, package requests wait</td></tr>
    </tbody></table></div>
    <p class="sub">Two of each — one per architecture — is what the project runs on its own host (RUNBOOK, <em>The Studio host</em>): x86_64 pool jobs are only a label and run natively on any machine; x86_64 <em>builds</em> on an aarch64 host run under user-mode emulation, correct but slower. Without a role the trust decides everything: a project worker takes pool jobs, rebuilds and audits alike; a community worker builds its owner's packages.</p>
  </section>

  <section>
    <h2>Before you start</h2>
    <div class="steps">
      <div class="step"><h3>A container runtime</h3><p><b>Docker Desktop</b> on macOS, Windows or Linux, or <b>Podman</b> — the <code>podman</code> command, or <a href="https://podman-desktop.io/">Podman Desktop</a> with its graphical window. Every command below is shown for both; they differ only in the first word. Give the runtime at least 2 CPUs and 4 GB of memory (Docker Desktop: <em>Settings → Resources</em>; Podman on macOS: <code>podman machine set --cpus 4 --memory 8192</code>); a browser-class package needs far more.</p></div>
      <div class="step"><h3>Which architecture you build</h3><p>A worker builds for its own architecture: an Apple silicon Mac or a Raspberry Pi builds <code>aarch64</code>, an Intel or AMD machine <code>x86_64</code>. Register the worker for the architecture of the machine it will run on; the image refuses a mismatch.</p></div>
      <div class="step"><h3>An account, a worker registration</h3><p>Sign in with GitHub (top right), open <a href="/factory">the Factory</a> and register a worker: a name and its architecture. You get a <b>token</b>, shown once — that machine's identity. Revoke it on the same page if the machine is lost.</p></div>
    </div>
  </section>

  <section id="contributor">
    <h2>As a contributor: your own packages</h2>
    <div class="steps">
      <div class="step"><h3>1. Start it</h3><p>One container is one task: it asks the pool for a build of yours, builds it, uploads the package, the PKGBUILD and the log to your staging workspace, and exits. The restart policy starts the next one.</p>
<pre># Docker Desktop
docker run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; -e GITHUB_TOKEN="$(gh auth token)" \
  ${IMG}:latest

# Podman
podman run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; -e GITHUB_TOKEN="$(gh auth token)" \
  ${IMG}:latest</pre>
      <p>Or keep the settings in a file with <a href="${REPO_URL}/blob/main/factory/image/compose.yml">compose.yml</a>: <code>OMARCHY_WORKER_TOKEN=… GITHUB_TOKEN=… docker compose up -d</code> (<code>podman compose</code> works the same).</p>
      <p><b>GITHUB_TOKEN</b>: the worker reads GitHub's API for every package it builds — the release, the files. Without a token GitHub allows 60 requests an hour from your address, and a queue of ten builds is ten failures; a fine-grained token with <em>no permissions at all</em> gives 5000. <b>--stop-timeout</b> (compose: <code>stop_grace_period</code>): a stop lets the build finish and report; killed mid-build, the task waits half an hour for its lease to expire. Change the settings between builds, not during one.</p></div>
      <div class="step"><h3>2. Give it work</h3><p>On <a href="/factory">the Factory</a>, register a package (the project's URL) and press <b>Build</b>. Your worker picks it up within a minute; the <em>Your builds</em> table follows it, and the <em>A worker of yours</em> table shows it alive. When the build is staged, a maintainer of the group sees it on <a href="/review">Review</a>.</p></div>
      <div class="step"><h3>3. Donate the machine, bring your agent</h3><p>Two switches, both yours to flip:</p>
<pre># also build other contributors' packages (their bumps after 14 days, package requests at once)
  -e WORKER_SHARED=1

# an agent drafts and corrects PKGBUILDs on this machine, with your key — the pool never holds one;
# one of these is enough (Anthropic, OpenAI, Gemini, xAI), FACTORY_MODEL picks the model
  -e ANTHROPIC_API_KEY=sk-…      # or OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY
  -e FACTORY_MODEL=claude-sonnet-5

# or your Claude subscription instead of a key (see "A Claude subscription as the agent" below)
  -e CLAUDE_CODE_OAUTH_TOKEN=…    # what 'claude setup-token' printed on your machine</pre>
      <p>The Factory page shows which agent each worker reported (<code>anthropic/claude-sonnet-5</code>, <code>claude-code/claude-sonnet-5</code>, <code>openai/gpt-5</code>, …); the key itself never leaves your machine.</p>
      <p>A shared worker with an agent is what turns a <em>package request</em> (a GitHub issue) into a first PKGBUILD and a first build; without one, requests wait. What your agent produces is evidence like any other build: a maintainer reads it before anything reaches users.</p></div>
      <div class="step"><h3>4. Watch it</h3><p>In <b>Docker Desktop</b>, <em>Containers</em> lists <code>omarchy-worker</code> with its state and a <em>Logs</em> tab; in <b>Podman Desktop</b>, the same under <em>Containers</em>. On the command line: <code>docker logs -f omarchy-worker</code> / <code>podman logs -f omarchy-worker</code>. The container exits after each task (that is by design) and the restart policy brings it back.</p>
      <div class="shot">Screenshot to add: Docker Desktop → Containers, the running <code>omarchy-worker</code> and its Logs tab; Podman Desktop → Containers, the same.</div></div>
    </div>
  </section>

  <section id="project">
    <h2>As a maintainer: the pool's jobs and approved rebuilds</h2>
    <p class="sub">Once a maintainer trusts the registration (<code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>; the <em>Trust</em> table on <a href="/review">Review</a> lists it), the same image switches to the project's work. Each build and check runs in a fresh Arch container it starts as a sibling through your runtime — so it needs the runtime's socket, and a working directory that has the <b>same path</b> on your machine and inside the container (the sibling containers mount subdirectories of it).</p>
    <div class="steps">
      <div class="step"><h3>1. Docker Desktop</h3>
<pre>mkdir -p "$HOME/omarchy-worker"
docker run -d --name omarchy-worker --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest --labels '{"where":"my-machine"}'</pre>
      <p>On Windows, use a path Docker Desktop shares (under your user profile) for the working directory, with the same spelling on both sides of the <code>-v</code>.</p></div>
      <div class="step"><h3>2. Podman</h3>
<pre># Linux (rootless): the socket is your user's — enable it once
systemctl --user enable --now podman.socket
podman run -d --name omarchy-worker --restart unless-stopped --security-opt label=disable \
  -v /run/user/$UID/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest

# macOS (podman machine, rootful by default): the socket lives inside the VM
podman run -d --name omarchy-worker --restart unless-stopped --security-opt label=disable \
  -v /run/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest</pre>
      <p><code>--security-opt label=disable</code> lets the container use the socket on SELinux hosts (Fedora, the podman machine). Mounting the socket path you see on macOS (<code>…/podman-machine-default-api.sock</code>) fails with <em>operation not supported</em>: it belongs to the host, not the VM — use the VM's path above.</p></div>
      <div class="step"><h3>3. Or without a container</h3><p>On a Linux host with podman or docker, the release binaries do the same: download <code>omarchy-pool-&lt;version&gt;-&lt;arch&gt;-linux.tar.gz</code> from the <a href="${REPO_URL}/releases/latest">latest release</a> and run <code>pkg-repo work --worker-token omw_… --arch aarch64</code>. Same options as below.</p></div>
      <div class="step"><h3>4. Options</h3><p>Anything after the image name goes to <code>pkg-repo work</code>:</p>
<pre>--kind build --kind health   only these kinds (default: everything a project worker may run)
--idle-exit 300           exit after five minutes without work (a fallback worker)
--once                    one task, then exit
--labels '{"where":"…"}'  shown on the Factory page</pre>
      <p>A project worker never builds a contributor's package: those run on the contributor's worker, or on a worker somebody donated with <code>WORKER_SHARED=1</code>. What it builds is the rebuild a maintainer approved — never one the same maintainer brought — and the pool signs the result.</p></div>
      <div class="step"><h3>5. The second agent</h3><p>Add your agent key — <code>-e ANTHROPIC_API_KEY=sk-…</code>, or <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>XAI_API_KEY</code>, or a Claude subscription as <code>CLAUDE_CODE_OAUTH_TOKEN</code> (<a href="#claude-code">below</a>); your key, on your machine; <code>-e FACTORY_MODEL=…</code> picks the model — and the worker also takes the <b>audit</b> of every build a contributor stages: it reads the PKGBUILD, the log and the <code>.PKGINFO</code> the maintainer will read, asks the model for a structured review — supply chain, security, packaging practice, licence — and attaches the report to the evidence. <a href="/review">Review</a> shows the verdict next to the build; the maintainer still decides. No such worker running, and the column says <em>waiting</em>.</p></div>
    </div>
  </section>

  <section id="claude-code">
    <h2>A Claude subscription as the agent</h2>
    <p class="sub">A Claude Pro or Max subscription can be the worker's agent instead of an API key: the worker runs <b>Claude Code in print mode</b> — <code>claude -p</code>, no tools, no session, the report as JSON — with a token from your own login. Nothing else changes: the same drafts, the same audits, the same evidence for the maintainer.</p>
    <div class="steps">
      <div class="step"><h3>1. A token, on your machine</h3><p>With Claude Code installed and logged in on the machine you use (the Studio, the laptop — not the worker), run</p>
<pre>claude setup-token</pre>
      <p>It opens the browser for a one-time consent and prints a long-lived token (<code>sk-ant-oat01-…</code>). That token is your subscription: keep it like a password, revoke it from your Claude account when a machine is lost. The worker never needs your login, only this.</p></div>
      <div class="step"><h3>2. Give it to the worker</h3>
<pre># a contributor's worker (docker works the same)
podman run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; -e GITHUB_TOKEN="$(gh auth token)" \
  -e CLAUDE_CODE_OAUTH_TOKEN=&lt;sk-ant-oat01-…&gt; \
  ${IMG}:latest

# with compose: the same variable in the environment or a .env file
CLAUDE_CODE_OAUTH_TOKEN=… OMARCHY_WORKER_TOKEN=… podman compose up -d

# a project host (factory/host): the line goes in etc/agent.env, which the review
# and community services read; FACTORY_PROVIDER makes the choice explicit when an
# API key sits in the same file
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
FACTORY_PROVIDER=claude-code</pre>
      <p>At start the worker installs Claude Code for its architecture (the official installer, checksum verified, into the container's home — about 200 MB, once per container; the image does not ship it) and reports <code>claude-code/claude-sonnet-5</code> as its agent on the Factory page. <code>FACTORY_MODEL</code> picks another model (<code>claude-opus-5</code>); <code>FACTORY_REASONING=low</code> keeps a draft or an audit from thinking longer than it needs. A binary of your own, mounted at <code>/usr/local/bin/claude</code> or named by <code>CLAUDE_CODE_BIN</code>, skips the install.</p></div>
      <div class="step"><h3>3. What it does, exactly</h3><p>Every completion is one process: <code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>, the PKGBUILD and the log on stdin, in an empty directory. No tool is available to the model — it cannot read a file, run a command or reach the network; it answers, and the worker reads the answer. The token goes to the child process; an <code>ANTHROPIC_API_KEY</code> in the same environment is withheld from it, so choosing the subscription means the subscription.</p></div>
      <div class="step"><h3>4. What it costs, and whose rules</h3><p>Nothing on top of the subscription — and the subscription's limits apply: each draft and each audit is a message in the same five-hour and weekly windows as your own use of Claude, and a worker that hits the limit fails the task (<em>You've hit your limit</em>, back in the queue for the next window; the pool retries an audit three times). Your agreement with Anthropic is what allows this use: read their consumer terms on automated and shared use before you put the token on a shared worker or a project host — the API key (<code>ANTHROPIC_API_KEY</code>, a workspace with a spending limit in the Console) is the plain path, and switching is one variable.</p></div>
    </div>
  </section>

  <section>
    <h2>Keeping it running</h2>
    <div class="steps">
      <div class="step"><h3>Update</h3><p>The image follows the pool's releases. <code>docker pull ${IMG}:latest</code> (or <code>podman pull</code>), then remove and recreate the container with the same command; a contributor's worker only needs the pull, the next container starts from the new image.</p></div>
      <div class="step"><h3>Stop, remove, revoke</h3><p><code>docker rm -f omarchy-worker</code> stops and removes it. The registration stays until you revoke it on <a href="/factory">the Factory</a> (or a maintainer does); a revoked token claims nothing, immediately.</p></div>
      <div class="step"><h3>Disk</h3><p>Every task builds in a fresh container that is removed afterwards; images and package caches stay. <code>docker system prune</code> / <code>podman system prune</code> reclaims them. A project worker's working directory holds the upstream keyrings, a checkout of the repository and the last builds — safe to delete when the worker is stopped.</p></div>
      <div class="step"><h3>Something is off</h3><p><em>the pool did not accept this token</em>: it was revoked, or mistyped. <em>registered for aarch64 but this machine is x86_64</em>: register a worker for this machine. <em>mount its socket</em>: the registration is project-trusted and needs the runtime's socket (above). <em>permission denied … docker.sock</em>: add <code>--security-opt label=disable</code> (Podman) or check the socket path. <em>No task for a while</em>: a contributor's worker only sees its owner's tasks unless started shared; a project worker only claims once trusted. The Factory page shows every queued task and every worker the pool has heard from.</p></div>
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
