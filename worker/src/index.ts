/**
 * Omarchy edge repository API.
 *
 * The worker never resolves dependencies: it only serves the metadata subgraph
 * the client asks for. SAT resolution happens locally in `omarchy-cli`, which
 * is the only side that knows the installed state.
 *
 * Routes (all under /api/v1):
 *   GET  /graph?targets=a,b&channel=stable  → transitive dependency closure of the
 *                                             latest version of each target
 *   GET  /packages/:name                    → all versions of a package
 *   GET  /blob/:sha256                      → streams the .pkg.tar.zst from R2 (Range OK)
 *   POST /sync/diff                         → given {name: version} returns available updates
 *   PUT  /packages                          → CI publish (multipart: manifest + archive + sig)
 */

import { handleGraph } from "./routes/graph";
import { handleBlob } from "./routes/blob";
import { handlePackage } from "./routes/packages";
import { handlePublish } from "./routes/publish";
import { handleSyncDiff } from "./routes/sync";

export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  DEFAULT_CHANNEL: string;
  PUBLISH_TOKEN: string;
}

const API_PREFIX = "/api/v1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) {
      return json({ error: "not found" }, 404);
    }
    const path = url.pathname.slice(API_PREFIX.length);
    const { method } = request;

    try {
      if (method === "GET" && path === "/graph") return await handleGraph(url, env);
      if (method === "GET" && path.startsWith("/packages/")) return await handlePackage(path.slice("/packages/".length), url, env);
      if (method === "GET" && path.startsWith("/blob/")) return await handleBlob(path.slice("/blob/".length), request, env);
      if (method === "POST" && path === "/sync/diff") return await handleSyncDiff(request, env);
      if (method === "PUT" && path === "/packages") return await handlePublish(request, env);
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
