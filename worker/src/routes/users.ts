import { json, type Env } from "../index";
import { groupsOf } from "../governance";

/**
 * A person's public page: what they contribute and what they maintain,
 * from the record the pool already keeps — registrations, builds,
 * approvals, workers — linked to their GitHub identity. Only registered
 * logins exist here; nothing private is shown (no tokens, no e-mail).
 */
interface TrackRecord {
  group: string;
  /** As a contributor: distinct packages a maintainer approved, builds that produced evidence, of which bumps, builds this person's workers did for others, rejections. */
  contributed: { approved: number; staged: number; bumps: number; donated: number; rejected: number };
  /** As a maintainer: decisions signed, and approvals whose project rebuild then failed. */
  maintained: { approvals: number; rejections: number; rebuilds_failed: number };
  score: number;
}

/**
 * The track record per group, from the record the pool keeps anyway —
 * approvals, staged builds, bumps, donated builds. The score is one
 * number per group with a formula anyone can check (docs/GOVERNANCE.md):
 * it says where a person has done the work, not who they are.
 */
export function scoreOf(r: Omit<TrackRecord, "score">): number {
  const c = r.contributed, m = r.maintained;
  return 3 * c.approved + c.staged + c.bumps + c.donated - 2 * c.rejected + 2 * m.approvals + m.rejections - 3 * m.rebuilds_failed;
}

export async function recordOf(env: Env, login: string): Promise<TrackRecord[]> {
  const [built, reviewed, donated, decided] = await Promise.all([
    env.DB.prepare(
      `SELECT "group" AS grp,
              SUM(CASE WHEN staged_prefix IS NOT NULL THEN 1 ELSE 0 END) AS staged,
              SUM(CASE WHEN staged_prefix IS NOT NULL AND pkgbuild_ref LIKE 'bump:%' THEN 1 ELSE 0 END) AS bumps
         FROM build_tasks WHERE owner = ? AND kind = 'build' AND trust = 'community' GROUP BY "group"`,
    ).bind(login).all<{ grp: string; staged: number; bumps: number }>(),
    env.DB.prepare(
      `SELECT a."group" AS grp,
              COUNT(DISTINCT CASE WHEN a.decision = 'approved' THEN a.name END) AS approved,
              SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM approvals a JOIN build_tasks t ON t.id = a.task_id WHERE t.owner = ? GROUP BY a."group"`,
    ).bind(login).all<{ grp: string; approved: number; rejected: number }>(),
    env.DB.prepare(
      `SELECT t."group" AS grp, COUNT(*) AS donated
         FROM build_tasks t JOIN build_workers w ON w.id = t.lease_owner
        WHERE w.owner = ? AND t.owner != ? AND t.kind = 'build' AND t.trust = 'community' AND t.staged_prefix IS NOT NULL GROUP BY t."group"`,
    ).bind(login, login).all<{ grp: string; donated: number }>(),
    env.DB.prepare(
      `SELECT a."group" AS grp,
              SUM(CASE WHEN a.decision = 'approved' THEN 1 ELSE 0 END) AS approvals,
              SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejections,
              SUM(CASE WHEN a.decision = 'approved' AND r.status = 'failed' THEN 1 ELSE 0 END) AS rebuilds_failed
         FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task WHERE a.by = ? GROUP BY a."group"`,
    ).bind(login).all<{ grp: string; approvals: number; rejections: number; rebuilds_failed: number }>(),
  ]);
  const by = new Map<string, Omit<TrackRecord, "score">>();
  const at = (g: string) => {
    let r = by.get(g);
    if (!r) { r = { group: g, contributed: { approved: 0, staged: 0, bumps: 0, donated: 0, rejected: 0 }, maintained: { approvals: 0, rejections: 0, rebuilds_failed: 0 } }; by.set(g, r); }
    return r;
  };
  for (const r of built.results) { const x = at(r.grp); x.contributed.staged = r.staged ?? 0; x.contributed.bumps = r.bumps ?? 0; }
  for (const r of reviewed.results) { const x = at(r.grp); x.contributed.approved = r.approved ?? 0; x.contributed.rejected = r.rejected ?? 0; }
  for (const r of donated.results) at(r.grp).contributed.donated = r.donated ?? 0;
  for (const r of decided.results) { const x = at(r.grp); x.maintained = { approvals: r.approvals ?? 0, rejections: r.rejections ?? 0, rebuilds_failed: r.rebuilds_failed ?? 0 }; }
  return [...by.values()].map((r) => ({ ...r, score: scoreOf(r) })).sort((a, b) => b.score - a.score || a.group.localeCompare(b.group));
}

