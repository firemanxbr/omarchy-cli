import { json, type Env } from "../index";
import { maintains, type Contributor } from "./contributors";

/**
 * Review: what maintainers do with staged builds (docs/GOVERNANCE.md).
 *
 *   GET  /factory/review                    staged builds — the contributors' (evidence) and the project's — with
 *                                           their evidence, the gate and the audit (public)
 *   POST /factory/tasks/:id/build   {note?} a maintainer, never the owner, on a contributor's staged build → the
 *                                           project builds the package again on a review worker with the project's
 *                                           agent: the request and the contributor's evidence as the lesson, its own
 *                                           recipe, the gate, staged like any build (review:<id>)
 *   POST /factory/tasks/:id/approve {note?} a maintainer, never the owner, on the *project's* staged build → the
 *                                           decision on the record and a publish job: the project's package into edge
 *   POST /factory/tasks/:id/reject  {note}  maintainer, either kind of staged build → back to registered with the reason
 *   GET  /factory/approvals                 the record (public)
 */

interface Staged {
  id: number;
  name: string;
  group: string;
  arch: string;
  version: string | null;
  owner: string | null;
  status: string;
  staged_prefix: string | null;
  result_sha256: string | null;
  result_filename: string | null;
  duration_ms: number | null;
  finished_at: string | null;
  pkgbuild_ref: string;
  lease_owner: string | null;
}

export async function handleReviewList(env: Env): Promise<Response> {
  const staged = await env.DB.prepare(
    `SELECT t.id, t.name, t."group", t.arch, t.version, t.owner, t.status, t.trust, t.params, t.staged_prefix, t.result_sha256, t.result_filename, t.duration_ms, t.finished_at, t.pkgbuild_ref, t.result,
            p.url, p.detected,
            (SELECT decision FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decision,
            (SELECT by FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decided_by,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_error
       FROM build_tasks t LEFT JOIN factory_packages p ON p.name = t.name
      WHERE t.kind = 'build' AND t.status = 'staged'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.decision = 'approved')
      ORDER BY t.id DESC LIMIT 100`,
  ).all();
  // A contributor's build that the project is building again, or built: the review row says so.
  const projectOf = new Map<number, { id: number; status: string; error: string | null }>();
  const builds = await env.DB.prepare("SELECT id, status, error, params FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') IS NOT NULL AND status IN ('queued', 'leased', 'staged', 'failed', 'done') ORDER BY id").all<{ id: number; status: string; error: string | null; params: string }>();
  for (const b of builds.results) {
    const from = Number((JSON.parse(b.params) as { review?: number }).review);
    if (from) projectOf.set(from, { id: b.id, status: b.status, error: b.error });
  }
  return json(
    {
      staged: staged.results.map((r) => ({
        ...r,
        // contributor: evidence, a maintainer has the project build it · project: the project's own build, a maintainer approves it
        kind: r.trust === "project" ? "project" : "contributor",
        from: r.trust === "project" && r.params ? ((JSON.parse(r.params as string) as { review?: number }).review ?? null) : null,
        project_build: r.trust === "community" ? (projectOf.get(r.id as number) ?? null) : null,
        params: undefined,
        detected: r.detected ? JSON.parse(r.detected as string) : null,
        evidence: { log: `/api/v1/factory/tasks/${r.id}/artifacts/build.log`, pkgbuild: `/api/v1/factory/tasks/${r.id}/artifacts/PKGBUILD`, pkginfo: `/api/v1/factory/tasks/${r.id}/artifacts/PKGINFO`, audit: `/api/v1/factory/tasks/${r.id}/artifacts/audit.md`, tests: `/api/v1/factory/tasks/${r.id}/artifacts/tests.log`, vet: `/api/v1/factory/tasks/${r.id}/artifacts/vet.json` },
        // The gate (factory/README.md *The gate*): the worker's own checks — checksums, shellcheck, namcap, the file list, the metadata, check(), the smoke test — as vet.json said.
        vet: vetOf(r.result as string | null),
        // The second agent's report (docs/GOVERNANCE.md): a verdict a
        // maintainer reads, never one the pool acts on.
        audit: auditOf(r.audit_status as string | null, r.audit_result as string | null, r.audit_error as string | null),
        audit_status: undefined, audit_result: undefined, audit_error: undefined, result: undefined,
      })),
    },
    200,
    { "cache-control": "no-store" },
  );
}

