import { json, type Env } from "../index";

/**
 * CI publish endpoint. Multipart form with fields:
 *   manifest  — PackageManifest JSON (produced by `pkg-extract inspect`)
 *   archive   — the untouched .pkg.tar.zst
 *   signature — detached ed25519 signature of the archive (optional until phase 4)
 *
 * Writes the archive to R2 keyed by sha256 and inserts the graph rows into D1
 * inside a batch so the metadata never references a missing blob.
 */
export async function handlePublish(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.PUBLISH_TOKEN}`) return json({ error: "unauthorized" }, 401);

  // TODO(phase 4): parse multipart, verify sha256 matches manifest, put to R2,
  // insert packages/provides/requires/files rows via env.DB.batch().
  return json({ error: "not implemented" }, 501);
}
