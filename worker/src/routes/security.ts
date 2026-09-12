import { isRing, json, RINGS, type Env, type Ring } from "../index";
import { isRepoArch } from "../r2";
import { ringHead } from "../db";

/**
 * Security data.
 *
 *   PUT  /security/advisories   {advisories: [...], cves: [...]}   upsert (pipeline)
 *   PUT  /security/matches      {matches: [{sha256, advisory, match, status}]} (pipeline)
 *   POST /security/prune?before=<iso>   drop rows an earlier run wrote (pipeline)
 *   GET  /security?ring=&arch=  what a ring serves that is vulnerable, and what that exposes
 */

interface AdvisoryIn {
  id: string;
  source: string;
  package: string;
  cves: string[];
  severity: string;
  status: string;
  affected?: string | null;
  fixed?: string | null;
  summary?: string | null;
  url: string;
}
interface CveIn {
  cve: string;
  kev?: boolean;
  kev_added?: string | null;
  epss?: number | null;
  epss_percentile?: number | null;
}
interface MatchIn {
  sha256: string;
  advisory: string;
  match: string;
  status: string;
}

const SEVERITIES = ["critical", "high", "medium", "low", "unknown"];

export async function handlePutAdvisories(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { advisories?: AdvisoryIn[]; cves?: CveIn[]; updated_at?: string };
  const now = body.updated_at ?? new Date().toISOString();
  const stmts = [];
  for (const a of body.advisories ?? []) {
    if (!a.id || !a.package || !a.url) return json({ error: "advisory needs id, package, url" }, 400);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET source = excluded.source, package = excluded.package, cves = excluded.cves, severity = excluded.severity,
           status = excluded.status, affected = excluded.affected, fixed = excluded.fixed, summary = excluded.summary, url = excluded.url, updated_at = excluded.updated_at`,
      ).bind(a.id, a.source, a.package, JSON.stringify(a.cves ?? []), SEVERITIES.includes(a.severity) ? a.severity : "unknown", a.status, a.affected ?? null, a.fixed ?? null, a.summary ?? null, a.url, now),
    );
  }
  for (const c of body.cves ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO cve_meta (cve, kev, kev_added, epss, epss_percentile, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cve) DO UPDATE SET kev = excluded.kev, kev_added = excluded.kev_added, epss = excluded.epss, epss_percentile = excluded.epss_percentile, updated_at = excluded.updated_at`,
      ).bind(c.cve, c.kev ? 1 : 0, c.kev_added ?? null, c.epss ?? null, c.epss_percentile ?? null, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ advisories: (body.advisories ?? []).length, cves: (body.cves ?? []).length, updated_at: now });
}

