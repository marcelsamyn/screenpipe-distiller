# Browser-based conversation detection

**Date:** 2026-06-13
**Status:** Approved, ready for planning

## Problem

WhatsApp conversations viewed in Chrome never reach the daily summary. The data
*is* captured by Screenpipe (verified: 44+ accessibility captures of WhatsApp Web
on 2026-06-12), but the distiller drops it.

Root cause, confirmed against live data:

1. **Misclassification + merging.** `condenseItems` buckets every frame by
   `app_name` and decides "is this a conversation?" via `isCommunicationApp(app_name)`
   (`screenpipe.ts:111-114, 171`). WhatsApp Web reports `app_name = "Google Chrome"`,
   so it is (a) never treated as communication and (b) merged into one giant
   "Google Chrome" bucket alongside every other tab. That bucket is sampled to just
   **10 snippets, longest-first** (`screenpipe.ts:174-177`), where WhatsApp's text
   loses to large pages (e.g. an 806k-token AI Studio tab). Measured: on 2026-06-12
   the "Google Chrome" bucket spanned 1759 frames / 208 URLs but contributed only 10
   text snippets — WhatsApp was not among them.

2. **Capture ceiling (out of scope to fix here).** WhatsApp Web exposes only its
   **left sidebar** (chat list + the single most-recent message per chat) to the
   accessibility tree, not the open thread. Verified: opening a chat and typing a
   message does not surface that message in the data — only the other party's latest
   reply appears, as a sidebar preview. So the available signal is "the latest line
   of each active conversation," not full threads. Capturing real threads would
   require a different capture path (pixel OCR, or Screenpipe Connections) — tracked
   as a follow-up, not part of this change.

## Goal

Route browser-based conversations through the existing communication-app handling so
they (a) get their own bucket separated from generic browsing, (b) receive the
larger, recency-first text budget, and (c) survive the top-N app cutoff. This fully
fixes problem (1) and salvages the partial sidebar signal. It also future-proofs:
if/when a richer capture path lands, the routing already exists.

Non-goals: fixing the capture ceiling (problem 2); any LLM map-reduce / pre-filter
step (unnecessary — see Token Budget).

## Design

### New module: `src/channels.ts`

Content classification is a distinct concern from the HTTP client and the condenser,
so it moves to its own file. It owns:

- `COMMUNICATION_APPS` + `isCommunicationApp` (moved verbatim from `screenpipe.ts`).
- `BROWSER_CHANNELS` — the clean-set channel table.
- `isBrowser(app)` — recognizes browser app names.
- `classifyChannel(content)` — the single entry point used by the condenser.

```ts
/** Minimal frame fields needed to classify a frame's conversation channel. */
export interface FrameContent {
  app_name?: string | null;
  window_name?: string | null;
  window_title?: string | null;
  browser_url?: string | null;
}

export interface ChannelClassification {
  /** The label this frame is bucketed under in the digest (the "app"). */
  bucketKey: string;
  /** Whether this bucket gets conversation treatment (recency sort, larger budget, rank protection). */
  isComms: boolean;
}

interface BrowserChannel {
  display: string;        // bucketKey when matched, e.g. "WhatsApp (web)"
  urlPatterns: string[];  // matched as substrings of browser_url (lowercased)
  titlePatterns: string[];// matched as substrings of window title (lowercased), browser-gated
}

const BROWSER_CHANNELS: BrowserChannel[] = [
  { display: "WhatsApp (web)", urlPatterns: ["web.whatsapp.com"], titlePatterns: ["whatsapp"] },
  { display: "Slack (web)",    urlPatterns: ["app.slack.com"],     titlePatterns: ["slack"] },
  { display: "Gmail",          urlPatterns: ["mail.google.com"],   titlePatterns: ["gmail"] },
  { display: "Messenger (web)",urlPatterns: ["messenger.com"],     titlePatterns: ["messenger"] },
  { display: "Discord (web)",  urlPatterns: ["discord.com/channels", "discord.com/app"], titlePatterns: ["discord"] },
  { display: "Telegram (web)", urlPatterns: ["web.telegram.org"],  titlePatterns: ["telegram"] },
  { display: "Teams (web)",    urlPatterns: ["teams.microsoft.com", "teams.live.com"], titlePatterns: ["microsoft teams"] },
];

const BROWSERS = ["chrome", "safari", "arc", "firefox", "edge", "brave", "vivaldi", "opera"];

function isBrowser(app: string): boolean {
  const a = app.toLowerCase();
  return BROWSERS.some((b) => a.includes(b));
}

export function classifyChannel(c: FrameContent): ChannelClassification {
  const app = (c.app_name ?? "Unknown").trim() || "Unknown";
  // 1. Native communication apps take precedence — preserves existing behavior and
  //    keeps the native WhatsApp/Slack desktop apps under their own name.
  if (isCommunicationApp(app)) return { bucketKey: app, isComms: true };
  // 2. Browser-based conversation channels.
  const url = (c.browser_url ?? "").toLowerCase();
  const title = `${c.window_name ?? ""} ${c.window_title ?? ""}`.toLowerCase();
  const browser = isBrowser(app);
  for (const ch of BROWSER_CHANNELS) {
    const urlHit = url !== "" && ch.urlPatterns.some((p) => url.includes(p));
    const titleHit = browser && ch.titlePatterns.some((p) => title.includes(p));
    if (urlHit || titleHit) return { bucketKey: ch.display, isComms: true };
  }
  // 3. Everything else keeps its app name and generic treatment.
  return { bucketKey: app, isComms: false };
}
```

