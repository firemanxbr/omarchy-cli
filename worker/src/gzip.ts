export async function gzipJson(value: unknown): Promise<ArrayBuffer> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** D1 hands BLOBs back as ArrayBuffer or as a plain number array depending on the path. */
export async function gunzipJson<T>(gz: ArrayBuffer | ArrayLike<number>): Promise<T> {
  const bytes = gz instanceof ArrayBuffer ? new Uint8Array(gz) : Uint8Array.from(gz);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}
