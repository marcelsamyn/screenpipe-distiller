import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const base = {
  SCREENPIPE_API_KEY: "sp-key",
  PETALS_API_KEY: "petals-key",
  OPENROUTER_API_KEY: "or-key",
};

describe("loadConfig", () => {
  test("applies defaults for optional fields", () => {
    const cfg = loadConfig(base);
    expect(cfg.SCREENPIPE_API_URL).toBe("http://localhost:3030");
    expect(cfg.PETALS_BASE_URL).toBe("https://petals.chat");
    expect(cfg.CURATION_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(cfg.USER_TIMEZONE).toBe("Europe/Brussels");
  });

  test("throws when a required secret is missing", () => {
    expect(() => loadConfig({ SCREENPIPE_API_KEY: "x", PETALS_API_KEY: "y" })).toThrow();
  });
});
