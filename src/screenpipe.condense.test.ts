import { describe, expect, spyOn, test } from "bun:test";
import { condenseItems, type SearchItem } from "./screenpipe";

const ocr = (app: string, text: string, ts: string, url?: string, window?: string): SearchItem => ({
  type: "OCR",
  content: { app_name: app, text, timestamp: ts, browser_url: url, window_name: window },
});

describe("condenseItems", () => {
  test("groups by app, dedupes windows/urls/text, counts frames", () => {
    const items: SearchItem[] = [
      ocr("Chrome", "GitHub - foo/bar", "2026-06-09T09:00:00Z", "https://github.com/foo/bar", "foo/bar"),
      ocr("Chrome", "GitHub - foo/bar", "2026-06-09T09:01:00Z", "https://github.com/foo/bar", "foo/bar"),
      ocr("Chrome", "Pull requests", "2026-06-09T09:05:00Z", "https://github.com/foo/bar/pulls", "foo/bar"),
      ocr("Ghostty", "$ bun test", "2026-06-09T10:00:00Z", undefined, "marcel — zsh"),
    ];
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.isEmpty).toBe(false);
    expect(digest.totalFrames).toBe(4);
    const chrome = digest.apps.find((a) => a.app === "Chrome");
    expect(chrome?.frames).toBe(3);
    expect(chrome?.urls).toEqual(["https://github.com/foo/bar", "https://github.com/foo/bar/pulls"]);
    expect(chrome?.windows).toEqual(["foo/bar"]);
    expect(chrome?.sampleText).toContain("GitHub - foo/bar");
    expect(chrome?.firstSeen).toBe("2026-06-09T09:00:00Z");
    expect(chrome?.lastSeen).toBe("2026-06-09T09:05:00Z");
    expect(digest.apps[0]?.app).toBe("Chrome");
  });

  test("maps audio to snippets and ignores empty transcriptions", () => {
    const items: SearchItem[] = [
      { type: "Audio", content: { transcription: "let's ship it", speaker_label: "Marcel", timestamp: "2026-06-09T11:00:00Z" } },
      { type: "Audio", content: { transcription: "", speaker_label: "Marcel", timestamp: "2026-06-09T11:01:00Z" } },
    ];
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.audio.length).toBe(1);
    expect(digest.audio[0]).toEqual({ speaker: "Marcel", text: "let's ship it", timestamp: "2026-06-09T11:00:00Z" });
  });

  test("empty input yields isEmpty digest", () => {
    const digest = condenseItems([], "2026-06-09");
    expect(digest.isEmpty).toBe(true);
    expect(digest.apps).toEqual([]);
    expect(digest.audio).toEqual([]);
  });

  test("warns when apps exceed MAX_APPS and are dropped", () => {
    const items: SearchItem[] = Array.from({ length: 25 }, (_, i) =>
      ocr(`App${i}`, "text", "2026-06-09T09:00:00Z"),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.apps.length).toBe(20);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("keeps the longest distinct text blocks when over the per-app cap", () => {
    const items: SearchItem[] = Array.from({ length: 12 }, (_, i) =>
      ocr("Zed", "x".repeat(i + 1), "2026-06-09T09:00:00Z"),
    );
    const digest = condenseItems(items, "2026-06-09");
    const zed = digest.apps.find((a) => a.app === "Zed");
    expect(zed?.sampleText.length).toBe(10);
    expect(zed?.sampleText).not.toContain("x"); // shortest dropped
    expect(zed?.sampleText).not.toContain("xx");
    expect(zed?.sampleText).toContain("x".repeat(12)); // longest kept
  });

  test("drops system-audio (media playback) but keeps real speech", () => {
    const items: SearchItem[] = [
      { type: "Audio", content: { transcription: "this is how you do a dead bug", speaker_label: "System Audio", timestamp: "2026-06-09T11:00:00Z" } },
      { type: "Audio", content: { transcription: "can you review my PR?", speaker_label: "Yuri", timestamp: "2026-06-09T11:05:00Z" } },
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.audio.length).toBe(1);
    expect(digest.audio[0]?.speaker).toBe("Yuri");
    warn.mockRestore();
  });

  test("gives communication apps a larger, recency-biased text budget", () => {
    const items: SearchItem[] = Array.from({ length: 20 }, (_, i) =>
      ocr("Slack", `message ${String(i).padStart(2, "0")}`, `2026-06-09T09:${String(i).padStart(2, "0")}:00Z`),
    );
    const digest = condenseItems(items, "2026-06-09");
    const slack = digest.apps.find((a) => a.app === "Slack");
    expect(slack?.sampleText.length).toBe(20); // all 20 kept (above the non-comms cap of 10)
    expect(slack?.sampleText[0]).toBe("message 19"); // most recent first
  });

  test("never drops a communication app with content, even when low-frame", () => {
    const items: SearchItem[] = [
      ...Array.from({ length: 25 }, (_, i) => ocr(`App${i}`, "x".repeat(60), `2026-06-09T08:00:0${i % 10}Z`)),
      ocr("Slack", "Yuri: ping about the release", "2026-06-09T09:00:00Z"),
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const digest = condenseItems(items, "2026-06-09");
    expect(digest.apps.find((a) => a.app === "Slack")).toBeDefined();
    warn.mockRestore();
  });

  test("splits a WhatsApp-Web frame out of the generic Chrome bucket", () => {
    const items: SearchItem[] = [
      ocr("Google Chrome", "GitHub - foo/bar", "2026-06-12T09:00:00Z", "https://github.com/foo/bar", "foo/bar"),
      ocr("Google Chrome", "Lorena: thanks so much!! 🎉", "2026-06-12T09:05:00Z", "https://web.whatsapp.com/", "WhatsApp"),
    ];
    const digest = condenseItems(items, "2026-06-12");
    const whatsapp = digest.apps.find((a) => a.app === "WhatsApp (web)");
    const chrome = digest.apps.find((a) => a.app === "Google Chrome");
    expect(whatsapp).toBeDefined();
    expect(whatsapp?.sampleText).toContain("Lorena: thanks so much!! 🎉");
    expect(chrome).toBeDefined();
    expect(chrome?.sampleText).toContain("GitHub - foo/bar");
    expect(chrome?.sampleText).not.toContain("Lorena: thanks so much!! 🎉");
  });

  test("gives a browser comms channel the larger, recency-first budget", () => {
    const items: SearchItem[] = Array.from({ length: 20 }, (_, i) =>
      ocr(
        "Google Chrome",
        `message ${String(i).padStart(2, "0")}`,
        `2026-06-12T09:${String(i).padStart(2, "0")}:00Z`,
        "https://web.whatsapp.com/",
        "WhatsApp",
      ),
    );
    const digest = condenseItems(items, "2026-06-12");
    const whatsapp = digest.apps.find((a) => a.app === "WhatsApp (web)");
    expect(whatsapp?.sampleText.length).toBe(20); // above the non-comms cap of 10
    expect(whatsapp?.sampleText[0]).toBe("message 19"); // most recent first
  });

  test("never drops a low-frame browser comms channel", () => {
    const items: SearchItem[] = [
      ...Array.from({ length: 25 }, (_, i) => ocr(`App${i}`, "x".repeat(60), `2026-06-12T08:00:0${i % 10}Z`)),
      ocr("Google Chrome", "Lorena: see you tonight", "2026-06-12T09:00:00Z", "https://web.whatsapp.com/", "WhatsApp"),
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const digest = condenseItems(items, "2026-06-12");
    expect(digest.apps.find((a) => a.app === "WhatsApp (web)")).toBeDefined();
    warn.mockRestore();
  });

  test("suppressBucket drops matching buckets entirely", () => {
    const items: SearchItem[] = [
      ocr("WhatsApp", "Lorena: hi", "2026-06-12T09:00:00Z"),
      ocr("Zed", "code", "2026-06-12T09:01:00Z"),
    ];
    const digest = condenseItems(items, "2026-06-12", {
      suppressBucket: (key) => key.toLowerCase().includes("whatsapp"),
    });
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeUndefined();
    expect(digest.apps.find((a) => a.app === "Zed")).toBeDefined();
  });

  test("digest carries an empty conversations array by default", () => {
    expect(condenseItems([], "2026-06-12").conversations).toEqual([]);
  });
});
