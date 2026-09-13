import { json, type Env } from "../index";
import { isRepoArch } from "../r2";
import type { WorkerIdentity } from "./contributors";
import { issueJobToken, scopesFor, type JobClaims } from "../jobtoken";

/**
 * The factory's brain. Cloudflare is the source of truth for package
 * requests and build tasks; build workers are ephemeral, live anywhere, and
 * *pull* work:
 *
 *   POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?} → a task with a lease and its job token, or 204
 *   POST /factory/tasks/:id/heartbeat                                  extend the lease (a fresh job token)
 *   POST /factory/tasks/:id/complete    {sha256, filename, version, duration_ms?, log_tail?} · {result, summary} for jobs
 *   POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?}   → requeued, or failed after max_attempts
 * The worker is its registered token (POST /factory/workers); a task's
 * writes use the job token the claim issued.
 *
 * A lease that expires (worker died, build hung) goes back to the queue on
 * the scheduler's next tick. Maintainers (their token) or the enqueue job:
 *
 *   POST /factory/requests              {name, group?, arches?, requested_by?, reason?}
 *   POST /factory/requests/:id/approve  {approved_by, pkgbuild_ref}  → tasks per arch
 *   POST /factory/requests/:id/reject   {by, reason}
 *   POST /factory/enqueue               {name, group, arches?, pkgbuild_ref, reason, version?, priority?}
 *   POST /factory/tasks/:id/cancel
 *
 * Read:
 *   GET  /factory                       overview: queue, workers, recent tasks, requests
 */

const LEASE_MINUTES = 30;
const WORKER_ALIVE_MINUTES = 10;

interface TaskRow {
  id: number;
  name: string;
  group: string;
  arch: string;
  version: string | null;
  pkgbuild_ref: string;
  reason: string;
  priority: number;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_sha256: string | null;
  result_filename: string | null;
  result_version: string | null;
  duration_ms: number | null;
  log_tail: string | null;
  error: string | null;
  created_at: string;
  kind: string;
  params: string | null;
  result: string | null;
  /** 0 = dry run: build and report, never publish. */
  publish: number;
  /** project: the worker signs and publishes · community: the result goes to staging for a maintainer. */
  trust: string;
  owner: string | null;
  staged_prefix: string | null;
}

/** Who is calling a worker endpoint: a registered worker (own token) or a job (its per-task token). */
export type Actor = { kind: "worker"; w: WorkerIdentity } | { kind: "job"; job: JobClaims };

const now = () => new Date().toISOString();
const plusMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();

async function event(env: Env, kind: string, status: string, summary: string, payload: unknown, source: string | null = "factory"): Promise<void> {
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES (?, NULL, ?, ?, ?, ?)")
    .bind(kind, source, status, summary, JSON.stringify(payload))
    .run();
}

function parseArches(v: unknown): string[] {
  const list = Array.isArray(v) ? v : ["x86_64", "aarch64"];
  return list.filter((a): a is string => typeof a === "string" && isRepoArch(a));
}

/**
 * Who already provides a name in edge. A factory build replaces the same
 * name in the ring, so a package Arch, ALARM or the OPR ship is never built
 * here by accident: it "enters the pool's cycle" as it is. chaotic-aur is the
 * exception — the factory is meant to take its names over.
 */
export async function providedBy(env: Env, name: string): Promise<{ source: string; arch: string; version: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT p.source, p.repo_arch AS arch, p.version FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = (SELECT release_id FROM ring_heads WHERE ring = 'edge') AND p.name = ?`,
  )
    .bind(name)
    .all<{ source: string; arch: string; version: string }>();
  return rows.results;
}

/**
 * Splits the requested architectures into the ones the factory should build
 * and the ones an upstream source already covers (skipped, with who ships
 * them). Per architecture: the OPR ships many names for x86_64 only, and
 * those are exactly what the factory builds for aarch64.
 */
export function splitByUpstream(provided: { source: string; arch: string; version: string }[], arches: string[], override: boolean | undefined): { build: string[]; skipped: { arch: string; source: string; version: string }[] } {
  const skipped: { arch: string; source: string; version: string }[] = [];
  const build = arches.filter((arch) => {
    const hit = provided.find((p) => p.arch === arch && !["factory", "chaotic"].includes(p.source));
    if (!hit || override) return true;
    skipped.push({ arch, source: hit.source, version: hit.version });
    return false;
  });
  return { build, skipped };
}

function nothingToBuild(skipped: { arch: string; source: string; version: string }[]): Response {
  return json(
    {
      error: `an upstream source already ships this package for every requested architecture (${skipped.map((s) => `${s.source} ${s.version} for ${s.arch}`).join(", ")}); it enters the pool's cycle as it is. Pass override:true to build it here anyway.`,
      skipped,
    },
    409,
  );
}

