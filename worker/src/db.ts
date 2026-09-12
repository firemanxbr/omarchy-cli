/** Index queries shared by several routes. */

import type { Env, Ring } from "./index";

export interface ReleaseRow {
  id: number;
  ring: Ring;
  seq: number;
  parent_id: number | null;
  source_id: number | null;
  note: string | null;
  created_at: string;
}

export async function ringHead(env: Env, ring: Ring): Promise<ReleaseRow | null> {
  return env.DB.prepare(
    "SELECT r.* FROM ring_heads h JOIN releases r ON r.id = h.release_id WHERE h.ring = ?",
  )
    .bind(ring)
    .first<ReleaseRow>();
}

/**
 * Manifests of a release. File lists dominate manifest size (a 10k-package
 * release is ~22 MB with them, ~5 MB without) and only `pkg-repo render`
 * needs them, so they are stripped unless `includeFiles` is set.
 */
export type ManifestDetail = "summary" | "default" | "files";

export async function releaseManifests(env: Env, releaseId: number, detail: ManifestDetail = "default"): Promise<unknown[]> {
  if (detail === "summary") {
    // Enough for status / list / search: ~100 bytes per package instead of ~800.
    const rows = await env.DB.prepare(
      `SELECT p.name, p.version, p.arch, p.filename, p.sha256, p.size_download, p.size_installed, p.source,
              json_extract(p.manifest_json, '$.description') AS description
         FROM release_packages rp JOIN packages p ON p.id = rp.package_id
        WHERE rp.release_id = ? ORDER BY p.name, p.arch`,
    )
      .bind(releaseId)
      .all();
    return rows.results;
  }
  const rows = await env.DB.prepare(
    `SELECT p.manifest_json, p.source FROM release_packages rp
       JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ? ORDER BY p.name, p.arch`,
  )
    .bind(releaseId)
    .all<{ manifest_json: string; source: string }>();
  return rows.results.map((r) => {
    const m = JSON.parse(r.manifest_json) as { files?: unknown; source?: string };
    m.source = r.source;
    if (detail !== "files") delete m.files;
    return m;
  });
}

export async function releaseSummary(env: Env, releaseId: number): Promise<{ package_count: number; size_download: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS package_count, COALESCE(SUM(p.size_download), 0) AS size_download
       FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ?`,
  )
    .bind(releaseId)
    .first<{ package_count: number; size_download: number }>();
  return row ?? { package_count: 0, size_download: 0 };
}
