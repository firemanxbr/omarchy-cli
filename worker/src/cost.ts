/**
 * What this pool costs, estimated every day from Cloudflare's own analytics
 * (GraphQL, an API token with Analytics: Read as the Worker secret
 * CLOUDFLARE_ANALYTICS_TOKEN) priced at the Workers Paid rates below, and a
 * guard: when the month's projected charges reach the budget, the scheduler
 * stops creating the jobs that write (sync, promote, render, security,
 * enqueue) until the estimate is back under it. Reads keep working; the
 * pool keeps serving. Budget review of 2026-09-13: the card is capped at
 * US$ 30 a month.
 */
import type { Env } from "./index";

/** Workers Paid, US$, 2026. Included quotas are per month. */
export const PRICES = {
  plan: 5,
  requests: { included: 10_000_000, per_million: 0.3 },
  cpu_ms: { included: 30_000_000, per_million: 0.02 },
  d1_rows_read: { included: 25_000_000_000, per_million: 0.001 },
  d1_rows_written: { included: 50_000_000, per_million: 1.0 },
  d1_storage_gb: { included: 5, per_gb: 0.75 },
  r2_storage_gb: { included: 10, per_gb: 0.015 },
  r2_class_a: { included: 1_000_000, per_million: 4.5 },
  r2_class_b: { included: 10_000_000, per_million: 0.36 },
};

/** The line the guard trips at, and the line the daily report warns at. */
export const BUDGET_GUARD_USD = 25;
export const BUDGET_WARN_USD = 15;

const CLASS_A = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "ListObjects", "PutBucket", "DeleteObject", "PutBucketLifecycleConfiguration", "ListBuckets"]);

export interface CostLine {
  item: string;
  used: number;
  unit: string;
  included: number;
  month_to_date_usd: number;
  projected_usd: number;
}

export interface CostEstimate {
  month: string;
  day_of_month: number;
  days_in_month: number;
  month_to_date_usd: number;
  projected_usd: number;
  lines: CostLine[];
  guard: boolean;
}

function overage(used: number, included: number, perUnit: number, unitSize: number): number {
  return Math.max(0, used - included) / unitSize * perUnit;
}

interface Usage {
  rowsRead: number;
  rowsWritten: number;
  classA: number;
  classB: number;
  requests: number;
  cpuMs: number;
}

interface Analytics {
  d1?: { sum: { rowsRead: number; rowsWritten: number }; dimensions: { databaseId: string } }[];
  r2s?: { max: { payloadSize: number; metadataSize: number }; dimensions: { bucketName: string } }[];
  r2o?: { sum: { requests: number }; dimensions: { actionType: string } }[];
  w?: { sum: { requests: number }; quantiles: { cpuTimeP50: number }; dimensions: { scriptName: string } }[];
}

const RATE_WINDOW_HOURS = 6;

function usageOf(a: Analytics): Usage {
  return {
    rowsRead: (a.d1 ?? []).reduce((n, r) => n + r.sum.rowsRead, 0),
    rowsWritten: (a.d1 ?? []).reduce((n, r) => n + r.sum.rowsWritten, 0),
    classA: (a.r2o ?? []).filter((r) => CLASS_A.has(r.dimensions.actionType)).reduce((n, r) => n + r.sum.requests, 0),
    classB: (a.r2o ?? []).filter((r) => !CLASS_A.has(r.dimensions.actionType)).reduce((n, r) => n + r.sum.requests, 0),
    requests: (a.w ?? []).reduce((n, r) => n + r.sum.requests, 0),
    cpuMs: (a.w ?? []).reduce((n, r) => n + (r.sum.requests * (r.quantiles.cpuTimeP50 ?? 0)) / 1000, 0),
  };
}

/**
 * The estimate for the current month: what the analytics say was used so
 * far, priced; and a projection that adds the *current* rate — the last
 * six hours, scaled — for the days left, so a fix shows in the next
 * estimate instead of being averaged with the expensive days before it.
 */
