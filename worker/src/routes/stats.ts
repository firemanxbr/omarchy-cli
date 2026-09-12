import { json, RINGS, type Env } from "../index";
import { EXPECTED_SOURCES, version } from "../meta";
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

  // Activity: everything but the half-hourly metrics snapshots.
  const events = await env.DB.prepare("SELECT * FROM events WHERE kind != 'metrics' ORDER BY id DESC LIMIT 40").all();
  const lastByKind = await env.DB.prepare(
    `SELECT e.* FROM events e JOIN (SELECT kind, COALESCE(source, '') AS src, COALESCE(ring, '') AS rg, MAX(id) AS id
                                     FROM events GROUP BY kind, COALESCE(source, ''), COALESCE(ring, '')) m ON m.id = e.id
      ORDER BY e.kind, e.source, e.ring`,
  ).all();

  const parse = (r: Record<string, unknown>) => ({ ...r, payload: r.payload ? JSON.parse(r.payload as string) : null });

  // Coverage: the latest successful sync of every (source, arch) says how many
  // packages upstream has; the pool says how many of them are here.
  const lastSync = await env.DB.prepare(
    `SELECT e.source, COALESCE(json_extract(e.payload, '$.arch'), 'x86_64') AS arch, e.status, e.created_at,
            json_extract(e.payload, '$.upstream_total') AS upstream_total, json_extract(e.payload, '$.deferred') AS deferred,
            json_extract(e.payload, '$.uploaded') AS uploaded, json_extract(e.payload, '$.removed') AS removed
       FROM events e JOIN (SELECT source, COALESCE(json_extract(payload, '$.arch'), 'x86_64') AS arch, MAX(id) AS id
                             FROM events WHERE kind = 'sync' AND status != 'error' AND source IS NOT NULL AND ring = 'edge'
                            GROUP BY source, COALESCE(json_extract(payload, '$.arch'), 'x86_64')) m ON m.id = e.id
      ORDER BY arch, e.source`,
  ).all<{ source: string; arch: string; status: string; created_at: string; upstream_total: number | null; deferred: number | null; uploaded: number | null; removed: number | null }>();
  const indexed = new Map((bySource.results as { source: string; arch: string; objects: number; bytes: number }[]).map((r) => [`${r.source}/${r.arch}`, r]));
  // Coverage counts what edge pins, not every object of the source in the
  // pool (superseded versions stay until retention runs).
  const edgeHead = rings.find((r) => r.ring === "edge");
  const pinnedEdge = new Map(((edgeHead?.sources ?? []) as { source: string; arch: string; packages: number }[]).map((s) => [`${s.source}/${s.arch}`, s.packages]));
  const stableHead = rings.find((r) => r.ring === "stable");
  const pinnedStable = new Map(((stableHead?.sources ?? []) as { source: string; arch: string; packages: number }[]).map((s) => [`${s.source}/${s.arch}`, s.packages]));
  const synced = new Map(lastSync.results.map((r) => [`${r.source}/${r.arch}`, r]));
  const keys = new Set([...EXPECTED_SOURCES.map((e) => `${e.source}/${e.arch}`), ...synced.keys()]);
  const coverage = [...keys].map((key) => {
    const [source, arch] = key.split("/");
    const r = synced.get(key);
    const have = indexed.get(key);
    const expected = EXPECTED_SOURCES.find((e) => e.source === source && e.arch === arch);
    return {
      source,
      arch,
      upstream: expected?.upstream ?? null,
      optional: expected?.optional ?? false,
      title: expected?.title ?? null,
      upstream_total: r?.upstream_total ?? null,
      indexed: pinnedEdge.get(key) ?? have?.objects ?? 0,
      objects: have?.objects ?? 0,
      bytes: have?.bytes ?? 0,
      pinned_stable: pinnedStable.get(key) ?? 0,
      missing: r?.upstream_total == null ? null : Math.max(0, r.upstream_total - (pinnedEdge.get(key) ?? have?.objects ?? 0)),
      last_sync: r?.created_at ?? null,
      last_status: r?.status ?? null,
    };
  });

  // Series for the charts (small projections, never whole payloads).
  const importsDaily = await env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs,
            COALESCE(SUM(json_extract(payload, '$.uploaded')), 0) AS packages,
            COALESCE(SUM(json_extract(payload, '$.bytes_uploaded')), 0) AS bytes
       FROM events WHERE kind = 'sync' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
      GROUP BY day ORDER BY day`,
  ).all();
  const syncRuns = await env.DB.prepare(
    `SELECT id, created_at, source, status, duration_ms, COALESCE(json_extract(payload, '$.arch'), 'x86_64') AS arch,
            json_extract(payload, '$.uploaded') AS uploaded, json_extract(payload, '$.bytes_uploaded') AS bytes,
            json_extract(payload, '$.concurrency') AS concurrency, json_extract(payload, '$.ci.run_url') AS run_url
       FROM events WHERE kind = 'sync' ORDER BY id DESC LIMIT 40`,
  ).all();
  const healthSeries = await env.DB.prepare(
    `SELECT id, created_at, ring, COALESCE(source, 'x86_64') AS arch, status FROM events
      WHERE kind = 'health' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days') ORDER BY id`,
  ).all();
  const metricsSeries = await env.DB.prepare(
    `SELECT created_at, json_extract(payload, '$.pool.objects') AS objects, json_extract(payload, '$.pool.bytes') AS bytes,
            json_extract(payload, '$.actions.running') AS running, json_extract(payload, '$.actions.runs') AS runs
       FROM events WHERE kind = 'metrics' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') ORDER BY id`,
  ).all();
  const latestMetrics = await env.DB.prepare("SELECT payload, created_at FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string; created_at: string }>();

  return json(
    {
      generated_at: new Date().toISOString(),
      version: version(env),
      rings,
      pool: { ...pool, by_source: bySource.results, referenced_by_heads: referenced, referenced_by_any_release: anyRelease, reclaimable },
      coverage,
      series: {
        imports_daily: importsDaily.results,
        sync_runs: syncRuns.results,
        health: healthSeries.results,
        metrics: metricsSeries.results,
      },
      metrics: latestMetrics ? { recorded_at: latestMetrics.created_at, ...JSON.parse(latestMetrics.payload) } : null,
      releases: releases.results,
      events: events.results.map(parse),
      latest: lastByKind.results.map(parse),
    },
    200,
    { "cache-control": "public, max-age=30" },
  );
}

