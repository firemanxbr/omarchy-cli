import { json, RINGS, type Env } from "../index";
import { version } from "../meta";
import { ringHead } from "../db";

/** Everything the dashboard shows, in one round trip. */
export async function handleStats(env: Env): Promise<Response> {
  const rings = [];
  for (const ring of RINGS) {
    const head = await ringHead(env, ring);
    if (!head) {
      rings.push({ ring, release: null, package_count: 0, bytes: 0, sources: [], artifacts: [] });
      continue;
    }
    const sources = await env.DB.prepare(
      `SELECT p.source, p.repo_arch AS arch, COUNT(*) AS packages, COALESCE(SUM(p.size_download), 0) AS bytes
         FROM release_packages rp JOIN packages p ON p.id = rp.package_id
        WHERE rp.release_id = ? GROUP BY p.source, p.repo_arch ORDER BY p.repo_arch, p.source`,
    )
      .bind(head.id)
      .all<{ source: string; arch: string; packages: number; bytes: number }>();
    const artifacts = await env.DB.prepare(
      "SELECT repo, arch, kind, size, created_at FROM release_artifacts WHERE release_id = ? ORDER BY repo, kind",
    )
      .bind(head.id)
      .all();
    const total = sources.results.reduce((a, s) => ({ p: a.p + s.packages, b: a.b + s.bytes }), { p: 0, b: 0 });
    rings.push({ ring, release: head, package_count: total.p, bytes: total.b, sources: sources.results, artifacts: artifacts.results });
  }

  const pool = await env.DB.prepare(
    "SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes, COUNT(DISTINCT name) AS names FROM packages",
  ).first<{ objects: number; bytes: number; names: number }>();
  const referenced = await env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id IN (SELECT rp.package_id FROM ring_heads h JOIN release_packages rp ON rp.release_id = h.release_id)`,
  ).first<{ objects: number; bytes: number }>();
  const anyRelease = await env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id IN (SELECT package_id FROM release_packages)`,
  ).first<{ objects: number; bytes: number }>();
  // What GC would actually delete now: unreferenced by the last 3 releases and past the grace period.
  const reclaimable = await env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id NOT IN (SELECT rp.package_id FROM release_packages rp
                        WHERE rp.release_id IN (SELECT id FROM releases r WHERE r.id IN (
                          SELECT id FROM releases r2 WHERE r2.ring = r.ring ORDER BY seq DESC LIMIT 3)))
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
  ).first<{ objects: number; bytes: number }>();
  const bySource = await env.DB.prepare(
    "SELECT source, repo_arch AS arch, COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages GROUP BY source, repo_arch ORDER BY repo_arch, source",
  ).all();

  const releases = await env.DB.prepare(
    `SELECT r.id, r.ring, r.seq, r.parent_id, r.source_id, r.note, r.created_at,
            (SELECT COUNT(*) FROM release_packages rp WHERE rp.release_id = r.id) AS package_count,
            (h.release_id IS NOT NULL) AS is_head
       FROM releases r LEFT JOIN ring_heads h ON h.release_id = r.id
      ORDER BY r.id DESC LIMIT 15`,
  ).all();

  const events = await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 40").all();
  const lastByKind = await env.DB.prepare(
    `SELECT e.* FROM events e JOIN (SELECT kind, COALESCE(source, '') AS src, COALESCE(ring, '') AS rg, MAX(id) AS id
                                     FROM events GROUP BY kind, COALESCE(source, ''), COALESCE(ring, '')) m ON m.id = e.id
      ORDER BY e.kind, e.source, e.ring`,
  ).all();

  const parse = (r: Record<string, unknown>) => ({ ...r, payload: r.payload ? JSON.parse(r.payload as string) : null });
  return json(
    {
      generated_at: new Date().toISOString(),
      version: version(env),
      rings,
      pool: { ...pool, by_source: bySource.results, referenced_by_heads: referenced, referenced_by_any_release: anyRelease, reclaimable },
      releases: releases.results,
      events: events.results.map(parse),
      latest: lastByKind.results.map(parse),
    },
    200,
    { "cache-control": "public, max-age=30" },
  );
}
