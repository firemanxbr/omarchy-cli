/**
 * The half-hourly metrics snapshot, taken by the brain itself: how the pool
 * and its jobs are doing, recorded as a `metrics` event so the dashboard can
 * draw seven days of history. It replaced metrics.yml, which measured GitHub
 * Actions runs — the pipeline no longer runs there.
 */
import type { Env } from "./index";
import { provenanceCounts } from "./provenance";
import { version } from "./meta";

const EVERY_MINUTES = 30;

export async function snapshotMetrics(env: Env, now = new Date()): Promise<string> {
  const last = await env.DB.prepare("SELECT created_at FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ created_at: string }>();
  if (last && now.getTime() - Date.parse(last.created_at) < (EVERY_MINUTES - 1) * 60000) return "metrics: on time";
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const alive = new Date(now.getTime() - 10 * 60000).toISOString();

  const pool = await env.DB.prepare("SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes, COUNT(DISTINCT name) AS names FROM packages").first<{ objects: number; bytes: number; names: number }>();
  const bySource = await env.DB.prepare(
    "SELECT source, repo_arch AS arch, COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages GROUP BY source, repo_arch ORDER BY repo_arch, source",
  ).all<{ source: string; arch: string; objects: number; bytes: number }>();
  const referenced = await env.DB.prepare("SELECT COALESCE(SUM(size_download), 0) AS bytes FROM packages WHERE released = 1").first<{ bytes: number }>();
  // What the three heads pin (distinct objects): the one place this join runs.
  const heads = await env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id IN (SELECT package_id FROM ring_packages)`,
  ).first<{ objects: number; bytes: number }>();
  // What retention would drop: nothing a ring serves, nothing the last
  // three releases of a ring added or removed (a rollback target), nothing
  // a kept checkpoint lists (routes/gc.ts has the same rule).
  const reclaimable = await env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id NOT IN (SELECT package_id FROM ring_packages)
        AND id NOT IN (SELECT package_id FROM release_deltas WHERE release_id IN (SELECT id FROM releases r WHERE r.id IN (
                          SELECT id FROM releases r2 WHERE r2.ring = r.ring ORDER BY seq DESC LIMIT 3)))
        AND id NOT IN (SELECT package_id FROM release_packages)
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
  ).first<{ objects: number; bytes: number }>();
  const rings = await env.DB.prepare(
    `SELECT h.ring, COUNT(*) AS packages, COALESCE(SUM(p.size_download), 0) AS bytes
       FROM ring_packages rp JOIN packages p ON p.id = rp.package_id JOIN ring_heads h ON h.ring = rp.ring
      GROUP BY h.ring ORDER BY h.ring`,
  ).all<{ ring: string; packages: number; bytes: number }>();

  // The pool's own jobs (sync, promote, health, security, gc…) and the
  // factory's builds over the last seven days, plus what is in flight now.
  const jobs = await env.DB.prepare(
    `SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms
       FROM build_tasks WHERE created_at >= ? OR status IN ('queued', 'leased') GROUP BY kind, status`,
  )
    .bind(since)
    .all<{ kind: string; status: string; n: number; ms: number }>();
  const sum = (rows: typeof jobs.results, f: (r: (typeof jobs.results)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  const minutes = (rows: typeof jobs.results, f: (r: (typeof jobs.results)[number]) => boolean) => Math.floor(rows.filter(f).reduce((a, r) => a + r.ms, 0) / 60000);
  const pool_jobs = jobs.results.filter((r) => r.kind !== "build");
  const builds = jobs.results.filter((r) => r.kind === "build");
  const inflight = (r: { status: string }) => r.status === "queued" || r.status === "leased";
  const kinds = [...new Set(pool_jobs.map((r) => r.kind))].sort().map((kind) => {
    const rows = pool_jobs.filter((r) => r.kind === kind);
    return { kind, runs: sum(rows, () => true), failed: sum(rows, (r) => r.status === "failed"), running: sum(rows, inflight), minutes: minutes(rows, () => true) };
  });
  const workers = await env.DB.prepare(
    `SELECT trust, COUNT(*) AS n, SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS alive, SUM(CASE WHEN last_seen > ? AND current_task IS NOT NULL THEN 1 ELSE 0 END) AS busy
       FROM build_workers WHERE revoked_at IS NULL GROUP BY trust`,
  )
    .bind(alive, alive)
    .all<{ trust: string; n: number; alive: number; busy: number }>();

  const payload = {
    since,
    jobs: {
      runs: sum(pool_jobs, () => true),
      running: sum(pool_jobs, inflight),
      failures: sum(pool_jobs, (r) => r.status === "failed"),
      minutes: minutes(pool_jobs, () => true),
      kinds,
    },
    builds: {
      runs: sum(builds, () => true),
      running: sum(builds, inflight),
      failures: sum(builds, (r) => r.status === "failed"),
      staged: sum(builds, (r) => r.status === "staged"),
      minutes: minutes(builds, () => true),
    },
    workers: {
      alive: workers.results.reduce((a, w) => a + w.alive, 0),
      busy: workers.results.reduce((a, w) => a + w.busy, 0),
      project: workers.results.find((w) => w.trust === "project")?.alive ?? 0,
      community: workers.results.find((w) => w.trust === "community")?.alive ?? 0,
    },
    pool: {
      objects: pool?.objects ?? 0,
      bytes: pool?.bytes ?? 0,
      names: pool?.names ?? 0,
      by_source: bySource.results,
      released_bytes: referenced?.bytes ?? 0,
      referenced_objects: heads?.objects ?? 0,
      referenced_bytes: heads?.bytes ?? 0,
      reclaimable_bytes: reclaimable?.bytes ?? 0,
      reclaimable_objects: reclaimable?.objects ?? 0,
    },
    rings: rings.results,
    // OPR recipes by origin, per ring: the AUR-synced count is the one to drive to zero.
    provenance: { stable: await provenanceCounts(env, "stable"), rc: await provenanceCounts(env, "rc"), edge: await provenanceCounts(env, "edge") },
    version: version(env).version,
  };
  // Snapshots are worth 90 days of history; the charts read 7.
  await env.DB.prepare("DELETE FROM events WHERE kind = 'metrics' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')").run();
  const summary = `${payload.jobs.runs} jobs in 7 days, ${payload.jobs.running} running, ${payload.jobs.minutes} worker-minutes · ${payload.workers.alive} worker(s) alive · pool ${payload.pool.objects} objects`;
  await env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('metrics', 'ok', ?, ?)").bind(summary, JSON.stringify(payload)).run();
  return `metrics: snapshot recorded — ${summary}`;
}
