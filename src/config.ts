/**
 * Loads + validates all runtime configuration from the environment.
 * Boundary parse: call once, then trust the typed Config everywhere.
 */
import { z } from "zod";

const configSchema = z.object({
  SCREENPIPE_API_URL: z.string().url().default("http://localhost:3030"),
  SCREENPIPE_API_KEY: z.string().min(1),
  PETALS_BASE_URL: z.string().url().default("https://petals.chat"),
  PETALS_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  CURATION_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4.6"),
  USER_TIMEZONE: z.string().min(1).default("Europe/Brussels"),
  USER_NAME: z.string().min(1).default("the user"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
