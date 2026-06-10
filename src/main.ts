/** CLI: `bun run distill [--date YYYY-MM-DD]` (default: yesterday). */
import { loadConfig } from "./config";
import { runDistill } from "./distill";
import { yesterdayKey } from "./date-utils";

function parseDateArg(argv: string[], timeZone: string): string {
  const idx = argv.indexOf("--date");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--date must be YYYY-MM-DD");
    return value;
  }
  return yesterdayKey(new Date(), timeZone);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dayKey = parseDateArg(process.argv.slice(2), config.USER_TIMEZONE);
  console.log(`[distill] day=${dayKey} tz=${config.USER_TIMEZONE}`);
  const { jobId, isEmptyDay } = await runDistill(dayKey, config);
  console.log(`[distill] uploaded day=${dayKey} jobId=${jobId} emptyDay=${isEmptyDay}`);
}

main().catch((err) => {
  console.error("[distill] failed:", err);
  process.exit(1);
});
