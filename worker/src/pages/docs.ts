/**
 * Documentation: the index of the chapters (layout.ts DOCS) — for users,
 * contributors, maintainers and whoever wants to know how the thing works.
 */
import { DOCS, page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <h1>Documentation</h1>
  <p class="lede">Everything about the pool in one place: how to use it, how to build for it, how it works and who decides what. The deeper material — architecture, runbook, testing, migration — lives in the repository's <a href="${REPO_URL}/tree/main/docs"><code>docs/</code></a>.</p>

  <section>
    <div class="doc-cards">
      ${DOCS.map((d) => `<a href="${d.href}"><h3>${d.label}</h3><p>${d.blurb}</p></a>`).join("\n      ")}
    </div>
  </section>

  <section>
    <h2>In the repository</h2>
    <div class="table-wrap"><table><thead><tr><th>Document</th><th>What it covers</th></tr></thead><tbody>
      <tr><td><a href="${REPO_URL}/blob/main/docs/ARCHITECTURE.md">ARCHITECTURE.md</a></td><td>the design: pool, index, releases and rings, promotion by evidence, the API, the pipeline of pulled jobs, the security layer</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/docs/RUNBOOK.md">RUNBOOK.md</a></td><td>operating it: jobs by hand, promotions and rollbacks, keys, costs, the kill switch, the scheduler, known limits</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/docs/GOVERNANCE.md">GOVERNANCE.md</a></td><td>contributors and maintainers, groups, the file that names them, bumps and the policy for packages nobody builds</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/SECURITY.md">SECURITY.md</a></td><td>the trust model: who holds which credential, per-job tokens, the key that never leaves the pool, what an attacker gets with each</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/factory/README.md">factory/README.md</a></td><td>the factory in detail: a package's life, the contract with the pool, the worker protocol, the image</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/docs/TESTING.md">TESTING.md</a></td><td>how every piece is verified, locally and in CI</td></tr>
      <tr><td><a href="${REPO_URL}/blob/main/docs/MIGRATION.md">MIGRATION.md</a></td><td>moving the whole thing to another Cloudflare account and GitHub organisation</td></tr>
    </tbody></table></div>
  </section>
`;

export function docsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Documentation · omarchy-pool",
    description: "How to use the pool, how to build for it, how it works and who decides what.",
    active: "docs",
    doc: "index",
    body: BODY,
    poolUrl,
    version,
  });
}
