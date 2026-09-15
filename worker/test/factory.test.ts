/**
 * The factory's brain inside workerd: registered workers claim with their
 * own token and get a lease and a per-job token; a community build stages
 * its evidence and queues the audit; only a project worker with the kind
 * takes the audit and only its report may be written; maintainers approve
 * — never their own package, no exception — and nothing of the contributor's
 * is copied: the project builds the recipe a maintainer merged, and that
 * build is linked back to the approval it answers. The same story
 * tests/e2e-worker.sh tells with real containers, in seconds.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { requeueExpiredLeases, workerReady } from "../src/routes/factory";
import { packageKey } from "../src/r2";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Two project workers (aarch64) and one community worker owned by a
// contributor; one group whose maintainer is 'm1' — exactly what
// POST /factory/workers, a maintainer's trust and MAINTAINERS.toml produce.
beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('w1', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w2', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w3', 'aarch64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z')`).bind(await h("omw_w1"), await h("omw_w2"), await h("omw_w3")),
    env.DB.prepare(`INSERT INTO factory_groups (name, description, maintainers) VALUES ('community', 'everything else', '["m1"]')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, role, areas) VALUES ('m1', ?, 'maintainer', '["community"]'), ('m2', ?, 'maintainer', '["community"]'), ('alice', ?, 'contributor', '[]')`).bind(await h("omc_m1"), await h("omc_m2"), await h("omc_alice")),
  ]);
});

describe("claims and leases", () => {
  it("a worker claims only with its own token, for its own architecture, and gets nothing from an empty queue", async () => {
    expect((await call("POST", "/factory/claim", { arch: "aarch64" })).status).toBe(401);
    expect((await call("POST", "/factory/claim", { arch: "x86_64" }, "omw_w1")).status).toBe(400);
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w1")).status).toBe(204);
    const self = await call("GET", "/factory/workers/self", undefined, "omw_w3");
    expect(self.json).toMatchObject({ id: "w3", arch: "aarch64", trust: "community", owner: "alice", mode: "dedicated" });
  });

  it("a maintainer enqueues a project build; a project worker takes it with a lease and a job token; a failure requeues it", async () => {
    expect((await call("POST", "/factory/enqueue", { name: "tool", group: "community", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"] })).status).toBe(401);
    const q = await call("POST", "/factory/enqueue", { name: "tool", group: "community", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" }, "omc_m1");
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    expect(q.json.tasks).toHaveLength(1);
    const id = q.json.tasks[0].id ?? q.json.tasks[0];
    // The community worker never sees a project build.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", hostname: "test", agent: "openai/gpt-5" }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(id);
    expect(c.json.task.status).toBe("leased");
    expect(c.json.token).toMatch(/^omj\./);
    expect(c.json.pkgbuild_path).toBe("factory/pkgbuilds/community/tool");
    // The task is leased: nobody else gets it; the job token heartbeats and moves the lease.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w2")).status).toBe(204);
    expect((await call("POST", `/factory/tasks/${id}/heartbeat`, {}, "omw_w2")).status).toBe(409);
    const hb = await call("POST", `/factory/tasks/${id}/heartbeat`, {}, c.json.token);
    expect(hb.status).toBe(200);
    expect(hb.json.token).toMatch(/^omj\./);
    // What the worker reported it runs shows on the Factory list; the key never travels.
    const fac = await call("GET", "/factory");
    expect(fac.json.workers.find((w: any) => w.id === "w1").agent).toBe("openai/gpt-5");
    expect(fac.json.workers.find((w: any) => w.id === "w1").current_task).toBe(id);
    // Fail: back in the queue behind its peers, attempts counted.
    const f = await call("POST", `/factory/tasks/${id}/fail`, { error: "boom" }, hb.json.token);
    expect(f.json).toMatchObject({ status: "queued", attempts: 1 });
    // The other project worker takes it; completing needs the package in the pool first.
    const c2 = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w2");
    expect(c2.json.task.id).toBe(id);
    expect((await call("POST", `/factory/tasks/${id}/complete`, { sha256: "0".repeat(64), filename: "nope" }, c2.json.token)).status).toBe(409);
    const filename = "tool-1.0-1-aarch64.pkg.tar.zst";
    const bytes = new TextEncoder().encode("fake tool");
    await env.PACKAGES.put(packageKey("factory", "aarch64", filename), bytes);
    const sha = "a".repeat(64);
    const idx = await call("POST", "/packages?source=factory&arch=aarch64", { schema_version: 1, name: "tool", version: "1.0-1", arch: "aarch64", sha256: sha, filename, size_download: bytes.length, size_installed: 1, provides: ["tool"], requires: [] }, c2.json.token);
    expect(idx.status, JSON.stringify(idx.json)).toBe(201);
    const done = await call("POST", `/factory/tasks/${id}/complete`, { sha256: sha, filename, version: "1.0-1", duration_ms: 1200 }, c2.json.token);
    expect(done.json).toMatchObject({ task: id, status: "done" });
    // The job token dies with the task.
    expect((await call("POST", `/factory/tasks/${id}/heartbeat`, {}, c2.json.token)).status).toBe(409);
    const built = await call("GET", "/factory/built");
    expect(built.json.built.some((t: any) => t.name === "tool" && t.arch === "aarch64")).toBe(true);
    // The lease is over, but who held it stays on the row: the load per worker and the seal read it later.
    const row = await env.DB.prepare("SELECT status, lease_owner, lease_expires_at FROM build_tasks WHERE id = ?").bind(id).first<{ status: string; lease_owner: string | null; lease_expires_at: string | null }>();
    expect(row).toMatchObject({ status: "done", lease_owner: "w2", lease_expires_at: null });
    const stats = await call("GET", "/stats");
    expect(stats.json.series.workers_daily.some((w: any) => w.worker === "w2" && Number(w.ms) === 1200)).toBe(true);
  });
});

describe("a community build, its audit and the review", () => {
  let task: number;
  let jobToken: string;

  it("the owner's worker stages the evidence with its job token; the builder cannot write the audit", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'community', 'aarch64', '1.0-1', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    // Project workers never build a contributor's package.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w1")).status).toBe(204);
    // A draft is the agent's work: a worker with no agent, or one whose probe failed, gets nothing; one whose agent answered gets it.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "" }, "omw_w3")).status).toBe(204);
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "error", agent_error: "HTTP 402: insufficient credit" }, "omw_w3")).status).toBe(204);
    // (GET /factory is edge-cached for ten seconds: the row is the check.)
    const w3row = async () => (await env.DB.prepare("SELECT last_seen, kinds, trust, agent, agent_status, agent_error FROM build_workers WHERE id = 'w3'").first<{ last_seen: string; kinds: string | null; trust: string; agent: string | null; agent_status: string | null; agent_error: string | null }>())!;
    let w3 = await w3row();
    expect(w3).toMatchObject({ agent: "openai/gpt-5", agent_status: "error", agent_error: "HTTP 402: insufficient credit", kinds: '["build"]' });
    expect(workerReady(w3, Date.now() - 600000)).toBe(false);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "ok", agent_checked_at: "2026-09-15T12:00:00Z" }, "omw_w3");
    expect(c.status).toBe(200);
    w3 = await w3row();
    expect(w3).toMatchObject({ agent_status: "ok", agent_error: null });
    expect(workerReady(w3, Date.now() - 600000)).toBe(true);
    task = c.json.task.id;
    jobToken = c.json.token;
    expect(c.json.upload).toBe(`/api/v1/factory/tasks/${task}/artifacts/<filename>`);
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "mine-1.0-1-aarch64.pkg.tar.zst"]) {
      expect((await call("PUT", `/factory/tasks/${task}/artifacts/${f}`, undefined, jobToken, `evidence ${f}`)).status).toBe(201);
    }
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, jobToken, "{}")).status).toBe(403);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/PKGBUILD`, undefined, "omw_w1", "x")).status).toBe(409);
    // Completing before the package is uploaded is refused; after, the build is staged and the audit queued.
    expect((await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "other.pkg.tar.zst" }, jobToken)).status).toBe(409);
    const st = await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1" }, jobToken);
    expect(st.json.status).toBe("staged");
    const review = await call("GET", "/factory/review");
    const row = review.json.staged.find((t: any) => t.id === task);
    expect(row.audit).toEqual({ status: "queued" });
    expect(row.evidence.audit).toBe(`/api/v1/factory/tasks/${task}/artifacts/audit.md`);
    // The PKGBUILD, the log and the .PKGINFO are public; the package is not.
    const ctx = createExecutionContext();
    const pk = await worker.fetch(new Request(`${API}/factory/tasks/${task}/artifacts/PKGINFO`), env, ctx);
    expect(await pk.text()).toBe("evidence PKGINFO");
    expect((await call("GET", `/factory/tasks/${task}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`)).status).toBe(403);
  });

  it("only a project worker declaring the kind takes the audit, and it may write the report only", async () => {
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"] }, "omw_w3")).status).toBe(204);
    // The second agent must answer too: a project worker whose agent is down is not handed the audit.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"], agent: "claude-code/claude-sonnet-5", agent_status: "error", agent_error: "claude-code: no answer in 90 s" }, "omw_w1")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w1");
    // The label with a hyphen in the provider is kept (it was refused until 2026-09-15: every Studio worker showed no agent).
    expect(await env.DB.prepare("SELECT agent, agent_status FROM build_workers WHERE id = 'w1'").first()).toEqual({ agent: "claude-code/claude-sonnet-5", agent_status: "ok" });
    expect(c.status).toBe(200);
    expect(c.json.task.kind).toBe("audit");
    expect(c.json.task.params.task).toBe(task);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/PKGBUILD`, undefined, c.json.token, "x")).status).toBe(400);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, c.json.token, '{"verdict":"warn"}')).status).toBe(201);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.md`, undefined, c.json.token, "# Audit: warn")).status).toBe(201);
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "warn", result: { verdict: "warn", summary: "SKIP checksum", model: "test", findings: [{ severity: "high", area: "supply-chain" }] } }, c.json.token);
    expect(done.json.status).toBe("done");
    const review = await call("GET", "/factory/review");
    expect(review.json.staged.find((t: any) => t.id === task).audit).toMatchObject({ status: "done", verdict: "warn", findings: 1, high: 1, model: "test" });
  });

  it("a newer build of the same package supersedes the staged one before it", async () => {
    // alice's worker builds mine again (a fix): the earlier staged row is cancelled with its pending audit, and the review queue shows one.
    await env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'community', 'aarch64', '1.0-2', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "ok" }, "omw_w3");
    expect(c.status).toBe(200);
    const again = c.json.task.id;
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "mine-1.0-2-aarch64.pkg.tar.zst"]) await call("PUT", `/factory/tasks/${again}/artifacts/${f}`, undefined, c.json.token, `evidence ${f}`);
    expect((await call("POST", `/factory/tasks/${again}/complete`, { sha256: "d".repeat(64), filename: "mine-1.0-2-aarch64.pkg.tar.zst", version: "1.0-2" }, c.json.token)).json.status).toBe("staged");
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(task).first()).toMatchObject({ status: "cancelled", error: `superseded by task ${again} (1.0-2)` });
    const staged = (await call("GET", "/factory/review")).json.staged.filter((t: any) => t.name === "mine");
    expect(staged.map((t: any) => t.id)).toEqual([again]);
    // The rest of the story continues with the build that stands.
    task = again;
  });

  it("a maintainer of the group approves — never their own package, no exception — and nothing of the contributor's is queued", async () => {
    expect((await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_alice")).status).toBe(403);
    expect((await call("POST", `/factory/tasks/${task}/reject`, {}, "omc_m1")).status).toBe(400); // a note is required
    // 'alice' brought it, so m1 may approve. Make it m1's own first: the sole maintainer of the group, still 403 — no bootstrap.
    await env.DB.prepare("UPDATE build_tasks SET owner = 'm1' WHERE id = ?").bind(task).run();
    const sole = await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_m1");
    expect(sole.status).toBe(403);
    expect(sole.json.error).toMatch(/one maintainer cannot approve/);
    await env.DB.prepare(`UPDATE factory_groups SET maintainers = '["m1","m2"]' WHERE name = 'community'`).run();
    expect((await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_m1")).status).toBe(403);
    const other = await call("POST", `/factory/tasks/${task}/approve`, { note: "looks right" }, "omc_m2");
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ decision: "approved", by: "m2", recipe: "factory/pkgbuilds/community/mine/PKGBUILD" });
    expect((await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_m2")).status).toBe(409);
    // No task was queued from the staged artifacts: the project builds only what a maintainer merges.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE pkgbuild_ref LIKE 'staging:%' AND kind = 'build'").first<{ n: number }>())!.n).toBe(0);
    // Approved builds leave the review queue; the record keeps the decision, without a build yet.
    expect((await call("GET", "/factory/review")).json.staged.some((t: any) => t.id === task)).toBe(false);
    const approvals = await call("GET", "/factory/approvals");
    expect(approvals.json.approvals[0]).toMatchObject({ task_id: task, decision: "approved", by: "m2", rebuild_task: null });
    // The profile's track record: m2 signed one approval in 'community'.
    const m2 = await call("GET", "/users/m2");
    expect(m2.json.record).toEqual([{ group: "community", contributed: { approved: 0, staged: 0, bumps: 0, donated: 0, rejected: 0 }, maintained: { approvals: 1, rejections: 0, rebuilds_failed: 0 }, score: 2 }]);
  });

  it("the project's build of the merged recipe completes with the seal: linked to the approval, the chain as JSON, an attestation next to the object", async () => {
    // The recipe m2 wrote landed on main: the enqueue job queues the project build at that commit.
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, "group", arches, status) VALUES ('mine', 'm1', 'https://github.com/alice/mine', 'community', '["aarch64"]', 'approved')`).run();
    const q = await call("POST", "/factory/enqueue", { name: "mine", group: "community", pkgbuild_ref: "9f1c2ab", reason: "merged", arches: ["aarch64"], version: "1.0-1" }, "omc_m2");
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    // The trusted worker claims it, publishes the package to the pool with the job token, completes.
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"] }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.pkgbuild_ref).toBe("9f1c2ab");
    const filename = "mine-1.0-1-aarch64.pkg.tar.zst";
    const bytes = new TextEncoder().encode("the project's build of mine");
    await env.PACKAGES.put(packageKey("factory", "aarch64", filename), bytes);
    const s = "c".repeat(64);
    const indexed = await call("POST", "/packages?source=factory&arch=aarch64", { schema_version: 1, name: "mine", version: "1.0-1", arch: "aarch64", sha256: s, filename, size_download: bytes.length, size_installed: 1, description: "mine", provides: ["mine"], requires: [], files: [] }, c.json.token);
    expect(indexed.status, JSON.stringify(indexed.json)).toBe(201);
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { sha256: s, filename, version: "1.0-1", duration_ms: 60000 }, c.json.token);
    expect(done.json).toMatchObject({ status: "done", attested: true });
    // The build is what users get: the registration is published, the approval it answers keeps the task.
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "published" });
    // (/factory/approvals is served from the edge cache for 30 s — the row itself is the check.)
    expect(await env.DB.prepare("SELECT task_id, rebuild_task FROM approvals ORDER BY id DESC LIMIT 1").first()).toEqual({ task_id: task, rebuild_task: c.json.task.id });
    // The seal: the whole chain, from the contributor's build that was the evidence to the approval and the merged recipe.
    const seal = (await call("GET", `/packages/${s}/provenance`)).json;
    expect(seal).toMatchObject({ origin: "factory", seal: "built by the Omarchy Pool", name: "mine", version: "1.0-1" });
    expect(seal.chain).toMatchObject({
      builder: { worker: "w1", trust: "project" },
      build: { task: c.json.task.id, arch: "aarch64" },
      recipe: { ref: "9f1c2ab", commit: "9f1c2ab", path: "factory/pkgbuilds/community/mine/PKGBUILD", learned_from: `/api/v1/factory/tasks/${task}/artifacts/PKGBUILD` },
      source_build: { task, worker: "w3" },
      approval: { by: "m2", note: "looks right", of_task: task },
    });
    // The superseding build's audit never ran (the decision came first and cancelled it): the seal says so, and the summary skips the verdict.
    expect(seal.chain.audit).toEqual({ verdict: null, status: "cancelled" });
    expect(seal.summary).toBe("built by the project on w1, approved by m2, signed by the pool");
    // The attestation: an in-toto Statement about exactly this object, in the pool beside it.
    expect(seal.object).toBe(`${env.POOL_URL}/factory/aarch64/${filename}`);
    expect(seal.attestation.statement).toBe(`${env.POOL_URL}/factory/aarch64/${filename}.provenance.json`);
    const obj = await env.PACKAGES.get(packageKey("factory", "aarch64", `${filename}.provenance.json`));
    const statement = JSON.parse(await obj!.text());
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject).toEqual([{ name: filename, digest: { sha256: s } }]);
    expect(statement.predicate.approval.by).toBe("m2");
    // A synced object has a seal too: where it came from and that its upstream signature was checked.
    expect(seal.upstream).toBeUndefined();
  });
});

describe("a recipe's failure", () => {
  it("fails at once when the worker says it is final, and the package says why; the infrastructure's is retried", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, "group", arches, status) VALUES ('broken', 'alice', 'https://github.com/alice/broken', 'community', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('broken', 'community', 'aarch64', '1.0-1', 'https://github.com/alice/broken@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`),
    ]);
    // A download that broke: back in the queue, as before.
    let c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    const transient = await call("POST", `/factory/tasks/${id}/fail`, { error: "exit 4: curl: (28) Connection timed out", final: false }, c.json.token);
    expect(transient.json).toMatchObject({ status: "queued", attempts: 1 });
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'broken'").first<{ status: string }>())!.status).toBe("building");
    // The recipe's: failed now, two attempts unspent, the package back to registered with the reason.
    c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.json.task.id).toBe(id);
    const final = await call("POST", `/factory/tasks/${id}/fail`, { error: "exit 4: error: target not found: ghostty", final: true }, c.json.token);
    expect(final.json).toMatchObject({ status: "failed", attempts: 2 });
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3")).status).toBe(204);
    const pkg = await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'broken'").first<{ status: string; detail: string }>();
    expect(pkg).toMatchObject({ status: "registered", detail: "build failed on w3: exit 4: error: target not found: ghostty" });
  });
});

describe("an expired lease", () => {
  it("puts the package back to waiting with the task, and to registered with the reason when the attempts are spent", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, "group", arches, status) VALUES ('orphan', 'alice', 'https://github.com/alice/orphan', 'community', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, max_attempts) VALUES ('orphan', 'community', 'aarch64', '1.0-1', 'https://github.com/alice/orphan@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 2)`),
    ]);
    const status = async () => (await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'orphan'").first<{ status: string; detail: string | null }>())!;
    // The worker took it and died: the lease runs out.
    let c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    expect((await status()).status).toBe("building");
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(id).first()).toMatchObject({ status: "queued" });
    expect(await status()).toEqual({ status: "waiting", detail: "lease by w3 expired; queued again" });
    // Again, and that was the last attempt.
    c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.json.task.id).toBe(id);
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(id).first()).toMatchObject({ status: "failed", error: "lease by w3 expired" });
    expect(await status()).toEqual({ status: "registered", detail: "build failed on w3: lease by w3 expired (the worker stopped mid-build?)" });
    expect(await requeueExpiredLeases(env)).toBe(0);
  });
});

describe("a package request", () => {
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  it("is checked before anything is written: the checklist, the description, the licence, the source", async () => {
    expect((await call("POST", "/factory/packages", { url: "https://example.org/htop" })).status).toBe(401);
    const noList = await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://github.com/htop-dev/htop/archive/refs/tags/3.5.3.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only" }, "omc_alice");
    expect(noList.status).toBe(400);
    expect(noList.json.error).toMatch(/confirm the checklist/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://x/y.tar.gz", version: "3.5.3", description: "short", license: "GPL-2.0-only", checklist }, "omc_alice")).json.error).toMatch(/description/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://x/y.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL v2", checklist }, "omc_alice")).json.error).toMatch(/SPDX/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only", checklist }, "omc_alice")).json.error).toMatch(/source is required/);
  });

  it("is written once to the record, signed when the pool signs, and registered for the contributor", async () => {
    const body = { name: "htop", url: "https://htop.dev/", source: "https://github.com/htop-dev/htop/archive/refs/tags/3.5.3.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only", arches: ["aarch64"], checklist };
    const r = await call("POST", "/factory/packages", body, "omc_alice");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.package).toMatchObject({ name: "htop", owner: "alice", project: "https://htop.dev", source: body.source, release: "3.5.3", description: body.description, license: "GPL-2.0-only", status: "registered" });
    expect(r.json.request).toMatchObject({ id: expect.any(Number), record: `${env.POOL_URL}/factory/htop/${r.json.request.id}/request.json`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const obj = await env.PACKAGES.get(`factory/htop/${r.json.request.id}/request.json`);
    const record = JSON.parse(await obj!.text());
    expect(record).toMatchObject({ schema: "omarchy-pool/package-request/1", name: "htop", project: "https://htop.dev", version: "3.5.3", requested_by: "alice", arches: ["aarch64"] });
    expect(Object.keys(record.checklist)).toEqual(["official", "license", "unshipped", "evidence"]);
    // The same project under another name, or the same name by someone else, is refused; the owner may renew their own.
    expect((await call("POST", "/factory/packages", { ...body, name: "htop2" }, "omc_alice")).status).toBe(409);
    expect((await call("POST", "/factory/packages", body, "omc_m2")).status).toBe(409);
    const renewed = await call("POST", "/factory/packages", { ...body, version: "3.5.4", source: body.source.replace("3.5.3", "3.5.4") }, "omc_alice");
    expect(renewed.status).toBe(200);
    expect(renewed.json.request.id).toBeGreaterThan(r.json.request.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM package_requests WHERE name = 'htop'").first<{ n: number }>())!.n).toBe(2);
    // A blocked contributor requests nothing and builds nothing.
    await env.DB.prepare("UPDATE contributors SET blocked_at = '2026-09-15T00:00:00Z', blocked_by = 'm1', blocked_reason = 'spam' WHERE login = 'alice'").run();
    expect((await call("POST", "/factory/packages", { ...body, name: "htop3", url: "https://htop.dev/x" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/htop/build", {}, "omc_alice")).status).toBe(403);
    await env.DB.prepare("UPDATE contributors SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE login = 'alice'").run();
  });

  it("gives a registration made before requests existed its record, from the staged PKGBUILD", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, "group", arches, detected, status, created_at) VALUES ('older', 'alice', 'https://github.com/alice/recipes', 'community', '["aarch64"]', '{"latest_tag":"v9"}', 'staged', '2026-09-14T10:00:00Z')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('older', 'community', 'aarch64', '1.2-1', 'https://github.com/alice/recipes@HEAD:older/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/older/1/')`),
    ]);
    const task = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'older'").first<{ id: number }>())!.id;
    await env.STAGING.put(`staging/alice/older/${task}/PKGBUILD`, "pkgname=older\npkgdesc=\"An older tool\"\nurl=\"https://github.com/upstream/older\"\nlicense=('Apache-2.0')\n");
    const { backfillRequests } = await import("../src/requests");
    expect(await backfillRequests(env)).toMatch(/older → \d+/);
    const pkg = await env.DB.prepare("SELECT request_id, project, description, license FROM factory_packages WHERE name = 'older'").first<{ request_id: number; project: string; description: string; license: string }>();
    expect(pkg).toMatchObject({ project: "https://github.com/upstream/older", description: "An older tool", license: "Apache-2.0" });
    const record = JSON.parse(await (await env.PACKAGES.get(`factory/older/${pkg!.request_id}/request.json`))!.text());
    expect(record).toMatchObject({ migrated: { pkgbuild_of_task: task }, version: "v9", source: "https://github.com/upstream/older/archive/refs/tags/v9.tar.gz" });
    expect(await backfillRequests(env)).toBe("");
  });
});
