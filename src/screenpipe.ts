/**
 * Screenpipe local REST client + day condenser.
 * Aliases: screenpipe search, activity digest, /search client.
 */
import { z } from "zod";
import type { DayDigest } from "./types";
import { dayWindowUtc } from "./date-utils";

export class ScreenpipeError extends Error {}

const contentSchema = z
  .object({
    text: z.string().nullish(),
    transcription: z.string().nullish(),
    app_name: z.string().nullish(),
    window_name: z.string().nullish(),
    window_title: z.string().nullish(),
    browser_url: z.string().nullish(),
    speaker_label: z.string().nullish(),
    text_content: z.string().nullish(),
    event_type: z.string().nullish(),
    timestamp: z.string(),
  })
  .passthrough();

const searchItemSchema = z.object({ type: z.string(), content: contentSchema });
const searchResponseSchema = z.object({
  data: z.array(searchItemSchema),
  pagination: z.unknown().nullish(),
});

export type SearchItem = z.infer<typeof searchItemSchema>;

export type ContentType = "ocr" | "audio" | "input" | "accessibility" | "all";

interface SearchParams {
  contentType: ContentType;
  startIso: string;
  endIso: string;
  limit: number;
  offset: number;
  minLength?: number;
}

export class ScreenpipeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(params: SearchParams): Promise<SearchItem[]> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("content_type", params.contentType);
    url.searchParams.set("start_time", params.startIso);
    url.searchParams.set("end_time", params.endIso);
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("offset", String(params.offset));
    if (params.minLength != null) url.searchParams.set("min_length", String(params.minLength));

    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) {
      throw new ScreenpipeError(`screenpipe /search ${params.contentType} failed: ${res.status} ${await res.text()}`);
    }
    return searchResponseSchema.parse(await res.json()).data;
  }

  async searchAll(params: Omit<SearchParams, "limit" | "offset">): Promise<SearchItem[]> {
    const limit = 500;
    const out: SearchItem[] = [];
    for (let offset = 0; offset <= 20_000; offset += limit) {
      const batch = await this.search({ ...params, limit, offset });
      out.push(...batch);
      if (batch.length < limit) break;
    }
    return out;
  }
}
