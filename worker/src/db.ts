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
  /** Stored once the release is complete (migration 0015); null on rows older than that. */
  package_count?: number | null;
  bytes?: number | null;
  /** Per (source, arch) slices, JSON, computed once at creation (releaseSources). */
  sources?: string | null;
}

/** Checkpoint every this many releases of a ring (migration 0017): a reconstruction walks at most this many deltas. */
export const CHECKPOINT_EVERY = 24;

/**
 * The SQL that lists what a ring serves now — its head's selection, kept
 * live in ring_packages. A derived table: `JOIN ${ringMembers(ring)} rp ON
 * rp.package_id = p.id`. Ring names come from the `Ring` enum, so inlining
 * them is safe.
 */
export function ringMembers(ring: Ring): string {
  return `(SELECT package_id FROM ring_packages WHERE ring = '${ring}')`;
}

/**
 * The SQL that lists a release's package ids: the ring's live selection
 * when the release is a head (no rows written, nothing reconstructed),
 * otherwise its checkpoint rows, materialised first when it has none.
 */
export async function releaseMembers(env: Env, releaseId: number): Promise<string> {
  const head = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(releaseId).first<{ ring: Ring }>();
  if (head) return ringMembers(head.ring);
  await ensureCheckpoint(env, releaseId);
  return `(SELECT package_id FROM release_packages WHERE release_id = ${Math.floor(releaseId)})`;
}

/**
 * Reconstructs a release that is not a checkpoint — the nearest checkpoint
 * behind it, then each delta up to it — and writes its membership into
 * release_packages so the SQL that reads a release by id works on it. A
 * one-off cost the size of the selection, paid only when an older release
 * is actually read (a pinned page, a diff, a rollback target).
 */
export async function ensureCheckpoint(env: Env, releaseId: number): Promise<void> {
  type Row = { id: number; parent_id: number | null; checkpoint: number };
  const start = await env.DB.prepare("SELECT id, parent_id, checkpoint FROM releases WHERE id = ?").bind(releaseId).first<Row>();
  if (!start) throw new Error(`release ${releaseId} does not exist`);
  if (start.checkpoint) return;
  // A head that is not a checkpoint: its rows are the ring's live ones.
  const head = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(releaseId).first<{ ring: Ring }>();
  const chain: Row[] = [start];
  let cur = start;
  while (!cur.checkpoint && !head) {
    if (cur.parent_id === null) throw new Error(`release ${releaseId} cannot be reconstructed: no checkpoint behind it`);
    const parent = await env.DB.prepare("SELECT id, parent_id, checkpoint FROM releases WHERE id = ?").bind(cur.parent_id).first<Row>();
    if (!parent) throw new Error(`release ${releaseId} cannot be reconstructed: release ${cur.parent_id} is gone`);
    chain.push(parent);
    cur = parent;
    if (chain.length > CHECKPOINT_EVERY * 4) throw new Error(`release ${releaseId} cannot be reconstructed: no checkpoint within ${chain.length} releases`);
  }
  const ids = new Set<number>();
  if (head) {
    for (const r of (await env.DB.prepare("SELECT package_id FROM ring_packages WHERE ring = ?").bind(head.ring).all<{ package_id: number }>()).results) ids.add(r.package_id);
  } else {
    const base = chain[chain.length - 1];
    for (const r of (await env.DB.prepare("SELECT package_id FROM release_packages WHERE release_id = ?").bind(base.id).all<{ package_id: number }>()).results) ids.add(r.package_id);
    // Oldest first, the checkpoint itself excluded.
    for (const r of chain.slice(0, -1).reverse()) {
      const deltas = await env.DB.prepare("SELECT package_id, op FROM release_deltas WHERE release_id = ?").bind(r.id).all<{ package_id: number; op: string }>();
      for (const d of deltas.results) {
        if (d.op === "remove") ids.delete(d.package_id);
        else ids.add(d.package_id);
      }
    }
  }
  const list = [...ids];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < list.length; i += 2000) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO release_packages (release_id, package_id) SELECT ?, value FROM json_each(?)").bind(releaseId, JSON.stringify(list.slice(i, i + 2000))));
  }
  stmts.push(env.DB.prepare("UPDATE releases SET checkpoint = 1 WHERE id = ?").bind(releaseId));
  await env.DB.batch(stmts);
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
  /** Keyset paging: the (name, repo_arch) of the last row of the previous page — the rows after it, in order. */
  after?: { name: string; repoArch: string } | null;
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
  // A page: after a (name, repo_arch) key — the rows in order from there, a
  // walk of the (name, repo_arch) index that reads what it returns — or, for
  // an older client, an OFFSET, which sorts the whole selection every page.
  const after = window.after ?? null;
  const page = window.limit ? ` LIMIT ${Math.floor(window.limit)}${after ? "" : ` OFFSET ${Math.floor(window.offset ?? 0)}`}` : "";
  const where = `WHERE (?1 IS NULL OR p.repo_arch = ?1)${after ? " AND (p.name, p.repo_arch) > (?2, ?3)" : ""} ORDER BY p.name, p.repo_arch`;
  const binds = after ? [arch, after.name, after.repoArch] : [arch];
  const members = await releaseMembers(env, releaseId);
  if (detail === "summary") {
    // Enough for status / list / search: ~100 bytes per package instead of ~800.
    const rows = await env.DB.prepare(
      `SELECT p.name, p.version, p.arch, p.repo_arch, p.filename, p.sha256, p.size_download, p.size_installed, p.source,
              json_extract(p.manifest_json, '$.description') AS description
         FROM ${members} rp JOIN packages p ON p.id = rp.package_id ${where}${page}`,
    )
      .bind(...binds)
      .all();
    return rows.results;
  }
  const rows = await env.DB.prepare(
    `SELECT p.id, p.manifest_json, p.source, p.repo_arch FROM ${members} rp
       JOIN packages p ON p.id = rp.package_id ${where}${page}`,
  )
    .bind(...binds)
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
        // Still compressed: the reader (pkg-repo render) inflates it; a page
        // of 500 chaotic-aur games decompressed here exceeded the Worker.
        if (m) (m as { files_gz?: string }).files_gz = toBase64(l.gz);
      }
    }
  }
  return out.map((o) => o.m);
}

