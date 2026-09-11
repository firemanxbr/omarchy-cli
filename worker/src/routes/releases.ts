import { isRing, json, type Env, type Ring } from "../index";
import { artifactKey } from "../r2";
import { releaseManifests, releaseSummary, ringHead, type ManifestDetail, type ReleaseRow } from "../db";

interface CreateRelease {
  ring: string;
  /** Promote: start from this ring's head selection instead of our own. */
  from_ring?: string | null;
  /** Roll back / pin: start from this exact release's selection (any ring). */
  from_release_id?: number | null;
  /** Package sha256s to add; a package replaces any same-name/arch entry. */
  add?: string[];
  /** Package names to drop from the selection. */
  remove?: string[];
  note?: string | null;
}

/**
 * Creates a new release for `ring`. The selection starts as a copy of the base
 * release (own head; `from_ring`'s head when promoting; an explicit
 * `from_release_id` when rolling back or pinning), then `remove` and `add` are
 * applied. Package bytes are never touched, and history is append-only: a
 * rollback is a new release whose selection equals an older one.
 */
export async function handleCreateRelease(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as CreateRelease;
  if (!isRing(body.ring)) return json({ error: "ring must be edge, rc or stable" }, 400);
  const ring: Ring = body.ring;
  let source: ReleaseRow | null = null;
  if (body.from_release_id !== undefined && body.from_release_id !== null) {
    source = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(body.from_release_id).first<ReleaseRow>();
    if (!source) return json({ error: `release ${body.from_release_id} does not exist` }, 404);
  } else if (body.from_ring !== undefined && body.from_ring !== null) {
    if (!isRing(body.from_ring)) return json({ error: "from_ring must be edge, rc or stable" }, 400);
    source = await ringHead(env, body.from_ring);
    if (!source) return json({ error: `ring ${body.from_ring} has no release to promote` }, 409);
  }
  const parent = await ringHead(env, ring);
  const base = source ?? parent;

  const add = body.add ?? [];
  const found = add.length
    ? (
        await env.DB.prepare("SELECT id, sha256 FROM packages WHERE sha256 IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(add))
          .all<{ id: number; sha256: string }>()
      ).results
    : [];
  const bySha = new Map(found.map((r) => [r.sha256, r.id]));
  const missing = add.filter((sha) => !bySha.has(sha));
  if (missing.length) return json({ error: `packages not indexed: ${missing.join(", ")}` }, 404);
  const added: number[] = add.map((sha) => bySha.get(sha)!);

  const seqRow = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM releases WHERE ring = ?")
    .bind(ring)
    .first<{ seq: number }>();
  const seq = seqRow!.seq;

  const created = await env.DB.prepare(
    "INSERT INTO releases (ring, seq, parent_id, source_id, note) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(ring, seq, parent?.id ?? null, source?.id ?? null, body.note ?? null)
    .first<{ id: number }>();
  const id = created!.id;

  const stmts: D1PreparedStatement[] = [];
  if (base) {
    // Copy the base selection, minus names being removed or replaced by an add.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO release_packages (release_id, package_id)
         SELECT ?, rp.package_id FROM release_packages rp JOIN packages p ON p.id = rp.package_id
          WHERE rp.release_id = ?
            AND p.name NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM packages q WHERE q.id IN (SELECT value FROM json_each(?))
                 AND q.name = p.name AND q.arch = p.arch)`,
      ).bind(id, base.id, JSON.stringify(body.remove ?? []), JSON.stringify(added)),
    );
  }
  for (const pkgId of added) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO release_packages (release_id, package_id) VALUES (?, ?)").bind(id, pkgId));
  }
  stmts.push(
    env.DB.prepare(
      "INSERT INTO ring_heads (ring, release_id) VALUES (?, ?) ON CONFLICT(ring) DO UPDATE SET release_id = excluded.release_id",
    ).bind(ring, id),
  );
  await env.DB.batch(stmts);

  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<ReleaseRow>();
  return json({ release, ...(await releaseSummary(env, id)) }, 201);
}

export async function handleGetRelease(ring: string, url: URL, env: Env): Promise<Response> {
  if (!isRing(ring)) return json({ error: "unknown ring" }, 404);
  const detail: ManifestDetail =
    url.searchParams.get("include") === "files" ? "files" : url.searchParams.get("fields") === "summary" ? "summary" : "default";
  const head = await ringHead(env, ring);
  if (!head) return json({ error: `ring ${ring} has no release yet` }, 404);
  const artifacts = await env.DB.prepare(
    "SELECT repo, arch, kind, size, created_at FROM release_artifacts WHERE release_id = ?",
  )
    .bind(head.id)
    .all();
  return json({
    release: head,
    ...(await releaseSummary(env, head.id)),
    artifacts: artifacts.results,
    packages: await releaseManifests(env, head.id, detail),
  });
}

export async function handleReleaseHistory(ring: string, env: Env): Promise<Response> {
  if (!isRing(ring)) return json({ error: "unknown ring" }, 404);
  const rows = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM release_packages rp WHERE rp.release_id = r.id) AS package_count,
            (h.release_id IS NOT NULL) AS is_head
       FROM releases r LEFT JOIN ring_heads h ON h.release_id = r.id
      WHERE r.ring = ? ORDER BY r.seq DESC LIMIT 50`,
  )
    .bind(ring)
    .all();
  return json({ ring, releases: rows.results });
}

/** Stores a generated database (or its signature) for a release. */
export async function handlePutArtifact(
  releaseId: number,
  kind: string,
  url: URL,
  request: Request,
  env: Env,
): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "omarchy";
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!request.body) return json({ error: "empty body" }, 400);
  const release = await env.DB.prepare("SELECT id FROM releases WHERE id = ?").bind(releaseId).first();
  if (!release) return json({ error: "release not found" }, 404);

  const key = artifactKey(releaseId, repo, arch, kind);
  const object = await env.PACKAGES.put(key, request.body);
  await env.DB.prepare(
    `INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(release_id, repo, arch, kind) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(releaseId, repo, arch, kind, key, object?.size ?? 0)
    .run();
  return json({ release_id: releaseId, repo, arch, kind, size: object?.size ?? 0 }, 201);
}
