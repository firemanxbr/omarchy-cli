import { json, type Env } from "../index";
import { archDirsFor, IMMUTABLE, packageKey, signatureKey } from "../r2";

const FILENAME_RE = /^[A-Za-z0-9@._+:-]+-(x86_64|aarch64|any)\.pkg\.tar\.(zst|xz)$/;

function target(url: URL): { filename: string; arch: string } | Response {
  const filename = url.searchParams.get("filename") ?? "";
  const m = filename.match(FILENAME_RE);
  if (!m) return json({ error: "filename must be <name>-<ver>-<arch>.pkg.tar.zst" }, 400);
  return { filename, arch: m[1] };
}

/**
 * Single-request upload (bodies up to the Workers request limit). R2 verifies
 * the SHA-256 of the bytes against the key we claim, so a corrupt upload is
 * rejected before it can be indexed. The object is written under every
 * architecture directory it must appear in.
 */
export async function handlePutPool(sha256: string, url: URL, request: Request, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  if (!request.body) return json({ error: "empty body" }, 400);
  const dirs = archDirsFor(t.arch);
  const existing = await env.PACKAGES.head(packageKey(dirs[0], t.filename));
  if (existing) return json({ sha256, key: packageKey(dirs[0], t.filename), size: existing.size, status: "already-present" });

  try {
    // Tee the body when the object must land in more than one directory.
    const streams = dirs.length === 1 ? [request.body] : request.body.tee();
    const results = await Promise.all(
      dirs.map((dir, i) =>
        env.PACKAGES.put(packageKey(dir, t.filename), streams[i], {
          sha256,
          httpMetadata: { contentType: "application/octet-stream", cacheControl: IMMUTABLE },
        }),
      ),
    );
    return json({ sha256, key: packageKey(dirs[0], t.filename), size: results[0]?.size ?? 0, status: "stored" }, 201);
  } catch (err) {
    return json({ error: "integrity check failed", detail: String(err) }, 422);
  }
}

export async function handlePutPoolSig(sha256: string, url: URL, request: Request, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  if (!request.body) return json({ error: "empty body" }, 400);
  const dirs = archDirsFor(t.arch);
  if (!(await env.PACKAGES.head(packageKey(dirs[0], t.filename)))) return json({ error: "archive not in pool" }, 404);
  const bytes = await request.arrayBuffer();
  await Promise.all(
    dirs.map((dir) => env.PACKAGES.put(signatureKey(dir, t.filename), bytes, { httpMetadata: { cacheControl: IMMUTABLE } })),
  );
  await env.DB.prepare("UPDATE packages SET has_signature = 1 WHERE sha256 = ?").bind(sha256).run();
  return json({ sha256, size: bytes.byteLength, status: "stored" }, 201);
}

/**
 * Multipart upload for archives larger than one request may carry. The parts
 * go straight to R2; `complete` records the object. Integrity is the
 * publisher's job here (it verifies the download against the upstream sha256
 * before uploading), since R2 cannot hash across parts.
 */
export async function handleMultipartCreate(sha256: string, url: URL, env: Env): Promise<Response> {
  const t = target(url);
  if (t instanceof Response) return t;
  const dirs = archDirsFor(t.arch);
  if (await env.PACKAGES.head(packageKey(dirs[0], t.filename))) return json({ status: "already-present" });
  const uploads = await Promise.all(
    dirs.map((dir) =>
      env.PACKAGES.createMultipartUpload(packageKey(dir, t.filename), {
        httpMetadata: { contentType: "application/octet-stream", cacheControl: IMMUTABLE },
      }),
    ),
  );
  return json({ sha256, uploads: uploads.map((u) => ({ key: u.key, uploadId: u.uploadId })) }, 201);
}

export async function handleMultipartPart(
  key: string,
  uploadId: string,
  part: number,
  request: Request,
  env: Env,
): Promise<Response> {
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
