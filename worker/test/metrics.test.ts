import { describe, expect, it } from "vitest";
import { RULES } from "../src/scheduler";

describe("metrics", () => {
  it("is no longer a workflow rule: the brain snapshots itself", () => {
    expect(RULES.some((r) => r.workflow === "metrics.yml")).toBe(false);
    expect(RULES.find((r) => r.workflow === "security")?.job?.kind).toBe("security");
  });
});

import { env } from "cloudflare:test";
import { anyTwice, snapshotMetrics } from "../src/metrics";

describe("any packages stored once per architecture", () => {
  it("counts the names, the objects and the second copies' bytes", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES
        ('1', 'fonts', '1-1', 'any', 'fonts-1-1-any.pkg.tar.zst', 100, 1, 0, '{}', 'extra', 'extra/x86_64/fonts', 'x86_64'),
        ('2', 'fonts', '1-1', 'any', 'fonts-1-1-any.pkg.tar.zst', 120, 1, 0, '{}', 'alarm', 'alarm/aarch64/fonts', 'aarch64'),
        ('3', 'docs', '2-1', 'any', 'docs-2-1-any.pkg.tar.zst', 50, 1, 0, '{}', 'extra', 'extra/x86_64/docs', 'x86_64'),
        ('4', 'zlib', '1-1', 'x86_64', 'zlib-1-1-x86_64.pkg.tar.zst', 30, 1, 0, '{}', 'core', 'core/x86_64/zlib', 'x86_64')`),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'stable', id FROM packages"),
    ]);
    expect(await anyTwice(env, "stable")).toEqual({ names: 2, objects: 3, bytes: 270, twice: 1, extra_bytes: 100 });
    expect(await anyTwice(env, "edge")).toEqual({ names: 0, objects: 0, bytes: 0, twice: 0, extra_bytes: 0 });
    // The snapshot carries it.
    await snapshotMetrics(env, new Date("2026-09-14T00:00:00Z"));
    const snap = await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
    expect(JSON.parse(snap!.payload).any.stable.twice).toBe(1);
  });
});
