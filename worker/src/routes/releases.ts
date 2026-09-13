import { signingEnabled, detachedSignature } from "../signing";
import { isRing, json, type Env, type Ring } from "../index";
import { artifactKey, isRepoArch, SHORT } from "../r2";
import { releaseManifests, releaseSummary, ringHead, type ManifestDetail, type ReleaseRow } from "../db";

interface CreateRelease {
  ring: string;
  /** Promote: start from this ring's head selection instead of our own. */
  from_ring?: string | null;
  /** Roll back / pin: start from this exact release's selection (any ring). */
  from_release_id?: number | null;
  /** Package sha256s to add; a package replaces any same-name entry of the same repo arch. */
  add?: string[];
  /** Package names to drop from the selection (scoped by `remove_arch` when given). */
  remove?: string[];
  remove_arch?: string | null;
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
  const removeArch = body.remove_arch ?? null;
  if (removeArch !== null && !isRepoArch(removeArch)) return json({ error: "remove_arch must be x86_64 or aarch64" }, 400);
  // Adds are looked up per repo arch when the caller scopes the request.
  const found = add.length
    ? (
        await env.DB.prepare(
          `SELECT id, sha256 FROM packages WHERE sha256 IN (SELECT value FROM json_each(?))
              AND (? IS NULL OR repo_arch = ?)`,
        )
          .bind(JSON.stringify(add), removeArch, removeArch)
          .all<{ id: number; sha256: string }>()
      ).results
    : [];
  const bySha = new Map(found.map((r) => [r.sha256, r.id]));
  const missing = add.filter((sha) => !bySha.has(sha));
  if (missing.length) return json({ error: `packages not indexed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}` }, 404);
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

  // 1. The added objects go in first, in a few statements (json_each over a
  //    couple of thousand ids each keeps every statement well under D1's
  //    size limit). 2. Then the base selection is copied minus names being
  //    removed (within remove_arch) and minus (name, repo_arch) pairs the new
  //    release already holds — a NOT EXISTS resolved through the
  //    (name, repo_arch) index and the release_packages primary key, so a
  //    15k-package base with a 13k-package add stays linear. The old form
  //    re-evaluated a json_each over every added id per base row.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < added.length; i += 2000) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO release_packages (release_id, package_id) SELECT ?, value FROM json_each(?)").bind(id, JSON.stringify(added.slice(i, i + 2000))),
    );
  }
  if (base) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO release_packages (release_id, package_id)
         SELECT ?1, rp.package_id FROM release_packages rp JOIN packages p ON p.id = rp.package_id
          WHERE rp.release_id = ?2
            AND NOT (p.name IN (SELECT value FROM json_each(?3)) AND (?4 IS NULL OR p.repo_arch = ?4))
            AND NOT EXISTS (
              SELECT 1 FROM packages q JOIN release_packages n ON n.package_id = q.id AND n.release_id = ?1
               WHERE q.name = p.name AND q.repo_arch = p.repo_arch)`,
      ).bind(id, base.id, JSON.stringify(body.remove ?? []), removeArch),
    );
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

/** Above this many manifests a caller must page (`limit`/`offset`). */
const MAX_UNPAGED = 2000;
const MAX_PAGE = 1000;

/**
 * The ring's current release (or `release_id=` — one of its earlier releases,
 * so a paging client stays on one release while the ring moves on) and its
 * packages. `arch=` narrows to one architecture; `limit=`/`offset=` page
 * through the manifests in (name, arch) order. Summaries are small and never
 * need paging; manifests do once a ring holds more than MAX_UNPAGED packages.
 */
export async function handleGetRelease(ring: string, url: URL, env: Env): Promise<Response> {
  if (!isRing(ring)) return json({ error: "unknown ring" }, 404);
  const detail: ManifestDetail =
    url.searchParams.get("include") === "files" ? "files" : url.searchParams.get("fields") === "summary" ? "summary" : "default";
  const arch = url.searchParams.get("arch");
  if (arch !== null && !isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  const pinned = url.searchParams.get("release_id");
  const release = pinned
    ? await env.DB.prepare("SELECT * FROM releases WHERE id = ? AND ring = ?").bind(Number(pinned), ring).first<ReleaseRow>()
    : await ringHead(env, ring);
  if (!release) return json({ error: pinned ? `release ${pinned} is not a ${ring} release` : `ring ${ring} has no release yet` }, 404);

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ?1 AND (?2 IS NULL OR p.repo_arch = ?2)`,
  )
    .bind(release.id, arch)
    .first<{ n: number }>();
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), MAX_PAGE) : 0;
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  if (!limit && detail !== "summary" && (total?.n ?? 0) > MAX_UNPAGED) {
    return json(
      { error: `release has ${total?.n} manifests; page with ?limit=<=${MAX_PAGE}&offset=&release_id=${release.id}`, total: total?.n },
      413,
    );
  }
  const artifacts = await env.DB.prepare(
    "SELECT repo, arch, kind, size, created_at FROM release_artifacts WHERE release_id = ?",
  )
    .bind(release.id)
    .all();
  const packages = await releaseManifests(env, release.id, detail, { arch, offset, limit });
  return json({
    release,
    ...(await releaseSummary(env, release.id)),
    artifacts: artifacts.results,
    page: { arch, offset, limit: limit || null, returned: packages.length, total: total?.n ?? 0 },
    packages,
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

/**
 * Stores a generated database (or its signature) for a release, at the live
 * per-ring key (`<arch>/<repo>.db`) beside the packages. `repo` is the pacman
 * repo name, e.g. `omarchy-core-stable`; pacman reads it statically from the
 * bucket's custom domain.
 */
export async function handlePutArtifact(
  releaseId: number,
  kind: string,
  url: URL,
  request: Request,
  env: Env,
): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!/^[a-z0-9-]+$/.test(repo)) return json({ error: "repo is required (e.g. omarchy-core-stable)" }, 400);
  if (!isRepoArch(arch)) return json({ error: "arch must be x86_64 or aarch64" }, 400);
  if (!request.body) return json({ error: "empty body" }, 400);
  const release = await env.DB.prepare("SELECT id FROM releases WHERE id = ?").bind(releaseId).first();
  if (!release) return json({ error: "release not found" }, 404);
  // The pool signs the databases it stores; a signature a client made with
  // its own copy of a key is not taken (an older `render --sign` is harmless,
  // and a rotated key cannot be undone by a stale worker).
  if (kind.endsWith(".sig") && signingEnabled(env)) {
    await request.body.cancel();
    return json({ release_id: releaseId, repo, arch, kind, status: "superseded", detail: "the pool signs its own databases" });
  }

  const bytes = await request.arrayBuffer();
  const key = artifactKey(arch, repo, kind);
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: SHORT } });
  const keys = [key];
  if ((kind === "db" || kind === "files") && signingEnabled(env)) {
    const sig = await detachedSignature(env, new Uint8Array(bytes));
    const sigKey = artifactKey(arch, repo, `${kind}.sig`);
    await env.PACKAGES.put(sigKey, sig, { httpMetadata: { contentType: "application/octet-stream", cacheControl: SHORT } });
    await env.DB.prepare(
      `INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id, repo, arch, kind) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
      .bind(releaseId, repo, arch, `${kind}.sig`, sigKey, sig.byteLength)
      .run();
    keys.push(sigKey);
  }
  await env.DB.prepare(
    `INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(release_id, repo, arch, kind) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(releaseId, repo, arch, kind, keys[0], bytes.byteLength)
    .run();
  return json({ release_id: releaseId, repo, arch, kind, keys, size: bytes.byteLength }, 201);
}
