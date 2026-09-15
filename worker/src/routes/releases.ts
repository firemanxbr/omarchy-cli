import { signingEnabled, detachedSignature } from "../signing";
import { isRing, json, type Env, type Ring } from "../index";
import { artifactKey, isRepoArch, REPO_ARCHES, SHORT } from "../r2";
import { REPO_ORDER, sourceOfRepo } from "../meta";
import { releaseManifests, releaseSummary, releaseSources, ringHead, ringMembers, releaseMembers, ensureCheckpoint, CHECKPOINT_EVERY, type ManifestDetail, type ReleaseRow } from "../db";

interface CreateRelease {
  ring: string;
  /** Promote: start from this ring's head selection instead of our own. */
  from_ring?: string | null;
  /** Roll back / pin: start from this exact release's selection (any ring). */
  from_release_id?: number | null;
  /**
   * Package sha256s to add; a package replaces the same-name entry of the
   * same source and repo arch. Another source's build of that name stays:
   * each source renders its own database, and the order of the include
   * (setup.ts) decides which one pacman takes — the pool holds every
   * source's row, the way the mirrors do.
   */
  add?: string[];
  /** Package names to drop from the selection, whichever source (scoped by `remove_arch` when given). */
  remove?: string[];
  /** Names to drop from one source's rows only: what a sync sends when its upstream dropped them. */
  remove_from?: { source: string; name: string }[];
  remove_arch?: string | null;
  /**
   * Promote or roll back one architecture only: the source's rows of this
   * architecture replace the ring's, the other architecture keeps what
   * the ring serves today. So x86_64 and aarch64 move at different times
   * when one architecture's evidence is red and the other's green.
   */
  arch?: string | null;
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

  // Where the selection starts: the ring's own live rows (a sync, a
  // publish), another ring's (a promotion), or an older release's
  // checkpoint rows (a rollback — materialised first if it has none).
  const onlyArch = body.arch ?? null;
  if (onlyArch !== null && !isRepoArch(onlyArch)) return json({ error: "arch must be x86_64 or aarch64" }, 400);
  if (onlyArch !== null && !source) return json({ error: "arch goes with from_ring or from_release_id" }, 400);
  let baseSql = "(SELECT package_id FROM ring_packages WHERE ring = '__none__')";
  if (source && !(parent && source.id === parent.id)) {
    const asHead = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(source.id).first<{ ring: Ring }>();
    if (asHead) baseSql = ringMembers(asHead.ring);
    else {
      await ensureCheckpoint(env, source.id);
      baseSql = `(SELECT package_id FROM release_packages WHERE release_id = ${source.id})`;
    }
    // One architecture from the source, the other as the ring serves it.
    if (onlyArch !== null && parent) {
      baseSql = `(SELECT b.package_id FROM ${baseSql} b JOIN packages p ON p.id = b.package_id WHERE p.repo_arch = '${onlyArch}'
                  UNION SELECT o.package_id FROM ${ringMembers(ring)} o JOIN packages p ON p.id = o.package_id WHERE p.repo_arch != '${onlyArch}')`;
    }
  } else if (parent) baseSql = ringMembers(ring);