export async function handlePutMatches(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { matches?: MatchIn[]; updated_at?: string };
  const now = body.updated_at ?? new Date().toISOString();
  const matches = body.matches ?? [];
  const shas = [...new Set(matches.map((m) => m.sha256))];
  const ids = new Map<string, number>();
  for (let i = 0; i < shas.length; i += 200) {
    const rows = await env.DB.prepare("SELECT id, sha256 FROM packages WHERE sha256 IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(shas.slice(i, i + 200)))
      .all<{ id: number; sha256: string }>();
    for (const r of rows.results) ids.set(r.sha256, r.id);
  }
  const stmts = [];
  let unknown = 0;
  for (const m of matches) {
    const id = ids.get(m.sha256);
    if (!id) {
      unknown++;
      continue;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (package_id, advisory_id) DO UPDATE SET match = excluded.match, status = excluded.status, updated_at = excluded.updated_at`,
      ).bind(id, m.advisory, m.match, m.status, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ matches: stmts.length, unknown_sha256: unknown, updated_at: now });
}

export async function handlePrune(url: URL, env: Env): Promise<Response> {
  const before = url.searchParams.get("before");
  if (!before) return json({ error: "before= is required" }, 400);
  const m = await env.DB.prepare("DELETE FROM package_advisories WHERE updated_at < ?").bind(before).run();
  const a = await env.DB.prepare("DELETE FROM advisories WHERE updated_at < ?").bind(before).run();
  return json({ pruned: { matches: m.meta.changes, advisories: a.meta.changes } });
}

/** Open advisories on the objects a ring serves, and what depends on them. */
export async function handleSecurity(url: URL, env: Env): Promise<Response> {
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  if (!isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  const head = await ringHead(env, ring);
  if (!head) return json({ ring, arch, vulnerable: [], totals: {} });

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.version, p.source, a.id AS advisory, a.source AS tracker, a.cves, a.severity, a.fixed, a.summary, a.url, pa.match,
            (SELECT MAX(c.kev) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS kev,
            (SELECT MAX(c.epss) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS epss
       FROM release_packages rp
       JOIN packages p ON p.id = rp.package_id AND p.repo_arch = ?2
       JOIN package_advisories pa ON pa.package_id = p.id AND pa.status = 'vulnerable'
       JOIN advisories a ON a.id = pa.advisory_id
      WHERE rp.release_id = ?1
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, p.name`,
  )
    .bind(head.id, arch)
    .all<{ id: number; name: string; version: string; source: string; advisory: string; tracker: string; cves: string; severity: string; fixed: string | null; summary: string | null; url: string; match: string; kev: number | null; epss: number | null }>();

  // Group per package; note whether a fixed object exists in another ring
  // (the fast-track candidate) and how many packages depend on it.
  const byPkg = new Map<string, { id: number; name: string; version: string; source: string; advisories: unknown[]; worst: string; kev: boolean; epss: number | null }>();
  const rank = (s: string) => SEVERITIES.indexOf(s);
  for (const r of rows.results) {
    const e = byPkg.get(r.name) ?? { id: r.id, name: r.name, version: r.version, source: r.source, advisories: [], worst: "unknown", kev: false, epss: null };
    e.advisories.push({ id: r.advisory, tracker: r.tracker, cves: JSON.parse(r.cves), severity: r.severity, fixed: r.fixed, summary: r.summary, url: r.url, match: r.match, kev: !!r.kev, epss: r.epss });
    if (rank(r.severity) < rank(e.worst)) e.worst = r.severity;
    if (r.kev) e.kev = true;
    if (r.epss != null && (e.epss == null || r.epss > e.epss)) e.epss = r.epss;
    byPkg.set(r.name, e);
  }
  const vulnerable = [...byPkg.values()];

  // Where is a version without open advisories? (per ring, same name/arch)
  const otherHeads = await Promise.all(RINGS.filter((r) => r !== ring).map(async (r) => ({ ring: r as Ring, head: await ringHead(env, r) })));
  const fixedElsewhere = new Map<string, { ring: string; version: string }[]>();
  if (vulnerable.length) {
    for (const { ring: r, head: h } of otherHeads) {
      if (!h) continue;
      const clean = await env.DB.prepare(
        `SELECT p.name, p.version FROM release_packages rp JOIN packages p ON p.id = rp.package_id
          WHERE rp.release_id = ?1 AND p.repo_arch = ?2 AND p.name IN (SELECT value FROM json_each(?3))
            AND NOT EXISTS (SELECT 1 FROM package_advisories pa WHERE pa.package_id = p.id AND pa.status = 'vulnerable')`,
      )
        .bind(h.id, arch, JSON.stringify(vulnerable.map((v) => v.name)))
        .all<{ name: string; version: string }>();
      for (const c of clean.results) fixedElsewhere.set(c.name, [...(fixedElsewhere.get(c.name) ?? []), { ring: r, version: c.version }]);
    }
  }

  // Exposure: packages in the ring that depend on a vulnerable one — by
  // declared name, or by loading a library it provides. Two indexed joins
  // (package_requires.requirement is indexed) unioned; an OR in the join
  // condition would scan the whole requires table.
  // Only confident advisories (exact, name-version) propagate: a name-only
  // one on glibc would mark the whole ring as exposed and say nothing.
  const confident = vulnerable.filter((v) => (v.advisories as { match: string }[]).some((a) => a.match !== "name-only"));
  const exposure = new Map<string, { declared: number; loads: number }>();
  let exposedTotal = 0;
  if (confident.length) {
    const ids = JSON.stringify(confident.map((v) => v.id));
    const ex = await env.DB.prepare(
      `SELECT vuln, SUM(declared) AS declared, SUM(loads) AS loads FROM (
         SELECT v.name AS vuln, COUNT(DISTINCT rq.package_id) AS declared, 0 AS loads
           FROM packages v
           JOIN package_requires rq ON rq.requirement = v.name AND rq.kind = 'depends'
           JOIN release_packages rp ON rp.package_id = rq.package_id AND rp.release_id = ?1
           JOIN packages d ON d.id = rq.package_id AND d.repo_arch = ?2 AND d.id != v.id
          WHERE v.id IN (SELECT value FROM json_each(?3)) GROUP BY v.name
         UNION ALL
         SELECT v.name, 0, COUNT(DISTINCT rq.package_id)
           FROM packages v
           JOIN package_provides pv ON pv.package_id = v.id AND pv.capability != v.name
           JOIN package_requires rq ON rq.requirement = pv.capability AND rq.kind = 'depends'
           JOIN release_packages rp ON rp.package_id = rq.package_id AND rp.release_id = ?1
           JOIN packages d ON d.id = rq.package_id AND d.repo_arch = ?2 AND d.id != v.id
          WHERE v.id IN (SELECT value FROM json_each(?3)) GROUP BY v.name
       ) GROUP BY vuln`,
    )
      .bind(head.id, arch, ids)
      .all<{ vuln: string; declared: number; loads: number }>();
    for (const r of ex.results) exposure.set(r.vuln, { declared: r.declared, loads: r.loads });
    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT rq.package_id FROM packages v
           JOIN package_requires rq ON rq.requirement = v.name AND rq.kind = 'depends'
           JOIN release_packages rp ON rp.package_id = rq.package_id AND rp.release_id = ?1
           JOIN packages d ON d.id = rq.package_id AND d.repo_arch = ?2 AND d.id != v.id
          WHERE v.id IN (SELECT value FROM json_each(?3))
         UNION
         SELECT rq.package_id FROM packages v
           JOIN package_provides pv ON pv.package_id = v.id AND pv.capability != v.name
           JOIN package_requires rq ON rq.requirement = pv.capability AND rq.kind = 'depends'
           JOIN release_packages rp ON rp.package_id = rq.package_id AND rp.release_id = ?1
           JOIN packages d ON d.id = rq.package_id AND d.repo_arch = ?2 AND d.id != v.id
          WHERE v.id IN (SELECT value FROM json_each(?3))
       )`,
    )
      .bind(head.id, arch, ids)
      .first<{ n: number }>();
    exposedTotal = total?.n ?? 0;
  }

  const totals: Record<string, number> = { packages: vulnerable.length, exposed: exposedTotal, kev: vulnerable.filter((v) => v.kev).length };
  for (const s of SEVERITIES) totals[s] = vulnerable.filter((v) => v.worst === s).length;
  const lastRun = await env.DB.prepare("SELECT MAX(updated_at) AS at, COUNT(*) AS n FROM advisories").first<{ at: string | null; n: number }>();
  return json(
    {
      ring,
      arch,
      release_id: head.id,
      updated_at: lastRun?.at ?? null,
      advisories_total: lastRun?.n ?? 0,
      totals,
      vulnerable: vulnerable.map((v) => ({ ...v, id: undefined, fixed_in: fixedElsewhere.get(v.name) ?? [], exposure: exposure.get(v.name) ?? { declared: 0, loads: 0 } })),
    },
    200,
    { "cache-control": "public, max-age=120" },
  );
}
