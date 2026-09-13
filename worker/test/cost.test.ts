import { describe, expect, it } from "vitest";
import { estimateCost, PRICES } from "../src/cost";
import type { Env } from "../src/index";

// Cloudflare's analytics for a month like September 2026 so far, stubbed.
// The month so far, and the last six hours (the rate the projection uses).
const analytics = {
  data: { viewer: {
    month: [{
      d1: [{ sum: { rowsRead: 17_000_000_000, rowsWritten: 20_000_000 }, dimensions: { databaseId: "x" } }],
      r2s: [{ max: { payloadSize: 275e9, metadataSize: 5e6 }, dimensions: { bucketName: "omarchy-packages" } }],
      r2o: [{ sum: { requests: 70_000 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 150_000 }, dimensions: { actionType: "HeadObject" } }],
      w: [{ sum: { requests: 132_000 }, quantiles: { cpuTimeP50: 1700 }, dimensions: { scriptName: "omarchy-repo" } }],
    }],
    recent: [{
      d1: [{ sum: { rowsRead: 250_000_000, rowsWritten: 200_000 }, dimensions: { databaseId: "x" } }],
      r2o: [{ sum: { requests: 500 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 2_000 }, dimensions: { actionType: "HeadObject" } }],
      w: [{ sum: { requests: 4_000 }, quantiles: { cpuTimeP50: 1700 }, dimensions: { scriptName: "omarchy-repo" } }],
    }],
  } },
};
const fetcher = (async (url: string | URL | Request) =>
  new Response(JSON.stringify(String(url).includes("/d1/database/") ? { result: { file_size: 5.1e8 } } : analytics), { status: 200 })) as unknown as typeof fetch;
const env = { CLOUDFLARE_ANALYTICS_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_D1_ID: "d" } as unknown as Env;

describe("the bill", () => {
  it("prices the month to date and projects it linearly", async () => {
    const est = await estimateCost(env, new Date("2026-09-13T16:00:00Z"), fetcher);
    expect(est.month).toBe("2026-09");
    expect(est.day_of_month).toBe(13);
    expect(est.days_in_month).toBe(30);
    const by = Object.fromEntries(est.lines.map((l) => [l.item, l]));
    expect(by["Workers Paid plan"].projected_usd).toBe(PRICES.plan);
    // 17 B rows read so far (25 B included: nothing yet); at 1 B/day for the
    // 17.33 days left ≈ 34.3 B → 9.3 B over → ≈ US$ 9.3. The expensive days
    // behind are not averaged forward.
    expect(by["D1 rows read"].month_to_date_usd).toBe(0);
    expect(by["D1 rows read"].projected_usd).toBeCloseTo(9.33, 1);
    // 20 M rows written + 0.8 M/day × 17.33 ≈ 34 M, 50 M included: nothing
    expect(by["D1 rows written"].projected_usd).toBe(0);
    // 275 GB of R2, 10 free: (265 × 0.015) ≈ 3.98 for the month
    expect(by["R2 storage"].projected_usd).toBeCloseTo(3.98, 1);
    expect(est.projected_usd).toBeCloseTo(5 + 9.33 + 3.98, 0);
    expect(est.guard).toBe(false);
  });

  it("raises the guard when the projection reaches the budget", async () => {
    const heavy = JSON.parse(JSON.stringify(analytics));
    heavy.data.viewer.month[0].d1[0].sum.rowsRead = 200_000_000_000;
    const f = (async () => new Response(JSON.stringify(heavy), { status: 200 })) as unknown as typeof fetch;
    const est = await estimateCost({ ...env, CLOUDFLARE_D1_ID: undefined } as unknown as Env, new Date("2026-09-13T16:00:00Z"), f);
    expect(est.guard).toBe(true);
    expect(est.month_to_date_usd).toBeGreaterThan(25);
  });
});