interface AuditReport { verdict: string; summary: string; findings: { severity: string; area: string }[]; model?: string }

/** The gate's summary the build's completion kept on the task (build_tasks.result → {vet}); null for a build older than the gate. */
function vetOf(result: string | null): { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } | null {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { vet?: { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } }).vet ?? null;
  } catch {
    return null;
  }
}

/** The audit as the Review page shows it: its state while pending, the verdict once done. */
function auditOf(status: string | null, result: string | null, error: string | null): { status: string; verdict?: string; summary?: string; findings?: number; high?: number; model?: string; error?: string } {
  if (!status) return { status: "none" };
  if (status !== "done") return { status, error: error ?? undefined };
  try {
    const r = JSON.parse(result ?? "{}") as AuditReport;
    const findings = Array.isArray(r.findings) ? r.findings : [];
    return { status: "done", verdict: r.verdict, summary: r.summary, findings: findings.length, high: findings.filter((f) => f.severity === "high").length, model: r.model };
  } catch {
    return { status: "done", error: "unreadable report" };
  }
}

/** A decision on the build ends the audit that has not started (the report of one that ran stays as evidence). */
async function cancelPendingAudit(env: Env, taskId: number): Promise<void> {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build was decided before the audit ran' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(taskId).run();
}

function canReview(c: Contributor, group: string): boolean {
  return maintains(c, group);
}

/** The owner of a package — the contributor who requested it — from the registration; the task's owner as the fallback. */
async function ownerOf(env: Env, name: string, fallback: string | null): Promise<string | null> {
  const p = await env.DB.prepare("SELECT owner, request_id FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; request_id: number | null }>();
  return p?.owner ?? fallback;
}

/**
 * "Build it by the project": a maintainer, never the owner, on a
 * contributor's staged build. The project builds the package again on a
 * worker it trusts, with its own agent — the request, the contributor's
 * PKGBUILD, log, gate and audit as the lesson, never the product — through
 * the same gate, staged like any build. Then a maintainer approves *that*.
 */
export async function handleProjectBuild(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.trust !== "community" || t.status !== "staged") return json({ error: `task ${id} is ${t.trust === "project" ? "the project's own build" : t.status}; the project builds from a contributor's staged build` }, 409);
  if (!canReview(c, t.group)) return json({ error: `a maintainer of ${t.group} is required` }, 403);
  const owner = await ownerOf(env, t.name, t.owner);
  if (owner === c.login) return json({ error: `${c.login} brought ${t.name}; another maintainer must review it` }, 403);
  const inFlight = await env.DB.prepare("SELECT id, status FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') = ? AND status IN ('queued', 'leased', 'staged')").bind(id).first<{ id: number; status: string }>();
  if (inFlight) return json({ error: `the project is already on it: task ${inFlight.id} is ${inFlight.status}` }, 409);
  const pkg = await env.DB.prepare("SELECT request_id, project, source, release, description, license FROM factory_packages WHERE name = ?").bind(t.name).first<{ request_id: number | null; project: string | null; source: string | null; release: string | null; description: string | null; license: string | null }>();
  const params = { review: id, request: pkg?.request_id ?? null, project: pkg?.project ?? null, source: pkg?.source ?? null, version: pkg?.release ?? t.version, description: pkg?.description ?? null, license: pkg?.license ?? null, owner, by: c.login, note: b.note ?? null };
  const row = await env.DB.prepare(
    `INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, ?, ?, 30, 0, 'project', ?, 'build', ?) RETURNING id`,
  )
    .bind(t.name, t.group, t.arch, t.version, `review:${id}`, `project build asked by ${c.login}`, owner, JSON.stringify(params))
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch}: the project is building it (task ${row?.id}), asked by ${c.login}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}): ${c.login} asked the project to build it — task ${row?.id}, from ${owner ?? "?"}'s build ${id}`, JSON.stringify({ task: row?.id, from: id, name: t.name, arch: t.arch, by: c.login, owner, note: b.note ?? null }))
    .run();
  return json({ task: row?.id, from: id, by: c.login });
}

