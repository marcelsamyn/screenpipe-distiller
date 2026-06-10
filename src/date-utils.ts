/**
 * Timezone-aware day keys ("YYYY-MM-DD") and UTC bounds for a local day.
 * Aliases: day window, local midnight, tz offset.
 */
export type DayKey = string;

export function dayKeyFor(date: Date, timeZone: string): DayKey {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function yesterdayKey(now: Date, timeZone: string): DayKey {
  return dayKeyFor(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

/** Milliseconds to add to a UTC instant to get the same wall-clock in `timeZone`. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

function localMidnightUtcIso(dayKey: DayKey, timeZone: string): string {
  const naive = new Date(`${dayKey}T00:00:00Z`);
  const offset = tzOffsetMs(naive, timeZone);
  return new Date(naive.getTime() - offset).toISOString();
}

function nextDayKey(dayKey: DayKey): DayKey {
  const next = new Date(`${dayKey}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function dayWindowUtc(dayKey: DayKey, timeZone: string): { startIso: string; endIso: string } {
  return {
    startIso: localMidnightUtcIso(dayKey, timeZone),
    endIso: localMidnightUtcIso(nextDayKey(dayKey), timeZone),
  };
}
