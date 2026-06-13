/**
 * Screenpipe local REST client + day condenser.
 * Aliases: screenpipe search, activity digest, /search client.
 */
import { z } from "zod";
import type { AppActivity, Conversation, DayDigest } from "./types";
import { dayWindowUtc } from "./date-utils";
import { classifyChannel } from "./channels";

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
    const maxOffset = 20_000;
    const out: SearchItem[] = [];
    for (let offset = 0; offset <= maxOffset; offset += limit) {
      const batch = await this.search({ ...params, limit, offset });
      out.push(...batch);
      if (batch.length < limit) return out;
    }
    console.warn(
      `[screenpipe] ${params.contentType} hit the ${maxOffset}-row page ceiling; ` +
        `later rows of the day were not fetched (raise maxOffset if this recurs).`,
    );
    return out;
  }
}

const MAX_APPS = 20;
const MAX_SAMPLE_TEXT_PER_APP = 10;
const MAX_SAMPLE_TEXT_PER_COMMS_APP = 25;
const MAX_TEXT_LEN = 500;
const MAX_TEXT_CANDIDATES = 300;

// Media playback (videos, music) is captured as system output audio, not
// conversation. Real microphone/diarized speech carries a different speaker label.
const SYSTEM_AUDIO_SPEAKER = "System Audio";

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pushDistinct(arr: string[], value: string | null | undefined): void {
  if (value && value.trim() && !arr.includes(value)) arr.push(value);
}

const SCREEN_TYPES = new Set(["OCR", "UI", "Accessibility"]);

export function condenseItems(
  items: SearchItem[],
  dayKey: string,
  opts: { suppressBucket?: (key: string) => boolean } = {},
): DayDigest {
  const byApp = new Map<string, AppActivityAcc>();
  const audio: DayDigest["audio"] = [];
  let totalFrames = 0;
  let droppedSystemAudio = 0;

  for (const item of items) {
    const c = item.content;
    if (item.type === "Audio") {
      const text = (c.transcription ?? c.text ?? "").trim();
      if (!text) continue;
      const speaker = c.speaker_label ?? null;
      if (speaker === SYSTEM_AUDIO_SPEAKER) {
        droppedSystemAudio += 1;
        continue;
      }
      audio.push({ speaker, text, timestamp: c.timestamp });
      continue;
    }
    const { bucketKey, isComms } = classifyChannel(c);
    if (opts.suppressBucket?.(bucketKey)) continue;
    // isComms is invariant for a given bucketKey — classifyChannel guarantees it,
    // so the first frame's value applies to the whole bucket.
    const acc = byApp.get(bucketKey) ?? newAcc(isComms);
    byApp.set(bucketKey, acc);
    if (SCREEN_TYPES.has(item.type)) totalFrames += 1;
    acc.frames += 1;
    pushDistinct(acc.windows, c.window_name ?? c.window_title);
    pushDistinct(acc.urls, c.browser_url);
    const raw = (c.text ?? c.text_content ?? "").trim();
    if (raw) {
      const snippet = truncate(raw, MAX_TEXT_LEN);
      if (snippet && !acc.seenText.has(snippet) && acc.texts.length < MAX_TEXT_CANDIDATES) {
        acc.seenText.add(snippet);
        acc.texts.push({ len: raw.length, snippet, ts: c.timestamp });
      }
    }
    if (!acc.firstSeen || c.timestamp < acc.firstSeen) acc.firstSeen = c.timestamp;
    if (!acc.lastSeen || c.timestamp > acc.lastSeen) acc.lastSeen = c.timestamp;
  }

  const ranked = [...byApp.entries()]
    .map(([app, a]) => {
      // Conversations: keep the most RECENT thread content with a larger budget.
      // Everything else: keep the longest distinct blocks (prose > UI chrome).
      const ordered = a.isComms
        ? [...a.texts].sort((t1, t2) => (t1.ts < t2.ts ? 1 : t1.ts > t2.ts ? -1 : 0))
        : [...a.texts].sort((t1, t2) => t2.len - t1.len);
      const budget = a.isComms ? MAX_SAMPLE_TEXT_PER_COMMS_APP : MAX_SAMPLE_TEXT_PER_APP;
      const activity: AppActivity = {
        app,
        windows: a.windows,
        urls: a.urls,
        sampleText: ordered.slice(0, budget).map((t) => t.snippet),
        firstSeen: a.firstSeen ?? "",
        lastSeen: a.lastSeen ?? "",
        frames: a.frames,
      };
      return { activity, isComms: a.isComms };
    })
    .sort((x, y) => y.activity.frames - x.activity.frames);

  // Keep the top apps by activity, but never drop a communication channel that
  // has real conversation text just because it was low-frame — those are high value.
  const top = ranked.slice(0, MAX_APPS);
  const extraComms = ranked.slice(MAX_APPS).filter((r) => r.isComms && r.activity.sampleText.length > 0);
  const apps = [...top, ...extraComms].map((r) => r.activity);

  if (ranked.length > apps.length) {
    console.warn(
      `[condense] ${dayKey}: kept top ${MAX_APPS} apps by frames` +
        `${extraComms.length ? ` + ${extraComms.length} communication channel(s)` : ""}, dropped ${ranked.length - apps.length}`,
    );
  }
  if (droppedSystemAudio > 0) {
    console.warn(
      `[condense] ${dayKey}: dropped ${droppedSystemAudio} system-audio (media playback) snippet(s) — not conversation`,
    );
  }

  const conversations: Conversation[] = [];
  return {
    dayKey,
    apps,
    audio,
    conversations,
    totalFrames,
    isEmpty: apps.length === 0 && audio.length === 0 && conversations.length === 0,
  };
}

interface AppActivityAcc {
  isComms: boolean;
  windows: string[];
  urls: string[];
  texts: { len: number; snippet: string; ts: string }[];
  seenText: Set<string>;
  firstSeen: string | null;
  lastSeen: string | null;
  frames: number;
}

function newAcc(isComms: boolean): AppActivityAcc {
  return { isComms, windows: [], urls: [], texts: [], seenText: new Set(), firstSeen: null, lastSeen: null, frames: 0 };
}

export async function fetchDayActivity(
  client: ScreenpipeClient,
  dayKey: string,
  timeZone: string,
): Promise<DayDigest> {
  const { startIso, endIso } = dayWindowUtc(dayKey, timeZone);
  const [ocr, audio, input] = await Promise.all([
    client.searchAll({ contentType: "ocr", startIso, endIso, minLength: 50 }),
    client.searchAll({ contentType: "audio", startIso, endIso }),
    client.searchAll({ contentType: "input", startIso, endIso }),
  ]);
  return condenseItems([...ocr, ...audio, ...input], dayKey);
}
