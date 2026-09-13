/**
 * The release logic, end to end inside workerd: packages indexed into a
 * local D1/R2, releases created, promoted, rolled back, edited per
 * architecture, read back paged and per arch, the dependency graph and
 * the overview stats — through the Worker's own fetch handler, with a job
 * token minted the way a claim mints one. Seconds, not the e2e script.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A job token with every scope the pipeline's jobs get, one hour long. */
function job(scopes: string[]): Promise<string> {
  return issueJobToken(env, { t: 1, k: "test", s: scopes, e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
}

const sha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

interface Pkg { name: string; version: string; arch: string; requires?: string[]; provides?: string[]; pkgprovides?: string[] }

/** Puts a fake object in the pool and indexes its manifest, as the sync does. */
async function index(source: string, repoArch: string, p: Pkg, token: string): Promise<string> {
  const filename = `${p.name}-${p.version}-${p.arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(repoArch, filename), bytes);
  const s = sha(`${repoArch}/${filename}`);
  const r = await call("POST", `/packages?source=${source}&arch=${repoArch}`, {
    schema_version: 1, name: p.name, version: p.version, arch: p.arch, sha256: s, filename,
    size_download: bytes.length, size_installed: bytes.length * 3, description: `${p.name} for tests`,
    provides: [p.name, ...(p.provides ?? [])], requires: p.requires ?? [], pkginfo: { provides: p.pkgprovides ?? [] }, files: [`usr/bin/${p.name}`],
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return s;
}

let pool: string;
let edge: string;
let rc: string;
let stable: string;
const shas: Record<string, string> = {};

beforeAll(async () => {
  pool = await job(["pool:write"]);
  edge = await job(["release:edge", "artifacts:*:edge"]);
  rc = await job(["release:rc"]);
  stable = await job(["release:stable"]);
  // x86_64: zlib 1.3, xz 5.8 (needs zlib), curl (needs xz); aarch64: zlib 1.3 and xz 5.8.
  shas["zlib-x86"] = await index("core", "x86_64", { name: "zlib", version: "1:1.3.2-3", arch: "x86_64", provides: ["libz.so=1-64"] }, pool);
  shas["xz-x86"] = await index("core", "x86_64", { name: "xz", version: "5.8.4-1", arch: "x86_64", requires: ["zlib"], provides: ["liblzma.so=5-64"] }, pool);
  shas["curl-x86"] = await index("extra", "x86_64", { name: "curl", version: "8.10.0-1", arch: "x86_64", requires: ["xz", "libz.so=1-64"] }, pool);
  shas["zlib-arm"] = await index("alarm", "aarch64", { name: "zlib", version: "1:1.3.2-3", arch: "aarch64" }, pool);
  shas["xz-arm"] = await index("alarm", "aarch64", { name: "xz", version: "5.8.4-1", arch: "aarch64", requires: ["zlib"] }, pool);
});

describe("POST /releases", () => {
  it("needs a job token with the ring's scope", async () => {
    expect((await call("POST", "/releases", { ring: "edge", add: [shas["zlib-x86"]] })).status).toBe(401);
    expect((await call("POST", "/releases", { ring: "edge", add: [shas["zlib-x86"]] }, rc)).status).toBe(403);
    expect((await call("POST", "/releases", { ring: "nope" }, edge)).status).toBe(403);
  });

  it("creates the first edge release from adds, then a second one on top of it", async () => {
    const r1 = await call("POST", "/releases", { ring: "edge", add: [shas["zlib-x86"], shas["xz-x86"], shas["zlib-arm"]], note: "first" }, edge);
    expect(r1.status).toBe(201);
    expect(r1.json.release.seq).toBe(1);
    expect(r1.json.package_count).toBe(3);
    // The next one starts from the head: the base is copied, the add replaces nothing here.
    const r2 = await call("POST", "/releases", { ring: "edge", add: [shas["curl-x86"], shas["xz-arm"]] }, edge);
    expect(r2.status).toBe(201);
    expect(r2.json.release.parent_id).toBe(r1.json.release.id);
    expect(r2.json.package_count).toBe(5);
    const head = await call("GET", "/releases/edge?fields=summary");
    expect(head.json.release.id).toBe(r2.json.release.id);
    expect(head.json.packages.map((p: any) => `${p.name}/${p.arch}`).sort()).toEqual(["curl/x86_64", "xz/aarch64", "xz/x86_64", "zlib/aarch64", "zlib/x86_64"]);
  });

  it("refuses a sha256 the index does not have", async () => {
    const r = await call("POST", "/releases", { ring: "edge", add: [sha("nowhere")] }, edge);
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/not indexed/);
  });

  it("replaces a same-name package of the same architecture, and removes per architecture", async () => {
    // A newer xz for x86_64 only: the aarch64 xz stays.
    const newer = await index("core", "x86_64", { name: "xz", version: "5.8.5-1", arch: "x86_64", requires: ["zlib"] }, pool);
    const r = await call("POST", "/releases", { ring: "edge", add: [newer], remove_arch: "x86_64" }, edge);
    expect(r.status).toBe(201);
    const x86 = await call("GET", "/releases/edge?fields=summary&arch=x86_64");
    expect(x86.json.packages.find((p: any) => p.name === "xz").version).toBe("5.8.5-1");
    const arm = await call("GET", "/releases/edge?fields=summary&arch=aarch64");
    expect(arm.json.packages.find((p: any) => p.name === "xz").version).toBe("5.8.4-1");
    // Remove curl from x86_64 only (it has no aarch64 row anyway); zlib stays on both.
    const r2 = await call("POST", "/releases", { ring: "edge", remove: ["curl"], remove_arch: "x86_64" }, edge);
    expect(r2.status).toBe(201);
    expect(r2.json.package_count).toBe(4);
    // Remove zlib everywhere.
    const r3 = await call("POST", "/releases", { ring: "edge", remove: ["zlib"] }, edge);
    expect(r3.json.package_count).toBe(2);
    // Put things back for the promotions below.
    const r4 = await call("POST", "/releases", { ring: "edge", add: [shas["zlib-x86"], shas["zlib-arm"], shas["curl-x86"]] }, edge);
    expect(r4.json.package_count).toBe(5);
  });

  it("promotes edge → rc → stable by copying the source ring's head, and rolls back to an earlier release", async () => {
    const edgeHead = (await call("GET", "/releases/edge?fields=summary")).json.release;
    const p1 = await call("POST", "/releases", { ring: "rc", from_ring: "edge", note: "promote" }, rc);
    expect(p1.status).toBe(201);
    expect(p1.json.release.source_id).toBe(edgeHead.id);
    expect(p1.json.release.parent_id).toBeNull();
    expect(p1.json.package_count).toBe(5);
    const p2 = await call("POST", "/releases", { ring: "stable", from_ring: "rc" }, stable);
    expect(p2.status).toBe(201);
    expect(p2.json.release.source_id).toBe(p1.json.release.id);
    // rc moves on: xz dropped. stable still serves it.
    const p3 = await call("POST", "/releases", { ring: "rc", remove: ["xz"] }, rc);
    expect(p3.json.package_count).toBe(3);
    // Roll rc back to its first release: a new release whose selection equals the older one.
    const rb = await call("POST", "/releases", { ring: "rc", from_release_id: p1.json.release.id, note: "rollback" }, rc);
    expect(rb.status).toBe(201);
    expect(rb.json.release.seq).toBe(3);
    expect(rb.json.release.source_id).toBe(p1.json.release.id);
    expect(rb.json.release.parent_id).toBe(p3.json.release.id);
    expect(rb.json.package_count).toBe(5);
    const hist = await call("GET", "/releases/rc/history");
    expect(hist.json.releases.map((r: any) => r.seq)).toEqual([3, 2, 1]);
    expect(hist.json.releases[0].is_head).toBe(1);
    // The wrong scope for the target ring is refused even when from_ring is allowed.
    expect((await call("POST", "/releases", { ring: "stable", from_ring: "rc" }, rc)).status).toBe(403);
    expect((await call("POST", "/releases", { ring: "rc", from_release_id: 9999 }, rc)).status).toBe(404);
    expect((await call("POST", "/releases", { ring: "rc", from_ring: "nope" }, rc)).status).toBe(400);
  });
});

describe("GET /releases/:ring/diff", () => {
  it("lists what a release changed against its parent, or against any earlier one, per architecture", async () => {
    // rc: release A (5 pkgs) → B (xz removed, 3) → C (rollback to A, 5).
    const hist = (await call("GET", "/releases/rc/history")).json.releases;
    const [c, b, a] = hist;
    const d1 = await call("GET", `/releases/rc/diff?from=${a.id}&to=${b.id}`);
    expect(d1.status).toBe(200);
    expect(d1.json.counts).toEqual({ added: 0, removed: 2, upgraded: 0, before: 5, after: 3 });
    expect(d1.json.removed.map((p: any) => `${p.name}/${p.arch}`)).toEqual(["xz/aarch64", "xz/x86_64"]);
    // Defaults: to = the head, from = its parent (B → C puts xz back).
    const d2 = await call("GET", "/releases/rc/diff");
    expect(d2.json.to.id).toBe(c.id);
    expect(d2.json.from.id).toBe(b.id);
    expect(d2.json.counts.added).toBe(2);
    // A rollback against the release it restored: nothing changed.
    const d3 = await call("GET", `/releases/rc/diff?from=${a.id}&to=${c.id}`);
    expect(d3.json.counts).toEqual({ added: 0, removed: 0, upgraded: 0, before: 5, after: 5 });
    // Per architecture, and the edge history's xz upgrade shows as upgraded.
    const eh = (await call("GET", "/releases/edge/history")).json.releases;
    const up = eh.find((r: any) => r.seq === 3); // the release that added xz 5.8.5 for x86_64
    const d4 = await call("GET", `/releases/edge/diff?to=${up.id}&arch=x86_64`);
    expect(d4.json.upgraded).toEqual([{ name: "xz", arch: "x86_64", from: "5.8.4-1", to: "5.8.5-1", source: "core" }]);
    expect((await call("GET", `/releases/edge/diff?to=${up.id}&arch=aarch64`)).json.counts.upgraded).toBe(0);
    expect((await call("GET", "/releases/rc/diff?to=999")).status).toBe(404);
    expect((await call("GET", "/releases/rc/diff?arch=mips")).status).toBe(400);
  });

  it("answers 410 for a release whose membership GC pruned", async () => {
    const a = (await call("GET", "/releases/rc/history")).json.releases.at(-1);
    await env.DB.prepare("DELETE FROM release_packages WHERE release_id = ?").bind(a.id).run();
    const d = await call("GET", `/releases/rc/diff?from=${a.id}`);
    expect(d.status).toBe(410);
    expect(d.json.error).toMatch(/retention/);
  });
});

describe("GET /releases/:ring", () => {
  it("pages the manifests in (name, arch) order and pins a release while paging", async () => {
    const all = await call("GET", "/releases/stable");
    expect(all.status).toBe(200);
    expect(all.json.page).toEqual({ arch: null, offset: 0, limit: null, returned: 5, total: 5 });
    const names = all.json.packages.map((p: any) => `${p.name}/${p.arch}`);
    expect(names).toEqual([...names].sort());
    const page1 = await call("GET", "/releases/stable?limit=2&offset=0");
    const page2 = await call("GET", `/releases/stable?limit=2&offset=2&release_id=${all.json.release.id}`);
    const page3 = await call("GET", `/releases/stable?limit=2&offset=4&release_id=${all.json.release.id}`);
    expect(page1.json.page.returned).toBe(2);
    expect(page2.json.page.returned).toBe(2);
    expect(page3.json.page.returned).toBe(1);
    expect([...page1.json.packages, ...page2.json.packages, ...page3.json.packages].map((p: any) => `${p.name}/${p.arch}`)).toEqual(names);
    expect(page1.json.packages[0].manifest ?? page1.json.packages[0]).toBeTruthy();
    // include=files carries the file lists (gzipped, as the client reads them); the default view does not.
    const files = await call("GET", "/releases/stable?include=files&arch=x86_64&limit=1");
    expect(files.json.packages[0].files_gz).toEqual(expect.any(String));
    expect(all.json.packages[0].files_gz).toBeUndefined();
  });

  it("narrows to one architecture and refuses unknown ones", async () => {
    const arm = await call("GET", "/releases/stable?fields=summary&arch=aarch64");
    expect(arm.json.page.total).toBe(2);
    expect(arm.json.packages.every((p: any) => p.arch === "aarch64")).toBe(true);
    expect((await call("GET", "/releases/stable?arch=mips")).status).toBe(400);
    expect((await call("GET", "/releases/nope")).status).toBe(404);
    expect((await call("GET", "/releases/stable?release_id=1")).status).toBe(404); // release 1 is an edge release
  });
});

describe("GET /graph", () => {
  it("returns the dependency closure of the targets within one architecture", async () => {
    const g = await call("GET", "/graph?ring=stable&arch=x86_64&targets=curl");
    expect(g.status).toBe(200);
    const names = (g.json.packages ?? g.json.manifests ?? []).map((p: any) => p.name).sort();
    // curl → xz (declared) and libz.so → zlib (a declared provides), xz → zlib.
    expect(names).toEqual(["curl", "xz", "zlib"]);
    const arm = await call("GET", "/graph?ring=stable&arch=aarch64&targets=xz");
    expect((arm.json.packages ?? arm.json.manifests).map((p: any) => `${p.name}/${p.arch}`).sort()).toEqual(["xz/aarch64", "zlib/aarch64"]);
    expect((await call("GET", "/graph?ring=stable&arch=x86_64")).status).toBe(400);
    expect((await call("GET", "/graph?ring=stable&arch=mips&targets=xz")).status).toBe(400);
  });
});

describe("GET /stats", () => {
  it("describes the rings and the pool without a metrics snapshot yet", async () => {
    const s = await call("GET", "/stats");
    expect(s.status).toBe(200);
    expect(s.json.rings.map((r: any) => r.ring)).toEqual(["edge", "rc", "stable"]);
    expect(s.json.rings.find((r: any) => r.ring === "stable").package_count).toBe(5);
    expect(s.json.pool.objects).toBeGreaterThanOrEqual(6);
  });
});

describe("unchanged architectures", () => {
  it("a release scoped to one architecture carries the parent's artifacts for the other, and says so", async () => {
    // Render x86_64 databases for stable's head: an artifact row.
    const head = (await call("GET", "/releases/stable?fields=summary")).json.release;
    await env.DB.prepare("INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES (?, 'omarchy-core-stable', 'x86_64', 'db', 'x86_64/omarchy-core-stable.db', 10), (?, 'omarchy-core-stable', 'aarch64', 'db', 'aarch64/omarchy-core-stable.db', 10)").bind(head.id, head.id).run();
    // An aarch64-only change: x86_64 is untouched, its artifact row comes along.
    const r = await call("POST", "/releases", { ring: "stable", remove: ["xz"], remove_arch: "aarch64" }, stable);
    expect(r.status).toBe(201);
    expect(r.json.unchanged_arches).toEqual(["x86_64"]);
    const view = await call("GET", "/releases/stable?fields=summary");
    expect(view.json.artifacts).toEqual([{ repo: "omarchy-core-stable", arch: "x86_64", kind: "db", size: 10, created_at: expect.any(String) }]);
    // A promotion or an unscoped change may touch both: nothing is assumed.
    const r2 = await call("POST", "/releases", { ring: "stable", remove: ["curl"] }, stable);
    expect(r2.json.unchanged_arches).toEqual([]);
    expect((await call("GET", "/releases/stable?fields=summary")).json.artifacts).toEqual([]);
  });
});
