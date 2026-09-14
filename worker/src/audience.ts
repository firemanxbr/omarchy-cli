/**
 * Who uses the pool: the machines that fetched a ring's database, counted
 * once a day from Cloudflare's zone analytics — distinct client addresses on
 * the pool's host for `/<arch>/omarchy-*-<ring>.db` over one UTC day. No
 * accounts, no cookies, nothing kept per request: one number per day, per
 * ring and per architecture, as an `audience` event. An address is a machine
 * most of the time; a NAT hides several and a laptop on the move counts
 * twice, so the dashboard says "about". The analytics token must carry
 * Zone · Analytics · Read on the zone (CLOUDFLARE_ZONE_ID); without it the
 * day is skipped once and the scheduler's log says why.
 */
import type { Env } from "./index";

export interface Audience {
  /** The UTC day measured, YYYY-MM-DD. */
  day: string;
  /** Distinct addresses that fetched any ring database. */
  machines: number;
  by_ring: Record<string, number>;
  by_arch: Record<string, number>;
  /** Database fetches that day, and the bytes they moved. */
  requests: number;
  bytes: number;
  /** True when Cloudflare sampled the day (counts are then estimates). */
  sampled: boolean;
}

/** Up to this many distinct addresses per query; beyond it the count is a floor. */
export const AUDIENCE_LIMIT = 10000;

interface Rows { count?: number; sum?: { edgeResponseBytes?: number }; avg?: { sampleInterval?: number }; dimensions?: { clientIP?: string } }
interface Zone { all?: Rows[]; stable?: Rows[]; rc?: Rows[]; edge?: Rows[]; x86_64?: Rows[]; aarch64?: Rows[]; totals?: Rows[] }

/** One day of the pool's audience, from the zone's request analytics. */
export async function measureAudience(env: Env, day: string, fetcher: typeof fetch = fetch): Promise<Audience> {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN is not set");
  if (!env.CLOUDFLARE_ZONE_ID) throw new Error("CLOUDFLARE_ZONE_ID is not set");
  const host = new URL(env.POOL_URL).host;
  const from = `${day}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString().slice(0, 19) + "Z";
  const base = `datetime_geq: "${from}", datetime_lt: "${to}", clientRequestHTTPHost: "${host}"`;
  const ips = (path: string, alias: string) =>
    `${alias}: httpRequestsAdaptiveGroups(limit: ${AUDIENCE_LIMIT}, filter: {${base}, clientRequestPath_like: "${path}"}) { count dimensions { clientIP } }`;
  const q = `{ viewer { zones(filter: {zoneTag: "${env.CLOUDFLARE_ZONE_ID}"}) {
    totals: httpRequestsAdaptiveGroups(limit: 1, filter: {${base}, clientRequestPath_like: "%.db"}) { count sum { edgeResponseBytes } avg { sampleInterval } }
    ${ips("%.db", "all")}
    ${ips("%-stable.db", "stable")}
    ${ips("%-rc.db", "rc")}
    ${ips("%-edge.db", "edge")}
    ${ips("/x86_64/%.db", "x86_64")}
    ${ips("/aarch64/%.db", "aarch64")}
  } } }`;
  const res = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const body = (await res.json()) as { data?: { viewer?: { zones?: Zone[] } }; errors?: { message: string }[] };
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(/zone\.analytics\.read/.test(msg) ? `the analytics token needs Zone · Analytics · Read on the zone: ${msg}` : msg);
  }
  const z = body.data?.viewer?.zones?.[0] ?? {};
  const n = (rows?: Rows[]) => (rows ?? []).length;
  const t = z.totals?.[0];
  return {
    day,
    machines: n(z.all),
    by_ring: { stable: n(z.stable), rc: n(z.rc), edge: n(z.edge) },
    by_arch: { x86_64: n(z.x86_64), aarch64: n(z.aarch64) },
    requests: t?.count ?? 0,
    bytes: t?.sum?.edgeResponseBytes ?? 0,
    sampled: (t?.avg?.sampleInterval ?? 1) > 1,
  };
}

/**
 * Once a day, after 00:30 UTC: yesterday's audience, recorded as an event.
 * A failure is recorded in the settings row too, so a token without the
 * permission is reported once a day, not every ten minutes.
 */
export async function dailyAudience(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const day = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'audience_checked'").first<{ value: string }>();
  if (last?.value === day) return "audience: measured today";
  const mark = env.DB.prepare("INSERT INTO settings (key, value) VALUES ('audience_checked', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(day);
  let a: Audience;
  try {
    a = await measureAudience(env, day, fetcher);
  } catch (e) {
    await mark.run();
    return `audience: not measured for ${day} — ${String(e instanceof Error ? e.message : e)}`;
  }
  const summary = `${day}: about ${a.machines.toLocaleString("en-US")} machines fetched a ring database (stable ${a.by_ring.stable} · rc ${a.by_ring.rc} · edge ${a.by_ring.edge}; x86_64 ${a.by_arch.x86_64} · aarch64 ${a.by_arch.aarch64})${a.sampled ? " — sampled" : ""}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('audience', 'ok', ?, ?)").bind(summary, JSON.stringify(a)),
    mark,
  ]);
  return `audience: ${summary}`;
}
