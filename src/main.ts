/** CLI: `bun run distill [--date YYYY-MM-DD] [--dry-run] [--update-existing]` (default: yesterday). */
import { loadConfig } from "./config";
import { runDistill } from "./distill";
import { targetDayKey } from "./date-utils";

function parseDateArg(argv: string[], timeZone: string): string {
  const idx = argv.indexOf("--date");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--date must be YYYY-MM-DD");
    return value;
  }
  return targetDayKey(new Date(), timeZone);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const argv = process.argv.slice(2);
  const dayKey = parseDateArg(argv, config.USER_TIMEZONE);
  const dryRun = argv.includes("--dry-run");
  const updateExisting = argv.includes("--update-existing");
  const flags = [dryRun ? "dry-run, not uploading" : null, updateExisting ? "update-existing" : null].filter(Boolean);
  console.log(`[distill] day=${dayKey} tz=${config.USER_TIMEZONE}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  const { jobId, isEmptyDay, markdown } = await runDistill(dayKey, config, undefined, { dryRun, updateExisting });
  if (dryRun) {
    console.log("\n----- curated document (NOT uploaded) -----\n");
    console.log(markdown);
  } else {
    console.log(`[distill] uploaded day=${dayKey} jobId=${jobId} emptyDay=${isEmptyDay}`);
  }
}

main().catch((err) => {
  console.error("[distill] failed:", err);
  process.exit(1);
});
