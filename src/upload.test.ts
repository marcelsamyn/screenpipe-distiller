import { describe, expect, test } from "bun:test";
import { buildDocument, resolveTarget, uploadDocument, UploadError } from "./upload";
import type { Config } from "./config";

const doc = { id: "screenpipe-activity-2026-06-09", content: "# x", title: "Computer activity — 2026-06-09", timestampIso: "2026-06-09T12:00:00Z" };
const petalsConfig = { UPLOAD_MODE: "petals", PETALS_BASE_URL: "https://petals.chat", PETALS_API_KEY: "petals-k" } as Config;
const directConfig = { UPLOAD_MODE: "direct", MEMORY_API_URL: "http://localhost:3000", MEMORY_USER_ID: "user_42" } as Config;

describe("buildDocument", () => {
  test("personal-scope markdown doc, no mode/userId", () => {
    const d = buildDocument(doc);
    expect(d.scope).toBe("personal");
    expect(d.contentType).toBe("markdown");
    expect(d.id).toBe("screenpipe-activity-2026-06-09");
    expect(d).not.toHaveProperty("mode");
  });
});

describe("resolveTarget", () => {
  test("petals mode → proxy url, x-api-key, no userId in body", () => {
    const t = resolveTarget(doc, petalsConfig, false);
    expect(t.url).toBe("https://petals.chat/api/memory/ingest/document");
    expect(t.headers["x-api-key"]).toBe("petals-k");
    expect(t.body).not.toHaveProperty("userId");
  });
  test("direct mode → memory url, userId in body, bearer only when key set", () => {
    const t = resolveTarget(doc, directConfig, false);
    expect(t.url).toBe("http://localhost:3000/ingest/document");
    expect((t.body as { userId: string }).userId).toBe("user_42");
    expect(t.headers["Authorization"]).toBeUndefined();
    const withKey = resolveTarget(doc, { ...directConfig, MEMORY_API_KEY: "mk" } as Config, false);
    expect(withKey.headers["Authorization"]).toBe("Bearer mk");
  });
  test("updateExisting flag rides the body in both modes", () => {
    expect((resolveTarget(doc, petalsConfig, true).body as { updateExisting: boolean }).updateExisting).toBe(true);
    expect((resolveTarget(doc, directConfig, true).body as { updateExisting: boolean }).updateExisting).toBe(true);
    expect((resolveTarget(doc, directConfig, false).body as { updateExisting: boolean }).updateExisting).toBe(false);
  });
  test("petals mode without key throws", () => {
    expect(() => resolveTarget(doc, { UPLOAD_MODE: "petals", PETALS_BASE_URL: "https://petals.chat" } as Config, false)).toThrow(UploadError);
  });
});

describe("uploadDocument", () => {
  test("returns jobId on 2xx and sends resolved headers + updateExisting body", async () => {
    let headerSeen = "";
    let bodySeen: { updateExisting?: boolean } = {};
    const f = (async (_url: string, init: RequestInit) => {
      headerSeen = new Headers(init.headers).get("x-api-key") ?? "";
      bodySeen = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ message: "ok", jobId: "job_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, petalsConfig, true, { fetchImpl: f, sleep: async () => {} });
    expect(res.jobId).toBe("job_1");
    expect(headerSeen).toBe("petals-k");
    expect(bodySeen.updateExisting).toBe(true);
  });
  test("throws UploadError on 4xx without retrying", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("bad", { status: 400 }); }) as unknown as typeof fetch;
    await expect(uploadDocument(doc, directConfig, false, { fetchImpl: f, sleep: async () => {} })).rejects.toBeInstanceOf(UploadError);
    expect(calls).toBe(1);
  });
  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 2 ? new Response("err", { status: 503 }) : new Response(JSON.stringify({ message: "ok", jobId: "job_2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, directConfig, false, { fetchImpl: f, sleep: async () => {} });
    expect(res.jobId).toBe("job_2");
    expect(calls).toBe(2);
  });
});