export async function handleUser(login: string, env: Env): Promise<Response> {
  const person = await env.DB.prepare("SELECT login, name, avatar_url, role, areas, created_at, last_seen, blocked_at, blocked_by, blocked_reason FROM contributors WHERE login = ?")
    .bind(login)
    .first<{ login: string; name: string | null; avatar_url: string | null; role: string; areas: string | null; created_at: string; last_seen: string; blocked_at: string | null; blocked_by: string | null; blocked_reason: string | null }>();
  if (!person) return json({ error: "no such contributor" }, 404);
  const areas = person.areas ? (JSON.parse(person.areas) as string[]) : [];
  const [packages, builds, counts, approvals, workers, groups, record] = await Promise.all([
    env.DB.prepare(`SELECT name, "group", url, arches, status, detail, updated_at FROM factory_packages WHERE owner = ? ORDER BY name`).bind(login).all(),
    env.DB.prepare(
      `SELECT id, name, "group", arch, version, status, reason, created_at, finished_at, duration_ms FROM build_tasks
        WHERE owner = ? AND kind = 'build' ORDER BY id DESC LIMIT 50`,
    )
      .bind(login)
      .all(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'staged' THEN 1 ELSE 0 END) AS staged,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COUNT(*) AS total
         FROM build_tasks WHERE owner = ? AND kind = 'build'`,
    )
      .bind(login)
      .first<{ staged: number; published: number; failed: number; total: number }>(),
    env.DB.prepare(`SELECT task_id, name, "group", arch, version, decision, note, created_at FROM approvals WHERE by = ? ORDER BY id DESC LIMIT 50`).bind(login).all(),
    env.DB.prepare("SELECT id, arch, mode, trust, agent, last_seen, builds_done, builds_failed, revoked_at FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(login).all(),
    groupsOf(env),
    recordOf(env, login),
  ]);
  // Packages this person approved into the pool (what they maintain, in practice).
  const approvedNames = [...new Set((approvals.results as { name: string; decision: string }[]).filter((a) => a.decision === "approved").map((a) => a.name))];
  const alive = new Date(Date.now() - 10 * 60000).toISOString();
  return json(
    {
      login: person.login,
      name: person.name,
      avatar_url: person.avatar_url,
      github: `https://github.com/${person.login}`,
      role: person.role,
      blocked: person.blocked_at ? { at: person.blocked_at, by: person.blocked_by, reason: person.blocked_reason } : null,
      areas,
      groups: groups.filter((g) => g.maintainers.includes(login)).map((g) => ({ name: g.name, description: g.description })),
      since: person.created_at,
      last_seen: person.last_seen,
      packages: packages.results,
      builds: builds.results,
      build_counts: counts ?? { staged: 0, published: 0, failed: 0, total: 0 },
      approvals: approvals.results,
      approved_packages: approvedNames,
      record,
      workers: (workers.results as { last_seen: string }[]).map((w) => ({ ...w, alive: w.last_seen > alive })),
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

/** Who stands behind a package the factory built: its owner, the group's maintainers, the last approval. */
export async function maintenanceOf(env: Env, name: string, source: string, packager: string | undefined): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { packager: packager ?? null };
  if (source !== "factory") return out;
  const pkg = await env.DB.prepare(`SELECT owner, "group", url, status FROM factory_packages WHERE name = ?`).bind(name).first<{ owner: string; group: string; url: string; status: string }>();
  const approval = await env.DB.prepare("SELECT by, version, arch, created_at, task_id FROM approvals WHERE name = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1")
    .bind(name)
    .first<{ by: string; version: string | null; arch: string; created_at: string; task_id: number }>();
  const group = pkg?.group ?? null;
  const groups = await groupsOf(env);
  const g = groups.find((x) => x.name === group);
  out.factory = {
    owner: pkg?.owner ?? null,
    url: pkg?.url ?? null,
    group,
    maintainers: g?.maintainers ?? [],
    approved_by: approval?.by ?? null,
    approved_at: approval?.created_at ?? null,
    approved_version: approval?.version ?? null,
    task: approval?.task_id ?? null,
  };
  return out;
}