/**
 * What a release holds, computed once — a release is immutable — and kept
 * on its row (migration 0015): the overview and the release views read
 * three numbers instead of joining thousands of rows on every call.
 */
export async function releaseSummary(env: Env, releaseId: number): Promise<{ package_count: number; size_download: number }> {
  const row = await env.DB.prepare("SELECT package_count, bytes FROM releases WHERE id = ?").bind(releaseId).first<{ package_count: number | null; bytes: number | null }>();
  if (row && row.package_count !== null && row.bytes !== null) return { package_count: row.package_count, size_download: row.bytes };
  const fresh = await env.DB.prepare(
    `SELECT COUNT(*) AS package_count, COALESCE(SUM(p.size_download), 0) AS size_download
       FROM ${await releaseMembers(env, releaseId)} rp JOIN packages p ON p.id = rp.package_id`,
  ).first<{ package_count: number; size_download: number }>();
  const out = fresh ?? { package_count: 0, size_download: 0 };
  await env.DB.prepare("UPDATE releases SET package_count = ?, bytes = ? WHERE id = ?").bind(out.package_count, out.size_download, releaseId).run();
  return out;
}

export interface SourceSlice {
  source: string;
  arch: string;
  packages: number;
  bytes: number;
}

/** Per (source, arch) breakdown of a release, computed once and stored. */
export async function releaseSources(env: Env, releaseId: number): Promise<SourceSlice[]> {
  const row = await env.DB.prepare("SELECT sources FROM releases WHERE id = ?").bind(releaseId).first<{ sources: string | null }>();
  if (row?.sources) return JSON.parse(row.sources) as SourceSlice[];
  const fresh = await env.DB.prepare(
    `SELECT p.source, p.repo_arch AS arch, COUNT(*) AS packages, COALESCE(SUM(p.size_download), 0) AS bytes
       FROM ${await releaseMembers(env, releaseId)} rp JOIN packages p ON p.id = rp.package_id
      GROUP BY p.source, p.repo_arch ORDER BY p.repo_arch, p.source`,
  ).all<SourceSlice>();
  await env.DB.prepare("UPDATE releases SET sources = ? WHERE id = ?").bind(JSON.stringify(fresh.results), releaseId).run();
  return fresh.results;
}

function toBase64(gz: ArrayBuffer | number[]): string {
  const bytes = gz instanceof ArrayBuffer ? new Uint8Array(gz) : Uint8Array.from(gz);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
