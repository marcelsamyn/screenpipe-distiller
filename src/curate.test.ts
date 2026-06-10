import { describe, expect, test } from "bun:test";
import { curateDigest, type ChatClient } from "./curate";
import type { Config } from "./config";
import type { DayDigest } from "./types";

const config = { CURATION_MODEL: "test/model", OPENROUTER_API_KEY: "k" } as Config;

const nonEmpty: DayDigest = {
  dayKey: "2026-06-09",
  apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: ["x"], firstSeen: "2026-06-09T10:00:00Z", lastSeen: "2026-06-09T11:00:00Z", frames: 3 }],
  audio: [],
  totalFrames: 3,
  isEmpty: false,
};

describe("curateDigest", () => {
  test("short-circuits an empty day without calling the LLM", async () => {
    let called = false;
    const client: ChatClient = { create: async () => { called = true; return { content: "x" }; } };
    const empty: DayDigest = { dayKey: "2026-06-09", apps: [], audio: [], totalFrames: 0, isEmpty: true };
    const doc = await curateDigest(empty, config, client);
    expect(called).toBe(false);
    expect(doc.isEmptyDay).toBe(true);
    expect(doc.markdown).toContain("2026-06-09");
  });

  test("sends system + user messages and returns the model markdown", async () => {
    let captured: { model: string; system: string; user: string } | null = null;
    const client: ChatClient = {
      create: async ({ model, messages }) => {
        captured = { model, system: messages[0]!.content, user: messages[1]!.content };
        return { content: "# Computer activity — 2026-06-09\n\n## What I worked on\n- stuff" };
      },
    };
    const doc = await curateDigest(nonEmpty, config, client);
    expect(captured!.model).toBe("test/model");
    expect(captured!.system).toContain("No action items");
    expect(captured!.user).toContain("Ghostty");
    expect(doc.isEmptyDay).toBe(false);
    expect(doc.markdown).toContain("What I worked on");
  });
});
