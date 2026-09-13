import { json, type Env } from "../index";
import { maintains, type Contributor } from "./contributors";

/**
 * Review: what maintainers do with staged builds.
 *
 *   GET  /factory/review                    staged community builds with their evidence (public)
 *   POST /factory/tasks/:id/approve {note?} maintainer of the package's area → a project build of the
 *                                           same PKGBUILD is queued; its result is signed and published
 *   POST /factory/tasks/:id/reject  {note}  maintainer → the package goes back to registered with the reason
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
    `SELECT t.id, t.name, t."group", t.arch, t.version, t.owner, t.status, t.staged_prefix, t.result_sha256, t.result_filename, t.duration_ms, t.finished_at, t.pkgbuild_ref,
            p.url, p.detected,
            (SELECT decision FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decision,
            (SELECT by FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decided_by
       FROM build_tasks t LEFT JOIN factory_packages p ON p.name = t.name
      WHERE t.kind = 'build' AND t.trust = 'community' AND t.status = 'staged'
      ORDER BY t.id DESC LIMIT 100`,
  ).all();
  return json(
    {
      staged: staged.results.map((r) => ({
        ...r,
        detected: r.detected ? JSON.parse(r.detected as string) : null,
        evidence: { log: `/api/v1/factory/tasks/${r.id}/artifacts/build.log`, pkgbuild: `/api/v1/factory/tasks/${r.id}/artifacts/PKGBUILD`, pkginfo: `/api/v1/factory/tasks/${r.id}/artifacts/PKGINFO` },
      })),
    },
    200,
    { "cache-control": "no-store" },
  );
}

function canReview(c: Contributor, group: string): boolean {
  return maintains(c, group);
}

export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  if (!canReview(c, t.group)) return json({ error: `a maintainer of ${t.group} is required` }, 403);
  const already = await env.DB.prepare("SELECT id FROM approvals WHERE task_id = ? AND decision = 'approved'").bind(id).first();
  if (already) return json({ error: "already approved" }, 409);
  // The project rebuilds the same PKGBUILD: the staged one, fetched by the
  // worker from this task's evidence. Signed and published by the project.
  const rebuild = await env.DB.prepare(
    `INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES (?, ?, ?, ?, ?, ?, 30, 1, 'project', ?, 'build') RETURNING id`,
  )
    .bind(t.name, t.group, t.arch, t.version, `staging:${id}`, `approved by ${c.login}`, t.owner)
    .first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, "group", arch, version, decision, by, note, rebuild_task) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`)
    .bind(id, t.name, t.group, t.arch, t.version, c.login, b.note ?? null, rebuild?.id ?? null)
    .run();
  await env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch} approved by ${c.login}; the project is rebuilding it`, t.name)
    .run();
  await env.DB.prepare("UPDATE build_requests SET status = 'approved', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status != 'approved'")
    .bind(c.login, `approved by ${c.login}; project rebuild task ${rebuild?.id}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) approved by ${c.login}${b.note ? " — " + b.note.slice(0, 120) : ""}; project rebuild queued as task ${rebuild?.id}`, JSON.stringify({ task: id, rebuild: rebuild?.id, name: t.name, arch: t.arch, by: c.login, owner: t.owner, note: b.note ?? null }))
    .run();
  return json({ task: id, decision: "approved", rebuild_task: rebuild?.id, by: c.login });
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
  await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`rejected by ${c.login}: ${b.note.slice(0, 200)}`, t.name)
    .run();
  await env.DB.prepare("UPDATE build_requests SET status = 'rejected', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status NOT IN ('approved', 'rejected')")
    .bind(`rejected by ${c.login}: ${b.note}`, t.name)
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
