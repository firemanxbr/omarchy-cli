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

export async function releaseManifests(env: Env, releaseId: number): Promise<unknown[]> {
  const rows = await env.DB.prepare(
    `SELECT p.manifest_json FROM release_packages rp
       JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ? ORDER BY p.name, p.arch`,
  )
    .bind(releaseId)
    .all<{ manifest_json: string }>();
  return rows.results.map((r) => JSON.parse(r.manifest_json));
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
