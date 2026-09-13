import { describe, expect, it } from "vitest";
import { RULES } from "../src/scheduler";

describe("metrics", () => {
  it("is no longer a workflow rule: the brain snapshots itself", () => {
    expect(RULES.some((r) => r.workflow === "metrics.yml")).toBe(false);
    expect(RULES.find((r) => r.workflow === "security")?.job?.kind).toBe("security");
  });
});
