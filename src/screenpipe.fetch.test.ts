import { describe, expect, test } from "bun:test";
import { fetchDayActivity, ScreenpipeClient } from "./screenpipe";
import type { Conversation } from "./types";

const ocrOnly = (app: string, text: string) =>
  (async (input: URL) => {
    const ct = new URL(input).searchParams.get("content_type")!;
    const data =
      ct === "ocr"
        ? [{ type: "OCR", content: { app_name: app, text, timestamp: "2026-06-09T10:00:00Z" } }]
        : [];
    return new Response(JSON.stringify({ data, pagination: {} }), { status: 200 });
  }) as unknown as typeof fetch;

const conv: Conversation = {
  channel: "WhatsApp",
  chatName: "Pat",
  isGroup: false,
  messages: [{ sender: "Pat", fromMe: false, text: "hi", timestamp: "2026-06-09T10:00:00Z" }],
};

describe("fetchDayActivity", () => {
  test("queries the three content types over the day window and condenses", async () => {
    const seen: string[] = [];
    const f = (async (input: URL) => {
      const ct = new URL(input).searchParams.get("content_type")!;
      seen.push(ct);
      const data =
        ct === "ocr"
          ? [{ type: "OCR", content: { app_name: "Chrome", text: "hi", timestamp: "2026-06-09T10:00:00Z" } }]
          : [];
      return new Response(JSON.stringify({ data, pagination: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ScreenpipeClient("http://localhost:3030", "tok", f);
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels");
    expect(seen.sort()).toEqual(["audio", "input", "ocr"]);
    expect(digest.apps[0]?.app).toBe("Chrome");
    expect(digest.conversations).toEqual([]);
  });

  test("attaches conversations and suppresses on-screen WhatsApp when the connector contributed", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("WhatsApp", "sidebar preview"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels", async () => [conv]);
    expect(digest.conversations).toEqual([conv]);
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeUndefined(); // suppressed
    expect(digest.isEmpty).toBe(false);
  });

  test("keeps on-screen WhatsApp when the connector returned nothing", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("WhatsApp", "sidebar preview"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels", async () => []);
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeDefined(); // not suppressed
  });
});
