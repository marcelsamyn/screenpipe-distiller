import { describe, expect, test } from "bun:test";
import { ScreenpipeClient, ScreenpipeError } from "./screenpipe";

function fakeFetch(pages: unknown[][]): typeof fetch {
  let i = 0;
  return (async () => {
    const data = pages[i++] ?? [];
    return new Response(JSON.stringify({ data, pagination: { total: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("ScreenpipeClient", () => {
  test("parses items and stops when a page is short", async () => {
    const item = { type: "OCR", content: { text: "hello", app_name: "Chrome", timestamp: "2026-06-09T10:00:00Z" } };
    const client = new ScreenpipeClient("http://localhost:3030", "tok", fakeFetch([[item]]));
    const items = await client.searchAll({ contentType: "ocr", startIso: "a", endIso: "b" });
    expect(items.length).toBe(1);
    expect(items[0]?.type).toBe("OCR");
    expect(items[0]?.content.app_name).toBe("Chrome");
  });

  test("throws ScreenpipeError on non-200", async () => {
    const f = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new ScreenpipeClient("http://localhost:3030", "tok", f);
    await expect(client.search({ contentType: "ocr", startIso: "a", endIso: "b", limit: 10, offset: 0 })).rejects.toBeInstanceOf(ScreenpipeError);
  });
});
