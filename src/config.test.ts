import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const directBase = {
  SCREENPIPE_API_KEY: "sp-key",
  OPENROUTER_API_KEY: "or-key",
  MEMORY_USER_ID: "user_x",
};

describe("loadConfig", () => {
  test("applies defaults for optional fields (direct mode)", () => {
    const cfg = loadConfig(directBase);
    expect(cfg.SCREENPIPE_API_URL).toBe("http://localhost:3030");
    expect(cfg.UPLOAD_MODE).toBe("direct");
    expect(cfg.MEMORY_API_URL).toBe("http://localhost:3000");
    expect(cfg.CURATION_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(cfg.USER_TIMEZONE).toBe("Europe/Brussels");
    expect(cfg.USER_NAME).toBe("the user");
  });

  test("throws when a required secret is missing", () => {
    expect(() => loadConfig({ SCREENPIPE_API_KEY: "x", MEMORY_USER_ID: "u" })).toThrow();
  });

  test("petals mode requires PETALS_API_KEY", () => {
    expect(() => loadConfig({ SCREENPIPE_API_KEY: "x", OPENROUTER_API_KEY: "o", UPLOAD_MODE: "petals" })).toThrow();
  });

  test("direct mode requires MEMORY_USER_ID", () => {
    expect(() => loadConfig({ SCREENPIPE_API_KEY: "x", OPENROUTER_API_KEY: "o", UPLOAD_MODE: "direct" })).toThrow();
  });

  test("defaults the WhatsApp connector to auto and expands the archive ~path", () => {
    const cfg = loadConfig(directBase);
    expect(cfg.WHATSAPP_CONNECTOR).toBe("auto");
    expect(cfg.WHATSAPP_GROUP_FILTER).toBe("contacts");
    expect(cfg.WHATSAPP_ARCHIVE_PATH.startsWith("~")).toBe(false);
    expect(cfg.WHATSAPP_ARCHIVE_PATH.endsWith("/.screenpipe-distiller/whatsapp/messages.sqlite")).toBe(true);
  });

  test("honors an explicit connector value, group filter, and absolute archive path", () => {
    const cfg = loadConfig({ ...directBase, WHATSAPP_CONNECTOR: "off", WHATSAPP_GROUP_FILTER: "all", WHATSAPP_ARCHIVE_PATH: "/tmp/wa.sqlite" });
    expect(cfg.WHATSAPP_CONNECTOR).toBe("off");
    expect(cfg.WHATSAPP_GROUP_FILTER).toBe("all");
    expect(cfg.WHATSAPP_ARCHIVE_PATH).toBe("/tmp/wa.sqlite");
  });
});
