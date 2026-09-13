import { json, type Env } from "./index";
import { jobHas, jobOf } from "./jobtoken";

/** Returns a 401 response when the bearer token is missing or wrong, else null. */
export function requireAuth(request: Request, env: Env): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.PUBLISH_TOKEN || !timingSafeEqual(token, env.PUBLISH_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Build workers hold their own token (FACTORY_TOKEN), separate from the
 * publish token: a leaked worker credential can claim and report builds but
 * cannot approve requests, promote rings or touch the pool directly.
 */
export function requireFactoryAuth(request: Request, env: Env): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.FACTORY_TOKEN || !timingSafeEqual(token, env.FACTORY_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** True when the bearer token is the project's FACTORY_TOKEN. */
export function isProjectFactoryToken(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return !!env.FACTORY_TOKEN && timingSafeEqual(token, env.FACTORY_TOKEN);
}

/** True when the bearer token is the publish token (a maintainer / the pipeline). */
export function requireAuthOk(request: Request, env: Env): boolean {
  return requireAuth(request, env) === null;
}

/**
 * A write is allowed with the publish token (a maintainer, the pipeline —
 * the transition credential) or with a job token that carries the scope.
 * Returns the 401/403 to send, or null when allowed.
 */
export async function authorize(request: Request, env: Env, scope: string): Promise<Response | null> {
  if (requireAuth(request, env) === null) return null;
  const job = await jobOf(request, env);
  if (!job) return json({ error: "unauthorized" }, 401);
  if (!job.s.includes(scope) && !job.s.some((s) => s.endsWith(":*") && scope.startsWith(s.slice(0, -1)))) {
    return json({ error: `job ${job.t} (${job.k}) may not ${scope}`, scopes: job.s }, 403);
  }
  return null;
}

/** POST /releases: the scope depends on the ring in the body. */
export async function authorizeRelease(request: Request, env: Env): Promise<Response | null> {
  if (requireAuth(request, env) === null) return null;
  let ring = "";
  try {
    ring = String(((await request.clone().json()) as { ring?: string }).ring ?? "");
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  return authorize(request, env, `release:${ring}`);
}

/** PUT /releases/:id/artifacts: the scope names the ring the release belongs to. */
export async function authorizeArtifacts(request: Request, env: Env, releaseId: number): Promise<Response | null> {
  if (requireAuth(request, env) === null) return null;
  const row = await env.DB.prepare("SELECT ring FROM releases WHERE id = ?").bind(releaseId).first<{ ring: string }>();
  if (!row) return json({ error: "no such release" }, 404);
  const ok = (await jobHas(request, env, `artifacts:*:${row.ring}`)) ?? (await jobHas(request, env, `artifacts:${releaseId}`));
  return ok ? null : authorize(request, env, `artifacts:*:${row.ring}`);
}
