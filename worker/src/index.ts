/**
 * Omarchy edge repository: immutable package pool (R2), index with pinned
 * releases (D1), and a pacman-compatible mirror on top.
 *
 * pacman-facing (no auth):
 *   GET  /:ring/os/:arch/<repo>.db[.tar.gz][.sig]   generated database of the ring head
 *   GET  /:ring/os/:arch/<repo>.files[.tar.gz][.sig]
 *   GET  /:ring/os/:arch/<filename>[.sig]           package blob from the pool
 *
 * API (JSON; mutations need `Authorization: Bearer <PUBLISH_TOKEN>`):
 *   PUT  /api/v1/pool/:sha256          raw archive body → R2 (integrity-checked)
 *   PUT  /api/v1/pool/:sha256/sig      raw detached signature
 *   POST /api/v1/packages              manifest JSON → index rows
 *   GET  /api/v1/packages/:sha256
 *   GET  /api/v1/releases/:ring        head release + manifests
 *   GET  /api/v1/releases/:ring/history
 *   POST /api/v1/releases              create / promote a release
 *   PUT  /api/v1/releases/:id/artifacts/:kind?repo=&arch=   generated db upload
 *   GET  /api/v1/graph?targets=a,b&ring=stable   dependency closure within the ring
 *
 * The worker never resolves dependencies or decides what is safe; it serves
 * data. Rendering and signing databases happens in the publisher (pkg-repo).
 */

import { handleMirror } from "./routes/mirror";
import { handlePutPool, handlePutPoolSig } from "./routes/pool";
import { handleGetPackage, handlePostPackage } from "./routes/packages";
import {
  handleCreateRelease,
  handleGetRelease,
  handleReleaseHistory,
  handlePutArtifact,
} from "./routes/releases";
import { handleGraph } from "./routes/graph";
import { requireAuth } from "./auth";

export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  DEFAULT_RING: string;
  PUBLISH_TOKEN: string;
}

export const RINGS = ["edge", "rc", "stable"] as const;
export type Ring = (typeof RINGS)[number];

export function isRing(s: string): s is Ring {
  return (RINGS as readonly string[]).includes(s);
}

const API = "/api/v1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const { method } = request;

    try {
      if (path.startsWith(API + "/")) {
        return await api(method, path.slice(API.length), url, request, env);
      }
      // /:ring/os/:arch/:file
      const m = path.match(/^\/([a-z]+)\/os\/([A-Za-z0-9_]+)\/([^/]+)$/);
      if (m && (method === "GET" || method === "HEAD")) {
        return await handleMirror(m[1], m[2], decodeURIComponent(m[3]), request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function api(method: string, path: string, url: URL, request: Request, env: Env): Promise<Response> {
  let m: RegExpMatchArray | null;

  if (method === "GET" && path === "/graph") return handleGraph(url, env);

  if ((m = path.match(/^\/pool\/([0-9a-f]{64})$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutPool(m[1], request, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/sig$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutPoolSig(m[1], request, env);
  }
  if (path === "/packages" && method === "POST") {
    return requireAuth(request, env) ?? handlePostPackage(request, env);
  }
  if ((m = path.match(/^\/packages\/([0-9a-f]{64})$/)) && method === "GET") {
    return handleGetPackage(m[1], env);
  }
  if (path === "/releases" && method === "POST") {
    return requireAuth(request, env) ?? handleCreateRelease(request, env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)$/)) && method === "GET") {
    return handleGetRelease(m[1], env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)\/history$/)) && method === "GET") {
    return handleReleaseHistory(m[1], env);
  }
  if ((m = path.match(/^\/releases\/(\d+)\/artifacts\/(db|db\.sig|files|files\.sig)$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutArtifact(Number(m[1]), m[2], url, request, env);
  }
  return json({ error: "not found" }, 404);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
