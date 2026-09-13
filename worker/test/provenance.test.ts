import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { syncProvenance, provenanceOf, provenanceCounts } from "../src/provenance";

// omacom/omarchy-pkgs as the GitHub API shows it: a head, one tree, a
// package.json and a commit per package.
function github(tree: Record<string, string>, metas: Record<string, unknown>, head = "abc123def456"): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/commits/master")) return new Response(JSON.stringify({ sha: head }));
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.entries(tree).map(([path, sha]) => ({ path, type: "blob", sha })) }));
    const raw = url.match(/pkgbuilds\/([^/]+)\/\.omarchy\/package\.json$/);
    if (raw) return metas[raw[1]] ? new Response(JSON.stringify(metas[raw[1]])) : new Response("nope", { status: 404 });
    const c = url.match(/commits\?path=pkgbuilds%2F([^&]+)/);
    if (c) return new Response(JSON.stringify([{ sha: `commit-${c[1]}`, commit: { committer: { date: "2026-09-01T00:00:00Z" } } }]));
    return new Response("unexpected " + url, { status: 500 });
  }) as unknown as typeof fetch;
}

describe("OPR provenance", () => {
  it("records each package's origin from the tree, fetching only what changed", async () => {
    const tree = { "pkgbuilds/omarchy/PKGBUILD": "b1", "pkgbuilds/omarchy/.omarchy/package.json": "m1", "pkgbuilds/claude-code/PKGBUILD": "b2", "pkgbuilds/claude-code/.omarchy/package.json": "m2", "pkgbuilds/odd/PKGBUILD": "b3", "README.md": "r" };
    const metas = { omarchy: { source: "local", channels: ["edge", "rc", "stable"], pinned: true }, "claude-code": { source: "aur", release_ring: "fast", upstream_commit: "f7dd445621ab53f9e51b70b351ff6917ff814175" } };
    const s = await syncProvenance(env, new Date("2026-09-14T06:00:00Z"), github(tree, metas));
    expect(s).toMatch(/3 packages, 3 changed, 0 gone/);
    const cc = await provenanceOf(env, "claude-code");
    expect(cc).toMatchObject({ source: "aur", upstream_commit: "f7dd445621ab53f9e51b70b351ff6917ff814175", release_ring: "fast", pkgbuild_commit: "commit-claude-code", pinned: false });
    expect(cc!.aur).toContain("aur.archlinux.org");
    expect(await provenanceOf(env, "omarchy")).toMatchObject({ source: "local", pinned: true, channels: ["edge", "rc", "stable"] });
    expect((await provenanceOf(env, "odd"))!.source).toBe("unknown");
    expect(await provenanceOf(env, "nope")).toBeNull();
    // Same day: nothing. Next day, one PKGBUILD changed and one package left: one fetched, one gone.
    expect(await syncProvenance(env, new Date("2026-09-14T09:00:00Z"), github(tree, metas))).toBe("provenance: scanned today");
    const tree2 = { ...tree, "pkgbuilds/claude-code/PKGBUILD": "b2-new" };
    delete (tree2 as Record<string, string>)["pkgbuilds/odd/PKGBUILD"];
    const metas2 = { ...metas, "claude-code": { source: "local" } };
    const s2 = await syncProvenance(env, new Date("2026-09-15T06:00:00Z"), github(tree2, metas2, "fedcba"));
    expect(s2).toMatch(/2 packages, 1 changed, 1 gone/);
    expect((await provenanceOf(env, "claude-code"))!.source).toBe("local");
    expect(await provenanceOf(env, "odd")).toBeNull();
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'provenance'").first<{ n: number }>();
    expect(ev!.n).toBe(2);
  });

  it("counts a ring's OPR packages by origin", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('1', 'omarchy', '1', 'x86_64', 'a', 1, 1, 0, '{}', 'packages', 'k1', 'x86_64'), ('2', 'claude-code', '1', 'x86_64', 'b', 1, 1, 0, '{}', 'packages', 'k2', 'x86_64'), ('3', 'zlib', '1', 'x86_64', 'c', 1, 1, 0, '{}', 'core', 'k3', 'x86_64'), ('4', 'mystery', '1', 'x86_64', 'd', 1, 1, 0, '{}', 'packages', 'k4', 'x86_64')"),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'stable', id FROM packages"),
    ]);
    await syncProvenance(env, new Date("2026-09-16T06:00:00Z"), github({ "pkgbuilds/omarchy/PKGBUILD": "b1", "pkgbuilds/omarchy/.omarchy/package.json": "m1", "pkgbuilds/claude-code/PKGBUILD": "b2", "pkgbuilds/claude-code/.omarchy/package.json": "m2" }, { omarchy: { source: "local" }, "claude-code": { source: "aur" } }));
    expect(await provenanceCounts(env, "stable")).toEqual({ packages: 3, local: 1, aur: 1, unknown: 1 });
    expect(await provenanceCounts(env, "edge")).toEqual({ packages: 0, local: 0, aur: 0, unknown: 0 });
  });
});
