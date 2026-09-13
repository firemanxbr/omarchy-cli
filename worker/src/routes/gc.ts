import { json, RINGS, type Env } from "../index";
import { packageKey, signatureKey } from "../r2";

/**
 * Retention: a package is protected while a ring serves it, while any of
 * the last `keep` releases of a ring added or removed it (a rollback
 * inside retention may need it back), while a kept checkpoint lists it,
 * or while it is younger than the grace period (an import in progress has
 * uploaded objects that no release pins yet). A kept checkpoint is, per
 * ring, the newest one at or before the oldest protected release — what
 * reconstructing any protected release starts from (migration 0017) —
 * and any checkpoint among the protected ones. `?keep=N` (default 3),
 * `?grace_days=N` (default 7).
 */
async function retention(env: Env, keep: number): Promise<{ protectedReleases: number[]; keptCheckpoints: number[]; checkpointSeq: Record<string, number> }> {
  const protectedReleases: number[] = [];
  const keptCheckpoints: number[] = [];
  const checkpointSeq: Record<string, number> = {};
  for (const ring of RINGS) {
    const rows = await env.DB.prepare("SELECT id, seq, checkpoint FROM releases WHERE ring = ? ORDER BY seq DESC LIMIT ?")
      .bind(ring, keep)
      .all<{ id: number; seq: number; checkpoint: number }>();
    for (const r of rows.results) {
      protectedReleases.push(r.id);
      if (r.checkpoint) keptCheckpoints.push(r.id);
    }
    const oldest = rows.results.at(-1);
    if (!oldest) continue;
    const base = await env.DB.prepare("SELECT id, seq FROM releases WHERE ring = ? AND checkpoint = 1 AND seq <= ? ORDER BY seq DESC LIMIT 1")
      .bind(ring, oldest.seq)
      .first<{ id: number; seq: number }>();
    if (base) {
      if (!keptCheckpoints.includes(base.id)) keptCheckpoints.push(base.id);
      checkpointSeq[ring] = base.seq;
    }
  }
  return { protectedReleases, keptCheckpoints, checkpointSeq };
}

async function unreferenced(env: Env, keep: number, graceDays: number) {
  const { protectedReleases, keptCheckpoints, checkpointSeq } = await retention(env, keep);
  const rows = await env.DB.prepare(
    `SELECT id, sha256, name, version, arch, repo_arch, filename, size_download, source FROM packages
      WHERE id NOT IN (SELECT package_id FROM ring_packages)
        AND id NOT IN (SELECT package_id FROM release_deltas WHERE release_id IN (SELECT value FROM json_each(?1)))
        AND id NOT IN (SELECT package_id FROM release_packages WHERE release_id IN (SELECT value FROM json_each(?2)))
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3)
      ORDER BY id`,
  )
    .bind(JSON.stringify(protectedReleases), JSON.stringify(keptCheckpoints), `-${graceDays} days`)
    .all<{ id: number; sha256: string; name: string; version: string; arch: string; repo_arch: string; filename: string; size_download: number; source: string }>();
  return { protectedReleases, keptCheckpoints, checkpointSeq, packages: rows.results };
}

function graceOf(url: URL): number {
  return Math.max(0, Number(url.searchParams.get("grace_days") ?? 7));
}

export async function handleUnreferenced(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const { protectedReleases, keptCheckpoints, packages } = await unreferenced(env, keep, graceOf(url));
  return json({
    keep,
    grace_days: graceOf(url),
    protected_releases: protectedReleases,
    kept_checkpoints: keptCheckpoints,
    count: packages.length,
    bytes: packages.reduce((a, p) => a + p.size_download, 0),
    packages,
  });
}

/**
 * Deletes unreferenced packages: R2 objects first, then the index rows.
 * Before that, the checkpoints nothing inside retention starts from, and
 * the deltas older than a kept checkpoint, are dropped: a release whose
 * objects are being deleted cannot be served or rolled back to anyway, its
 * row, summary and note stay in the history.
 */
export async function handleGc(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const { protectedReleases, keptCheckpoints, checkpointSeq, packages } = await unreferenced(env, keep, graceOf(url));
  const pruned = await env.DB.prepare("DELETE FROM release_packages WHERE release_id NOT IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(keptCheckpoints))
    .run();
  await env.DB.prepare("UPDATE releases SET checkpoint = 0 WHERE checkpoint = 1 AND id NOT IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keptCheckpoints)).run();
  let deltasPruned = 0;
  for (const [ring, seq] of Object.entries(checkpointSeq)) {
    const d = await env.DB.prepare("DELETE FROM release_deltas WHERE release_id IN (SELECT id FROM releases WHERE ring = ? AND seq <= ?)").bind(ring, seq).run();
    deltasPruned += d.meta.changes ?? 0;
  }
  const victims = packages.slice(0, limit);
  let bytes = 0;
  for (const p of victims) {
    await env.PACKAGES.delete([packageKey(p.repo_arch, p.filename), signatureKey(p.repo_arch, p.filename)]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM package_provides WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_requires WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_files WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_file_lists WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_components WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(p.id),
    ]);
    bytes += p.size_download;
  }
  // Advisories and matches are replaced by every security run (the run
  // prunes what it did not refresh); the CVE metadata behind them (KEV,
  // EPSS) is not, so a CVE no advisory mentions any more goes after 90
  // days.
  const cves = await env.DB.prepare(
    `DELETE FROM cve_meta WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
       AND NOT EXISTS (SELECT 1 FROM advisories a, json_each(a.cves) j WHERE j.value = cve_meta.cve)`,
  ).run();
  return json({ keep, deleted: victims.length, bytes, remaining: packages.length - victims.length, protected_releases: protectedReleases, kept_checkpoints: keptCheckpoints, membership_rows_pruned: pruned.meta.changes ?? 0, delta_rows_pruned: deltasPruned, cve_meta_pruned: cves.meta.changes ?? 0 });
}
