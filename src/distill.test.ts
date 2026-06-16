import { describe, expect, test } from "bun:test";
import { runDistill, type DistillDeps } from "./distill";
import type { Config } from "./config";
import type { DayDigest } from "./types";

const config = { USER_TIMEZONE: "Europe/Brussels" } as Config;

describe("runDistill", () => {
  test("fetch → curate → upload, returning the jobId", async () => {
    const digest: DayDigest = { dayKey: "2026-06-09", apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: [], firstSeen: "", lastSeen: "", frames: 1 }], audio: [], totalFrames: 1, isEmpty: false };
    let uploadedId = "";
    const deps: DistillDeps = {
      fetchDay: async () => digest,
      curate: async () => ({ markdown: "# doc", isEmptyDay: false }),
      upload: async (p) => { uploadedId = p.id; return { jobId: "job_9" }; },
    };
    const res = await runDistill("2026-06-09", config, deps);
    expect(res.jobId).toBe("job_9");
    expect(uploadedId).toBe("screenpipe-activity-2026-06-09");
  });

  test("passes updateExisting through to the upload dep (default false)", async () => {
    const digest: DayDigest = { dayKey: "2026-06-09", apps: [], audio: [], totalFrames: 0, isEmpty: true };
    const seen: boolean[] = [];
    const deps: DistillDeps = {
      fetchDay: async () => digest,
      curate: async () => ({ markdown: "# doc", isEmptyDay: true }),
      upload: async (_p, updateExisting) => { seen.push(updateExisting); return { jobId: "job_u" }; },
    };
    await runDistill("2026-06-09", config, deps);
    await runDistill("2026-06-09", config, deps, { updateExisting: true });
    expect(seen).toEqual([false, true]);
  });

  test("dry-run skips upload and returns the curated markdown", async () => {
    const digest: DayDigest = {
      dayKey: "2026-06-09",
      apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: [], firstSeen: "", lastSeen: "", frames: 1 }],
      audio: [],
      totalFrames: 1,
      isEmpty: false,
    };
    let uploadCalled = false;
    const deps: DistillDeps = {
      fetchDay: async () => digest,
      curate: async () => ({ markdown: "# preview doc", isEmptyDay: false }),
      upload: async () => { uploadCalled = true; return { jobId: "should-not-happen" }; },
    };
    const res = await runDistill("2026-06-09", config, deps, { dryRun: true });
    expect(uploadCalled).toBe(false);
    expect(res.jobId).toBe(null);
    expect(res.markdown).toBe("# preview doc");
  });
});
