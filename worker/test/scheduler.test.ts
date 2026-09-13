import { describe, expect, it } from "vitest";
import { isDue, RULES } from "../src/scheduler";

const at = (iso: string) => new Date(iso);
const run = (created_at: string, status = "completed", event = "schedule", display_title = "") => ({ created_at, status, event, display_title });

describe("scheduler rules", () => {
  const sync = RULES.find((r) => r.workflow === "sync")!;
  const stable = RULES.find((r) => r.workflow === "promote" && r.inputs?.to === "stable")!;

  it("dispatches an interval workflow only once it is overdue and idle", () => {
    const now = at("2026-09-12T16:00:00Z");
    expect(isDue(sync, [run("2026-09-12T13:20:00Z")], now).due).toBe(false); // 160 min ago, every 180
    expect(isDue(sync, [run("2026-09-12T12:50:00Z")], now).due).toBe(true); // 190 min ago
    expect(isDue(sync, [run("2026-09-12T12:50:00Z", "in_progress")], now).due).toBe(false);
    expect(isDue(sync, [], now).due).toBe(true); // never ran
  });

  it("dispatches a daily slot after a grace period, once", () => {
    expect(isDue(stable, [], at("2026-09-12T09:05:00Z")).due).toBe(false); // GitHub's cron gets first go
    expect(isDue(stable, [], at("2026-09-12T09:15:00Z")).due).toBe(true);
    expect(isDue(stable, [run("2026-09-12T09:02:00Z", "completed", "schedule")], at("2026-09-12T09:15:00Z")).due).toBe(false);
    expect(isDue(stable, [run("2026-09-11T09:02:00Z")], at("2026-09-12T18:00:00Z")).due).toBe(true); // yesterday's run does not count
  });

  it("only runs the weekly slot on its weekday", () => {
    const gc = RULES.find((r) => r.workflow === "gc")!;
    expect(isDue(gc, [], at("2026-09-12T05:00:00Z")).due).toBe(false); // Saturday
    expect(isDue(gc, [], at("2026-09-13T05:00:00Z")).due).toBe(true); // Sunday
  });
});
