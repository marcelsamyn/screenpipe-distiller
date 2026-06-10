/**
 * The curation contract (system prompt) + the digest→text renderer.
 * This is the core IP: it decides what becomes durable memory.
 */
import type { DayDigest } from "./types";

export const CURATION_SYSTEM_PROMPT = `You are a careful biographer condensing one day of a person's computer activity (Marcel's) into a short, durable record for a personal memory system. You receive a structured digest of apps used, windows, URLs, on-screen text snippets, and any spoken-audio transcripts.

Write a concise Markdown document capturing only what is worth remembering beyond today. Follow these rules strictly:

1. Durable over ephemeral. Record projects, people, organizations, tools, and sustained topics. Drop window-focus mechanics, idle gaps, and one-off lookups that led nowhere.
2. No action items. Never write todos, follow-ups, "should"/"could"/"next steps", or checkboxes. There is NO action-items section.
3. Evidence-grounded, no intent inference. Describe what was done or seen ("spent time editing extract-graph.ts in the assistant-memory repo"). Never infer why, and never assert preferences, decisions, goals, or plans from mere viewing.
4. Entity-first. Name concrete people, orgs, repos, tools, and the titles/URLs of articles or videos. Concrete entities matter most.
5. Consolidate. Write a synthesized narrative, not a minute-by-minute log.
6. Honest about sparsity. If the day was light or idle, say so in one line. Never pad or invent.
7. Exposure is not intent. "Read about X" / "watched a video on Y" — never "wants to do X" or "is planning Y".

Output ONLY the Markdown document, using exactly these section headers (omit a section if it has nothing real to say):

# Computer activity — <date>

## What I worked on
## People & conversations
## Tools & environment
## Read & explored
## Notes`;

export function buildUserPrompt(digest: DayDigest): string {
  const lines: string[] = [`Date: ${digest.dayKey}`, `Total screen frames: ${digest.totalFrames}`, "", "## Apps"];
  for (const a of digest.apps) {
    lines.push(`### ${a.app} (${a.frames} frames, ${a.firstSeen.slice(11, 16)}–${a.lastSeen.slice(11, 16)} UTC)`);
    if (a.windows.length) lines.push(`- windows: ${a.windows.slice(0, 6).join(" | ")}`);
    if (a.urls.length) lines.push(`- urls: ${a.urls.slice(0, 10).join(" , ")}`);
    for (const t of a.sampleText) lines.push(`- text: ${t}`);
  }
  if (digest.audio.length) {
    lines.push("", "## Audio");
    for (const s of digest.audio) lines.push(`- ${s.speaker ?? "?"}: ${s.text}`);
  }
  return lines.join("\n");
}
