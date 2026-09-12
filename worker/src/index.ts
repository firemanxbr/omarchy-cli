/**
 * Omarchy packaging staging: immutable package pool (R2), index with pinned
 * releases (D1), generated pacman databases, and a public dashboard.
 *
 * pacman never talks to this worker. Packages and the per-ring databases are
 * plain R2 objects served from the bucket's custom domain (POOL_URL):
 *   <arch>/<filename>            <arch>/omarchy-<source>-<ring>.db (.files, .sig)
 *
 * API (JSON; mutations need `Authorization: Bearer <PUBLISH_TOKEN>`):
 *   PUT  /api/v1/pool/:sha256?filename=            raw archive → R2 (integrity-checked)
 *   PUT  /api/v1/pool/:sha256/sig?filename=        detached signature
 *   POST /api/v1/pool/:sha256/multipart?filename=  large archives: create / parts / complete
 *   POST /api/v1/packages?source=core              manifest JSON → index rows
 *   POST /api/v1/packages/known                    which sha256s are already indexed
 *   GET  /api/v1/packages/:sha256
 *   GET  /api/v1/releases/:ring[?fields=summary|include=files][&arch=&limit=&offset=&release_id=]
 *   GET  /api/v1/releases/:ring/history
 *   POST /api/v1/releases                          create / promote / roll back
 *   PUT  /api/v1/releases/:id/artifacts/:kind?repo=&arch=
 *   GET  /api/v1/graph?targets=a,b&ring=stable
 *   POST /api/v1/events   GET /api/v1/events       activity log
 *   GET  /api/v1/stats                             everything the dashboard shows
 *   GET  /api/v1/version                           running release, commit, deploy time
 *   GET  /api/v1/pool/unreferenced?keep=3          retention: what GC would delete
 *   POST /api/v1/pool/gc?keep=3&limit=200          delete it (objects, then rows)
 *   GET  /                                         the dashboard
 *   GET  /pool/<arch>/<file>                       fallback static origin (dev)
 */

import { handleMultipartComplete, handleMultipartCreate, handleMultipartPart, handlePutPool, handlePutPoolSig } from "./routes/pool";
import { handleGetPackage, handleKnownPackages, handlePostPackage } from "./routes/packages";
import { handleCreateRelease, handleGetRelease, handleReleaseHistory, handlePutArtifact } from "./routes/releases";
import { handleGraph } from "./routes/graph";
import { handleGetEvents, handlePostEvent } from "./routes/events";
import { handleStats } from "./routes/stats";
import { handleGc, handleUnreferenced } from "./routes/gc";
import { dashboardHtml } from "./dashboard";
import { DASHBOARD_HOST, LEGACY_DASHBOARD_HOST, version } from "./meta";
import { handleStatic } from "./routes/static";
import { requireAuth } from "./auth";

export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  DEFAULT_RING: string;
  POOL_URL: string;
  PUBLISH_TOKEN: string;
  /** Set by the Release workflow at deploy time (`wrangler deploy --var`); "dev" otherwise. */
  POOL_VERSION?: string;
  POOL_COMMIT?: string;
  POOL_DEPLOYED_AT?: string;
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

    // The dashboard moved from dashboard-omarchy to omarchy-pool; the old name
    // was published, so it keeps redirecting.
    if (url.hostname === LEGACY_DASHBOARD_HOST) {
      url.hostname = DASHBOARD_HOST;
      return Response.redirect(url.toString(), 301);
    }

    try {
      if (path.startsWith(API + "/")) {
        const res = await api(method, path.slice(API.length), url, request, env);
        res.headers.set("access-control-allow-origin", "*");
        return res;
      }
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
      if (path.startsWith("/pool/") && (method === "GET" || method === "HEAD")) {
        return await handleStatic(decodeURIComponent(path.slice("/pool/".length)), request, env);
      }
      if (path === "/" || path === "/index.html") {
        return new Response(dashboardHtml(env.POOL_URL, version(env)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
        });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function cors(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

async function api(method: string, path: string, url: URL, request: Request, env: Env): Promise<Response> {
  let m: RegExpMatchArray | null;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (method === "GET" && path === "/stats") return handleStats(env);
  if (method === "GET" && path === "/version") return json(version(env), 200, { "cache-control": "public, max-age=30" });
  if (method === "GET" && path === "/graph") return handleGraph(url, env);
  if (method === "GET" && path === "/events") return handleGetEvents(url, env);
  if (method === "GET" && path === "/pool/unreferenced") return handleUnreferenced(url, env);
  if (method === "POST" && path === "/pool/gc") return requireAuth(request, env) ?? handleGc(url, env);
  if (method === "POST" && path === "/events") return requireAuth(request, env) ?? handlePostEvent(request, env);

  if ((m = path.match(/^\/pool\/([0-9a-f]{64})$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutPool(m[1], url, request, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/sig$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutPoolSig(m[1], url, request, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/multipart$/)) && method === "POST") {
    return requireAuth(request, env) ?? handleMultipartCreate(m[1], url, env);
  }
  if ((m = path.match(/^\/pool\/multipart\/([A-Za-z0-9._-]+)\/part\/(\d+)$/)) && method === "PUT") {
    const key = url.searchParams.get("key") ?? "";
    return requireAuth(request, env) ?? handleMultipartPart(key, m[1], Number(m[2]), request, env);
  }
  if ((m = path.match(/^\/pool\/multipart\/([A-Za-z0-9._-]+)\/complete$/)) && method === "POST") {
    const key = url.searchParams.get("key") ?? "";
    return requireAuth(request, env) ?? handleMultipartComplete(key, m[1], request, env);
  }
  if (path === "/packages" && method === "POST") {
    return requireAuth(request, env) ?? handlePostPackage(url, request, env);
  }
  if (path === "/packages/known" && method === "POST") {
    return handleKnownPackages(request, env);
  }
  if ((m = path.match(/^\/packages\/([0-9a-f]{64})$/)) && method === "GET") {
    return handleGetPackage(m[1], env);
  }
  if (path === "/releases" && method === "POST") {
    return requireAuth(request, env) ?? handleCreateRelease(request, env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)$/)) && method === "GET") {
    return handleGetRelease(m[1], url, env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)\/history$/)) && method === "GET") {
    return handleReleaseHistory(m[1], env);
  }
  if ((m = path.match(/^\/releases\/(\d+)\/artifacts\/(db|db\.sig|files|files\.sig)$/)) && method === "PUT") {
    return requireAuth(request, env) ?? handlePutArtifact(Number(m[1]), m[2], url, request, env);
  }
  return json({ error: "not found" }, 404);
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
