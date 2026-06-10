/**
 * Checks Screenpipe recording health and notifies (macOS) when it is down,
 * stale, or audio transcription has stalled. Read-only; no memory writes.
 */
import { z } from "zod";
import { loadConfig, type Config } from "./config";
import { ScreenpipeClient } from "./screenpipe";

const STALE_FRAMES_MINUTES = 30;

const healthSchema = z
  .object({ status: z.string().nullish(), audio_db_write_stalled: z.boolean().nullish() })
  .passthrough();

export interface HealthResult {
  ok: boolean;
  problems: string[];
}

export function evaluateHealth(
  health: z.infer<typeof healthSchema>,
  newestFrameIso: string | null,
  now: Date,
): HealthResult {
  const problems: string[] = [];
  if (health.status && health.status !== "healthy") problems.push(`recording status: ${health.status}`);
  if (health.audio_db_write_stalled) problems.push("audio transcription stalled");
  if (!newestFrameIso) {
    problems.push("no recent frames found");
  } else {
    const ageMin = (now.getTime() - new Date(newestFrameIso).getTime()) / 60_000;
    if (ageMin > STALE_FRAMES_MINUTES) problems.push(`screen capture stale (${Math.round(ageMin)}m old)`);
  }
  return { ok: problems.length === 0, problems };
}

async function newestFrameIso(client: ScreenpipeClient, now: Date): Promise<string | null> {
  const since = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const items = await client.search({ contentType: "ocr", startIso: since, endIso: now.toISOString(), limit: 1, offset: 0 });
  return items[0]?.content.timestamp ?? null;
}

async function notify(title: string, message: string): Promise<void> {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  await Bun.spawn(["osascript", "-e", script]).exited;
}

async function main(): Promise<void> {
  const config: Config = loadConfig();
  const now = new Date();
  const res = await fetch(`${config.SCREENPIPE_API_URL}/health`);
  const health = healthSchema.parse(await res.json());
  const client = new ScreenpipeClient(config.SCREENPIPE_API_URL, config.SCREENPIPE_API_KEY);
  const newest = await newestFrameIso(client, now).catch(() => null);
  const result = evaluateHealth(health, newest, now);
  if (!result.ok) {
    console.warn("[health] problems:", result.problems);
    await notify("Screenpipe needs attention", result.problems.join("; "));
  } else {
    console.log("[health] ok");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[health] check failed:", err);
    process.exit(1);
  });
}
