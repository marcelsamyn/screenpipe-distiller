/**
 * Screenpipe local REST client + day condenser.
 * Aliases: screenpipe search, activity digest, /search client.
 */
import { z } from "zod";
import type { AppActivity, DayDigest } from "./types";
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

const MAX_APPS = 20;
const MAX_SAMPLE_TEXT_PER_APP = 8;
const MAX_TEXT_LEN = 200;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pushDistinct(arr: string[], value: string | null | undefined): void {
  if (value && value.trim() && !arr.includes(value)) arr.push(value);
}

const SCREEN_TYPES = new Set(["OCR", "UI", "Accessibility"]);

export function condenseItems(items: SearchItem[], dayKey: string): DayDigest {
  const byApp = new Map<string, AppActivityAcc>();
  const audio: DayDigest["audio"] = [];
  let totalFrames = 0;

  for (const item of items) {
    const c = item.content;
    if (item.type === "Audio") {
      const text = (c.transcription ?? c.text ?? "").trim();
      if (text) audio.push({ speaker: c.speaker_label ?? null, text, timestamp: c.timestamp });
      continue;
    }
    const app = (c.app_name ?? "Unknown").trim() || "Unknown";
    const acc = byApp.get(app) ?? newAcc();
    byApp.set(app, acc);
    if (SCREEN_TYPES.has(item.type)) totalFrames += 1;
    acc.frames += 1;
    pushDistinct(acc.windows, c.window_name ?? c.window_title);
    pushDistinct(acc.urls, c.browser_url);
    const text = c.text ?? c.text_content;
    if (text && text.trim()) {
      const snippet = truncate(text, MAX_TEXT_LEN);
      if (snippet && acc.sampleText.length < MAX_SAMPLE_TEXT_PER_APP && !acc.sampleText.includes(snippet)) {
        acc.sampleText.push(snippet);
      }
    }
    if (!acc.firstSeen || c.timestamp < acc.firstSeen) acc.firstSeen = c.timestamp;
    if (!acc.lastSeen || c.timestamp > acc.lastSeen) acc.lastSeen = c.timestamp;
  }

  const apps: AppActivity[] = [...byApp.entries()]
    .map(([app, a]) => ({
      app,
      windows: a.windows,
      urls: a.urls,
      sampleText: a.sampleText,
      firstSeen: a.firstSeen ?? "",
      lastSeen: a.lastSeen ?? "",
      frames: a.frames,
    }))
    .sort((x, y) => y.frames - x.frames)
    .slice(0, MAX_APPS);

  return { dayKey, apps, audio, totalFrames, isEmpty: apps.length === 0 && audio.length === 0 };
}

interface AppActivityAcc {
  windows: string[];
  urls: string[];
  sampleText: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  frames: number;
}

function newAcc(): AppActivityAcc {
  return { windows: [], urls: [], sampleText: [], firstSeen: null, lastSeen: null, frames: 0 };
}