**False-positive guard:** title matching is gated on `isBrowser(app)`, so a code file
named `whatsapp.ts` open in an editor is never mistaken for a conversation. URL
matching needs no gate (only browsers populate `browser_url`). Title matching is
essential because the real WhatsApp frames come through the a11y path, which may not
carry `browser_url`; `app_name = "Google Chrome"` satisfies the browser gate.

**Precedence:** native-comms check first → browser-channel check → generic. This keeps
a native desktop WhatsApp/Teams app bucketed under its real name rather than the
"(web)" synthetic label.

### Condenser changes: `src/screenpipe.ts`

- Remove `COMMUNICATION_APPS` / `isCommunicationApp` (now imported from `./channels`).
- In the loop, replace `const app = (c.app_name ?? "Unknown")…` with
  `const { bucketKey, isComms } = classifyChannel(c);` and bucket by `bucketKey`.
- `AppActivityAcc` gains `isComms: boolean`, set when the accumulator is created
  (`newAcc(isComms)`). A given `bucketKey` always yields the same `isComms`.
- At ranking, read `a.isComms` instead of recomputing `isCommunicationApp(app)`.
- Keep `AppActivity` (in `types.ts`) unchanged. Carry comms-ness through a local
  ranked tuple so it never leaks into the public digest shape:

```ts
const ranked = [...byApp.entries()]
  .map(([app, a]) => {
    const ordered = a.isComms
      ? [...a.texts].sort((t1, t2) => (t1.ts < t2.ts ? 1 : t1.ts > t2.ts ? -1 : 0))
      : [...a.texts].sort((t1, t2) => t2.len - t1.len);
    const budget = a.isComms ? MAX_SAMPLE_TEXT_PER_COMMS_APP : MAX_SAMPLE_TEXT_PER_APP;
    const activity: AppActivity = {
      app, windows: a.windows, urls: a.urls,
      sampleText: ordered.slice(0, budget).map((t) => t.snippet),
      firstSeen: a.firstSeen ?? "", lastSeen: a.lastSeen ?? "", frames: a.frames,
    };
    return { activity, isComms: a.isComms };
  })
  .sort((x, y) => y.activity.frames - x.activity.frames);

const top = ranked.slice(0, MAX_APPS);
const extraComms = ranked.slice(MAX_APPS).filter((r) => r.isComms && r.activity.sampleText.length > 0);
const apps = [...top, ...extraComms].map((r) => r.activity);
```

The `extraComms` warn message and everything downstream are unchanged in behavior.

### Prompt tweak: `src/curation-prompt.ts`

Extend rule 6 to (a) name WhatsApp / messaging apps including browser-based ones, and
(b) tell the model how to honestly handle a sidebar-only capture:

> 6. Conversations: summarize the substance. For real exchanges — Slack, email,
> iMessage, WhatsApp and other messaging apps (including browser-based ones like
> WhatsApp Web or Gmail), meetings, PR threads, assistant chats — summarize WHAT was
> discussed, decided, or asked, and name the people involved. Do not merely list
> contact names. If audio transcripts of a meeting are present, summarize the
> discussion and any outcomes. A messaging app's captured text may be only a sidebar
> of recent-message previews rather than a full thread; treat each preview as the
> latest line of that conversation and summarize from it without inventing the rest.

### README

Add an `## Architecture` section with the Mermaid pipeline diagram
(`Screenpipe → fetch → condense → curate → upload`), noting the browser-conversation
routing lives inside `condenseItems`.

## Token budget

Measured current curation prompt for 2026-06-12: **~13.8k tokens** (1k system + 12.7k
user). Adding a `WhatsApp (web)` comms bucket (25 snippets × ≤500 chars) adds **~3k
tokens**; worst case with several browser channels active, ~25k total — well under
10–15% of the Sonnet context. The deterministic `condenseItems` cap is already the
"reduce." An LLM map-reduce pre-filter is therefore unnecessary and is explicitly out
of scope.

## Testing

- **`src/channels.test.ts`** (new): `classifyChannel` —
  - WhatsApp Web by URL (`browser_url = web.whatsapp.com`, `app_name = Google Chrome`) → `{ "WhatsApp (web)", true }`.
  - WhatsApp Web by title only (no `browser_url`, title contains "WhatsApp", app is Chrome) → `{ "WhatsApp (web)", true }`.
  - Title match in a non-browser app (e.g. `app_name = "Zed"`, title "whatsapp.ts") → generic `{ "Zed", false }`.
  - Native WhatsApp desktop app (`app_name = "WhatsApp"`) → `{ "WhatsApp", true }` (native precedence, not "(web)").
  - Generic Chrome tab (github URL) → `{ "Google Chrome", false }`.
- **`src/screenpipe.condense.test.ts`** (extend):
  - A WhatsApp-Web frame and a GitHub frame both under `app_name = "Google Chrome"`
    split into two buckets: `"WhatsApp (web)"` (comms) and `"Google Chrome"` (generic).
  - The `"WhatsApp (web)"` bucket gets recency-first ordering and the 25-snippet budget.
  - A low-frame `"WhatsApp (web)"` bucket survives the top-N cutoff.
  - Existing tests (generic Chrome, native Slack) continue to pass unchanged.

Run: `bun test` and `bun run type-check`.

## Follow-up (separate work, after this lands)

- **Capture real threads.** Investigate Screenpipe **Connections**
  (https://docs.screenpi.pe/connections) to read WhatsApp messages directly, and/or
  enabling pixel OCR for Chrome. Determine whether Connections works with the
  Screenpipe CLI or is desktop-app-only.
- **Audio backlog.** Health check shows 1,832 transcription segments pending and the
  mic inactive; spoken conversations may be delayed/missed. Separate investigation.