  // The release row is the first statement of the same batch as its delta:
  // D1 runs a batch as one transaction, so a failure leaves no half-made
  // release behind (the row without deltas of a failed attempt would). The
  // row is addressed by (ring, seq) — unique — until its id is read back.
  const rel = `(SELECT id FROM releases WHERE ring = ?1 AND seq = ?2)`;
  // The target selection: the base minus the names being removed (within
  // remove_arch; `remove` from every source, `remove_from` from one) minus
  // any (source, name, repo_arch) an added package replaces, plus the adds.
  // The delta is the target against what the ring serves now, both ways —
  // the only rows a release writes (migration 0017) — and the ring's live
  // rows move by exactly that delta. The JSON parameters are materialised
  // once (a CTE), never re-parsed per row: evaluated inline over a 32k-row
  // ring they took D1 past its CPU limit.
  const removeFrom = (body.remove_from ?? []).map((r) => ({ source: String(r.source), name: String(r.name) }));
  const own = ringMembers(ring);
  const withSets = `WITH rm(name, source) AS MATERIALIZED (
         SELECT value, NULL FROM json_each(?3)
         UNION ALL SELECT json_extract(value, '$.name'), json_extract(value, '$.source') FROM json_each(?6)),
       adds(id) AS MATERIALIZED (SELECT value FROM json_each(?5)),
       addnames(name, repo_arch, source) AS MATERIALIZED (SELECT q.name, q.repo_arch, q.source FROM packages q WHERE q.id IN (SELECT id FROM adds)),
       target(package_id) AS MATERIALIZED (
         SELECT b.package_id FROM ${baseSql} b JOIN packages p ON p.id = b.package_id
          WHERE NOT EXISTS (SELECT 1 FROM rm WHERE rm.name = p.name AND (rm.source IS NULL OR rm.source = p.source) AND (?4 IS NULL OR p.repo_arch = ?4))
            AND NOT EXISTS (SELECT 1 FROM addnames a WHERE a.name = p.name AND a.repo_arch = p.repo_arch AND a.source = p.source)
         UNION SELECT id FROM adds)`;
  const args = [ring, seq, JSON.stringify(body.remove ?? []), removeArch, JSON.stringify(added), JSON.stringify(removeFrom)];
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("INSERT INTO releases (ring, seq, parent_id, source_id, note) VALUES (?1, ?2, ?3, ?4, ?5)").bind(ring, seq, parent?.id ?? null, source?.id ?? null, body.note ?? null),
    env.DB.prepare(`${withSets} INSERT INTO release_deltas (release_id, package_id, op) SELECT ${rel}, package_id, 'add' FROM (SELECT package_id FROM target EXCEPT SELECT package_id FROM ${own})`).bind(...args),
    env.DB.prepare(`${withSets} INSERT INTO release_deltas (release_id, package_id, op) SELECT ${rel}, package_id, 'remove' FROM (SELECT package_id FROM ${own} EXCEPT SELECT package_id FROM target)`).bind(...args),
    env.DB.prepare(`DELETE FROM ring_packages WHERE ring = ?1 AND package_id IN (SELECT package_id FROM release_deltas WHERE release_id = ${rel} AND op = 'remove')`).bind(ring, seq),
    env.DB.prepare(`INSERT OR IGNORE INTO ring_packages (ring, package_id) SELECT ?1, package_id FROM release_deltas WHERE release_id = ${rel} AND op = 'add'`).bind(ring, seq),
    env.DB.prepare(`INSERT INTO ring_heads (ring, release_id) VALUES (?1, ${rel}) ON CONFLICT(ring) DO UPDATE SET release_id = excluded.release_id`).bind(ring, seq),
  ];
  // A checkpoint — the full membership written out — for the first release
  // of a ring and then every CHECKPOINT_EVERY: what bounds a reconstruction.
  const lastCheckpoint = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM releases WHERE ring = ? AND checkpoint = 1").bind(ring).first<{ seq: number }>();
  const checkpoint = !parent || seq - (lastCheckpoint?.seq ?? 0) >= CHECKPOINT_EVERY;
  if (checkpoint) {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO release_packages (release_id, package_id) SELECT ${rel}, package_id FROM ring_packages WHERE ring = ?1`).bind(ring, seq));
    stmts.push(env.DB.prepare(`UPDATE releases SET checkpoint = 1 WHERE id = ${rel}`).bind(ring, seq));
  }
  // The objects this release pins are "released" from now on (the overview
  // counts them without touching the membership again).
  for (let i = 0; i < added.length; i += 2000) {
    stmts.push(env.DB.prepare("UPDATE packages SET released = 1 WHERE released = 0 AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(added.slice(i, i + 2000))));
  }
  // An architecture the request could not have touched — the base copied
  // from the parent, every add and remove scoped to the other one by
  // remove_arch — serves exactly what the parent served: its databases
  // are already rendered, at the live keys. The parent's artifact rows
  // carry over, and the caller is told not to render it again (a sync of
  // an aarch64 source no longer re-renders the 15k-package x86_64 extra).
  const untouched = (body.remove ?? []).length === 0 && removeFrom.length === 0 && added.length === 0;
  const scoped = parent && base?.id === parent.id ? removeArch : onlyArch !== null && (untouched || removeArch === onlyArch) ? onlyArch : null;
  const unchanged: string[] = parent && scoped !== null ? REPO_ARCHES.filter((a) => a !== scoped) : [];
  if (unchanged.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) SELECT ${rel}, repo, arch, kind, r2_key, size FROM release_artifacts WHERE release_id = ?3 AND arch IN (SELECT value FROM json_each(?4))`,
      ).bind(ring, seq, parent!.id, JSON.stringify(unchanged)),
    );
  }
  await env.DB.batch(stmts);
  const created = await env.DB.prepare("SELECT id FROM releases WHERE ring = ? AND seq = ?").bind(ring, seq).first<{ id: number }>();
  const id = created!.id;
  // Immutable from here: what it holds is computed once and kept on the row.
  const summary = await releaseSummary(env, id);
  await releaseSources(env, id);

  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<ReleaseRow>();
  return json({ release, ...summary, unchanged_arches: unchanged }, 201);
}

