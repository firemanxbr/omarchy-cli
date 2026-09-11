import { json, type Env } from "../index";
import { poolKey, poolSigKey } from "../r2";

/**
 * Streams the request body straight into R2. R2 verifies the SHA-256 of the
 * uploaded bytes against the key we claim, so a corrupt or mislabelled upload
 * is rejected before it can be referenced by the index.
 */
export async function handlePutPool(sha256: string, request: Request, env: Env): Promise<Response> {
  if (!request.body) return json({ error: "empty body" }, 400);
  const existing = await env.PACKAGES.head(poolKey(sha256));
  if (existing) return json({ sha256, size: existing.size, status: "already-present" });

  try {
    const object = await env.PACKAGES.put(poolKey(sha256), request.body, {
      sha256,
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return json({ sha256, size: object?.size ?? 0, status: "stored" }, 201);
  } catch (err) {
    return json({ error: "integrity check failed", detail: String(err) }, 422);
  }
}

export async function handlePutPoolSig(sha256: string, request: Request, env: Env): Promise<Response> {
  if (!request.body) return json({ error: "empty body" }, 400);
  if (!(await env.PACKAGES.head(poolKey(sha256)))) return json({ error: "archive not in pool" }, 404);
  const object = await env.PACKAGES.put(poolSigKey(sha256), request.body);
  await env.DB.prepare("UPDATE packages SET has_signature = 1 WHERE sha256 = ?").bind(sha256).run();
  return json({ sha256, size: object?.size ?? 0, status: "stored" }, 201);
}
