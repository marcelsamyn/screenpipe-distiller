import { describe, expect, test } from "bun:test";
import { evaluateHealth } from "./health";

describe("evaluateHealth", () => {
  test("flags audio stall and frame staleness", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const r = evaluateHealth(
      { status: "degraded", audio_db_write_stalled: true },
      "2026-06-10T09:00:00Z", // newest frame 3h old
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("audio"))).toBe(true);
    expect(r.problems.some((p) => p.includes("stale"))).toBe(true);
  });

  test("healthy when recording fresh and audio fine", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const r = evaluateHealth({ status: "healthy", audio_db_write_stalled: false }, "2026-06-10T11:58:00Z", now);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});