/** Queue one task per architecture unless an identical one is already queued or running. */
async function enqueue(env: Env, t: { name: string; group: string; arches: string[]; pkgbuild_ref: string; reason: string; version?: string | null; priority?: number; publish?: boolean }): Promise<number[]> {
  const ids: number[] = [];
  for (const arch of t.arches) {
    const dup = await env.DB.prepare(
      "SELECT id FROM build_tasks WHERE name = ? AND arch = ? AND pkgbuild_ref = ? AND status IN ('queued', 'leased') LIMIT 1",
    )
      .bind(t.name, arch, t.pkgbuild_ref)
      .first<{ id: number }>();
    if (dup) {
      ids.push(dup.id);
      continue;
    }
    const row = await env.DB.prepare(
      `INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(t.name, t.group, arch, t.version ?? null, t.pkgbuild_ref, t.reason, t.priority ?? 100, t.publish === false ? 0 : 1)
      .first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  return ids;
}

// ---------- maintainers / pipeline ----------

const REQUEST_STATUSES = ["requested", "drafting", "validating", "review", "approved", "rejected", "failed"];

/**
 * A request is a project URL and a name. It is what a user files (an issue,
 * this API); the request workflow drafts the PKGBUILD, validates it with a
 * dry-run build and opens the pull request a maintainer approves — every
 * stage reported back here (PATCH) so the Factory page tells the story.
 */
export async function handleCreateRequest(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; group?: string; arches?: unknown; url?: string; requested_by?: string; reason?: string; issue_url?: string; override?: boolean };
  if (!b.name || !/^[a-z0-9@._+-]+$/.test(b.name)) return json({ error: "name must be a pacman package name" }, 400);
  if (b.url && !/^https?:\/\/[^\s]+$/.test(b.url)) return json({ error: "url must be http(s)" }, 400);
  const group = b.group ?? "community";
  const arches = parseArches(b.arches);
  const { build, skipped } = splitByUpstream(await providedBy(env, b.name), arches, b.override);
  if (!build.length) return nothingToBuild(skipped);
  const row = await env.DB.prepare(
    `INSERT INTO build_requests (name, "group", arches, url, requested_by, reason, issue_url) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET reason = COALESCE(excluded.reason, reason), arches = excluded.arches, url = COALESCE(excluded.url, url),
       issue_url = COALESCE(excluded.issue_url, issue_url), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') RETURNING *`,
  )
    .bind(b.name, group, JSON.stringify(build), b.url ?? null, b.requested_by ?? null, b.reason ?? null, b.issue_url ?? null)
    .first();
  await event(env, "request", "ok", `${b.name} requested for ${build.join(", ")}${b.requested_by ? " by " + b.requested_by : ""}${b.url ? " from " + b.url : ""}`, { name: b.name, group, arches: build, skipped, url: b.url ?? null, requested_by: b.requested_by ?? null });
  return json({ request: row, skipped }, 201);
}

export async function handleUpdateRequest(idOrName: number | string, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { status?: string; detail?: string; pr_url?: string; pkgbuild_ref?: string; by?: string };
  if (b.status && !REQUEST_STATUSES.includes(b.status)) return json({ error: `status must be one of ${REQUEST_STATUSES.join(", ")}` }, 400);
  const req = await env.DB.prepare(typeof idOrName === "number" ? "SELECT * FROM build_requests WHERE id = ?" : "SELECT * FROM build_requests WHERE name = ?")
    .bind(idOrName)
    .first<{ id: number; name: string; status: string }>();
  if (!req) return json({ error: "no such request" }, 404);
  const id = req.id;
  const approving = b.status === "approved";
  await env.DB.prepare(
    `UPDATE build_requests SET status = COALESCE(?, status), detail = COALESCE(?, detail), pr_url = COALESCE(?, pr_url), pkgbuild_ref = COALESCE(?, pkgbuild_ref),
       approved_by = CASE WHEN ? THEN ? ELSE approved_by END, approved_at = CASE WHEN ? THEN ? ELSE approved_at END, updated_at = ? WHERE id = ?`,
  )
    .bind(b.status ?? null, b.detail ?? null, b.pr_url ?? null, b.pkgbuild_ref ?? null, approving ? 1 : 0, b.by ?? null, approving ? 1 : 0, now(), now(), id)
    .run();
  if (b.status && b.status !== req.status) {
    await event(env, "request", b.status === "failed" || b.status === "rejected" ? "warn" : "ok", `${req.name}: ${b.status}${b.detail ? " — " + b.detail.slice(0, 160) : ""}`, { request: id, status: b.status, pr_url: b.pr_url ?? null });
  }
  return json({ request: id, status: b.status ?? req.status });
}

export async function handleApproveRequest(id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { approved_by?: string; pkgbuild_ref?: string };
  if (!b.pkgbuild_ref) return json({ error: "pkgbuild_ref (the git commit holding the PKGBUILD) is required" }, 400);
  const req = await env.DB.prepare("SELECT * FROM build_requests WHERE id = ?").bind(id).first<{ id: number; name: string; group: string; arches: string }>();
  if (!req) return json({ error: "no such request" }, 404);
  await env.DB.prepare("UPDATE build_requests SET status = 'approved', approved_by = ?, approved_at = ?, pkgbuild_ref = ? WHERE id = ?")
    .bind(b.approved_by ?? null, now(), b.pkgbuild_ref, id)
    .run();
  const tasks = await enqueue(env, { name: req.name, group: req.group, arches: JSON.parse(req.arches), pkgbuild_ref: b.pkgbuild_ref, reason: "approved", priority: 50 });
  await event(env, "approve", "ok", `${req.name} approved${b.approved_by ? " by " + b.approved_by : ""}: ${tasks.length} build task(s) queued`, { request: id, tasks, pkgbuild_ref: b.pkgbuild_ref });
  return json({ request: id, tasks });
}

export async function handleRejectRequest(id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { by?: string; reason?: string };
  const res = await env.DB.prepare("UPDATE build_requests SET status = 'rejected', approved_by = ?, approved_at = ?, reason = COALESCE(?, reason) WHERE id = ?")
    .bind(b.by ?? null, now(), b.reason ?? null, id)
    .run();
  if (!res.meta.changes) return json({ error: "no such request" }, 404);
  return json({ request: id, status: "rejected" });
}

export async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; group?: string; arches?: unknown; pkgbuild_ref?: string; reason?: string; version?: string; priority?: number; override?: boolean; publish?: boolean };
  if (!b.name || !b.group || !b.pkgbuild_ref || !b.reason) return json({ error: "name, group, pkgbuild_ref and reason are required" }, 400);
  const arches = parseArches(b.arches);
  const { build, skipped } = splitByUpstream(await providedBy(env, b.name), arches, b.override);
  if (!build.length) return nothingToBuild(skipped);
  const tasks = await enqueue(env, { name: b.name, group: b.group, arches: build, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, version: b.version ?? null, priority: b.priority, publish: b.publish });
  const note = (skipped.length ? `; ${skipped.map((s) => `${s.arch} skipped, ${s.source} ships ${s.version}`).join(", ")}` : "") + (b.publish === false ? "; dry run, nothing will be published" : "");
  await event(env, "enqueue", "ok", `${b.name}${b.version ? " " + b.version : ""}: ${tasks.length} build task(s) queued for ${build.join(", ")} (${b.reason})${note}`, { name: b.name, arches: build, skipped, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, tasks });
  return json({ tasks, arches: build, skipped }, 201);
}

