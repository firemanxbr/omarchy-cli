import { json, type Env } from "../index";
import { isRepoArch } from "../r2";

/**
 * The factory's brain. Cloudflare is the source of truth for package
 * requests and build tasks; build workers are ephemeral, live anywhere, and
 * *pull* work:
 *
 *   POST /factory/claim                 {worker, arch, hostname?, labels?, version?} → a task with a lease, or 204
 *   POST /factory/tasks/:id/heartbeat   {worker}                       extend the lease
 *   POST /factory/tasks/:id/complete    {worker, sha256, filename, version, duration_ms?, log_tail?}
 *   POST /factory/tasks/:id/fail        {worker, error, duration_ms?, log_tail?}   → requeued, or failed after max_attempts
 *
 * A lease that expires (worker died, build hung) goes back to the queue on
 * the scheduler's next tick. Maintainers / the pipeline (publish token):
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
  /** 0 = dry run: build and report, never publish. */
  publish: number;
}

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
function splitByUpstream(provided: { source: string; arch: string; version: string }[], arches: string[], override: boolean | undefined): { build: string[]; skipped: { arch: string; source: string; version: string }[] } {
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

export async function handleCreateRequest(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; group?: string; arches?: unknown; requested_by?: string; reason?: string; override?: boolean };
  if (!b.name || !/^[a-z0-9@._+-]+$/.test(b.name)) return json({ error: "name must be a pacman package name" }, 400);
  const group = b.group ?? "community";
  const arches = parseArches(b.arches);
  const { build, skipped } = splitByUpstream(await providedBy(env, b.name), arches, b.override);
  if (!build.length) return nothingToBuild(skipped);
  const row = await env.DB.prepare(
    `INSERT INTO build_requests (name, "group", arches, requested_by, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET reason = COALESCE(excluded.reason, reason), arches = excluded.arches RETURNING *`,
  )
    .bind(b.name, group, JSON.stringify(build), b.requested_by ?? null, b.reason ?? null)
    .first();
  await event(env, "request", "ok", `${b.name} requested for ${build.join(", ")}${b.requested_by ? " by " + b.requested_by : ""}`, { name: b.name, group, arches: build, skipped, requested_by: b.requested_by ?? null });
  return json({ request: row, skipped }, 201);
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

async function touchWorker(env: Env, w: { worker: string; arch: string; hostname?: string; labels?: unknown; version?: string }, currentTask: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, version, last_seen, current_task) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET arch = excluded.arch, hostname = COALESCE(excluded.hostname, hostname), labels = COALESCE(excluded.labels, labels),
       version = COALESCE(excluded.version, version), last_seen = excluded.last_seen, current_task = excluded.current_task`,
  )
    .bind(w.worker, w.arch, w.hostname ?? null, w.labels ? JSON.stringify(w.labels) : null, w.version ?? null, now(), currentTask)
    .run();
}

export async function handleClaim(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { worker?: string; arch?: string; hostname?: string; labels?: unknown; version?: string };
  if (!b.worker || !b.arch || !isRepoArch(b.arch)) return json({ error: "worker and arch (x86_64|aarch64) are required" }, 400);
  // One statement claims the next queued task of this architecture: D1
  // serialises writes, so two workers never get the same one.
  const task = await env.DB.prepare(
    `UPDATE build_tasks SET status = 'leased', lease_owner = ?1, lease_expires_at = ?2, started_at = ?3, attempts = attempts + 1, error = NULL
      WHERE id = (SELECT id FROM build_tasks WHERE status = 'queued' AND arch = ?4 ORDER BY priority, id LIMIT 1) AND status = 'queued'
      RETURNING *`,
  )
    .bind(b.worker, plusMinutes(LEASE_MINUTES), now(), b.arch)
    .first<TaskRow>();
  await touchWorker(env, { worker: b.worker, arch: b.arch, hostname: b.hostname, labels: b.labels, version: b.version }, task?.id ?? null);
  if (!task) return new Response(null, { status: 204 });
  return json({ task, lease_minutes: LEASE_MINUTES, repo: "https://github.com/firemanxbr/omarchy-pool", pkgbuild_path: `factory/pkgbuilds/${task.group}/${task.name}` });
}

async function owned(env: Env, id: number, worker: string): Promise<TaskRow | Response> {
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!task) return json({ error: "no such task" }, 404);
  if (task.status !== "leased" || task.lease_owner !== worker) return json({ error: `task ${id} is ${task.status}${task.lease_owner ? " by " + task.lease_owner : ""}; the lease is not yours` }, 409);
  return task;
}

export async function handleHeartbeat(id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { worker?: string };
  if (!b.worker) return json({ error: "worker is required" }, 400);
  const task = await owned(env, id, b.worker);
  if (task instanceof Response) return task;
  const until = plusMinutes(LEASE_MINUTES);
  await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = ? WHERE id = ?").bind(until, id).run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = ? WHERE id = ?").bind(now(), id, b.worker).run();
  return json({ task: id, lease_expires_at: until });
}

export async function handleComplete(id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { worker?: string; sha256?: string; filename?: string; version?: string; duration_ms?: number; log_tail?: string };
  if (!b.worker || !b.sha256 || !b.filename) return json({ error: "worker, sha256 and filename are required" }, 400);
  const task = await owned(env, id, b.worker);
  if (task instanceof Response) return task;
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
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_done = builds_done + 1 WHERE id = ?").bind(now(), b.worker).run();
  await event(env, "build", "ok", `${task.name} ${b.version ?? ""} built for ${task.arch} by ${b.worker}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""}${task.publish === 0 ? " (dry run, not published)" : ""}`, { task: id, arch: task.arch, sha256: indexed.sha256, filename: b.filename, worker: b.worker, attempts: task.attempts, duration_ms: b.duration_ms ?? null });
  return json({ task: id, status: "done" });
}

export async function handleFail(id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { worker?: string; error?: string; duration_ms?: number; log_tail?: string };
  if (!b.worker) return json({ error: "worker is required" }, 400);
  const task = await owned(env, id, b.worker);
  if (task instanceof Response) return task;
  const exhausted = task.attempts >= task.max_attempts;
  // A requeued task goes behind its peers (priority + 10) so one broken
  // PKGBUILD does not hold the queue.
  await env.DB.prepare(
    `UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, log_tail = ?, duration_ms = ?, lease_owner = NULL, lease_expires_at = NULL, priority = priority + 10 WHERE id = ?`,
  )
    .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, (b.error ?? "build failed").slice(0, 2000), (b.log_tail ?? "").slice(-4000), b.duration_ms ?? null, id)
    .run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = NULL, builds_failed = builds_failed + 1 WHERE id = ?").bind(now(), b.worker).run();
  await event(env, "build", exhausted ? "error" : "warn", `${task.name} for ${task.arch} failed on ${b.worker} (attempt ${task.attempts}/${task.max_attempts})${exhausted ? " — giving up" : " — back in the queue"}: ${(b.error ?? "").slice(0, 120)}`, { task: id, arch: task.arch, worker: b.worker, attempts: task.attempts, exhausted });
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

export async function handleFactory(env: Env): Promise<Response> {
  const counts = await env.DB.prepare("SELECT status, arch, COUNT(*) AS n FROM build_tasks GROUP BY status, arch").all();
  const workers = await env.DB.prepare("SELECT * FROM build_workers ORDER BY last_seen DESC LIMIT 50").all<{ last_seen: string; labels: string | null }>();
  const tasks = await env.DB.prepare("SELECT * FROM build_tasks ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT 60").all<TaskRow>();
  const requests = await env.DB.prepare("SELECT * FROM build_requests ORDER BY CASE status WHEN 'requested' THEN 0 ELSE 1 END, id DESC LIMIT 60").all();
  const alive = Date.now() - WORKER_ALIVE_MINUTES * 60000;
  return json(
    {
      generated_at: now(),
      lease_minutes: LEASE_MINUTES,
      counts: counts.results,
      workers: workers.results.map((w) => ({ ...w, labels: w.labels ? JSON.parse(w.labels) : null, alive: Date.parse(w.last_seen) > alive })),
      tasks: tasks.results.map((t) => ({ ...t, log_tail: undefined })),
      requests: requests.results,
    },
    200,
    { "cache-control": "public, max-age=10" },
  );
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
      WHERE status != 'cancelled' AND id = (SELECT MAX(id) FROM build_tasks u WHERE u.name = t.name AND u.arch = t.arch AND u.version IS t.version AND u.status != 'cancelled')
      ORDER BY name, arch, id`,
  ).all();
  return json({ built: rows.results }, 200, { "cache-control": "no-store" });
}

export async function handleTask(id: number, env: Env): Promise<Response> {
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  return task ? json({ task }) : json({ error: "no such task" }, 404);
}
