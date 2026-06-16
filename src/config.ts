/**
 * Loads + validates all runtime configuration from the environment.
 * Boundary parse: call once, then trust the typed Config everywhere.
 */
import { z } from "zod";

const configSchema = z
  .object({
    SCREENPIPE_API_URL: z.string().url().default("http://localhost:3030"),
    SCREENPIPE_API_KEY: z.string().min(1),
    OPENROUTER_API_KEY: z.string().min(1),
    CURATION_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4.6"),
    USER_TIMEZONE: z.string().min(1).default("Europe/Brussels"),
    USER_NAME: z.string().min(1).default("the user"),
    // Upload target: "direct" → Assistant Memory; "petals" → Petals proxy.
    UPLOAD_MODE: z.enum(["direct", "petals"]).default("direct"),
    // direct mode (Assistant Memory)
    MEMORY_API_URL: z.string().url().default("http://localhost:3000"),
    MEMORY_API_KEY: z.string().optional(),
    MEMORY_USER_ID: z.string().optional(),
    // petals mode (Petals proxy)
    PETALS_BASE_URL: z.string().url().default("https://petals.chat"),
    PETALS_API_KEY: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.UPLOAD_MODE === "petals" && !cfg.PETALS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PETALS_API_KEY"],
        message: "PETALS_API_KEY is required when UPLOAD_MODE=petals",
      });
    }
    if (cfg.UPLOAD_MODE === "direct" && !cfg.MEMORY_USER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MEMORY_USER_ID"],
        message: "MEMORY_USER_ID is required when UPLOAD_MODE=direct",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
