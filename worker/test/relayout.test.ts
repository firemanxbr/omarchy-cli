/**
 * The one-time move from the flat layout to one directory per source
 * (routes/relayout.ts): objects copied with their signature, rows pointed
 * at the new key, a row whose bytes the pool never held marked a ghost,
 * the flat directories purged only once nothing is left to move — and the
 * upload, index and seal routes speaking the new layout throughout.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string, raw?: Uint8Array): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A row of the flat layout, as the pool held them: the object at <arch>/<filename>, the row's key the same. */
async function flat(source: string, arch: string, name: string, bytes: Uint8Array, sha: string, withSig = true): Promise<string> {
  const filename = `${name}-1.0-1-${arch}.pkg.tar.zst`;
  await env.PACKAGES.put(`${arch}/${filename}`, bytes, { sha256: await sha256(bytes) });
  if (withSig) await env.PACKAGES.put(`${arch}/${filename}.sig`, new TextEncoder().encode(`sig of ${filename}`));
  await env.DB.prepare(
    `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
     VALUES (?, ?, '1.0-1', ?, ?, ?, 1, ?, '{}', ?, ?, ?)`,
  ).bind(sha, name, arch, filename, bytes.length, withSig ? 1 : 0, source, `${arch}/${filename}`, arch).run();
  return filename;
}

let relayout: string;
let pool: string;

