import { describe, expect, it } from "vitest";
import { issueJobToken, jobOf, scopesFor } from "../src/jobtoken";
import { jobsOf, RULES, SYNC_SOURCES } from "../src/scheduler";
import type { Env } from "../src/index";

const env = { JOB_TOKEN_SECRET: "test-secret" } as unknown as Env;
const req = (token: string) => new Request("https://x/", { headers: { authorization: `Bearer ${token}` } });

describe("job tokens", () => {
  it("round-trips claims and rejects tampering, another secret and expiry", async () => {
    const claims = { t: 42, k: "sync", s: scopesFor("sync", 42, "project", { ring: "edge" }), e: Math.floor(Date.now() / 1000) + 60, w: "w1" };
    const token = await issueJobToken(env, claims);
    expect(token.startsWith("omj.")).toBe(true);
    expect(await jobOf(req(token), env)).toEqual(claims);
    expect(await jobOf(req(token.slice(0, -2) + "zz"), env)).toBeNull();
    expect(await jobOf(req(token), { JOB_TOKEN_SECRET: "other" } as unknown as Env)).toBeNull();
    const expired = await issueJobToken(env, { ...claims, e: Math.floor(Date.now() / 1000) - 1 });
    expect(await jobOf(req(expired), env)).toBeNull();
    expect(await jobOf(req("omc_not_a_job_token"), env)).toBeNull();
  });

  it("gives each kind the scopes it needs and nothing else", () => {
    expect(scopesFor("build", 7, "community", {})).toEqual(["task:7", "events", "staging:7"]);
    expect(scopesFor("build", 7, "project", {})).toContain("pool:write");
    expect(scopesFor("build", 7, "community", {})).not.toContain("pool:write");
    expect(scopesFor("promote", 8, "project", { from: "rc", to: "stable" })).toEqual(["task:8", "events", "release:stable", "artifacts:*:stable"]);
    expect(scopesFor("gc", 9, "project", {})).toEqual(["task:9", "events", "gc"]);
    expect(scopesFor("sync", 10, "project", { ring: "rc" })).toContain("release:rc");
    // A scheduled sync names its sources, each with a ring: the OPR's rc and
    // stable channels need their rings' scopes too (task 120, 2026-09-14).
    const sources = JSON.stringify([{ source: "extra", arch: "x86_64", ring: "edge" }, { source: "packages", arch: "x86_64", ring: "rc" }, { source: "packages", arch: "x86_64", ring: "stable" }]);
    const sync = scopesFor("sync", 11, "project", { arch: "x86_64", sources });
    expect(sync).toEqual(expect.arrayContaining(["pool:write", "release:edge", "release:rc", "release:stable", "artifacts:*:rc", "artifacts:*:stable"]));
    expect(scopesFor("sync", 12, "project", { sources: "not json" })).toEqual(["task:12", "events", "pool:write", "release:edge", "artifacts:*:edge"]);
  });
});

describe("pulled jobs", () => {
  it("expands sync to one task per architecture carrying all its sources, health per ring and architecture", () => {
    const sync = RULES.find((r) => r.job?.kind === "sync")!;
    expect(jobsOf(sync).map((j) => j.arch)).toEqual(["x86_64", "aarch64"]);
    const arm = jobsOf(sync).find((j) => j.arch === "aarch64")!;
    expect(JSON.parse(arm.params.sources)).toHaveLength(SYNC_SOURCES.filter((s) => s.arch === "aarch64").length);
    // Arch Linux ARM, the OPR, then the Mac's own: the Asahi fork (a GitHub release resolved at sync time) and asahi-alarm; the AUR selection last, optional.
    expect(JSON.parse(arm.params.sources).map((s: { source: string }) => s.source)).toEqual(["core", "alarm", "extra", "packages", "asahi", "asahi-alarm", "aur"]);
    const asahi = JSON.parse(arm.params.sources).find((s: { source: string }) => s.source === "asahi");
    expect(asahi.base_url).toBe("github-release://maralcbr/omarchy-pkgs/asahi-packages-stable-");
    expect(asahi.keyring).toBe("omarchy-asahi");
    const health = RULES.find((r) => r.job?.kind === "health")!;
    expect(jobsOf(health)).toHaveLength(6);
    const promote = RULES.find((r) => r.job?.kind === "promote" && r.job.params.to === "stable")!;
    expect(jobsOf(promote)).toEqual([{ kind: "promote", params: { from: "rc", to: "stable", note: "daily stable" }, arch: "x86_64" }]);
  });
});