/**
 * Service status, measured now: the index (one D1 query) and the pool (an R2
 * HEAD of the latest rendered database). This is what "online" means in the
 * header — the pipeline's own state (syncs, health) is a separate matter.
 */
export async function handleServiceStatus(env: Env): Promise<Response> {
  const t0 = Date.now();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("index did not answer within 5 s")), 5000));
  const index = await Promise.race([env.DB.prepare("SELECT COUNT(*) AS n FROM ring_heads").first<{ n: number }>(), timeout])
    .then((r) => ({ ok: true, ms: Date.now() - t0, rings: r?.n ?? 0 }))
    .catch((e: unknown) => ({ ok: false, ms: Date.now() - t0, error: String(e) }));
  // The most recently rendered database is an object the pipeline guarantees;
  // before any render, listing the bucket is the check.
  const last = await env.DB.prepare("SELECT r2_key FROM release_artifacts WHERE kind = 'db' ORDER BY created_at DESC LIMIT 1")
    .first<{ r2_key: string }>()
    .catch(() => null);
  const t1 = Date.now();
  const pool = await (last
    ? env.PACKAGES.head(last.r2_key).then((o) => ({ ok: o !== null, ms: Date.now() - t1, key: last.r2_key, error: o === null ? "rendered database missing from the pool" : undefined }))
    : env.PACKAGES.list({ limit: 1 }).then(() => ({ ok: true, ms: Date.now() - t1, key: null, error: undefined }))
  ).catch((e: unknown) => ({ ok: false, ms: Date.now() - t1, key: null, error: String(e) }));
  const ok = index.ok && pool.ok;
  return json(
    { ok, state: ok ? "online" : "degraded", api: { ok: true }, index, pool, checked_at: new Date().toISOString() },
    ok ? 200 : 503,
    { "cache-control": "no-store" },
  );
}
