import { json, type Env } from "../index";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Streams a package archive from R2, honouring Range requests. */
export async function handleBlob(sha256: string, request: Request, env: Env): Promise<Response> {
  if (!SHA256_RE.test(sha256)) return json({ error: "invalid sha256" }, 400);

  const object = await env.PACKAGES.get(`${sha256}.pkg.tar.zst`, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (object === null) return json({ error: "blob not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (object.range && "offset" in object.range && object.range.offset !== undefined) {
    const offset = object.range.offset;
    const end = offset + (object.range.length ?? object.size - offset) - 1;
    headers.set("content-range", `bytes ${offset}-${end}/${object.size}`);
  }

  const body = "body" in object ? object.body : null;
  return new Response(body, { status: body && object.range ? 206 : body ? 200 : 304, headers });
}
