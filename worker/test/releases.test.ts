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

interface Pkg { name: string; version: string; arch: string; requires?: string[]; provides?: string[]; pkgprovides?: string[]; components?: { ecosystem: string; name: string; version: string }[] }

/** Puts a fake object in the pool and indexes its manifest, as the sync does. */
async function index(source: string, repoArch: string, p: Pkg, token: string): Promise<string> {
  const filename = `${p.name}-${p.version}-${p.arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(repoArch, filename), bytes);
  const s = sha(`${repoArch}/${filename}`);
  const r = await call("POST", `/packages?source=${source}&arch=${repoArch}`, {
    schema_version: 1, name: p.name, version: p.version, arch: p.arch, sha256: s, filename,
    size_download: bytes.length, size_installed: bytes.length * 3, description: `${p.name} for tests`,
    provides: [p.name, ...(p.provides ?? [])], requires: p.requires ?? [], pkginfo: { provides: p.pkgprovides ?? [] }, files: [`usr/bin/${p.name}`], components: p.components ?? [],
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
  shas["curl-x86"] = await index("extra", "x86_64", { name: "curl", version: "8.10.0-1", arch: "x86_64", requires: ["xz", "libz.so=1-64"], components: [{ ecosystem: "Go", name: "golang.org/x/crypto", version: "v0.21.0" }, { ecosystem: "crates.io", name: "openssl", version: "0.10.64" }] }, pool);
  shas["zlib-arm"] = await index("alarm", "aarch64", { name: "zlib", version: "1:1.3.2-3", arch: "aarch64" }, pool);
  shas["xz-arm"] = await index("alarm", "aarch64", { name: "xz", version: "5.8.4-1", arch: "aarch64", requires: ["zlib"] }, pool);
});

describe("embedded components", () => {
  it("are indexed one row per module or crate, and come back with the package", async () => {
    const rows = await env.DB.prepare("SELECT ecosystem, name, version FROM package_components ORDER BY ecosystem").all();
    expect(rows.results).toEqual([{ ecosystem: "Go", name: "golang.org/x/crypto", version: "v0.21.0" }, { ecosystem: "crates.io", name: "openssl", version: "0.10.64" }]);
    // Served by no ring yet: the security job's view is empty until a release pins curl.
    expect((await call("GET", "/security/components")).json.components).toEqual([]);
  });
});

describe("GET /packages/:sha256/provenance", () => {
  it("seals a synced object with its upstream project and keyring", async () => {
    const curl = (await call("GET", `/packages/${shas["curl-x86"]}/provenance`)).json;
    expect(curl).toMatchObject({ origin: "archlinux", seal: "imported from Arch Linux", source: "extra", upstream: { project: "Arch Linux", keyring: "archlinux", verified: false }, chain: null, attestation: null });
    const zlib = (await call("GET", `/packages/${shas["zlib-arm"]}/provenance`)).json;
    expect(zlib).toMatchObject({ origin: "archlinuxarm", upstream: { project: "Arch Linux ARM", keyring: "archlinuxarm" } });
    expect((await call("GET", `/packages/${"0".repeat(64)}/provenance`)).status).toBe(404);
  });
});

describe("POST /packages", () => {
  it("indexes one row per sha256: the same bytes under the other architecture directory are refused, not a database error", async () => {
    const filename = "fonts-1-1-any.pkg.tar.zst";
    const bytes = new TextEncoder().encode("the same any package in both directories");
    const manifest = { schema_version: 1, name: "fonts", version: "1-1", arch: "any", sha256: sha("fonts-any"), filename, size_download: bytes.length, size_installed: 1, description: "fonts", provides: ["fonts"], requires: [], files: [] };
    for (const arch of ["x86_64", "aarch64"]) await env.PACKAGES.put(packageKey(arch, filename), bytes);
    expect((await call("POST", "/packages?source=packages&arch=x86_64", manifest, pool)).status).toBe(201);
    expect((await call("POST", "/packages?source=packages&arch=x86_64", manifest, pool)).json.status).toBe("already-indexed");
    const other = await call("POST", "/packages?source=packages&arch=aarch64", manifest, pool);
    expect(other.status).toBe(409);
    expect(other.json.repo_arch).toBe("x86_64");
  });
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
    // curl is served now: what it embeds is what the security job asks OSV about.
    const comps = (await call("GET", "/security/components?after=release")).json.components; // a fresh key: cached five minutes
    expect(comps).toEqual([{ ecosystem: "Go", name: "golang.org/x/crypto", version: "v0.21.0", sha256s: [shas["curl-x86"]] }, { ecosystem: "crates.io", name: "openssl", version: "0.10.64", sha256s: [shas["curl-x86"]] }]);
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

  it("answers 410 for a release whose checkpoint GC pruned", async () => {
    const a = (await call("GET", "/releases/rc/history")).json.releases.at(-1);
    // What GC does to a checkpoint nothing inside retention starts from.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM release_packages WHERE release_id = ?").bind(a.id),
      env.DB.prepare("DELETE FROM release_deltas WHERE release_id = ?").bind(a.id),
      env.DB.prepare("UPDATE releases SET checkpoint = 0 WHERE id = ?").bind(a.id),
    ]);
    const d = await call("GET", `/releases/rc/diff?from=${a.id}`);
    expect(d.status).toBe(410);
    expect(d.json.error).toMatch(/retention/);
  });
});

describe("per-architecture promotion", () => {
  it("moves one architecture from the source ring and keeps the other as the target serves it", async () => {
    // edge x86_64 gains a newer zlib; rc keeps the old one on both.
    const zlibNew = await index("core", "x86_64", { name: "zlib", version: "1:1.3.3-1", arch: "x86_64" }, pool);
    const e = await call("POST", "/releases", { ring: "edge", add: [zlibNew], remove_arch: "x86_64" }, edge);
    expect(e.status).toBe(201);
    expect((await call("POST", "/releases", { ring: "rc", arch: "x86_64" }, rc)).status).toBe(400); // arch goes with a source
    expect((await call("POST", "/releases", { ring: "rc", from_ring: "edge", arch: "mips" }, rc)).status).toBe(400);
    const p = await call("POST", "/releases", { ring: "rc", from_ring: "edge", arch: "x86_64", note: "x86_64 only" }, rc);
    expect(p.status).toBe(201);
    expect(p.json.unchanged_arches).toEqual(["aarch64"]);
    const x86 = (await call("GET", "/releases/rc?fields=summary&arch=x86_64")).json.packages;
    expect(x86.find((q: any) => q.name === "zlib").version).toBe("1:1.3.3-1");
    const arm = (await call("GET", "/releases/rc?fields=summary&arch=aarch64")).json.packages;
    expect(arm.map((q: any) => `${q.name} ${q.version}`).sort()).toEqual(["xz 5.8.4-1", "zlib 1:1.3.2-3"]);
    // The delta says exactly that: one x86_64 object out, one in.
    const d = await call("GET", `/releases/rc/diff?to=${p.json.release.id}`);
    expect(d.json.counts).toMatchObject({ added: 0, removed: 0, upgraded: 1 });
    expect(d.json.upgraded[0]).toMatchObject({ name: "zlib", arch: "x86_64", to: "1:1.3.3-1" });
    // Roll that architecture back alone: aarch64 untouched again.
    const rb = await call("POST", "/releases", { ring: "rc", from_release_id: p.json.release.parent_id, arch: "x86_64", note: "x86_64 back" }, rc);
    expect(rb.status).toBe(201);
    expect(rb.json.unchanged_arches).toEqual(["aarch64"]);
    expect((await call("GET", "/releases/rc?fields=summary&arch=x86_64")).json.packages.find((q: any) => q.name === "zlib").version).toBe("1:1.3.2-3");
  });
});

describe("GET /releases/:ring", () => {
  it("pages the manifests in (name, arch) order and pins a release while paging", async () => {
    const all = await call("GET", "/releases/stable");
    expect(all.status).toBe(200);
    expect(all.json.page).toEqual({ arch: null, offset: 0, after: null, limit: null, returned: 5, total: 5, next: null });
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
    // Keyset paging: page.next names the last row (its source too: each source's build is a row), `after=` continues from it, the last page has no next.
    expect(page1.json.page.next).toBe(`${page1.json.packages[1].name}/${page1.json.packages[1].repo_arch}/${page1.json.packages[1].source}`);
    const k2 = await call("GET", `/releases/stable?limit=2&after=${encodeURIComponent(page1.json.page.next)}&release_id=${all.json.release.id}`);
    expect(k2.json.page).toMatchObject({ after: page1.json.page.next, offset: null, returned: 2 });
    const k3 = await call("GET", `/releases/stable?limit=2&after=${encodeURIComponent(k2.json.page.next)}&release_id=${all.json.release.id}`);
    expect(k3.json.page.returned).toBe(1);
    expect(k3.json.page.next).toBeNull();
    expect([...page1.json.packages, ...k2.json.packages, ...k3.json.packages].map((p: any) => `${p.name}/${p.arch}`)).toEqual(names);
    expect((await call("GET", "/releases/stable?limit=2&after=nonsense")).status).toBe(400);
    expect((await call("GET", "/releases/stable?limit=2&after=/x86_64/core")).status).toBe(400);
    // A cursor from before the source joined it (a walk started on the previous deployment) continues after the name and arch.
    const old = await call("GET", `/releases/stable?limit=2&after=${encodeURIComponent(`${page1.json.packages[1].name}/${page1.json.packages[1].repo_arch}`)}&release_id=${all.json.release.id}`);
    expect(old.json.packages.map((p: any) => `${p.name}/${p.arch}`)).toEqual(k2.json.packages.map((p: any) => `${p.name}/${p.arch}`));
    // The total comes from the release row, per architecture too.
    expect((await call("GET", "/releases/stable?arch=aarch64&fields=summary")).json.page.total).toBe(2);
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

describe("releases as deltas", () => {
  // Thirty releases: a few milliseconds each here, a fsync each on a CI runner.
  it("writes only what changed, checkpoints every 24th release, and reconstructs any older one on demand", { timeout: 60000 }, async () => {
    const before = (await call("GET", "/releases/edge/history")).json.releases[0];
    const deltas = async (id: number) => (await env.DB.prepare("SELECT op, COUNT(*) AS n FROM release_deltas WHERE release_id = ? GROUP BY op ORDER BY op").bind(id).all<{ op: string; n: number }>()).results;
    const rows = async (id: number) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM release_packages WHERE release_id = ?").bind(id).first<{ n: number }>())!.n;
    // Take xz out of x86_64, put it back: two rows per release, never a copy of the selection.
    const r1 = await call("POST", "/releases", { ring: "edge", remove: ["xz"], remove_arch: "x86_64" }, edge);
    expect(r1.json.package_count).toBe(before.package_count - 1);
    expect(await deltas(r1.json.release.id)).toEqual([{ op: "remove", n: 1 }]);
    expect(await rows(r1.json.release.id)).toBe(0);
    const xzNow = (await call("GET", "/releases/edge?fields=summary&arch=x86_64&release_id=" + before.id)).json.packages.find((p: any) => p.name === "xz");
    const r2 = await call("POST", "/releases", { ring: "edge", add: [xzNow.sha256], remove_arch: "x86_64" }, edge);
    expect(await deltas(r2.json.release.id)).toEqual([{ op: "add", n: 1 }]);
    expect(r2.json.package_count).toBe(before.package_count);
    // The ring's live rows are what the head serves.
    const live = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages WHERE ring = 'edge'").first<{ n: number }>())!.n;
    expect(live).toBe(before.package_count);
    // Reading `before` by id above reconstructed it: it is a checkpoint now, and it holds what it held.
    const ck = await env.DB.prepare("SELECT checkpoint FROM releases WHERE id = ?").bind(before.id).first<{ checkpoint: number }>();
    expect(ck!.checkpoint).toBe(1);
    expect(await rows(before.id)).toBe(before.package_count);
    // Twenty-odd more releases: the next checkpoint comes 24 after the last one (reads by id made some on demand above).
    const ckBefore = (await env.DB.prepare("SELECT MAX(seq) AS seq FROM releases WHERE ring = 'edge' AND checkpoint = 1").first<{ seq: number }>())!.seq;
    let last = r2.json.release;
    for (let i = 0; i < 26; i++) {
      const r = await call("POST", "/releases", { ring: "edge", remove: [i % 2 ? "xz" : "nothing"], remove_arch: "x86_64", ...(i % 2 ? {} : { add: [xzNow.sha256] }) }, edge);
      expect(r.status).toBe(201);
      last = r.json.release;
    }
    const hist = (await call("GET", "/releases/edge/history")).json.releases as { id: number; seq: number }[];
    const cks = (await env.DB.prepare("SELECT seq FROM releases WHERE ring = 'edge' AND checkpoint = 1 ORDER BY seq").all<{ seq: number }>()).results.map((r) => r.seq);
    expect(cks).toContain(1);
    expect(cks).toContain(ckBefore + 24);
    expect(cks).not.toContain(ckBefore + 23);
    expect(cks).not.toContain(ckBefore + 25);
    // An old, non-checkpoint release paged by id is reconstructed from the checkpoint behind it plus the deltas.
    const mid = hist.find((r) => r.seq === ckBefore + 20)!;
    const page = await call("GET", `/releases/edge?fields=summary&arch=x86_64&release_id=${mid.id}`);
    expect(page.status).toBe(200);
    // The loop alternates: even i puts xz back, odd i removes it; seq = r2.seq + 1 + i.
    const i = mid.seq - r2.json.release.seq - 1;
    expect(page.json.packages.some((p: any) => p.name === "xz")).toBe(i % 2 === 0);
    expect(page.json.page.total).toBe((await call("GET", `/releases/edge/diff?to=${mid.id}&arch=x86_64`)).json.counts.after);
    expect(last.seq).toBe(hist[0].seq);
  });

  it("retention keeps what a rollback inside it may need, and drops the rest", { timeout: 60000 }, async () => {
    // keep=3 protects the last three releases of each ring; the kept checkpoint is the newest at or before the oldest of them.
    const un = await call("GET", "/pool/unreferenced?keep=3&grace_days=0");
    expect(un.status).toBe(200);
    const head = (await call("GET", "/releases/edge/history")).json.releases[0].seq as number;
    const expected = (await env.DB.prepare("SELECT MAX(seq) AS seq FROM releases WHERE ring = 'edge' AND checkpoint = 1 AND seq <= ?").bind(head - 2).first<{ seq: number }>())!.seq;
    const seqs = await env.DB.prepare("SELECT id, seq FROM releases WHERE ring = 'edge' AND id IN (SELECT value FROM json_each(?)) ORDER BY seq").bind(JSON.stringify(un.json.kept_checkpoints)).all<{ id: number; seq: number }>();
    expect(seqs.results.map((r) => r.seq)).toContain(expected);
    // Nothing a ring serves is ever listed.
    const served = new Set((await env.DB.prepare("SELECT package_id FROM ring_packages").all<{ package_id: number }>()).results.map((r) => r.package_id));
    for (const p of un.json.packages) expect(served.has(p.id)).toBe(false);
    const gc = await call("POST", "/pool/gc?keep=3&grace_days=0", undefined, await job(["gc"]));
    expect(gc.status).toBe(200);
    expect(gc.json.kept_checkpoints).toEqual(un.json.kept_checkpoints);
    // Deltas at or before the kept checkpoint are gone; the ones after it stay (a protected release reconstructs through them).
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM release_deltas d JOIN releases r ON r.id = d.release_id WHERE r.ring = 'edge' AND r.seq <= ?").bind(expected).first<{ n: number }>();
    expect(old!.n).toBe(0);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM release_deltas d JOIN releases r ON r.id = d.release_id WHERE r.ring = 'edge' AND r.seq > ?").bind(expected).first<{ n: number }>();
    expect(recent!.n).toBeGreaterThan(0);
    // The head still reads, an old protected release still reconstructs, a pruned one answers 410.
    expect((await call("GET", "/releases/edge?fields=summary")).status).toBe(200);
    const hist = (await call("GET", "/releases/edge/history")).json.releases as { id: number; seq: number }[];
    expect((await call("GET", `/releases/edge/diff?to=${hist[1].id}`)).status).toBe(200);
    expect((await call("GET", `/releases/edge/diff?from=${hist.find((r) => r.seq === expected - 3)!.id}`)).status).toBe(410);
  });
});

describe("one row per source", () => {
  it("keeps another source's build of a name, replaces only its own, and removes per source", async () => {
    // Arch Linux ARM's mesa and asahi-alarm's: two builds of one name, both
    // served (each in its own database; the include's order picks on a Mac).
    const mesaExtra = await index("extra", "aarch64", { name: "mesa", version: "1:26.2.2-1", arch: "aarch64" }, pool);
    const mesaAsahi = await index("asahi-alarm", "aarch64", { name: "mesa", version: "26.1.8-1", arch: "aarch64" }, pool);
    expect((await call("POST", "/releases", { ring: "edge", add: [mesaExtra], remove_arch: "aarch64" }, edge)).status).toBe(201);
    const second = await call("POST", "/releases", { ring: "edge", add: [mesaAsahi], remove_arch: "aarch64" }, edge);
    expect(second.status).toBe(201);
    const rows = async () =>
      ((await call("GET", "/releases/edge?fields=summary&arch=aarch64")).json.packages as { name: string; version: string; source: string }[])
        .filter((p) => p.name === "mesa")
        .map((p) => `${p.source} ${p.version}`)
        .sort();
    expect(await rows()).toEqual(["asahi-alarm 26.1.8-1", "extra 1:26.2.2-1"]);
    // The diff sees a source's add, not a downgrade of the other's.
    const d = await call("GET", `/releases/edge/diff?to=${second.json.release.id}&arch=aarch64`);
    expect(d.json.counts).toMatchObject({ added: 1, removed: 0, upgraded: 0 });
    expect(d.json.added[0]).toMatchObject({ name: "mesa", source: "asahi-alarm" });
    // A newer build from extra replaces extra's row only.
    const mesaExtra2 = await index("extra", "aarch64", { name: "mesa", version: "1:26.2.3-1", arch: "aarch64" }, pool);
    const third = await call("POST", "/releases", { ring: "edge", add: [mesaExtra2], remove_arch: "aarch64" }, edge);
    expect(third.status).toBe(201);
    expect(await rows()).toEqual(["asahi-alarm 26.1.8-1", "extra 1:26.2.3-1"]);
    expect((await call("GET", `/releases/edge/diff?to=${third.json.release.id}&arch=aarch64`)).json.upgraded).toEqual([
      { name: "mesa", arch: "aarch64", from: "1:26.2.2-1", to: "1:26.2.3-1", source: "extra" },
    ]);
    // The package page lists every source's row of the ring, the one pacman would take first; `source=` looks at another.
    const page = await call("GET", "/package/mesa?ring=edge&arch=aarch64");
    expect(page.status).toBe(200);
    expect(page.json.rings.filter((r: any) => r.ring === "edge").map((r: any) => r.source)).toEqual(["asahi-alarm", "extra"]);
    expect(page.json.package.source).toBe("asahi-alarm");
    expect((await call("GET", "/package/mesa?ring=edge&arch=aarch64&source=extra")).json.package.version).toBe("1:26.2.3-1");
    // Keyset paging walks both rows of the name: one per page, nothing skipped at the boundary between them.
    const all = ((await call("GET", "/releases/edge?fields=summary&arch=aarch64")).json.packages as { name: string; source: string }[]).map((p) => `${p.name}/${p.source}`);
    const walked: string[] = [];
    let after: string | null = null;
    for (;;) {
      const r = await call("GET", `/releases/edge?fields=summary&arch=aarch64&limit=1${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      walked.push(...r.json.packages.map((p: any) => `${p.name}/${p.source}`));
      if (!r.json.page.next) break;
      after = r.json.page.next;
    }
    expect(walked).toEqual(all);
    expect(all.filter((k) => k.startsWith("mesa/"))).toEqual(["mesa/asahi-alarm", "mesa/extra"]);
    // A sync's removal is scoped to its source; a maintainer's `remove` drops the name from every source.
    const r1 = await call("POST", "/releases", { ring: "edge", remove_from: [{ source: "asahi-alarm", name: "mesa" }], remove_arch: "aarch64" }, edge);
    expect(r1.status).toBe(201);
    expect(await rows()).toEqual(["extra 1:26.2.3-1"]);
    expect((await call("POST", "/releases", { ring: "edge", add: [mesaAsahi], remove_arch: "aarch64" }, edge)).status).toBe(201);
    expect(await rows()).toEqual(["asahi-alarm 26.1.8-1", "extra 1:26.2.3-1"]);
    const r2 = await call("POST", "/releases", { ring: "edge", remove: ["mesa"], remove_arch: "aarch64" }, edge);
    expect(r2.status).toBe(201);
    expect(await rows()).toEqual([]);
  });
});
