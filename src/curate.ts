/**
 * Curates a day digest into a Markdown activity document via OpenRouter.
 * The OpenAI client is injectable so tests mock only the external AI.
 */
import OpenAI from "openai";
import type { Config } from "./config";
import type { CuratedDoc, DayDigest } from "./types";
import { buildSystemPrompt, buildUserPrompt } from "./curation-prompt";

export class CurationError extends Error {}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Minimal seam over the OpenAI chat API so tests can inject a fake. */
export interface ChatClient {
  create(args: { model: string; messages: ChatMessage[] }): Promise<{ content: string | null }>;
}

function openRouterClient(config: Config): ChatClient {
  const openai = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: config.OPENROUTER_API_KEY });
  return {
    create: async ({ model, messages }) => {
      const completion = await openai.chat.completions.create({ model, messages, temperature: 0.2 });
      return { content: completion.choices[0]?.message?.content ?? null };
    },
  };
}

function emptyDayMarkdown(dayKey: string): string {
  return `# Computer activity — ${dayKey}\n\n## Notes\nMinimal or no recorded computer activity for this day.`;
}

export async function curateDigest(digest: DayDigest, config: Config, client?: ChatClient): Promise<CuratedDoc> {
  if (digest.isEmpty) return { markdown: emptyDayMarkdown(digest.dayKey), isEmptyDay: true };
  const chat = client ?? openRouterClient(config);
  const { content } = await chat.create({
    model: config.CURATION_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt(config.USER_NAME) },
      { role: "user", content: buildUserPrompt(digest) },
    ],
  });
  const markdown = content?.trim();
  if (!markdown) throw new CurationError("curation returned empty content");
  return { markdown, isEmptyDay: false };
}
