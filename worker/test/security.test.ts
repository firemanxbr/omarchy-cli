/**
 * The security view's `fixed_in`: a version elsewhere counts as clean only
 * when it was examined the same way — a package whose vulnerable object
 * carries embedded components (what OSV advisories are about) is not
 * "fixed" in a ring that serves an object indexed before the component
 * scan existed (no components, no advisories, no knowledge).
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

const sha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

/** A Go binary in the pool: `components` is what pkg-extract found in it (none for an object indexed before the scan). */
async function index(repoArch: string, version: string, components: { ecosystem: string; name: string; version: string }[], token: string): Promise<{ sha256: string; id: number }> {
  const filename = `smolvm-${version}-${repoArch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(repoArch, filename), bytes);
  const s = sha(`${repoArch}/${filename}`);
  const r = await call("POST", `/packages?source=packages&arch=${repoArch}`, {
    schema_version: 1, name: "smolvm", version, arch: repoArch, sha256: s, filename, size_download: bytes.length, size_installed: 1,
    description: "a small vm", provides: ["smolvm"], requires: [], pkginfo: { provides: [] }, files: ["usr/bin/smolvm"], components,
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { sha256: s, id: r.json.id };
}

let old: { sha256: string; id: number };
let cur: { sha256: string; id: number };

beforeAll(async () => {
  const pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const edge = await issueJobToken(env, { t: 2, k: "test", s: ["release:edge"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const rc = await issueJobToken(env, { t: 3, k: "test", s: ["release:rc"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  // 1.15.0 indexed before the component scan existed; 1.15.1 scanned, and vulnerable through a Go module.
  old = await index("x86_64", "1.15.0-1", [], pool);
  cur = await index("x86_64", "1.15.1-1", [{ ecosystem: "Go", name: "golang.org/x/net", version: "v0.20.0" }], pool);
  expect((await call("POST", "/releases", { ring: "rc", add: [old.sha256] }, rc)).status).toBe(201);
  expect((await call("POST", "/releases", { ring: "edge", add: [cur.sha256] }, edge)).status).toBe(201);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at) VALUES ('osv:GO-2024-1234:smolvm', 'osv', 'smolvm', '[\"CVE-2024-1234\"]', 'critical', 'vulnerable', NULL, NULL, 'x/net', 'https://osv.dev/GO-2024-1234', '2026-09-14T00:00:00Z')"),
    env.DB.prepare("INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, 'osv:GO-2024-1234:smolvm', 'exact', 'vulnerable', '2026-09-14T00:00:00Z')").bind(cur.id),
  ]);
});

describe("GET /security fixed_in", () => {
  it("does not call a version clean when it was never scanned for the components the advisory is about", async () => {
    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=1")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v, JSON.stringify(view)).toBeTruthy();
    expect(v.fixed_in).toEqual([]);
  });
  it("does once the other object carries components and no open advisory", async () => {
    await env.DB.prepare("INSERT INTO package_components (package_id, ecosystem, name, version) VALUES (?, 'Go', 'golang.org/x/net', 'v0.30.0')").bind(old.id).run();
    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=2")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v.fixed_in).toEqual([{ ring: "rc", version: "1.15.0-1" }]);
  });
});

/** Something in the pool that depends on smolvm: by name, or by a library it provides. */
async function dependant(name: string, requires: string[], token: string): Promise<string> {
  const filename = `${name}-1.0-1-x86_64.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey("x86_64", filename), bytes);
  const s = sha(`x86_64/${filename}`);
  const r = await call("POST", "/packages?source=packages&arch=x86_64", {
    schema_version: 1, name, version: "1.0-1", arch: "x86_64", sha256: s, filename, size_download: bytes.length, size_installed: 1,
    description: name, provides: [name], requires, pkginfo: { provides: [] }, files: [`usr/bin/${name}`],
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return s;
}

describe("GET /security exposure", () => {
  it("counts what depends on a vulnerable package in that ring, by name and by a library it provides", async () => {
    const pool = await issueJobToken(env, { t: 4, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    const edge = await issueJobToken(env, { t: 5, k: "test", s: ["release:edge"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    const rc = await issueJobToken(env, { t: 6, k: "test", s: ["release:rc"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    // The vulnerable object also ships a library.
    await env.DB.prepare("INSERT INTO package_provides (package_id, capability, declared) VALUES (?, 'libsmol.so.1', 0)").bind(cur.id).run();
    const byName = await dependant("smol-cli", ["smolvm"], pool);
    const byLibrary = await dependant("smol-gui", ["libsmol.so.1"], pool);
    const elsewhere = await dependant("smol-rc-only", ["smolvm"], pool);
    expect((await call("POST", "/releases", { ring: "edge", add: [byName, byLibrary] }, edge)).status).toBe(201);
    expect((await call("POST", "/releases", { ring: "rc", add: [elsewhere] }, rc)).status).toBe(201);

    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=3")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v.exposure).toEqual({ declared: 1, loads: 1 });
    expect(view.totals.exposed).toBe(2);
    // rc serves a clean smolvm: nothing there is exposed.
    const rcView = (await call("GET", "/security?ring=rc&arch=x86_64&_=3")).json;
    expect(rcView.vulnerable.find((p: any) => p.name === "smolvm")).toBeUndefined();
    expect(rcView.totals.exposed).toBe(0);
  });
});
