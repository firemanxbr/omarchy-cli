import { json, type Env } from "../index";
import { maintains, type Contributor } from "./contributors";

/**
 * Review: what maintainers do with staged builds.
 *
 *   GET  /factory/review                    staged community builds with their evidence and the audit's verdict (public)
 *   POST /factory/tasks/:id/approve {note?} a maintainer of the package's group, never its owner → the decision
 *                                           is recorded; nothing of the contributor's is copied. The project
 *                                           builds the recipe a maintainer writes from the evidence and merges
 *                                           into factory/pkgbuilds/<group>/<name>/ (the hourly enqueue job)
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
            (SELECT by FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decided_by,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_error
       FROM build_tasks t LEFT JOIN factory_packages p ON p.name = t.name
      WHERE t.kind = 'build' AND t.trust = 'community' AND t.status = 'staged'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.decision = 'approved')
      ORDER BY t.id DESC LIMIT 100`,
  ).all();
  return json(
    {
      staged: staged.results.map((r) => ({
        ...r,
        detected: r.detected ? JSON.parse(r.detected as string) : null,
        evidence: { log: `/api/v1/factory/tasks/${r.id}/artifacts/build.log`, pkgbuild: `/api/v1/factory/tasks/${r.id}/artifacts/PKGBUILD`, pkginfo: `/api/v1/factory/tasks/${r.id}/artifacts/PKGINFO`, audit: `/api/v1/factory/tasks/${r.id}/artifacts/audit.md` },
        // The second agent's report (docs/GOVERNANCE.md): a verdict a
        // maintainer reads, never one the pool acts on.
        audit: auditOf(r.audit_status as string | null, r.audit_result as string | null, r.audit_error as string | null),
        audit_status: undefined, audit_result: undefined, audit_error: undefined,
      })),
    },
    200,
    { "cache-control": "no-store" },
  );
}

interface AuditReport { verdict: string; summary: string; findings: { severity: string; area: string }[]; model?: string }

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

export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  if (!canReview(c, t.group)) return json({ error: `a maintainer of ${t.group} is required` }, 403);
  // Conflict of interest: nobody approves their own package, and a group
  // with a single maintainer is no exception — that maintainer's own
  // packages wait for a second one (docs/GOVERNANCE.md).
  if (t.owner === c.login) return json({ error: `${c.login} brought ${t.name}; another maintainer of ${t.group} must approve it — a group with one maintainer cannot approve that maintainer's own packages` }, 403);
  const already = await env.DB.prepare("SELECT id FROM approvals WHERE task_id = ? AND decision = 'approved'").bind(id).first();
  if (already) return json({ error: "already approved" }, 409);
  // The decision, on the record. Nothing of the contributor's is copied —
  // not the package, not the PKGBUILD: the project builds the recipe a
  // maintainer writes from this evidence and merges into the repository,
  // queued from main by the hourly enqueue job. When that build lands,
  // handleComplete links it to this approval (the seal and the track
  // record read the link) and publishes the registration.
  const recipe = `factory/pkgbuilds/${t.group}/${t.name}/PKGBUILD`;
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, "group", arch, version, decision, by, note, rebuild_task) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, NULL)`)
    .bind(id, t.name, t.group, t.arch, t.version, c.login, b.note ?? null)
    .run();
  await env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch} approved by ${c.login}; waiting for a maintainer's recipe in ${recipe}`, t.name)
    .run();
  await env.DB.prepare("UPDATE build_requests SET status = 'approved', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status != 'approved'")
    .bind(c.login, `approved by ${c.login}; the project builds ${recipe} once it is on main`, t.name)
    .run();
  await cancelPendingAudit(env, id);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) approved by ${c.login}${b.note ? " — " + b.note.slice(0, 120) : ""}; the project builds it once ${recipe} is on main`, JSON.stringify({ task: id, name: t.name, arch: t.arch, by: c.login, owner: t.owner, note: b.note ?? null, recipe }))
    .run();
  return json({ task: id, decision: "approved", by: c.login, recipe });
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
