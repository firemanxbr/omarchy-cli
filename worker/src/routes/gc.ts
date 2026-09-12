import { json, RINGS, type Env } from "../index";
import { packageKey, signatureKey } from "../r2";

/**
 * Retention: a package is protected while any of the last `keep` releases of
 * any ring references it. Everything else can be deleted from the pool.
 * `?keep=N` (default 3).
 */
async function unreferenced(env: Env, keep: number) {
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
      ORDER BY id`,
  )
    .bind(JSON.stringify(protectedReleases))
    .all<{ id: number; sha256: string; name: string; version: string; arch: string; repo_arch: string; filename: string; size_download: number; source: string }>();
  return { protectedReleases, packages: rows.results };
}

export async function handleUnreferenced(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const { protectedReleases, packages } = await unreferenced(env, keep);
  return json({
    keep,
    protected_releases: protectedReleases,
    count: packages.length,
    bytes: packages.reduce((a, p) => a + p.size_download, 0),
    packages,
  });
}

/** Deletes unreferenced packages: R2 objects first, then the index rows. */
export async function handleGc(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? 3));
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const { packages } = await unreferenced(env, keep);
  const victims = packages.slice(0, limit);
  let bytes = 0;
  for (const p of victims) {
    await env.PACKAGES.delete([packageKey(p.repo_arch, p.filename), signatureKey(p.repo_arch, p.filename)]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM package_provides WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_requires WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_files WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM package_file_lists WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM release_packages WHERE package_id = ?").bind(p.id),
      env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(p.id),
    ]);
    bytes += p.size_download;
  }
  return json({ keep, deleted: victims.length, bytes, remaining: packages.length - victims.length });
}
