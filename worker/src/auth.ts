import { json, type Env } from "./index";

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
