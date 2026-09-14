/**
 * Per-job credentials. When a worker claims a task the pool hands it a
 * token that is good for that task only: the routes the job needs (its
 * scopes), until the lease ends. The worker's own token can only claim;
 * whatever a job writes, it writes with this one. A leaked job token is
 * worth one job's writes for thirty minutes.
 *
 *   omj.<base64url(json claims)>.<base64url(hmac-sha256)>
 *   claims = { t: task id, k: kind, s: [scopes], e: unix seconds, w: worker }
 *
 * Scopes:
 *   task:<id>            heartbeat / complete / fail this task
 *   staging:<id>         upload evidence for this (community) task
 *   pool:write           upload objects and index manifests
 *   release:<ring>       create a release in that ring (add / remove / promote into it)
 *   artifacts:<release>  store rendered databases for that release
 *   security:write       advisories and matches
 *   gc                   retention
 *   events               journal lines
 */
import type { Env } from "./index";

export interface JobClaims {
  t: number;
  k: string;
  s: string[];
  e: number;
  w: string;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(env: Env): Promise<CryptoKey> {
  const secret = env.JOB_TOKEN_SECRET ?? "";
  if (!secret) throw new Error("JOB_TOKEN_SECRET is not set; no job token can be issued or verified");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueJobToken(env: Env, claims: JobClaims): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await key(env), enc.encode(payload));
  return `omj.${payload}.${b64url(sig)}`;
}

/** The claims of a valid, unexpired job token in the request, or null. */
export async function jobOf(request: Request, env: Env): Promise<JobClaims | null> {
  const h = request.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const m = token.match(/^omj\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(env), unb64url(m[2]), enc.encode(m[1]));
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(unb64url(m[1]))) as JobClaims;
    if (!claims.e || claims.e * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Does a job token in the request carry the scope? */
export async function jobHas(request: Request, env: Env, scope: string): Promise<JobClaims | null> {
  const c = await jobOf(request, env);
  return c && c.s.includes(scope) ? c : null;
}

/** The scopes a task of this kind needs, from its parameters. */
export function scopesFor(kind: string, id: number, trust: string, params: Record<string, unknown>): string[] {
  const s = [`task:${id}`, "events"];
  const ring = typeof params.ring === "string" ? params.ring : "edge";
  switch (kind) {
    case "build":
      if (trust === "community") s.push(`staging:${id}`);
      else s.push("pool:write", `release:${ring}`, `artifacts:*:${ring}`);
      break;
    case "sync": {
      // One task syncs every source of an architecture, each into its own
      // ring (the OPR's edge/rc/stable channels): a scope per ring named.
      s.push("pool:write");
      const rings = new Set<string>([ring]);
      let sources: unknown = params.sources;
      if (typeof sources === "string") {
        try {
          sources = JSON.parse(sources);
        } catch {
          sources = [];
        }
      }
      if (Array.isArray(sources)) for (const src of sources) if (src && typeof src === "object" && typeof (src as { ring?: unknown }).ring === "string") rings.add((src as { ring: string }).ring);
      for (const r of rings) s.push(`release:${r}`, `artifacts:*:${r}`);
      break;
    }
    case "promote":
      s.push(`release:${String(params.to ?? "rc")}`, `artifacts:*:${String(params.to ?? "rc")}`);
      break;
    case "rollback":
      s.push(`release:${ring}`, `artifacts:*:${ring}`);
      break;
    case "render":
      s.push(`artifacts:*:${ring}`);
      break;
    case "security":
      s.push("security:write", "release:rc", "release:stable", "artifacts:*:rc", "artifacts:*:stable");
      break;
    case "gc":
      s.push("gc");
      break;
    case "enqueue":
      s.push("factory:write");
      break;
    case "verify":
      // Every ring: a wrong signature replaced, a ring re-pinned to what the pool stores, rendered.
      s.push("pool:write", "release:edge", "release:rc", "release:stable", "artifacts:*:edge", "artifacts:*:rc", "artifacts:*:stable");
      break;
    case "audit":
      // The report goes next to the evidence it is about: the staged task's prefix.
      if (typeof params.task === "number" || typeof params.task === "string") s.push(`staging:${params.task}`);
      break;
    default:
      break;
  }
  return s;
}