/**
 * What changed between two releases of a ring: packages added, removed and
 * upgraded (same name and architecture, another version — a downgrade
 * shows there too, with the versions telling). Both releases must still
 * be inside retention: GC prunes the membership of older ones, and a
 * pruned side answers 410 rather than an empty diff.
 */
export async function handleReleaseDiff(ring: string, url: URL, env: Env): Promise<Response> {
  if (!isRing(ring)) return json({ error: "unknown ring" }, 404);
  const to = Number(url.searchParams.get("to") ?? 0) || (await ringHead(env, ring))?.id || 0;
  const toRow = await env.DB.prepare("SELECT * FROM releases WHERE id = ? AND ring = ?").bind(to, ring).first<ReleaseRow>();
  if (!toRow) return json({ error: `release ${to} is not a ${ring} release` }, 404);
  const from = Number(url.searchParams.get("from") ?? 0) || toRow.parent_id || 0;
  const fromRow = from ? await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(from).first<ReleaseRow>() : null;
  if (from && !fromRow) return json({ error: `release ${from} does not exist` }, 404);
  const arch = url.searchParams.get("arch");
  if (arch !== null && !isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  // A release inside retention is a head, a checkpoint or reconstructable
  // from one; GC prunes the checkpoints and deltas of older ones, and such
  // a release keeps its summary but has no list to compare.
  const members: Record<number, string> = {};
  for (const r of [toRow, fromRow]) {
    if (!r) continue;
    try {
      members[r.id] = await releaseMembers(env, r.id);
    } catch {
      return json({ error: `release ${r.id} is outside retention: its package list was pruned, only its summary remains` }, 410);
    }
  }
  type Side = { name: string; arch: string; version: string; sha256: string; source: string };
  const side = (id: number) =>
    env.DB.prepare(
      `SELECT p.name, p.repo_arch AS arch, p.version, p.sha256, p.source FROM ${members[id]} rp JOIN packages p ON p.id = rp.package_id
        WHERE (?1 IS NULL OR p.repo_arch = ?1)`,
    ).bind(arch).all<Side>();
  const [a, b] = await Promise.all([fromRow ? side(fromRow.id) : Promise.resolve({ results: [] as Side[] }), side(toRow.id)]);
  // A row is one source's build of a name: another source taking the name
  // over is that source's add and the other's removal, not an upgrade.
  const key = (p: { source: string; name: string; arch: string }) => `${p.source}\0${p.name}\0${p.arch}`;
  const before = new Map(a.results.map((p) => [key(p), p]));
  const after = new Map(b.results.map((p) => [key(p), p]));
  const added = [], removed = [], upgraded = [];
  for (const [k, p] of after) {
    const was = before.get(k);
    if (!was) added.push(p);
    else if (was.sha256 !== p.sha256) upgraded.push({ name: p.name, arch: p.arch, from: was.version, to: p.version, source: p.source });
  }
  for (const [k, p] of before) if (!after.has(k)) removed.push(p);
  const byName = (x: { name: string; arch: string; source: string }, y: { name: string; arch: string; source: string }) =>
    x.name.localeCompare(y.name) || x.arch.localeCompare(y.arch) || x.source.localeCompare(y.source);
  return json(
    {
      ring,
      from: fromRow ? { id: fromRow.id, seq: fromRow.seq, created_at: fromRow.created_at, note: fromRow.note } : null,
      to: { id: toRow.id, seq: toRow.seq, created_at: toRow.created_at, note: toRow.note },
      arch,
      counts: { added: added.length, removed: removed.length, upgraded: upgraded.length, before: a.results.length, after: b.results.length },
      added: added.sort(byName),
      removed: removed.sort(byName),
      upgraded: upgraded.sort(byName),
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

/** Above this many manifests a caller must page (`limit`/`offset`). */
const MAX_UNPAGED = 2000;
const MAX_PAGE = 1000;

/**
 * The ring's current release (or `release_id=` — one of its earlier releases,
 * so a paging client stays on one release while the ring moves on) and its
 * packages. `arch=` narrows to one architecture; `limit=`/`offset=` page
 * through the manifests in (name, arch, source) order. Summaries are small and never
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

  // How many the release holds, for this architecture: the release row
  // knows (its count and its per-source slices are computed once, when it
  // is created); the join only runs for a row from before that.
  const total = await releaseCount(env, release, arch);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), MAX_PAGE) : 0;
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  // `after=<name>/<repo_arch>/<source>`: the page after that row (keyset),
  // instead of an offset. A source's build of a name is its own row, so
  // the cursor names the source too; the older two-part form (a walk that
  // started before this deployment) still continues from its name and arch.
  const afterParam = url.searchParams.get("after");
  let after: { name: string; repoArch: string; source: string | null } | null = null;
  if (afterParam) {
    const parts = afterParam.split("/");
    const bad = () => json({ error: "after must be <name>/<repo_arch>/<source>, as page.next gives it" }, 400);
    if (parts.length >= 3 && isRepoArch(parts[parts.length - 2]) && parts[parts.length - 1]) {
      after = { name: parts.slice(0, -2).join("/"), repoArch: parts[parts.length - 2], source: parts[parts.length - 1] };
    } else if (parts.length >= 2 && isRepoArch(parts[parts.length - 1])) {
      after = { name: parts.slice(0, -1).join("/"), repoArch: parts[parts.length - 1], source: null };
    } else return bad();
    if (!after.name) return bad();
  }
  if (!limit && detail !== "summary" && total > MAX_UNPAGED) {
    return json(
      { error: `release has ${total} manifests; page with ?limit=<=${MAX_PAGE}&after=<page.next>&release_id=${release.id}`, total },
      413,
    );
  }
  const artifacts = await env.DB.prepare(
    "SELECT repo, arch, kind, size, created_at FROM release_artifacts WHERE release_id = ?",
  )
    .bind(release.id)
    .all();
  const packages = await releaseManifests(env, release.id, detail, { arch, offset, limit, after });
  const last = packages.length && limit && packages.length === limit ? (packages[packages.length - 1] as { name: string; repo_arch: string; source: string }) : null;
  return json({
    release,
    ...(await releaseSummary(env, release.id)),
    artifacts: artifacts.results,
    // A ring holds every source's build of a name; a client that installs
    // by itself takes the first in this order, as pacman takes the first
    // repository of the include that has the name.
    source_order: REPO_ORDER,
    page: { arch, offset: after ? null : offset, after: afterParam ?? null, limit: limit || null, returned: packages.length, total, next: last ? `${last.name}/${last.repo_arch}/${last.source}` : null },
    packages,
  });
}

/** The release's package count, for one architecture or all — from its row when the row carries it. */
async function releaseCount(env: Env, release: ReleaseRow, arch: string | null): Promise<number> {
  if (arch === null && release.package_count !== null && release.package_count !== undefined) return release.package_count;
  if (arch !== null && release.sources) {
    try {
      const slices = JSON.parse(release.sources) as { arch: string; packages: number }[];
      if (Array.isArray(slices) && slices.length) return slices.filter((s) => s.arch === arch).reduce((n, s) => n + s.packages, 0);
    } catch {
      // an unreadable column: count
    }
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${await releaseMembers(env, release.id)} rp JOIN packages p ON p.id = rp.package_id
      WHERE (?1 IS NULL OR p.repo_arch = ?1)`,
  )
    .bind(arch)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleReleaseHistory(ring: string, env: Env): Promise<Response> {
  if (!isRing(ring)) return json({ error: "unknown ring" }, 404);
  const rows = await env.DB.prepare(
    `SELECT r.*, (h.release_id IS NOT NULL) AS is_head
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
  // A database lives in the directory of the source it lists: omarchy-<source>-<ring>.
  const source = sourceOfRepo(repo);
  if (!source) return json({ error: "repo must be omarchy-<source>-<ring>" }, 400);
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
  const key = artifactKey(source, arch, repo, kind);
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: SHORT } });
  const keys = [key];
  if ((kind === "db" || kind === "files") && signingEnabled(env)) {
    const sig = await detachedSignature(env, new Uint8Array(bytes));
    const sigKey = artifactKey(source, arch, repo, `${kind}.sig`);
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
