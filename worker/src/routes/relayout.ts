/**
 * The move from the flat layout (`<arch>/<filename>`, one object per
 * filename whichever source built it) to one directory per source
 * (`<source>/<arch>/<filename>`, r2.ts) — run once, as the `relayout` job:
 *
 *   POST /pool/relayout?phase=copy&limit=N   copies up to N objects to their
 *     source's directory — R2 checks the row's sha256 on the way — with the
 *     signature and attestation beside them, then points the row at the new
 *     key. Nothing is deleted. A row whose bytes the pool never held (a
 *     rebuild indexed behind an earlier build of the filename, before
 *     2026-09-12) is marked `ghost/…`: it names no object, and retention
 *     takes it in time. Repeat until `remaining` is 0.
 *   POST /pool/relayout?phase=purge&limit=N  once nothing is left to move
 *     and the rings are rendered again: deletes what remains under the flat
 *     directories — the old objects, signatures and databases — a page at
 *     a time. Repeat until `truncated` is false.
 *
 * Between the two, the include (setup.ts) names both directories, so a
 * package not yet moved is still found; after, only the source's.
 */
import { json, type Env } from "../index";
import { IMMUTABLE, packageKey, REPO_ARCHES } from "../r2";

/** Rows whose object is not in its source's directory yet (a null key is the flat one, from before the column). */
export const UNMOVED = "(r2_key IS NULL OR (r2_key NOT LIKE source || '/%' AND r2_key NOT LIKE 'ghost/%'))";

interface Row { id: number; sha256: string; source: string; repo_arch: string; filename: string; r2_key: string | null }

const hex = (sum: ArrayBuffer | undefined) => (sum ? [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("") : null);

export async function handleRelayout(url: URL, env: Env): Promise<Response> {
  const phase = url.searchParams.get("phase") ?? "copy";
  const limit = Math.min(80, Math.max(1, Number(url.searchParams.get("limit") ?? 40)));
  if (phase === "copy") return copy(env, limit);
  if (phase === "purge") return purge(env, limit);
  return json({ error: "phase must be copy or purge" }, 400);
}

async function copy(env: Env, limit: number): Promise<Response> {
  await env.DB.prepare("UPDATE packages SET r2_key = repo_arch || '/' || filename WHERE r2_key IS NULL").run();
  const rows = (await env.DB.prepare(`SELECT id, sha256, source, repo_arch, filename, r2_key FROM packages WHERE ${UNMOVED} ORDER BY id LIMIT ?`).bind(limit).all<Row>()).results;
  let moved = 0, ghosts = 0, missing = 0;
  const errors: string[] = [];
  const one = async (row: Row) => {
    const from = row.r2_key!;
    const to = packageKey(row.source, row.repo_arch, row.filename);
    try {
      const outcome = await copyObject(env, from, to, row.sha256);
      if (outcome === "missing") { missing++; return; }
      if (outcome === "ghost") {
        ghosts++;
        await env.DB.prepare("UPDATE packages SET r2_key = 'ghost/' || source || '/' || repo_arch || '/' || filename WHERE id = ?").bind(row.id).run();
        return;
      }
      for (const suffix of [".sig", ".provenance.json", ".provenance.json.sig"]) {
        if (await env.PACKAGES.head(`${to}${suffix}`)) continue;
        const side = await env.PACKAGES.get(`${from}${suffix}`);
        if (side) await env.PACKAGES.put(`${to}${suffix}`, side.body, { httpMetadata: side.httpMetadata });
      }
      await env.DB.prepare("UPDATE packages SET r2_key = ? WHERE id = ?").bind(to, row.id).run();
      moved++;
    } catch (err) {
      errors.push(`${from}: ${String(err)}`);
    }
  };
  // Four at a time: the bytes stream from one key to the other through
  // this invocation, and a batch of large objects must not run it out of
  // subrequests or memory.
  const queue = [...rows];
  await Promise.all(Array.from({ length: 4 }, async () => { for (let r = queue.shift(); r; r = queue.shift()) await one(r); }));
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM packages WHERE ${UNMOVED}`).first<{ n: number }>();
  return json({ phase: "copy", moved, ghosts, missing, errors, remaining: left?.n ?? 0 });
}

/**
 * The object at `to`, with the row's bytes: copied from `from` unless it is
 * there already. "ghost" when the bytes behind the filename are another
 * row's (R2 refuses the copy against the row's sha256, or says so up
 * front), "missing" when nothing is stored at `from` at all.
 */
async function copyObject(env: Env, from: string, to: string, sha256: string): Promise<"copied" | "present" | "ghost" | "missing"> {
  const there = await env.PACKAGES.head(to);
  if (there) return hex(there.checksums.sha256) === sha256 || !there.checksums.sha256 ? "present" : "ghost";
  const obj = await env.PACKAGES.get(from);
  if (!obj) return "missing";
  const stored = hex(obj.checksums.sha256);
  if (stored && stored !== sha256) {
    await obj.body.cancel();
    return "ghost";
  }
  try {
    await env.PACKAGES.put(to, obj.body, { sha256, httpMetadata: { contentType: obj.httpMetadata?.contentType ?? "application/octet-stream", cacheControl: IMMUTABLE } });
  } catch (err) {
    if (/checksum|sha256|mismatch|integrity/i.test(String(err))) return "ghost";
    throw err;
  }
  return "copied";
}

async function purge(env: Env, limit: number): Promise<Response> {
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM packages WHERE ${UNMOVED}`).first<{ n: number }>();
  if (left?.n) return json({ error: "objects are still moving; purge once copy reports nothing remaining", remaining: left.n }, 409);
  let deleted = 0;
  let truncated = false;
  for (const arch of REPO_ARCHES) {
    const page = await env.PACKAGES.list({ prefix: `${arch}/`, limit: Math.min(1000, limit * 25) });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.PACKAGES.delete(keys);
    deleted += keys.length;
    truncated ||= page.truncated;
  }
  return json({ phase: "purge", deleted, truncated });
}
