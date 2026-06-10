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
});
