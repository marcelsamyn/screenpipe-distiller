import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, buildUserPrompt } from "./curation-prompt";
import type { DayDigest } from "./types";

const digest: DayDigest = {
  dayKey: "2026-06-09",
  apps: [{ app: "Ghostty", windows: ["zsh"], urls: [], sampleText: ["$ bun test"], firstSeen: "2026-06-09T10:00:00Z", lastSeen: "2026-06-09T11:00:00Z", frames: 12 }],
  audio: [{ speaker: "Marcel", text: "let's ship it", timestamp: "2026-06-09T11:00:00Z" }],
  totalFrames: 12,
  isEmpty: false,
};

describe("curation prompt", () => {
  test("system prompt forbids action items, infers nothing, and includes name + sections", () => {
    const sys = buildSystemPrompt("Marcel");
    expect(sys).toContain("No invented action items");
    expect(sys).toContain("DO capture real commitments");
    expect(sys.toLowerCase()).toContain("exposure");
    expect(sys).toContain("Never guess which project");
    expect(sys).toContain("Marcel");
    expect(sys).toContain("Notable knowledge");
    expect(sys).toContain("Conversations & meetings");
    expect(sys).toContain("Commitments & promises");
  });

  test("user prompt renders apps, urls, and audio for the day", () => {
    const p = buildUserPrompt(digest);
    expect(p).toContain("2026-06-09");
    expect(p).toContain("Ghostty");
    expect(p).toContain("$ bun test");
    expect(p).toContain("let's ship it");
  });
});
