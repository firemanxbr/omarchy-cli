import type { Env } from "../index";

/**
 * Streams pool objects straight from the bucket, Range included. In production
 * pacman reads the R2 custom domain instead; this route exists for local
 * development (wrangler dev has no custom domain) and as a fallback origin.
 */
export async function handleStatic(key: string, request: Request, env: Env): Promise<Response> {
  if (!/^[A-Za-z0-9_]+\/[A-Za-z0-9@._+:-]+$/.test(key)) return new Response("not found", { status: 404 });
  const object = await env.PACKAGES.get(key, { range: request.headers, onlyIf: request.headers });
  if (object === null) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=60");
  const body = "body" in object ? object.body : null;
  if (body === null) return new Response(null, { status: 304, headers });

  const partial = request.headers.has("range") && object.range && "offset" in object.range && object.range.offset !== undefined;
  if (partial && object.range && "offset" in object.range && object.range.offset !== undefined) {
    const offset = object.range.offset;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
