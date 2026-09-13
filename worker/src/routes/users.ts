import { json, type Env } from "../index";
import { groupsOf } from "../governance";

/**
 * A person's public page: what they contribute and what they maintain,
 * from the record the pool already keeps — registrations, builds,
 * approvals, workers — linked to their GitHub identity. Only registered
 * logins exist here; nothing private is shown (no tokens, no e-mail).
 */
export async function handleUser(login: string, env: Env): Promise<Response> {
  const person = await env.DB.prepare("SELECT login, name, avatar_url, role, areas, created_at, last_seen FROM contributors WHERE login = ?")
    .bind(login)
    .first<{ login: string; name: string | null; avatar_url: string | null; role: string; areas: string | null; created_at: string; last_seen: string }>();
  if (!person) return json({ error: "no such contributor" }, 404);
  const areas = person.areas ? (JSON.parse(person.areas) as string[]) : [];
  const [packages, builds, counts, approvals, workers, groups] = await Promise.all([
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
    env.DB.prepare("SELECT id, arch, mode, trust, last_seen, builds_done, builds_failed, revoked_at FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(login).all(),
    groupsOf(env),
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
      areas,
      groups: groups.filter((g) => g.maintainers.includes(login)).map((g) => ({ name: g.name, description: g.description })),
      since: person.created_at,
      last_seen: person.last_seen,
      packages: packages.results,
      builds: builds.results,
      build_counts: counts ?? { staged: 0, published: 0, failed: 0, total: 0 },
      approvals: approvals.results,
      approved_packages: approvedNames,
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
