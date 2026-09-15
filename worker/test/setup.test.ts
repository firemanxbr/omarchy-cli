/**
 * Joining a ring in one command: the script the pool serves carries this
 * deployment's addresses and no placeholder; the pacman.d include lists
 * exactly the databases the ring's head release serves for the
 * architecture, optional sources only when asked.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

async function get(path: string): Promise<{ status: number; text: string; type: string | null }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") };
}

describe("GET /setup", () => {
  it("is a readable shell script with the pool's own addresses in it", async () => {
    const r = await get("/setup");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/plain");
    expect(r.text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(r.text).toContain("curl -fsSL http://pool.test/setup | sudo bash -s -- --ring stable");
    expect(r.text).toContain('API="http://pool.test/api/v1"');
    expect(r.text).not.toContain("__API__");
    expect(r.text).not.toContain("__POOL__");
    // It never upgrades on its own.
    expect(r.text).not.toMatch(/^\s*(sudo )?pacman -Syu/m);
    expect(r.text).toContain("Now run:  sudo pacman -Syu");
  });
});

describe("GET /api/v1/pacman.conf", () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO releases (id, ring, seq) VALUES (901, 'stable', 7)"),
      env.DB.prepare("INSERT INTO ring_heads (ring, release_id) VALUES ('stable', 901)"),
      env.DB.prepare(`INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES
        (901, 'omarchy-core-stable', 'x86_64', 'db', 'k1', 1), (901, 'omarchy-core-stable', 'x86_64', 'files', 'k2', 1),
        (901, 'omarchy-extra-stable', 'x86_64', 'db', 'k3', 1), (901, 'omarchy-chaotic-stable', 'x86_64', 'db', 'k4', 1),
        (901, 'omarchy-core-stable', 'aarch64', 'db', 'k5', 1), (901, 'omarchy-alarm-stable', 'aarch64', 'db', 'k6', 1),
        (901, 'omarchy-packages-stable', 'aarch64', 'db', 'k7', 1), (901, 'omarchy-factory-stable', 'aarch64', 'db', 'k8', 1)`),
    ]);
  });
  it("lists the ring's databases for the architecture, the optional ones only when asked", async () => {
    const x = await get("/api/v1/pacman.conf?ring=stable&arch=x86_64");
    expect(x.status).toBe(200);
    expect(x.type).toContain("text/plain");
    expect(x.text).toContain("release #7");
    expect(x.text).toContain("[omarchy-core-stable]\nSigLevel = Required DatabaseRequired\nServer = ");
    expect(x.text).toContain("[omarchy-extra-stable]");
    expect(x.text).not.toContain("[omarchy-chaotic-stable]");
    expect(x.text).toContain("http://pool.test/setup rewrites this file");
    // Priority is order: core before extra; with the optional source asked for, it comes last.
    expect(x.text.indexOf("[omarchy-core-stable]")).toBeLessThan(x.text.indexOf("[omarchy-extra-stable]"));
    expect(x.text).not.toContain("files");
    const withChaotic = await get("/api/v1/pacman.conf?ring=stable&arch=x86_64&with=chaotic");
    expect(withChaotic.text).toContain("[omarchy-chaotic-stable]");
    expect(withChaotic.text.indexOf("[omarchy-extra-stable]")).toBeLessThan(withChaotic.text.indexOf("[omarchy-chaotic-stable]"));
    const arm = await get("/api/v1/pacman.conf?ring=stable&arch=aarch64");
    expect(arm.text).toContain("[omarchy-alarm-stable]");
    expect(arm.text).not.toContain("[omarchy-extra-stable]");
    // Omarchy's own packages and the factory's builds sit above Arch's, alarm last — the order [omarchy] has on an Omarchy install.
    const order = ["[omarchy-packages-stable]", "[omarchy-factory-stable]", "[omarchy-core-stable]", "[omarchy-alarm-stable]"].map((r) => arm.text.indexOf(r));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("says so when the ring has no release, or the ring or arch is unknown", async () => {
    expect((await get("/api/v1/pacman.conf?ring=rc&arch=x86_64")).status).toBe(404);
    expect((await get("/api/v1/pacman.conf?ring=nightly&arch=x86_64")).status).toBe(404);
    expect((await get("/api/v1/pacman.conf?ring=stable&arch=riscv64")).status).toBe(404);
  });
});
