import { describe, expect, test } from "bun:test";
import { buildDocumentBody, uploadDocument, UploadError } from "./upload";
import type { Config } from "./config";

const config = { PETALS_BASE_URL: "https://petals.chat", PETALS_API_KEY: "petals-k" } as Config;
const doc = { id: "screenpipe-activity-2026-06-09", content: "# x", title: "Computer activity — 2026-06-09", timestampIso: "2026-06-09T12:00:00Z" };

describe("upload", () => {
  test("buildDocumentBody produces a personal-scope markdown document", () => {
    const body = buildDocumentBody(doc);
    expect(body.document.scope).toBe("personal");
    expect(body.document.contentType).toBe("markdown");
    expect(body.document.id).toBe("screenpipe-activity-2026-06-09");
    expect(body).not.toHaveProperty("mode"); // v1 sends no mode
  });

  test("returns jobId on 2xx and sends x-api-key", async () => {
    let headerSeen = "";
    const f = (async (_url: string, init: RequestInit) => {
      headerSeen = new Headers(init.headers).get("x-api-key") ?? "";
      return new Response(JSON.stringify({ message: "ok", jobId: "job_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, config, { fetchImpl: f, sleep: async () => {} });
    expect(res.jobId).toBe("job_1");
    expect(headerSeen).toBe("petals-k");
  });

  test("throws UploadError on 4xx without retrying", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("bad", { status: 400 }); }) as unknown as typeof fetch;
    await expect(uploadDocument(doc, config, { fetchImpl: f, sleep: async () => {} })).rejects.toBeInstanceOf(UploadError);
    expect(calls).toBe(1);
  });

  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 2 ? new Response("err", { status: 503 }) : new Response(JSON.stringify({ message: "ok", jobId: "job_2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await uploadDocument(doc, config, { fetchImpl: f, sleep: async () => {} });
    expect(res.jobId).toBe("job_2");
    expect(calls).toBe(2);
  });
});
