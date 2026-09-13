import { json, type Env } from "../index";
import { roleFor } from "../governance";
import { sha256Hex } from "./contributors";

/**
 * Sign in with GitHub (OAuth web flow). The dashboard sends the visitor to
 * GitHub; GitHub sends them back with a code; the pool swaps it for an
 * access token, reads the login once (the token is dropped), and issues the
 * contributor token as an HttpOnly cookie on this origin. Pages call the
 * API same-origin, so the cookie is the session; the token never reaches
 * page scripts.
 *
 *   GET /auth/github            → GitHub (state in a short-lived cookie)
 *   GET /auth/github/callback   → cookie omc, redirect to ?next (same origin)
 *   GET /auth/me                → {login, role, areas} or 401
 *   POST /auth/logout           → cookie cleared
 *
 * Needs GITHUB_OAUTH_CLIENT_ID (var) and GITHUB_OAUTH_CLIENT_SECRET (secret)
 * of a GitHub OAuth App whose callback URL is <dashboard>/auth/github/callback.
 */

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function cookieOf(request: Request, name: string): string | null {
  const m = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function safeNext(url: URL): string {
  const next = url.searchParams.get("next") ?? "/contribute";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/contribute";
}

export async function handleAuthStart(url: URL, env: Env): Promise<Response> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) return json({ error: "sign-in with GitHub is not configured (GITHUB_OAUTH_CLIENT_ID); use a token on the Contributors page" }, 501);
  const state = crypto.randomUUID();
  const redirect = `${url.origin}/auth/github/callback`;
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  gh.searchParams.set("redirect_uri", redirect);
  gh.searchParams.set("state", state);
  gh.searchParams.set("scope", "read:user");
  const headers = new Headers({ location: gh.toString() });
  headers.append("set-cookie", cookie("omc_state", `${state}:${encodeURIComponent(safeNext(url))}`, 600, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

export async function handleAuthCallback(url: URL, request: Request, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookieOf(request, "omc_state");
  if (!code || !state || !saved || !saved.startsWith(`${state}:`)) return json({ error: "sign-in state mismatch; start again" }, 400);
  const next = decodeURIComponent(saved.slice(state.length + 1)) || "/contribute";
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return json({ error: "sign-in with GitHub is not configured" }, 501);
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "omarchy-pool" },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/github/callback` }),
  });
  const t = (await tok.json()) as { access_token?: string; error?: string };
  if (!t.access_token) return json({ error: `GitHub did not issue a token (${t.error ?? tok.status})` }, 502);
  const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "omarchy-pool" } });
  if (!res.ok) return json({ error: `GitHub user lookup failed (HTTP ${res.status})` }, 502);
  const u = (await res.json()) as { login: string; name?: string; avatar_url?: string; type?: string };
  if (!u.login || u.type === "Bot") return json({ error: "a user account is required" }, 400);
  // The contributor token: a new one per sign-in, hashed at rest; the old
  // one (if any) stops working — the same as POST /factory/register.
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  // A browser session (oms_): separate from the CLI / worker token (omc_),
  // which signing in must not replace. A first sign-in registers the
  // contributor with a token they can replace from the Contributors page.
  const token = `oms_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const { role, areas } = await roleFor(env, u.login);
  await env.DB.prepare(
    `INSERT INTO contributors (login, name, avatar_url, token_hash, session_hash, role, areas) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, session_hash = excluded.session_hash,
       role = excluded.role, areas = excluded.areas, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(u.login, u.name ?? null, u.avatar_url ?? null, await sha256Hex(`unset:${crypto.randomUUID()}`), await sha256Hex(token), role, JSON.stringify(areas))
    .run();
  const headers = new Headers({ location: next });
  headers.append("set-cookie", cookie("omc", token, 30 * 86400, url.protocol === "https:"));
  headers.append("set-cookie", cookie("omc_state", "", 0, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

export function handleLogout(url: URL): Response {
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", cookie("omc", "", 0, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}