beforeAll(async () => {
  relayout = await issueJobToken(env, { t: 1, k: "test", s: ["relayout", "events"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
});

describe("POST /pool/relayout", () => {
  it("copies every object into its source's directory, marks the ghosts, and purges the flat directories last", async () => {
    const zlib = new TextEncoder().encode("zlib from arch");
    const zlibSha = await sha256(zlib);
    const zlibFile = await flat("core", "x86_64", "zlib", zlib, zlibSha);
    const tool = new TextEncoder().encode("tool built by the factory");
    const toolFile = await flat("factory", "aarch64", "tool", tool, await sha256(tool), false);
    await env.PACKAGES.put(`aarch64/${toolFile}.provenance.json`, new TextEncoder().encode("{}"));
    // Two rows behind one flat key: the OPR's rc rebuild of a file the edge sync stored first — the pool never held its bytes.
    const app = new TextEncoder().encode("app, the edge build");
    const appFile = await flat("packages", "x86_64", "app", app, await sha256(app));
    await env.DB.prepare(
      `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
       VALUES (?, 'app', '1.0-1', 'x86_64', ?, ?, 1, 1, '{}', 'packages', ?, 'x86_64')`,
    ).bind("b".repeat(64), appFile, app.length, `x86_64/${appFile}`).run();
    // A row from before the column existed.
    await env.DB.prepare("UPDATE packages SET r2_key = NULL WHERE name = 'tool'").run();
    // Old databases in the flat directory, and a database rendered before the move.
    await env.PACKAGES.put("x86_64/omarchy-core-edge.db", new TextEncoder().encode("db"));

    expect((await call("POST", "/pool/relayout?phase=copy", undefined, pool)).status).toBe(403);
    // Purge refuses while anything is left to move.
    const early = await call("POST", "/pool/relayout?phase=purge", undefined, relayout);
    expect(early.status).toBe(409);
    expect(early.json.remaining).toBe(4);

    const c1 = await call("POST", "/pool/relayout?phase=copy&limit=2", undefined, relayout);
    expect(c1.status).toBe(200);
    expect(c1.json).toMatchObject({ phase: "copy", moved: 2, ghosts: 0, missing: 0, errors: [], remaining: 2 });
    const c2 = await call("POST", "/pool/relayout?phase=copy&limit=40", undefined, relayout);
    expect(c2.json).toMatchObject({ moved: 1, ghosts: 1, missing: 0, errors: [], remaining: 0 });
    // The objects, with what sat beside them; the old ones still there until the purge.
    expect(await (await env.PACKAGES.get(`core/x86_64/${zlibFile}`))!.text()).toBe("zlib from arch");
    expect(await (await env.PACKAGES.get(`core/x86_64/${zlibFile}.sig`))!.text()).toBe(`sig of ${zlibFile}`);
    expect(await env.PACKAGES.head(`factory/aarch64/${toolFile}.provenance.json`)).not.toBeNull();
    expect(await env.PACKAGES.head(`factory/aarch64/${toolFile}.sig`)).toBeNull();
    expect(await env.PACKAGES.head(`x86_64/${zlibFile}`)).not.toBeNull();
    const rows = (await env.DB.prepare("SELECT name, sha256, r2_key FROM packages WHERE name IN ('zlib', 'tool', 'app') ORDER BY name, id").all<{ name: string; sha256: string; r2_key: string }>()).results;
    expect(rows.map((r) => r.r2_key)).toEqual([`packages/x86_64/${appFile}`, `ghost/packages/x86_64/${appFile}`, `factory/aarch64/${toolFile}`, `core/x86_64/${zlibFile}`]);
    // The seal names the new place.
    expect((await call("GET", `/packages/${zlibSha}/provenance`)).json.object).toBe(`${env.POOL_URL}/core/x86_64/${zlibFile}`);
    // A second copy pass is a no-op.
    expect((await call("POST", "/pool/relayout?phase=copy", undefined, relayout)).json).toMatchObject({ moved: 0, ghosts: 0, remaining: 0 });

    const p1 = await call("POST", "/pool/relayout?phase=purge", undefined, relayout);
    expect(p1.status).toBe(200);
    expect(p1.json).toMatchObject({ phase: "purge", truncated: false });
    expect(p1.json.deleted).toBeGreaterThanOrEqual(6);
    expect(await env.PACKAGES.head(`x86_64/${zlibFile}`)).toBeNull();
    expect(await env.PACKAGES.head("x86_64/omarchy-core-edge.db")).toBeNull();
    expect(await env.PACKAGES.head(`core/x86_64/${zlibFile}`)).not.toBeNull();
    expect((await env.PACKAGES.list({ prefix: "x86_64/" })).objects).toEqual([]);
    expect((await env.PACKAGES.list({ prefix: "aarch64/" })).objects).toEqual([]);
  });

  it("uploads, indexes and signs under the source's directory; a filename is one object per source, not per pool", async () => {
    const bytes = new TextEncoder().encode("asusctl as Arch builds it");
    const sha = await sha256(bytes);
    const filename = "asusctl-6.5.0-1-x86_64.pkg.tar.zst";
    expect((await call("PUT", `/pool/${sha}?filename=${filename}&arch=x86_64`, undefined, pool, bytes)).status).toBe(400); // no source
    const up = await call("PUT", `/pool/${sha}?filename=${filename}&source=extra&arch=x86_64`, undefined, pool, bytes);
    expect(up.status).toBe(201);
    expect(up.json.key).toBe(`extra/x86_64/${filename}`);
    // The OPR's build of the same filename: another object, in its own directory.
    const opr = new TextEncoder().encode("asusctl as the OPR builds it");
    const oprSha = await sha256(opr);
    const up2 = await call("PUT", `/pool/${oprSha}?filename=${filename}&source=packages&arch=x86_64`, undefined, pool, opr);
    expect(up2.status).toBe(201);
    expect(up2.json.key).toBe(`packages/x86_64/${filename}`);
    const manifest = (s: string, size: number) => ({ schema_version: 1, name: "asusctl", version: "6.5.0-1", arch: "x86_64", sha256: s, filename, size_download: size, size_installed: 1, provides: ["asusctl"], requires: [], files: [] });
    expect((await call("POST", "/packages?source=extra&arch=x86_64", manifest(sha, bytes.length), pool)).status).toBe(201);
    expect((await call("POST", "/packages?source=packages&arch=x86_64", manifest(oprSha, opr.length), pool)).status).toBe(201);
    // What the sync asks before importing: the filename collides within a source only.
    const known = await call("POST", "/packages/known", { sha256: [sha, oprSha], filenames: [filename], source: "extra", arch: "x86_64" }, pool);
    expect(known.json.known.sort()).toEqual([sha, oprSha].sort());
    expect(known.json.by_filename).toEqual({ [filename]: sha });
    expect((await call("POST", "/packages/known", { sha256: [], filenames: [filename], source: "asahi", arch: "x86_64" }, pool)).json.by_filename).toEqual({});
    expect((await call("POST", "/packages/known", { sha256: [], filenames: [filename], arch: "x86_64" }, pool)).status).toBe(400);
    // A signature lands beside its object, in the source's directory.
    const sig = await call("PUT", `/pool/${oprSha}/sig?filename=${filename}&source=packages&arch=x86_64`, undefined, pool, new TextEncoder().encode("opr sig"));
    expect(sig.status).toBe(201);
    expect(await (await env.PACKAGES.get(`packages/x86_64/${filename}.sig`))!.text()).toBe("opr sig");
    expect(await env.PACKAGES.head(`extra/x86_64/${filename}.sig`)).toBeNull();
    expect((await call("GET", `/packages/${oprSha}/provenance`)).json.upstream.signature).toBe(`${env.POOL_URL}/packages/x86_64/${filename}.sig`);
  });
});