export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string; params: string | null; result_filename: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  // What users get is the project's build: a contributor's build cannot be
  // approved — it is evidence, and "Build it by the project" comes first.
  if (t.trust !== "project") return json({ error: `task ${id} is a contributor's build — evidence, never what users get. Have the project build it first (POST /factory/tasks/${id}/build), then approve the project's build` }, 409);
  if (!canReview(c, t.group)) return json({ error: `a maintainer of ${t.group} is required` }, 403);
  // Conflict of interest: nobody approves their own package, and a group
  // with a single maintainer is no exception — that maintainer's own
  // packages wait for a second one (docs/GOVERNANCE.md).
  const owner = await ownerOf(env, t.name, t.owner);
  if (owner === c.login) return json({ error: `${c.login} brought ${t.name}; another maintainer of ${t.group} must approve it — a group with one maintainer cannot approve that maintainer's own packages` }, 403);
  const already = await env.DB.prepare("SELECT id FROM approvals WHERE task_id = ? AND decision = 'approved'").bind(id).first();
  if (already) return json({ error: "already approved" }, 409);
  // The decision, on the record, and the publish job: a project worker
  // carries the staged package into the pool (signed there), renders
  // edge, and handleComplete marks the registration published and links
  // this approval to the build (the seal and the track record read it).
  const files = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(id).all<{ key: string }>()).results.map((r) => r.key.slice(r.key.lastIndexOf("/") + 1));
  if (!files.length) return json({ error: "the project's build left no package in staging" }, 409);
  const publish = await env.DB.prepare(
    `INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, '-', ?, 20, 1, 'project', NULL, 'publish', ?) RETURNING id`,
  )
    .bind(t.name, t.group, t.arch, t.version, `approved by ${c.login}`, JSON.stringify({ task: id, name: t.name, arch: t.arch, version: t.version, files, by: c.login }))
    .first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, "group", arch, version, decision, by, note, rebuild_task) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`)
    .bind(id, t.name, t.group, t.arch, t.version, c.login, b.note ?? null, id)
    .run();
  await env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch} approved by ${c.login}; publishing the project's build (job ${publish?.id})`, t.name)
    .run();
  await cancelPendingAudit(env, id);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) approved by ${c.login}${b.note ? " — " + b.note.slice(0, 120) : ""}; the project's build ${id} goes into edge (job ${publish?.id})`, JSON.stringify({ task: id, publish: publish?.id, name: t.name, arch: t.arch, by: c.login, owner, note: b.note ?? null }))
    .run();
  return json({ task: id, decision: "approved", by: c.login, publish: publish?.id });
}

export async function handleReject(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  if (!b.note) return json({ error: "a note saying why is required" }, 400);
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  if (!canReview(c, t.group)) return json({ error: `a maintainer of ${t.group} is required` }, 403);
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, "group", arch, version, decision, by, note) VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?)`)
    .bind(id, t.name, t.group, t.arch, t.version, c.login, b.note)
    .run();
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE id = ?").bind(`rejected by ${c.login}: ${b.note.slice(0, 500)}`, id).run();
  await cancelPendingAudit(env, id);
  await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`rejected by ${c.login}: ${b.note.slice(0, 200)}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) rejected by ${c.login}: ${b.note.slice(0, 140)}`, JSON.stringify({ task: id, name: t.name, arch: t.arch, by: c.login, owner: t.owner, note: b.note }))
    .run();
  return json({ task: id, decision: "rejected", by: c.login });
}

export async function handleApprovals(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT a.*, r.status AS rebuild_status, r.result_filename AS rebuild_result FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task ORDER BY a.id DESC LIMIT 100`,
  ).all();
  return json({ approvals: rows.results }, 200, { "cache-control": "public, max-age=30" });
}
