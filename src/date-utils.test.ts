import { describe, expect, test } from "bun:test";
import { dayKeyFor, yesterdayKey, dayWindowUtc, targetDayKey } from "./date-utils";

describe("date-utils", () => {
  test("dayKeyFor formats local day in tz", () => {
    // 2026-06-09T23:30:00Z is 2026-06-10 01:30 in Brussels (+02:00)
    expect(dayKeyFor(new Date("2026-06-09T23:30:00Z"), "Europe/Brussels")).toBe("2026-06-10");
  });

  test("yesterdayKey is the local day before now", () => {
    expect(yesterdayKey(new Date("2026-06-10T08:00:00Z"), "Europe/Brussels")).toBe("2026-06-09");
  });

  test("dayWindowUtc returns local-midnight bounds in UTC", () => {
    // Brussels is +02:00 in June → local midnight 2026-06-09 == 2026-06-08T22:00Z
    const { startIso, endIso } = dayWindowUtc("2026-06-09", "Europe/Brussels");
    expect(startIso).toBe("2026-06-08T22:00:00.000Z");
    expect(endIso).toBe("2026-06-09T22:00:00.000Z");
  });

  test("targetDayKey: today in afternoon/evening, yesterday before noon", () => {
    // 2026-06-10T20:00:00Z = 22:00 Brussels (>= noon) -> today
    expect(targetDayKey(new Date("2026-06-10T20:00:00Z"), "Europe/Brussels")).toBe("2026-06-10");
    // 2026-06-10T06:00:00Z = 08:00 Brussels (< noon) -> yesterday
    expect(targetDayKey(new Date("2026-06-10T06:00:00Z"), "Europe/Brussels")).toBe("2026-06-09");
  });
});
