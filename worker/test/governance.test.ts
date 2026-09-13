import { describe, expect, it } from "vitest";
import { parseGovernance } from "../src/governance";
// The repository's own file, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import repositoryFile from "../../factory/MAINTAINERS.toml?raw";

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

  it("accepts the repository's own file", () => {
    const g = parseGovernance(repositoryFile);
    expect(g.length).toBeGreaterThan(0);
    for (const x of g) expect(x.maintainers.length).toBeGreaterThan(0);
  });
});
