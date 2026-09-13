import { json, type Env } from "../index";
import { signingEnabled, detachedSignature } from "../signing";
import { IMMUTABLE, isRepoArch, packageKey, signatureKey } from "../r2";

const FILENAME_RE = /^[A-Za-z0-9@._+:-]+-(x86_64|aarch64|any)\.pkg\.tar\.(zst|xz)$/;

/** `?filename=` and `?arch=` (the upstream repository's architecture). */
function target(url: URL): { filename: string; repoArch: string } | Response {
  const filename = url.searchParams.get("filename") ?? "";
  if (!FILENAME_RE.test(filename)) return json({ error: "filename must be <name>-<ver>-<arch>.pkg.tar.zst" }, 400);
  const repoArch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRepoArch(repoArch)) return json({ error: "arch must be x86_64 or aarch64" }, 400);
  return { filename, repoArch };
}

/**
 * Single-request upload (bodies up to the Workers request limit). R2 verifies
 * the SHA-256 of the bytes against the key we claim, so a corrupt upload is
 * rejected before it can be indexed. Existing objects are never overwritten.
 */
export async function handlePutPool(sha256: string, url: URL, request: Request, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  if (!request.body) return json({ error: "empty body" }, 400);
  const key = packageKey(t.repoArch, t.filename);
  const existing = await env.PACKAGES.head(key);
  if (existing) return json({ sha256, key, size: existing.size, status: "already-present" });

  try {
    const object = await env.PACKAGES.put(key, request.body, {
      sha256,
      httpMetadata: { contentType: "application/octet-stream", cacheControl: IMMUTABLE },
    });
    return json({ sha256, key, size: object?.size ?? 0, status: "stored" }, 201);
  } catch (err) {
    return r2PutError(err);
  }
}

/**
 * POST /pool/:sha256/sign?filename=&arch= — the pool signs a package object
 * it stores (a factory build the job just published). The object is
 * streamed from R2 into the signature; the .sig lands beside it.
 */
export async function handleSignPool(sha256: string, url: URL, env: Env): Promise<Response> {
  if (!signingEnabled(env)) return json({ error: "the pool has no signing key configured" }, 501);
  const t = target(url);
  if (t instanceof Response) return t;
  const key = packageKey(t.repoArch, t.filename);
  const obj = await env.PACKAGES.get(key);
  if (!obj) return json({ error: "archive not in pool" }, 404);
  const storedSha = obj.checksums.sha256 ? [...new Uint8Array(obj.checksums.sha256)].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  if (storedSha && storedSha !== sha256) return json({ error: `the pool serves ${storedSha} under ${t.filename}; not ${sha256}` }, 409);
  const sig = await detachedSignature(env, obj.body as ReadableStream<Uint8Array>);
  await env.PACKAGES.put(signatureKey(t.repoArch, t.filename), sig, { httpMetadata: { cacheControl: IMMUTABLE } });
  await env.DB.prepare("UPDATE packages SET has_signature = 1 WHERE sha256 = ? AND repo_arch = ?").bind(sha256, t.repoArch).run();
  return json({ sha256, signed: true, size: sig.byteLength }, 201);
}

export async function handlePutPoolSig(sha256: string, url: URL, request: Request, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  if (!request.body) return json({ error: "empty body" }, 400);
  const archive = await env.PACKAGES.head(packageKey(t.repoArch, t.filename));
  if (!archive) return json({ error: "archive not in pool" }, 404);
  // A signature belongs to exact bytes. The pool keeps the first object
  // stored under a filename, so a signature of a rebuild with different
  // content would break verification of what is actually served.
  const storedSha = archive.checksums.sha256 ? [...new Uint8Array(archive.checksums.sha256)].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  if (storedSha && storedSha !== sha256) return json({ error: `the pool serves ${storedSha} under ${t.filename}; a signature for ${sha256} does not apply`, stored: storedSha }, 409);
  const bytes = await request.arrayBuffer();
  await env.PACKAGES.put(signatureKey(t.repoArch, t.filename), bytes, { httpMetadata: { cacheControl: IMMUTABLE } });
  await env.DB.prepare("UPDATE packages SET has_signature = 1 WHERE sha256 = ? AND repo_arch = ?").bind(sha256, t.repoArch).run();
  return json({ sha256, size: bytes.byteLength, status: "stored" }, 201);
}

/**
 * Multipart upload for archives larger than one request may carry. Integrity
 * is the publisher's job here (it verifies the download against the upstream
 * sha256 before uploading), since R2 cannot hash across parts.
 */
export async function handleMultipartCreate(sha256: string, url: URL, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  const key = packageKey(t.repoArch, t.filename);
  if (await env.PACKAGES.head(key)) return json({ status: "already-present" });
  const upload = await env.PACKAGES.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/octet-stream", cacheControl: IMMUTABLE },
  });
  return json({ sha256, uploads: [{ key: upload.key, uploadId: upload.uploadId }] }, 201);
}

export async function handleMultipartPart(key: string, uploadId: string, part: number, request: Request, env: Env): Promise<Response> {
  if (!request.body) return json({ error: "empty body" }, 400);
  const upload = env.PACKAGES.resumeMultipartUpload(key, uploadId);
  const uploaded = await upload.uploadPart(part, request.body);
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

export async function handleMultipartComplete(key: string, uploadId: string, request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { parts: { partNumber: number; etag: string }[] };
  const upload = env.PACKAGES.resumeMultipartUpload(key, uploadId);
  const object = await upload.complete(body.parts);
  return json({ key, size: object.size, status: "stored" }, 201);
}

/**
 * A failed `put` with a `sha256` option is either a checksum mismatch (the
 * upload is wrong: 422, do not retry) or an R2-side error such as
 * `internal error (10001)` (503: the publisher retries with backoff).
 */
export function r2PutError(err: unknown): Response {
  const detail = String(err);
  if (/checksum|sha256|mismatch|integrity/i.test(detail)) {
    return json({ error: "integrity check failed", detail }, 422);
  }
  return json({ error: "storage error, retry", detail }, 503, { "retry-after": "5" });
}
