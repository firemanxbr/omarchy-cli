import { describe, expect, it } from "vitest";
import { parseGovernance } from "../src/governance";
// The repository's own file, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import repositoryFile from "../../factory/MAINTAINERS.toml?raw";

describe("governance file", () => {
  it("parses the list of maintainers, sorted, without duplicates", () => {
    expect(parseGovernance(`maintainers = ["firemanxbr", "adamb", "firemanxbr"]`)).toEqual(["adamb", "firemanxbr"]);
  });

  it("still reads the older grouped form as the union of its lists", () => {
    expect(parseGovernance(`[groups.omarchy]\nmaintainers = ["firemanxbr", "adamb"]\n\n[groups.community]\nmaintainers = ["firemanxbr"]`)).toEqual(["adamb", "firemanxbr"]);
  });

  it("refuses an empty list, a bad login, or no list at all", () => {
    expect(() => parseGovernance(`maintainers = []`)).toThrow(/no maintainer/);
    expect(() => parseGovernance(`maintainers = ["not a login!"]`)).toThrow(/logins/);
    expect(() => parseGovernance(`title = "x"`)).toThrow(/maintainers/);
  });

  it("accepts the repository's own file", () => {
    expect(parseGovernance(repositoryFile).length).toBeGreaterThan(0);
  });
});
