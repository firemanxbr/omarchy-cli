/** R2 key layout and a Range-aware streaming response. */

export const poolKey = (sha256: string) => `pool/${sha256}.pkg.tar.zst`;
export const poolSigKey = (sha256: string) => `pool/${sha256}.pkg.tar.zst.sig`;
export const artifactKey = (releaseId: number, repo: string, arch: string, kind: string) =>
  `releases/${releaseId}/${repo}-${arch}.${kind}`;

export async function streamObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  cacheControl: string,
  filename?: string,
): Promise<Response> {
  const object = await bucket.get(key, { range: request.headers, onlyIf: request.headers });
  if (object === null) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("content-type", "application/octet-stream");
  if (filename) headers.set("content-disposition", `inline; filename="${filename}"`);

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
