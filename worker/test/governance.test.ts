import { describe, expect, it } from "vitest";
import { parseGovernance } from "../src/governance";

const FILE = `
[groups.omarchy]
description = "What Omarchy ships"
maintainers = ["firemanxbr", "adamb"]

[groups.community]
maintainers = ["firemanxbr"]
`;

describe("governance file", () => {
  it("parses groups with their maintainers, sorted by name", () => {
    const g = parseGovernance(FILE);
    expect(g.map((x) => x.name)).toEqual(["community", "omarchy"]);
    expect(g[1]).toEqual({ name: "omarchy", description: "What Omarchy ships", maintainers: ["firemanxbr", "adamb"] });
    expect(g[0].description).toBe("");
  });

  it("refuses a group without maintainers, a bad group name or a bad login", () => {
    expect(() => parseGovernance(`[groups.x]\nmaintainers = []`)).toThrow(/no maintainer/);
    expect(() => parseGovernance(`[groups."Bad Name"]\nmaintainers = ["a"]`)).toThrow(/group name/);
    expect(() => parseGovernance(`[groups.ok]\nmaintainers = ["not a login!"]`)).toThrow(/logins/);
    expect(() => parseGovernance(`title = "x"`)).toThrow(/groups/);
  });

  it("accepts the repository's own file", async () => {
    const fs = await import("node:fs");
    const g = parseGovernance(fs.readFileSync(new URL("../../factory/MAINTAINERS.toml", import.meta.url), "utf8"));
    expect(g.length).toBeGreaterThan(0);
    for (const x of g) expect(x.maintainers.length).toBeGreaterThan(0);
  });
});
