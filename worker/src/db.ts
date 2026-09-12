/** Index queries shared by several routes. */

import type { Env, Ring } from "./index";
import { gunzipJson } from "./gzip";

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

/** A window over a release's packages: an architecture, and a page of rows. */
export interface ManifestWindow {
  arch?: string | null;
  offset?: number;
  limit?: number;
}

/**
 * Packages of a release, ordered by (name, arch). A whole 15k-package ring
 * with file lists is far more than one Worker invocation can hold, so callers
 * page through it (`limit`/`offset`) and usually ask for one architecture.
 */
export async function releaseManifests(
  env: Env,
  releaseId: number,
  detail: ManifestDetail = "default",
  window: ManifestWindow = {},
): Promise<unknown[]> {
  const arch = window.arch ?? null;
  const page = window.limit ? ` LIMIT ${Math.floor(window.limit)} OFFSET ${Math.floor(window.offset ?? 0)}` : "";
  if (detail === "summary") {
    // Enough for status / list / search: ~100 bytes per package instead of ~800.
    const rows = await env.DB.prepare(
      `SELECT p.name, p.version, p.arch, p.repo_arch, p.filename, p.sha256, p.size_download, p.size_installed, p.source,
              json_extract(p.manifest_json, '$.description') AS description
         FROM release_packages rp JOIN packages p ON p.id = rp.package_id
        WHERE rp.release_id = ?1 AND (?2 IS NULL OR p.repo_arch = ?2) ORDER BY p.name, p.arch${page}`,
    )
      .bind(releaseId, arch)
      .all();
    return rows.results;
  }
  const rows = await env.DB.prepare(
    `SELECT p.id, p.manifest_json, p.source, p.repo_arch FROM release_packages rp
       JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ?1 AND (?2 IS NULL OR p.repo_arch = ?2) ORDER BY p.name, p.arch${page}`,
  )
    .bind(releaseId, arch)
    .all<{ id: number; manifest_json: string; source: string; repo_arch: string }>();
  const out = rows.results.map((r) => {
    const m = JSON.parse(r.manifest_json) as { files?: unknown; source?: string; repo_arch?: string };
    m.source = r.source;
    m.repo_arch = r.repo_arch;
    delete m.files;
    return { id: r.id, m };
  });
  if (detail === "files") {
    // Attach the gzip-stored file lists in batches.
    const byId = new Map(out.map((o) => [o.id, o.m]));
    const ids = out.map((o) => o.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const lists = await env.DB.prepare(
        "SELECT package_id, gz FROM package_file_lists WHERE package_id IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(chunk))
        .all<{ package_id: number; gz: ArrayBuffer | number[] }>();
      for (const l of lists.results) {
        const m = byId.get(l.package_id);
        if (m) m.files = await gunzipJson<string[]>(l.gz);
      }
    }
  }
  return out.map((o) => o.m);
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
