/**
 * Governance comes from the repository, not from the database. The file
 * factory/MAINTAINERS.toml on main names the groups and their maintainers;
 * changing it is a pull request another maintainer approves. The brain
 * reads main every ten minutes and applies it: a login listed under a group
 * is a maintainer of that group, everyone else is a contributor. Nothing
 * here grants a role by hand.
 */
import { parse } from "smol-toml";
import type { Env } from "./index";

export const GOVERNANCE_FILE = "factory/MAINTAINERS.toml";
const RAW = `https://raw.githubusercontent.com/firemanxbr/omarchy-pool/main/${GOVERNANCE_FILE}`;

export interface Group {
  name: string;
  description: string;
  maintainers: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Parses the governance file; throws on anything that is not a group with a list of logins. */
export function parseGovernance(text: string): Group[] {
  const doc = parse(text) as { groups?: Record<string, { description?: unknown; maintainers?: unknown }> };
  if (!doc.groups || typeof doc.groups !== "object") throw new Error("no [groups.<name>] tables");
  const out: Group[] = [];
  for (const [name, g] of Object.entries(doc.groups)) {
    if (!NAME.test(name)) throw new Error(`group name '${name}' is not [a-z0-9-]`);
    if (!Array.isArray(g.maintainers) || !g.maintainers.every((m) => typeof m === "string" && LOGIN.test(m))) {
      throw new Error(`group '${name}': maintainers must be a list of GitHub logins`);
    }
    const maintainers = [...new Set(g.maintainers as string[])];
    if (maintainers.length === 0) throw new Error(`group '${name}' has no maintainer`);
    out.push({ name, description: typeof g.description === "string" ? g.description : "", maintainers });
  }
  if (out.length === 0) throw new Error("no groups");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The groups as last applied. */
export async function groupsOf(env: Env): Promise<Group[]> {
  const rows = await env.DB.prepare("SELECT name, description, maintainers FROM factory_groups ORDER BY name").all<{ name: string; description: string; maintainers: string }>();
  return rows.results.map((r) => ({ ...r, maintainers: JSON.parse(r.maintainers) as string[] }));
}

/** The role and areas the governance file gives a login: maintainer of the groups that list it, else contributor. */
export async function roleFor(env: Env, login: string): Promise<{ role: "maintainer" | "contributor"; areas: string[] }> {
  const areas = (await groupsOf(env)).filter((g) => g.maintainers.includes(login)).map((g) => g.name);
  return areas.length ? { role: "maintainer", areas } : { role: "contributor", areas: [] };
}

/**
 * Reads the file on main and applies it when it changed: groups replaced,
 * every registered contributor's role and areas recomputed, each change a
 * `role` line in the journal. Returns a one-line log.
 */
export async function syncGovernance(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(RAW, { headers: { "user-agent": "omarchy-pool" }, cf: { cacheTtl: 120 } } as RequestInit);
  if (!res.ok) throw new Error(`${GOVERNANCE_FILE}: HTTP ${res.status}`);
  const text = await res.text();
  const hash = await sha256Hex(text);
  const known = await env.DB.prepare("SELECT value FROM settings WHERE key = 'governance_sha256'").first<{ value: string }>();
  if (known?.value === hash) return "governance: unchanged";
  const groups = parseGovernance(text);
  return applyGovernance(env, groups, hash);
}

export async function applyGovernance(env: Env, groups: Group[], hash: string): Promise<string> {
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM factory_groups")];
  for (const g of groups) {
    stmts.push(env.DB.prepare("INSERT INTO factory_groups (name, description, maintainers) VALUES (?, ?, ?)").bind(g.name, g.description, JSON.stringify(g.maintainers)));
  }
  stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES ('governance_sha256', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(hash));
  await env.DB.batch(stmts);

  const people = await env.DB.prepare("SELECT login, role, areas FROM contributors").all<{ login: string; role: string; areas: string | null }>();
  const changes: string[] = [];
  for (const p of people.results) {
    const areas = groups.filter((g) => g.maintainers.includes(p.login)).map((g) => g.name);
    const role = areas.length ? "maintainer" : "contributor";
    const before = p.areas ? (JSON.parse(p.areas) as string[]) : [];
    if (p.role === role && before.join(",") === areas.join(",")) continue;
    await env.DB.prepare("UPDATE contributors SET role = ?, areas = ? WHERE login = ?").bind(role, JSON.stringify(areas), p.login).run();
    const line = `${p.login} is ${role}${areas.length ? " of " + areas.join(", ") : ""} (${GOVERNANCE_FILE})`;
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('role', NULL, 'factory', 'ok', ?, ?)")
      .bind(line, JSON.stringify({ login: p.login, role, areas, was: { role: p.role, areas: before }, source: GOVERNANCE_FILE }))
      .run();
    changes.push(line);
  }
  return `governance: ${groups.length} group(s) applied${changes.length ? " — " + changes.join("; ") : ""}`;
}