export async function estimateCost(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<CostEstimate> {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN is not set");
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const elapsedDays = (now.getTime() - Date.parse(start)) / 86400000;
  const remainingDays = Math.max(0, daysInMonth - elapsedDays);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_HOURS * 3600000).toISOString();
  const acc = `accounts(filter: {accountTag: "${account}"})`;
  const block = (since: string) => `
    d1: d1AnalyticsAdaptiveGroups(limit: 20, filter: {datetime_geq: "${since}"}) { sum { rowsRead rowsWritten } dimensions { databaseId } }
    r2o: r2OperationsAdaptiveGroups(limit: 100, filter: {datetime_geq: "${since}"}) { sum { requests } dimensions { actionType } }
    w: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: "${since}"}) { sum { requests } quantiles { cpuTimeP50 } dimensions { scriptName } }`;
  const q = `{ viewer {
    month: ${acc} { ${block(start)}
      r2s: r2StorageAdaptiveGroups(limit: 20, filter: {datetime_geq: "${new Date(now.getTime() - 86400000).toISOString()}"}) { max { payloadSize metadataSize } dimensions { bucketName } } }
    recent: ${acc} { ${block(windowStart)} }
  } }`;
  const res = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const body = (await res.json()) as { data?: { viewer?: { month?: Analytics[]; recent?: Analytics[] } }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  const a: Analytics = body.data?.viewer?.month?.[0] ?? {};
  const month = usageOf(a);
  const rate = usageOf(body.data?.viewer?.recent?.[0] ?? {});
  const perDay = 24 / RATE_WINDOW_HOURS;
  const project = (k: keyof Usage) => month[k] + rate[k] * perDay * remainingDays;
  const { rowsRead, rowsWritten, classA, classB, requests, cpuMs } = month;
  const r2Bytes = (a.r2s ?? []).reduce((n, r) => n + r.max.payloadSize + r.max.metadataSize, 0);
  // The database file size comes from the D1 API (the token that reads
  // analytics reads that too); unknown counts as nothing, well under 5 GB.
  let d1Gb = 0;
  if (env.CLOUDFLARE_D1_ID) {
    const d1 = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${env.CLOUDFLARE_D1_ID}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ result?: { file_size?: number } }>) : null))
      .catch(() => null);
    d1Gb = (d1?.result?.file_size ?? 0) / 1e9;
  }
  const r2Gb = r2Bytes / 1e9;

  const line = (item: string, used: number, unit: string, included: number, mtd: number, projected: number): CostLine => ({ item, used, unit, included, month_to_date_usd: round(mtd), projected_usd: round(projected) });
  const lines: CostLine[] = [
    line("Workers Paid plan", 1, "month", 0, PRICES.plan, PRICES.plan),
    line("Workers requests", requests, "requests", PRICES.requests.included, overage(requests, PRICES.requests.included, PRICES.requests.per_million, 1e6), overage(project("requests"), PRICES.requests.included, PRICES.requests.per_million, 1e6)),
    line("Workers CPU", cpuMs, "CPU-ms", PRICES.cpu_ms.included, overage(cpuMs, PRICES.cpu_ms.included, PRICES.cpu_ms.per_million, 1e6), overage(project("cpuMs"), PRICES.cpu_ms.included, PRICES.cpu_ms.per_million, 1e6)),
    line("D1 rows read", rowsRead, "rows", PRICES.d1_rows_read.included, overage(rowsRead, PRICES.d1_rows_read.included, PRICES.d1_rows_read.per_million, 1e6), overage(project("rowsRead"), PRICES.d1_rows_read.included, PRICES.d1_rows_read.per_million, 1e6)),
    line("D1 rows written", rowsWritten, "rows", PRICES.d1_rows_written.included, overage(rowsWritten, PRICES.d1_rows_written.included, PRICES.d1_rows_written.per_million, 1e6), overage(project("rowsWritten"), PRICES.d1_rows_written.included, PRICES.d1_rows_written.per_million, 1e6)),
    line("D1 storage", d1Gb, "GB", PRICES.d1_storage_gb.included, overage(d1Gb, PRICES.d1_storage_gb.included, PRICES.d1_storage_gb.per_gb, 1), overage(d1Gb, PRICES.d1_storage_gb.included, PRICES.d1_storage_gb.per_gb, 1)),
    line("R2 storage", r2Gb, "GB", PRICES.r2_storage_gb.included, overage(r2Gb, PRICES.r2_storage_gb.included, PRICES.r2_storage_gb.per_gb, 1) * (dayOfMonth / daysInMonth), overage(r2Gb, PRICES.r2_storage_gb.included, PRICES.r2_storage_gb.per_gb, 1)),
    line("R2 class A operations", classA, "requests", PRICES.r2_class_a.included, overage(classA, PRICES.r2_class_a.included, PRICES.r2_class_a.per_million, 1e6), overage(project("classA"), PRICES.r2_class_a.included, PRICES.r2_class_a.per_million, 1e6)),
    line("R2 class B operations", classB, "requests", PRICES.r2_class_b.included, overage(classB, PRICES.r2_class_b.included, PRICES.r2_class_b.per_million, 1e6), overage(project("classB"), PRICES.r2_class_b.included, PRICES.r2_class_b.per_million, 1e6)),
  ];
  const mtd = round(lines.reduce((n, l) => n + l.month_to_date_usd, 0));
  const projected = round(lines.reduce((n, l) => n + l.projected_usd, 0));
  return { month: start.slice(0, 7), day_of_month: dayOfMonth, days_in_month: daysInMonth, month_to_date_usd: mtd, projected_usd: projected, lines, guard: projected >= BUDGET_GUARD_USD || mtd >= BUDGET_GUARD_USD };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Is the guard up? (The scheduler asks before creating a job that writes.) */
export async function costGuard(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_guard'").first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * The daily cost job: estimate, record a `cost` event (the dashboard's tile
 * and the daily report read the latest), raise or lower the guard.
 */
export async function dailyCost(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_checked'").first<{ value: string }>();
  if (last?.value === day) return "cost: estimated today";
  const est = await estimateCost(env, now, fetcher);
  const guardBefore = await costGuard(env);
  const status = est.guard ? "error" : est.projected_usd >= BUDGET_WARN_USD ? "warn" : "ok";
  const summary = `Cloudflare, ${est.month}: US$ ${est.month_to_date_usd.toFixed(2)} so far, US$ ${est.projected_usd.toFixed(2)} projected${est.guard ? ` — over the US$ ${BUDGET_GUARD_USD} guard: jobs that write are paused` : ""}`;
  const stmts = [
    env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('cost', ?, ?, ?)").bind(status, summary, JSON.stringify(est)),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_checked', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(day),
  ];
  if (est.guard && !guardBefore) {
    stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_guard', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(summary));
  } else if (!est.guard && guardBefore) {
    stmts.push(env.DB.prepare("DELETE FROM settings WHERE key = 'cost_guard'"));
  }
  await env.DB.batch(stmts);
  return `cost: ${summary}`;
}
