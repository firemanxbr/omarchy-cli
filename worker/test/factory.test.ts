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
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('m1', ?, 'maintainer'), ('m2', ?, 'maintainer'), ('alice', ?, 'contributor')`).bind(await h("omc_m1"), await h("omc_m2"), await h("omc_alice")),
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
    expect((await call("POST", "/factory/enqueue", { name: "tool", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"] })).status).toBe(401);
    const q = await call("POST", "/factory/enqueue", { name: "tool", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" }, "omc_m1");
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
    expect(c.json.pkgbuild_path).toBe("factory/pkgbuilds/tool");
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
  let req: number;

  it("the owner's worker stages the evidence with its job token; the builder cannot write the audit", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'aarch64', '1.0-1', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
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
    // The package this build is for: requested (record #), so the evidence has a place on the record.
    req = (await env.DB.prepare(`INSERT INTO package_requests (name, owner, project, source, version, description, license, arches, checklist, record, sha256) VALUES ('mine', 'alice', 'https://github.com/alice/mine', 'https://github.com/alice/mine/archive/refs/tags/v1.0.tar.gz', 'v1.0', 'Mine, a tool', 'MIT', '["aarch64"]', '{}', 'factory/mine/0/request.json', 'x') RETURNING id`).first<{ id: number }>())!.id;
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, request_id, project) VALUES ('mine', 'alice', 'https://github.com/alice/mine', '["aarch64"]', 'building', ?, 'https://github.com/alice/mine')`).bind(req).run();
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "mine-1.0-1-aarch64.pkg.tar.zst"]) {
      expect((await call("PUT", `/factory/tasks/${task}/artifacts/${f}`, undefined, jobToken, `evidence ${f}`)).status).toBe(201);
    }
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, jobToken, "{}")).status).toBe(403);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/PKGBUILD`, undefined, "omw_w1", "x")).status).toBe(409);
    // Completing before the package is uploaded is refused; after, the build is staged and the audit queued.
    expect((await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "other.pkg.tar.zst" }, jobToken)).status).toBe(409);
    // A gate that failed never stages: the worker reports a failure instead.
    await call("PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, jobToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "fail", checks: [{ name: "smoke", status: "fail", detail: "a binary does not start" }] }));
    const refused = await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1" }, jobToken);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/gate failed \(smoke\)/);
    await call("PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, jobToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "checksums", status: "pass", detail: "" }, { name: "check", status: "warn", detail: "no check()" }] }));
    const st = await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1" }, jobToken);
    expect(st.json.status).toBe("staged");
    // The gate's verdict stays with the task; the evidence — not the package — is on the record, signed when the pool signs.
    expect(JSON.parse((await env.DB.prepare("SELECT result FROM build_tasks WHERE id = ?").bind(task).first<{ result: string }>())!.result)).toEqual({ vet: { verdict: "pass", fails: 0, warnings: 1, failed: [], warned: ["check"] } });
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "vet.json"]) expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/${f}`), f).not.toBeNull();
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/mine-1.0-1-aarch64.pkg.tar.zst`)).toBeNull();
    const review = await call("GET", "/factory/review");
    const row = review.json.staged.find((t: any) => t.id === task);
    expect(row.audit).toEqual({ status: "queued" });
    expect(row.evidence.audit).toBe(`/api/v1/factory/tasks/${task}/artifacts/audit.md`);
    expect(row.vet).toEqual({ verdict: "pass", fails: 0, warnings: 1, failed: [], warned: ["check"] });
    expect(row.evidence.vet).toBe(`/api/v1/factory/tasks/${task}/artifacts/vet.json`);
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
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "warn", result: { verdict: "warn", summary: "SKIP checksum", model: "test", category: "terminal", findings: [{ severity: "high", area: "supply-chain" }] } }, c.json.token);
    expect(done.json.status).toBe("done");
    const review = await call("GET", "/factory/review");
    expect(review.json.staged.find((t: any) => t.id === task).audit).toMatchObject({ status: "done", verdict: "warn", findings: 1, high: 1, model: "test" });
    // The report joins the evidence on the record.
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/audit.md`)).not.toBeNull();
    // The agent's category is a proposal: the registration took it because none was set, and the review row shows it.
    expect(review.json.staged.find((t: any) => t.id === task).category).toBe("terminal");
  });

  it("a maintainer settles the category — any maintainer, from the fixed list — and a second audit does not undo it", async () => {
    expect((await call("POST", "/factory/packages/mine/category", { category: "editors" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/mine/category", { category: "desktop-stuff" }, "omc_m1")).status).toBe(400);
    expect((await call("POST", "/factory/packages/nothing/category", { category: "editors" }, "omc_m1")).status).toBe(404);
    const set = await call("POST", "/factory/packages/mine/category", { category: "editors" }, "omc_m1");
    expect(set.json).toMatchObject({ package: "mine", category: "editors", was: "terminal", by: "m1" });
    expect((await env.DB.prepare("SELECT category FROM factory_packages WHERE name = 'mine'").first())!.category).toBe("editors");
    expect((await env.DB.prepare("SELECT summary FROM events WHERE kind = 'category' ORDER BY id DESC LIMIT 1").first())!.summary).toBe("mine: editors (was terminal), settled by m1");
    // What the agent proposes later is only a proposal: a settled category stays.
    await env.DB.prepare("UPDATE factory_packages SET category = 'editors' WHERE name = 'mine'").run();
    const again = await env.DB.prepare("UPDATE factory_packages SET category = 'games' WHERE name = 'mine' AND category IS NULL").run();
    expect(again.meta.changes).toBe(0);
  });

  it("a newer build of the same package supersedes the staged one before it", async () => {
    // alice's worker builds mine again (a fix): the earlier staged row is cancelled with its pending audit, and the review queue shows one.
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'aarch64', '1.0-2', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
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

  it("a contributor's build cannot be approved; a maintainer — never the owner — has the project build it", async () => {
    // Nothing of the contributor's is ever what users get: the approval is refused outright.
    const refused = await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_m2");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/Have the project build it first/);
    expect((await call("POST", `/factory/tasks/${task}/build`, {}, "omc_alice")).status).toBe(403);
    // The owner is who requested the package (the registration), not who happened to build it.
    await env.DB.prepare("UPDATE factory_packages SET owner = 'm1' WHERE name = 'mine'").run();
    const own = await call("POST", `/factory/tasks/${task}/build`, {}, "omc_m1");
    expect(own.status).toBe(403);
    expect(own.json.error).toMatch(/another maintainer/);
    await env.DB.prepare(`INSERT OR IGNORE INTO factory_maintainers (login) VALUES ('m2')`).run();
    const asked = await call("POST", `/factory/tasks/${task}/build`, { note: "reads well" }, "omc_m2");
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({ from: task, by: "m2", task: expect.any(Number) });
    expect((await call("POST", `/factory/tasks/${task}/build`, {}, "omc_m2")).status).toBe(409); // once at a time
    const t = await env.DB.prepare("SELECT trust, kind, pkgbuild_ref, publish, owner, params FROM build_tasks WHERE id = ?").bind(asked.json.task).first<{ trust: string; kind: string; pkgbuild_ref: string; publish: number; owner: string; params: string }>();
    expect(t).toMatchObject({ trust: "project", kind: "build", pkgbuild_ref: `review:${task}`, publish: 0, owner: "m1" });
    expect(JSON.parse(t!.params)).toMatchObject({ review: task, request: req, project: "https://github.com/alice/mine", by: "m2", description: null });
    // No build ever starts from the staged artifact itself.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE pkgbuild_ref LIKE 'staging:%' AND kind = 'build'").first<{ n: number }>())!.n).toBe(0);
    // The review row says the project is on it.
    const row = (await call("GET", "/factory/review")).json.staged.find((x: any) => x.id === task);
    expect(row).toMatchObject({ kind: "contributor", project_build: { id: asked.json.task, status: "queued" } });
    projectTask = asked.json.task;
  });

  let projectTask: number;
  let projectToken: string;

  it("the project's review build runs on a trusted worker with its agent, stages its own package and evidence, and queues its audit", async () => {
    // A worker whose agent is down is not handed it (a review build drafts with the agent); one whose agent answers is.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "error" }, "omw_w1")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(projectTask);
    expect(c.json.task.pkgbuild_ref).toBe(`review:${task}`);
    expect(c.json.upload).toBe(`/api/v1/factory/tasks/${projectTask}/artifacts/<filename>`);
    expect(c.json.pkgbuild_path).toBeNull();
    projectToken = c.json.token;
    // Everything to the project's staging space — no quota, its own prefix.
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "mine-1.0-1-aarch64.pkg.tar.zst"]) {
      expect((await call("PUT", `/factory/tasks/${projectTask}/artifacts/${f}`, undefined, projectToken, `the project's ${f}`)).status).toBe(201);
    }
    await call("PUT", `/factory/tasks/${projectTask}/artifacts/vet.json`, undefined, projectToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%PKGBUILD'").bind(projectTask).first<{ key: string }>())!.key).toBe(`staging/@project/mine/${projectTask}/PKGBUILD`);
    const st = await call("POST", `/factory/tasks/${projectTask}/complete`, { sha256: "e".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1", duration_ms: 90000 }, projectToken);
    expect(st.json.status).toBe("staged");
    expect(await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "staged", detail: expect.stringMatching(/built by the project \(task \d+\), gate pass/) });
    // Its evidence is on the record, its audit queued, and the review shows it as the project's — the contributor's row points at it.
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${projectTask}/PKGBUILD`)).not.toBeNull();
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE kind = 'audit' AND json_extract(params, '$.task') = ?").bind(projectTask).first()).toMatchObject({ status: "queued" });
    const rows = (await call("GET", "/factory/review")).json.staged;
    expect(rows.find((x: any) => x.id === projectTask)).toMatchObject({ kind: "project", from: task, owner: "m1", vet: { verdict: "pass" } });
    expect(rows.find((x: any) => x.id === task)).toMatchObject({ project_build: { id: projectTask, status: "staged" } });
  });

  it("a maintainer — never the owner, no exception — approves the project's build; a publish job carries it into the pool; the seal tells the chain", async () => {
    await env.DB.prepare(`DELETE FROM factory_maintainers WHERE login = 'm2'`).run();
    const sole = await call("POST", `/factory/tasks/${projectTask}/approve`, {}, "omc_m1");
    expect(sole.status).toBe(403);
    expect(sole.json.error).toMatch(/with one maintainer, that maintainer.s own packages wait/);
    await env.DB.prepare(`INSERT OR IGNORE INTO factory_maintainers (login) VALUES ('m2')`).run();
    const other = await call("POST", `/factory/tasks/${projectTask}/approve`, { note: "looks right" }, "omc_m2");
    expect(other.status, JSON.stringify(other.json)).toBe(200);
    expect(other.json).toMatchObject({ task: projectTask, decision: "approved", by: "m2", publish: expect.any(Number) });
    expect((await call("POST", `/factory/tasks/${projectTask}/approve`, {}, "omc_m2")).status).toBe(409);
    expect(await env.DB.prepare("SELECT task_id, rebuild_task FROM approvals ORDER BY id DESC LIMIT 1").first()).toEqual({ task_id: projectTask, rebuild_task: projectTask });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "approved" });
    // The publish job: a project worker takes it; its token may read the staged package (a maintainer's privilege otherwise).
    const pub = await env.DB.prepare("SELECT kind, trust, params FROM build_tasks WHERE id = ?").bind(other.json.publish).first<{ kind: string; trust: string; params: string }>();
    expect(pub).toMatchObject({ kind: "publish", trust: "project" });
    expect(JSON.parse(pub!.params)).toMatchObject({ task: projectTask, files: ["mine-1.0-1-aarch64.pkg.tar.zst"], by: "m2" });
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["publish"] }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(other.json.publish);
    const ctx = createExecutionContext();
    const pk = await worker.fetch(new Request(`${API}/factory/tasks/${projectTask}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`, { headers: { authorization: `Bearer ${c.json.token}` } }), env, ctx);
    expect(pk.status).toBe(200);
    expect(await pk.text()).toBe("the project's mine-1.0-1-aarch64.pkg.tar.zst");
    expect((await worker.fetch(new Request(`${API}/factory/tasks/${projectTask}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`), env, createExecutionContext())).status).toBe(403);
    // The worker publishes into the pool with the job token, renders, completes; the brain marks the registration published and writes the seal.
    const filename = "mine-1.0-1-aarch64.pkg.tar.zst";
    const bytes = new TextEncoder().encode("the project's build of mine");
    await env.PACKAGES.put(packageKey("factory", "aarch64", filename), bytes);
    const s = "e".repeat(64);
    const indexed = await call("POST", "/packages?source=factory&arch=aarch64", { schema_version: 1, name: "mine", version: "1.0-1", arch: "aarch64", sha256: s, filename, size_download: bytes.length, size_installed: 1, description: "mine", provides: ["mine"], requires: [], files: [] }, c.json.token);
    expect(indexed.status, JSON.stringify(indexed.json)).toBe(201);
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "published", result: { sha256: s, filename, version: "1.0-1", task: projectTask }, duration_ms: 5000 }, c.json.token);
    expect(done.json).toMatchObject({ status: "done" });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "published" });
    expect(await env.DB.prepare("SELECT status, result_sha256 FROM build_tasks WHERE id = ?").bind(projectTask).first()).toMatchObject({ status: "done", result_sha256: s });
    // The seal: the project's own build and recipe, learned from the contributor's, approved by m2.
    const seal = (await call("GET", `/packages/${s}/provenance`)).json;
    expect(seal).toMatchObject({ origin: "factory", seal: "built by the Omarchy Pool", name: "mine", version: "1.0-1" });
    expect(seal.chain).toMatchObject({
      builder: { worker: "w1", trust: "project" },
      build: { task: projectTask, arch: "aarch64", gate: { verdict: "pass" } },
      recipe: { ref: `review:${task}`, by: "the project's agent, from the evidence", pkgbuild: `/api/v1/factory/tasks/${projectTask}/artifacts/PKGBUILD`, learned_from: `/api/v1/factory/tasks/${task}/artifacts/PKGBUILD` },
      source_build: { task, worker: "w3", gate: null }, // the superseding build staged no vet.json
      approval: { by: "m2", note: "looks right", of_task: projectTask },
    });
    expect(seal.chain.audit).toMatchObject({ of_task: projectTask, verdict: null, status: "cancelled" });
    expect(seal.summary).toBe("built by the project on w1, approved by m2, signed by the pool");
    expect(seal.attestation.statement).toBe(`${env.POOL_URL}/factory/aarch64/${filename}.provenance.json`);
    const statement = JSON.parse(await (await env.PACKAGES.get(packageKey("factory", "aarch64", `${filename}.provenance.json`)))!.text());
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicate.approval.by).toBe("m2");
  });

});

describe("a recipe's failure", () => {
  it("fails at once when the worker says it is final, and the package says why; the infrastructure's is retried", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('broken', 'alice', 'https://github.com/alice/broken', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('broken', 'aarch64', '1.0-1', 'https://github.com/alice/broken@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`),
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
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('orphan', 'alice', 'https://github.com/alice/orphan', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, max_attempts) VALUES ('orphan', 'aarch64', '1.0-1', 'https://github.com/alice/orphan@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 2)`),
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
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, detected, status, created_at) VALUES ('older', 'alice', 'https://github.com/alice/recipes', '["aarch64"]', '{"latest_tag":"v9"}', 'staged', '2026-09-14T10:00:00Z')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('older', 'aarch64', '1.2-1', 'https://github.com/alice/recipes@HEAD:older/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/older/1/')`),
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

describe("blocking", () => {
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  it("a maintainer blocks a package: it leaves every ring it is in, its builds stop, its project is refused; another maintainer lifts it", async () => {
    // 'mine' is published in edge (the earlier story); block it.
    expect((await call("POST", "/factory/packages/mine/block", { reason: "ships a token stealer" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/mine/block", { reason: "x" }, "omc_m2")).status).toBe(400);
    // The publish job put it in edge (pkg-repo publish creates the release in reality): seeded here as the ring's head.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO releases (ring, seq, note) VALUES ('edge', 1, 'seed')"),
      env.DB.prepare("INSERT INTO ring_heads (ring, release_id) SELECT 'edge', id FROM releases WHERE ring = 'edge' AND seq = 1"),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'edge', id FROM packages WHERE sha256 = ?").bind("e".repeat(64)),
    ]);
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = 'mine' AND rp.ring = 'edge'").first<{ n: number }>())!.n;
    expect(before).toBe(1);
    const blocked = await call("POST", "/factory/packages/mine/block", { reason: "ships a token stealer" }, "omc_m2");
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    expect(blocked.json).toMatchObject({ blocked: "mine", by: "m2", rings: [{ ring: "edge", release: expect.any(Number) }] });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = 'mine'").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'render' AND status = 'queued' AND json_extract(params, '$.ring') = 'edge'").first<{ n: number }>())!.n).toBe(2);
    expect(await env.DB.prepare("SELECT status, blocked_by FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "rejected", blocked_by: "m2" });
    expect((await call("POST", "/factory/packages/mine/block", { reason: "again" }, "omc_m2")).status).toBe(409);
    // The record, signed when the pool signs; the door closed to the owner and to a new request of the same project.
    const rec = blocked.json.record.replace(`${env.POOL_URL}/`, "");
    expect(await env.PACKAGES.head(rec)).not.toBeNull();
    expect(rec).toMatch(/^factory\/mine\/\d+\/decision-\d+T\d+\.json$/);
    expect((await call("POST", "/factory/packages/mine/build", {}, "omc_m1")).json.error).toMatch(/blocked by a maintainer/);
    expect((await call("POST", "/factory/packages", { url: "https://github.com/alice/mine", description: "Mine, again", license: "MIT", checklist }, "omc_alice")).status).toBe(403);
    // The one who blocked cannot lift it; another maintainer can.
    expect((await call("POST", "/factory/packages/mine/unblock", { reason: "false alarm" }, "omc_m2")).status).toBe(403);
    const lifted = await call("POST", "/factory/packages/mine/unblock", { reason: "false alarm" }, "omc_m1");
    expect(lifted.status).toBe(200);
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'mine'").first()).toEqual({ blocked_at: null });
    expect((await call("GET", "/factory/blocks")).json.packages).toEqual([]);
  });

  it("a maintainer blocks a contributor: nothing more from them, their workers revoked, their packages rejected — and their sources stay closed to other accounts", async () => {
    // bob requests something, registers a worker, then gets blocked by m1.
    await env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('bob', ?, 'contributor')`).bind(await sha256Hex("omc_bob")).run();
    const req = await call("POST", "/factory/packages", { url: "https://evil.example/tool", source: "https://evil.example/tool-1.0.tar.gz", version: "1.0", description: "A tool of dubious intent", license: "MIT", arches: ["aarch64"], checklist }, "omc_bob");
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    const w = await call("POST", "/factory/workers", { name: "box", arch: "aarch64" }, "omc_bob");
    expect(w.status).toBe(201);
    expect((await call("POST", "/factory/contributors/bob/block", { reason: "spam requests" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/contributors/m2/block", { reason: "no reason at all" }, "omc_m1")).status).toBe(409); // a maintainer is a governance PR
    expect((await call("POST", "/factory/contributors/m1/block", { reason: "no reason at all" }, "omc_m1")).status).toBe(400);
    const blocked = await call("POST", "/factory/contributors/bob/block", { reason: "spam requests" }, "omc_m1");
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    expect(blocked.json).toMatchObject({ blocked: "bob", by: "m1", packages: ["tool"], workers_revoked: [w.json.worker] });
    expect(await env.PACKAGES.head(blocked.json.record.replace(`${env.POOL_URL}/`, ""))).not.toBeNull();
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'tool'").first()).toEqual({ status: "rejected" });
    expect(await env.DB.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM build_workers WHERE id = ?").bind(w.json.worker).first()).toEqual({ revoked: 1 });
    // Every door: request, build, a worker — refused with the reason.
    expect((await call("POST", "/factory/packages", { url: "https://evil.example/other", source: "https://evil.example/o.tar.gz", version: "1", description: "Another tool of intent", license: "MIT", checklist }, "omc_bob")).json.error).toMatch(/blocked by a maintainer: spam requests/);
    expect((await call("POST", "/factory/workers", { name: "box2", arch: "aarch64" }, "omc_bob")).status).toBe(403);
    expect((await call("GET", "/factory/blocks")).json.contributors).toEqual([expect.objectContaining({ login: "bob", blocked_by: "m1", blocked_reason: "spam requests" })]);
    // A fresh account asking for the same project, or the same source: no.
    await env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('bob2', ?, 'contributor')`).bind(await sha256Hex("omc_bob2")).run();
    const again = await call("POST", "/factory/packages", { name: "tool2", url: "https://evil.example/tool", source: "https://evil.example/tool-1.0.tar.gz", version: "1.0", description: "A tool of dubious intent", license: "MIT", checklist }, "omc_bob2");
    expect(again.status).toBe(403);
    expect(again.json.error).toMatch(/requested by bob, who is blocked/);
    // Lifting: not by the one who blocked.
    expect((await call("POST", "/factory/contributors/bob/unblock", { reason: "talked it over" }, "omc_m1")).status).toBe(403);
    expect((await call("POST", "/factory/contributors/bob/unblock", { reason: "talked it over" }, "omc_m2")).status).toBe(200);
    expect((await call("GET", "/factory/blocks")).json.contributors).toEqual([]);
  });
});
