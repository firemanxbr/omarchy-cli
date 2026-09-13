import { json, RINGS, type Env } from "../index";
import { packageKey, signatureKey } from "../r2";

/**
 * Retention: a package is protected while any of the last `keep` releases of
 * any ring references it, or while it is younger than the grace period (an
 * import in progress has uploaded objects that no release pins yet).
 * `?keep=N` (default 3), `?grace_days=N` (default 7).
 */
async function unreferenced(env: Env, keep: number, graceDays: number) {
  const protectedReleases: number[] = [];
  for (const ring of RINGS) {
    const rows = await env.DB.prepare("SELECT id FROM releases WHERE ring = ? ORDER BY seq DESC LIMIT ?")
      .bind(ring, keep)
      .all<{ id: number }>();
    for (const r of rows.results) protectedReleases.push(r.id);
  }
  const rows = await env.DB.prepare(
    `SELECT id, sha256, name, version, arch, repo_arch, filename, size_download, source FROM packages
      WHERE id NOT IN (SELECT package_id FROM release_packages
                        WHERE release_id IN (SELECT value FROM json_each(?)))
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      ORDER BY id`,
  )
    .bind(JSON.stringify(protectedReleases), `-${graceDays} days`)
    .all<{ id: number; sha256: string; name: string; version: string; arch: string; repo_arch: string; filename: string; size_download: number; source: string }>();
  return { protectedReleases, packages: rows.results };
}

function graceOf(url: URL): number {
  return Math.max(0, Number(url.searchParams.get("grace_days") ?? 7));
}

export async function handleUnreferenced(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const { protectedReleases, packages } = await unreferenced(env, keep, graceOf(url));
  return json({
    keep,
    grace_days: graceOf(url),
    protected_releases: protectedReleases,
    count: packages.length,
    bytes: packages.reduce((a, p) => a + p.size_download, 0),
    packages,
  });
}

/**
 * Deletes unreferenced packages: R2 objects first, then the index rows.
 * Before that, the membership of every release outside retention is
 * dropped: a release whose objects are being deleted cannot be served or
 * rolled back to anyway, its row and note stay in the history, and
 * release_packages (D1 bills every row read from it) shrinks to what the
 * last `keep` releases per ring actually pin.
 */
export async function handleGc(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const { protectedReleases, packages } = await unreferenced(env, keep, graceOf(url));
  const pruned = await env.DB.prepare("DELETE FROM release_packages WHERE release_id NOT IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(protectedReleases))
    .run();
  const victims = packages.slice(0, limit);
  let bytes = 0;
  for (const p of victims) {
    await env.PACKAGES.delete([packageKey(p.repo_arch, p.filename), signatureKey(p.repo_arch, p.filename)]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM package_provides WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_requires WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_files WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_file_lists WHERE package_id = ?").bind(p.id),
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
  return json({ keep, deleted: victims.length, bytes, remaining: packages.length - victims.length, membership_rows_pruned: pruned.meta.changes ?? 0, cve_meta_pruned: cves.meta.changes ?? 0 });
}
