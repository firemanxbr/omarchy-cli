/**
 * The dashboard's pages, served by the Worker's own fetch handler: every
 * door and every detail page answers, carries the shared frame (the three
 * doors in the navigation, the footer), keeps the text the e2e script and
 * the old addresses rely on, and leaves no template placeholder behind.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const PAGES = ["/", "/factory", "/contribute", "/pipeline", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/governance", "/packages", "/package/zlib", "/security", "/status", "/journal", "/review", "/user/someone", "/api", "/diff"];

describe("dashboard pages", () => {
  it("every page is served with the shared frame and no placeholder left behind", async () => {
    for (const path of PAGES) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("omarchy-pool");
      for (const door of ['href="/"', 'href="/factory"', 'href="/pipeline"', 'href="/docs"']) expect(html, `${path} nav`).toContain(door);
      expect(html, path).toContain("built for Omarchy");
      expect(html, path).not.toMatch(/__[A-Z_]+__/);
      expect(html, path).not.toContain("${");
    }
  });

  it("the Pool keeps its headline, the Factory serves the contributors, the Pipeline draws the living system", async () => {
    expect(await (await get("/")).text()).toContain("tested before they reach you");
    const factory = await (await get("/factory")).text();
    expect(factory).toContain("Sign in with GitHub");
    expect(factory).toContain('id="pkg-form"');
    expect(await (await get("/contribute")).text()).toContain('id="pkg-form"');
    const pipeline = await (await get("/pipeline")).text();
    expect(pipeline).toContain('data-live="verified-today"');
    expect(pipeline).toContain("sponsor@firemanxbr.org");
    expect(pipeline).toContain('id="staged"');
  });

  it("the documentation hub carries the five stages and the old chapter addresses still redirect", async () => {
    const docs = await (await get("/docs")).text();
    for (const stage of ["sync", "pin", "promote", "render", "serve"]) expect(docs).toContain(`data-stage="${stage}"`);
    const res = await get("/how-it-works");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://pool.test/docs/how-it-works");
  });
});
