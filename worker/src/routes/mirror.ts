import { isRing, type Env } from "../index";
import { ringHead } from "../db";
import { poolKey, poolSigKey, streamObject } from "../r2";

const DB_FILE = /^([A-Za-z0-9_-]+)\.(db|files)(\.tar\.gz)?(\.sig)?$/;

/**
 * pacman mirror: `Server = https://host/$repo/os/$arch` with `$repo` being the
 * ring. Databases come from the ring head's artifacts; package files are
 * resolved by filename within that release and streamed from the pool.
 */
export async function handleMirror(ring: string, arch: string, file: string, request: Request, env: Env): Promise<Response> {
  if (!isRing(ring)) return new Response("unknown ring", { status: 404 });
  const head = await ringHead(env, ring);
  if (!head) return new Response("ring has no release", { status: 404 });

  const db = file.match(DB_FILE);
  if (db) {
    const [, repo, base, , sig] = db;
    const kind = sig ? `${base}.sig` : base;
    const row = await env.DB.prepare(
      "SELECT r2_key FROM release_artifacts WHERE release_id = ? AND repo = ? AND arch = ? AND kind = ?",
    )
      .bind(head.id, repo, arch, kind)
      .first<{ r2_key: string }>();
    if (!row) return new Response("database not generated for this release", { status: 404 });
    return streamObject(env.PACKAGES, row.r2_key, request, "public, max-age=60", file);
  }

  const wantSig = file.endsWith(".sig");
  const filename = wantSig ? file.slice(0, -4) : file;
  const pkg = await env.DB.prepare(
    `SELECT p.sha256, p.has_signature FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ? AND p.filename = ? AND p.arch = ?`,
  )
    .bind(head.id, filename, arch)
    .first<{ sha256: string; has_signature: number }>();
  if (!pkg) return new Response("package not in this release", { status: 404 });
  if (wantSig && !pkg.has_signature) return new Response("no signature", { status: 404 });

  const key = wantSig ? poolSigKey(pkg.sha256) : poolKey(pkg.sha256);
  return streamObject(env.PACKAGES, key, request, "public, max-age=31536000, immutable", file);
}