export async function handleCancelTask(id: number, env: Env): Promise<Response> {
  const res = await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'leased')").bind(now(), id).run();
  return res.meta.changes ? json({ task: id, status: "cancelled" }) : json({ error: "task is not queued or leased" }, 409);
}

// ---------- workers ----------

async function touchWorker(env: Env, w: { worker: string; arch: string; hostname?: string; labels?: unknown; version?: string; mode?: string }, currentTask: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, version, last_seen, current_task) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET arch = excluded.arch, hostname = COALESCE(excluded.hostname, hostname), labels = COALESCE(excluded.labels, labels),
       version = COALESCE(excluded.version, version), last_seen = excluded.last_seen, current_task = excluded.current_task, mode = COALESCE(?, mode)`,
  )
    .bind(w.worker, w.arch, w.hostname ?? null, w.labels ? JSON.stringify(w.labels) : null, w.version ?? null, now(), currentTask, w.mode ?? null)
    .run();
}

const ALL_KINDS = ["build", "sync", "promote", "render", "health", "security", "metrics", "gc", "enqueue"];

export async function handleClaim(request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = (await request.json()) as { arch?: string; hostname?: string; labels?: unknown; version?: string; kinds?: unknown; shared?: unknown };
  if (!b.arch || !isRepoArch(b.arch)) return json({ error: "arch (x86_64|aarch64) is required" }, 400);
  if (actor.kind === "job") return json({ error: "a job token cannot claim; use the worker token" }, 403);
  // A worker is its registration: id, owner, trust and what it may build.
  const workerId = actor.w.id;
  if (actor.w.arch !== b.arch) return json({ error: `this worker is registered for ${actor.w.arch}` }, 400);
  const trust = actor.w.trust === "project" ? "project" : "community";
  // What this worker may claim. Project trust takes any kind it declares,
  // but never a contributor's build: project workers do the work a
  // maintainer would — pool jobs and the rebuild of an approved package —
  // and nothing that has no evidence and no review yet. Community trust
  // takes community builds only, and by default only its owner's: a worker
  // started with --shared (the claim says so) donates its compute to
  // anyone's, so a contributor never ends up building strangers' packages
  // by accident. Community results never reach the pool either way.
  const wanted = (Array.isArray(b.kinds) ? b.kinds.filter((k): k is string => typeof k === "string" && ALL_KINDS.includes(k)) : trust === "project" ? ALL_KINDS : ["build"]);
  const kinds = trust === "project" ? wanted : ["build"];
  const shared = trust === "community" && b.shared === true;
  let scope = `kind IN (SELECT value FROM json_each(?))`;
  const binds: unknown[] = [JSON.stringify(kinds)];
  if (trust === "project") {
    scope += ` AND (kind != 'build' OR trust = 'project')`;
  } else {
    // The owner's worker takes the owner's tasks; a donated worker takes
    // anyone's once shared_after has passed (at once when it is unset).
    scope += ` AND trust = 'community'`;
    if (shared) {
      scope += ` AND (owner = ? OR shared_after IS NULL OR shared_after <= ?)`;
      binds.push(actor.w.owner ?? "-", now());
    } else {
      scope += ` AND owner = ?`;
      binds.push(actor.w.owner ?? "-");
    }
  }
  // One statement claims the next queued task of this architecture: D1
  // serialises writes, so two workers never get the same one.
  const task = await env.DB.prepare(
    `UPDATE build_tasks SET status = 'leased', lease_owner = ?, lease_expires_at = ?, started_at = ?, attempts = attempts + 1, error = NULL
      WHERE id = (SELECT id FROM build_tasks WHERE status = 'queued' AND (arch = ? OR kind IN ('metrics', 'gc', 'security', 'promote')) AND ${scope} ORDER BY priority, id LIMIT 1) AND status = 'queued'
      RETURNING *`,
  )
    .bind(workerId, plusMinutes(LEASE_MINUTES), now(), b.arch, ...binds)
    .first<TaskRow>();
  await touchWorker(env, { worker: workerId, arch: b.arch, hostname: b.hostname, labels: b.labels, version: b.version, mode: trust === "community" ? (shared ? "shared" : "dedicated") : undefined }, task?.id ?? null);
  if (!task) return new Response(null, { status: 204 });
  if (task.trust === "community" && task.kind === "build") {
    await env.DB.prepare("UPDATE factory_packages SET status = 'building', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`building on ${workerId} (${task.arch})`, task.name).run();
  }
  // The job's own credential: exactly the routes this task needs, until the lease ends.
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params), e: expires, w: workerId });
  return json({
    task: { ...task, params },
    token,
    token_expires_at: new Date(expires * 1000).toISOString(),
    lease_minutes: LEASE_MINUTES,
    repo: "https://github.com/firemanxbr/omarchy-pool",
    pkgbuild_path: task.kind === "build" && !(task.pkgbuild_ref.includes(":") || task.pkgbuild_ref.startsWith("draft")) ? `factory/pkgbuilds/${task.group}/${task.name}` : null,
    // Where a community result goes: PUT these back with the job token.
    upload: task.trust === "community" ? `/api/v1/factory/tasks/${task.id}/artifacts/<filename>` : null,
  });
}

async function owned(env: Env, id: number, actor: Actor): Promise<TaskRow | Response> {
  if (actor.kind === "job" && !actor.job.s.includes(`task:${id}`)) return json({ error: `this job token is for task ${actor.job.t}` }, 403);
  const who = actor.kind === "worker" ? actor.w.id : actor.job.w;
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!task) return json({ error: "no such task" }, 404);
  if (task.status !== "leased" || task.lease_owner !== who) return json({ error: `task ${id} is ${task.status}${task.lease_owner ? " by " + task.lease_owner : ""}; the lease is not yours` }, 409);
  return task;
}

function workerName(actor: Actor): string {
  return actor.kind === "worker" ? actor.w.id : actor.job.w;
}

export async function handleHeartbeat(id: number, env: Env, actor: Actor): Promise<Response> {
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const until = plusMinutes(LEASE_MINUTES);
  await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = ? WHERE id = ?").bind(until, id).run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = ? WHERE id = ?").bind(now(), id, who).run();
  // The lease moved; so does the job's credential.
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params), e: expires, w: who });
  return json({ task: id, lease_expires_at: until, token, token_expires_at: new Date(expires * 1000).toISOString() });
}

export async function handleComplete(id: number, request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = (await request.json()) as { sha256?: string; filename?: string; version?: string; duration_ms?: number; log_tail?: string; result?: unknown; summary?: string };
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  if (task.kind !== "build") {
    // A pool job: what it did is its result; the journal gets one line.
    await env.DB.prepare("UPDATE build_tasks SET status = 'done', finished_at = ?, duration_ms = ?, log_tail = ?, result = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?")
      .bind(now(), b.duration_ms ?? null, (b.log_tail ?? "").slice(-4000), b.result ? JSON.stringify(b.result) : null, id)
      .run();
    await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_done = builds_done + 1 WHERE id = ?").bind(now(), who).run();
    const p = task.params ? (JSON.parse(task.params) as Record<string, string>) : {};
    const label = [p.source, p.arch, p.ring, p.from && p.to ? `${p.from} → ${p.to}` : null].filter(Boolean).join("/");
    await event(env, "job", "ok", `${task.kind}${label ? " " + label : ""}: ${b.summary ?? "done"} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 1000) + " s" : ""}`, { task: id, kind: task.kind, params: p, worker: who, result: b.result ?? null, duration_ms: b.duration_ms ?? null });
    return json({ task: id, status: "done" });
  }
  if (!b.sha256 || !b.filename) return json({ error: "sha256 and filename are required" }, 400);
  if (task.trust === "community") {
    // The result must be in the contributor's staging workspace: the
    // package named, its PKGBUILD and the build log.
    const prefix = `staging/${task.owner}/${task.name}/${task.id}/`;
    const have = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ?").bind(id).all<{ key: string }>()).results.map((r) => r.key.slice(prefix.length));
    const missing = [b.filename, "PKGBUILD", "build.log"].filter((f) => !have.includes(f));
    if (missing.length) return json({ error: `upload ${missing.join(", ")} to staging first (PUT /factory/tasks/${id}/artifacts/<filename>)`, have }, 409);
    await env.DB.prepare(
      "UPDATE build_tasks SET status = 'staged', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, version = COALESCE(version, ?), duration_ms = ?, log_tail = ?, staged_prefix = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
    )
      .bind(now(), b.sha256, b.filename, b.version ?? null, b.version ?? null, b.duration_ms ?? null, (b.log_tail ?? "").slice(-4000), prefix, id)
      .run();
    await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_done = builds_done + 1 WHERE id = ?").bind(now(), who).run();
    await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
      .bind(`${b.version ?? ""} built for ${task.arch} by ${who}; waiting for a maintainer`, task.name).run();
    await env.DB.prepare("UPDATE build_requests SET status = 'review', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status IN ('requested', 'drafting', 'validating')")
      .bind(`built for ${task.arch} by ${who}; staged for a maintainer (task ${id})`, task.name).run();
    await event(env, "build", "ok", `${task.name} ${b.version ?? ""} built for ${task.arch} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""} — staged for a maintainer (${task.owner})`, { task: id, arch: task.arch, sha256: b.sha256, filename: b.filename, worker: who, owner: task.owner, staged_prefix: prefix, duration_ms: b.duration_ms ?? null });
    return json({ task: id, status: "staged", staged_prefix: prefix });
  }
  // The result must be in the pool. A rebuild of a version already stored
  // under the same filename pins the stored object (pkg-repo publish), so
  // the filename settles which sha256 the pool actually serves.
  let indexed = task.publish === 0 ? { sha256: b.sha256 } : null;
  if (!indexed) {
    indexed = await env.DB.prepare("SELECT sha256 FROM packages WHERE sha256 = ? OR (filename = ? AND repo_arch = ?) ORDER BY sha256 = ? DESC LIMIT 1")
      .bind(b.sha256, b.filename, task.arch, b.sha256)
      .first<{ sha256: string }>();
  }
  if (!indexed) return json({ error: "publish the package to the pool first (pkg-repo publish --source factory), then complete" }, 409);
  await env.DB.prepare(
    "UPDATE build_tasks SET status = 'done', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, duration_ms = ?, log_tail = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
  )
    .bind(now(), indexed.sha256, b.filename, b.version ?? null, b.duration_ms ?? null, (b.log_tail ?? "").slice(-4000), id)
    .run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_done = builds_done + 1 WHERE id = ?").bind(now(), who).run();
  await event(env, "build", "ok", `${task.name} ${b.version ?? ""} built for ${task.arch} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""}${task.publish === 0 ? " (dry run, not published)" : ""}`, { task: id, arch: task.arch, sha256: indexed.sha256, filename: b.filename, worker: who, attempts: task.attempts, duration_ms: b.duration_ms ?? null });
  return json({ task: id, status: "done" });
}

export async function handleFail(id: number, request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = (await request.json()) as { error?: string; duration_ms?: number; log_tail?: string };
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const exhausted = task.attempts >= task.max_attempts;
  // A requeued task goes behind its peers (priority + 10) so one broken
  // PKGBUILD does not hold the queue.
  await env.DB.prepare(
    `UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, log_tail = ?, duration_ms = ?, lease_owner = NULL, lease_expires_at = NULL, priority = priority + 10 WHERE id = ?`,
  )
    .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, (b.error ?? "build failed").slice(0, 2000), (b.log_tail ?? "").slice(-4000), b.duration_ms ?? null, id)
    .run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_failed = builds_failed + 1 WHERE id = ?").bind(now(), who).run();
  if (task.trust === "community" && exhausted) {
    await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`build failed on ${who}: ${(b.error ?? "").slice(0, 160)}`, task.name).run();
  }
  await event(env, "build", exhausted ? "error" : "warn", `${task.name} for ${task.arch} failed on ${who} (attempt ${task.attempts}/${task.max_attempts})${exhausted ? " — giving up" : " — back in the queue"}: ${(b.error ?? "").slice(0, 120)}`, { task: id, arch: task.arch, worker: who, attempts: task.attempts, exhausted });
  return json({ task: id, status: exhausted ? "failed" : "queued", attempts: task.attempts });
}

/** Leases that expired go back to the queue (or fail when out of attempts). Called by the scheduler. */
export async function requeueExpiredLeases(env: Env): Promise<number> {
  const expired = await env.DB.prepare("SELECT id, name, arch, lease_owner, attempts, max_attempts FROM build_tasks WHERE status = 'leased' AND lease_expires_at < ?")
    .bind(now())
    .all<{ id: number; name: string; arch: string; lease_owner: string; attempts: number; max_attempts: number }>();
  for (const t of expired.results) {
    const exhausted = t.attempts >= t.max_attempts;
    await env.DB.prepare("UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL, priority = priority + 10 WHERE id = ? AND status = 'leased'")
      .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, `lease by ${t.lease_owner} expired`, t.id)
      .run();
    await env.DB.prepare("UPDATE build_workers SET current_task = NULL WHERE id = ? AND current_task = ?").bind(t.lease_owner, t.id).run();
    await event(env, "build", exhausted ? "error" : "warn", `${t.name} for ${t.arch}: lease by ${t.lease_owner} expired${exhausted ? " — giving up" : " — back in the queue"}`, { task: t.id, worker: t.lease_owner, attempts: t.attempts });
  }
  return expired.results.length;
}

// ---------- read ----------

export async function handleFactory(env: Env, url?: URL): Promise<Response> {
  const limit = Math.min(200, Math.max(10, Number(url?.searchParams.get("limit") ?? 60) || 60));
  const counts = await env.DB.prepare("SELECT status, arch, COUNT(*) AS n FROM build_tasks GROUP BY status, arch").all();
  // Every worker belongs to someone: the project (trust project, granted by
  // a maintainer; or the hosted fallback, owner NULL) or a contributor.
  const workers = await env.DB.prepare(
    "SELECT * FROM build_workers WHERE revoked_at IS NULL ORDER BY (last_seen > ?) DESC, last_seen DESC LIMIT 200",
  )
    .bind(new Date(Date.now() - WORKER_ALIVE_MINUTES * 60000).toISOString())
    .all<{ last_seen: string; labels: string | null; owner: string | null; trust: string; packages: string | null }>();
  const tasks = await env.DB.prepare("SELECT * FROM build_tasks ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT ?").bind(limit).all<TaskRow>();
  const requests = await env.DB.prepare("SELECT * FROM build_requests ORDER BY CASE status WHEN 'requested' THEN 0 ELSE 1 END, id DESC LIMIT ?").bind(limit).all();
  const alive = Date.now() - WORKER_ALIVE_MINUTES * 60000;
  return json(
    {
      generated_at: now(),
      lease_minutes: LEASE_MINUTES,
      limit,
      counts: counts.results,
      workers: workers.results.map((w) => ({
        ...w,
        labels: w.labels ? JSON.parse(w.labels) : null,
        packages: w.packages ? JSON.parse(w.packages) : null,
        alive: Date.parse(w.last_seen) > alive,
        // omarchy: runs for the project (trusted, or the hosted fallback) · community: a contributor's
        side: w.trust === "project" || w.owner === null ? "omarchy" : "community",
      })),
      tasks: tasks.results.map((t) => ({ ...t, log_tail: undefined })),
      requests: requests.results,
    },
    200,
    { "cache-control": "public, max-age=10" },
  );
}

/**
 * Workers from before registration (no token of their own: the retired
 * shared secret's ephemeral runners and hosts) can never claim again; a day
 * after their last report they are forgotten. The journal keeps their builds.
 */
export async function pruneWorkers(env: Env): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM build_workers WHERE token_hash IS NULL AND last_seen < ?")
    .bind(new Date(Date.now() - 86400000).toISOString())
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Every (name, arch, version) the factory has a task for, with the latest
 * status. The enqueue workflow reconciles the PKGBUILDs on main against
 * this, so a merge nobody's push event announced (a bot's auto-merge, a
 * deploy race) is still built within the hour.
 */
export async function handleBuilt(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT name, arch, version, status, pkgbuild_ref, id FROM build_tasks t
      WHERE kind = 'build' AND status != 'cancelled' AND id = (SELECT MAX(id) FROM build_tasks u WHERE u.kind = 'build' AND u.name = t.name AND u.arch = t.arch AND u.version IS t.version AND u.status != 'cancelled')
      ORDER BY name, arch, id`,
  ).all();
  return json({ built: rows.results }, 200, { "cache-control": "no-store" });
}

export async function handleTask(id: number, env: Env): Promise<Response> {
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  return task ? json({ task }) : json({ error: "no such task" }, 404);
}
