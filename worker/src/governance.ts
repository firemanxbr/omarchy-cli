/**
 * Governance comes from the repository, not from the database. The file
 * factory/MAINTAINERS.toml on main lists the maintainers; changing it is a
 * pull request another maintainer approves. The brain reads main every ten
 * minutes and applies it: a login listed there is a maintainer, everyone
 * else is a contributor. No areas — every maintainer reviews everything;
 * what a package is about is its category (categories.ts), not who may
 * approve it. Nothing here grants a role by hand.
 */
import { parse } from "smol-toml";
import type { Env } from "./index";

export const GOVERNANCE_FILE = "factory/MAINTAINERS.toml";
const RAW = `https://raw.githubusercontent.com/firemanxbr/omarchy-pool/main/${GOVERNANCE_FILE}`;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Parses the governance file into the list of maintainers; throws on anything
 * else. The older form — `[groups.<name>]` tables, each with a list — is
 * read as the union of its lists, so the file and the brain may change in
 * either order.
 */
export function parseGovernance(text: string): string[] {
  const doc = parse(text) as { maintainers?: unknown; groups?: Record<string, { maintainers?: unknown }> };
  const lists: unknown[] = [];
  if (doc.maintainers !== undefined) lists.push(doc.maintainers);
  else if (doc.groups && typeof doc.groups === "object") for (const g of Object.values(doc.groups)) lists.push(g?.maintainers);
  if (lists.length === 0) throw new Error("no `maintainers` list");
  const out = new Set<string>();
  for (const l of lists) {
    if (!Array.isArray(l) || !l.every((m) => typeof m === "string" && LOGIN.test(m))) throw new Error("maintainers must be a list of GitHub logins");
    for (const m of l as string[]) out.add(m);
  }
  if (out.size === 0) throw new Error("no maintainer listed");
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The maintainers as last applied. */
export async function maintainersOf(env: Env): Promise<{ login: string; since: string }[]> {
  const rows = await env.DB.prepare("SELECT login, since FROM factory_maintainers ORDER BY login").all<{ login: string; since: string }>();
  return rows.results;
}

/** The role the governance file gives a login: maintainer if listed, else contributor. */
export async function roleFor(env: Env, login: string): Promise<"maintainer" | "contributor"> {
  const row = await env.DB.prepare("SELECT 1 AS yes FROM factory_maintainers WHERE login = ?").bind(login).first<{ yes: number }>();
  return row ? "maintainer" : "contributor";
}

/**
 * Reads the file on main and applies it when it changed: the list replaced,
 * every registered contributor's role recomputed, each change a `role` line
 * in the journal. Returns a one-line log.
 */
export async function syncGovernance(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(RAW, { headers: { "user-agent": "omarchy-pool" }, cf: { cacheTtl: 120 } } as RequestInit);
  if (!res.ok) throw new Error(`${GOVERNANCE_FILE}: HTTP ${res.status}`);
  const text = await res.text();
  const hash = await sha256Hex(text);
  const known = await env.DB.prepare("SELECT value FROM settings WHERE key = 'governance_sha256'").first<{ value: string }>();
  if (known?.value === hash) return "governance: unchanged";
  return applyGovernance(env, parseGovernance(text), hash);
}

export async function applyGovernance(env: Env, maintainers: string[], hash: string): Promise<string> {
  // `since` survives for a login that stays listed; a newcomer gets today.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM factory_maintainers WHERE login NOT IN (${maintainers.map(() => "?").join(", ") || "''"})`).bind(...maintainers),
    ...maintainers.map((m) => env.DB.prepare("INSERT OR IGNORE INTO factory_maintainers (login) VALUES (?)").bind(m)),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('governance_sha256', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(hash),
  ];
  await env.DB.batch(stmts);

  const people = await env.DB.prepare("SELECT login, role FROM contributors").all<{ login: string; role: string }>();
  const changes: string[] = [];
  for (const p of people.results) {
    const role = maintainers.includes(p.login) ? "maintainer" : "contributor";
    if (p.role === role) continue;
    await env.DB.prepare("UPDATE contributors SET role = ?, areas = NULL WHERE login = ?").bind(role, p.login).run();
    const line = `${p.login} is ${role} (${GOVERNANCE_FILE})`;
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('role', NULL, 'factory', 'ok', ?, ?)")
      .bind(line, JSON.stringify({ login: p.login, role, was: { role: p.role }, source: GOVERNANCE_FILE }))
      .run();
    changes.push(line);
  }
  return `governance: ${maintainers.length} maintainer(s) applied${changes.length ? " — " + changes.join("; ") : ""}`;
}
