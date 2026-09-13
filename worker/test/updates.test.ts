import { describe, expect, it } from "vitest";
import { pkgverOf } from "../src/updates";
import { field, parseIssue } from "../src/requests";

describe("bumps", () => {
  it("turns a release tag into a pkgver", () => {
    expect(pkgverOf("v1.2.3")).toBe("1.2.3");
    expect(pkgverOf("2024-01-05")).toBe("2024.01.05");
    expect(pkgverOf("release/1.0")).toBe("1.0");
    expect(pkgverOf("V3.0-rc1")).toBe("3.0.rc1");
  });
});

describe("package request issues", () => {
  const body = "### Project URL\n\nhttps://github.com/Owner/Tool.git\n\n### Package name (optional)\n\n_No response_\n\n### Group\n\nomarchy\n\n### Notes for the packager (optional)\n\nneeds libfoo\n";
  it("reads the form fields", () => {
    expect(field(body, "Group")).toBe("omarchy");
    expect(field(body, "Package name (optional)")).toBe("");
    expect(parseIssue(body)).toEqual({ url: "https://github.com/Owner/Tool", name: "tool", group: "omarchy", hint: "needs libfoo" });
  });
  it("refuses what is not a GitHub project", () => {
    expect(parseIssue("### Project URL\n\nhttps://example.org/x\n")).toEqual({ error: "not a GitHub project URL: https://example.org/x" });
    expect(parseIssue("nothing")).toMatchObject({ error: expect.stringContaining("not a GitHub project URL") });
  });
});
