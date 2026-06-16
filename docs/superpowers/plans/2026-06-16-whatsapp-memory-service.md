# WhatsApp → Memory Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract WhatsApp into a standalone `~/code/whatsapp-memory` service that keeps the Baileys sync alive (no re-pair) and pushes each completed day's chats straight into Memory as structured transcripts, and strip all WhatsApp handling out of `screenpipe-distiller`.

**Architecture:** A new Bun repo owns the Baileys **gateway** (relocated verbatim, reusing the existing `~/.screenpipe-distiller/whatsapp/` session + SQLite) and a new **pusher** that reads completed-day messages, builds one `meeting_transcript` per `(chat, day)`, and POSTs them to Memory via Petals (`/api/memory/ingest/transcript`). A `push-state.sqlite` watermark guarantees each transcript is written exactly once. `screenpipe-distiller` loses its WhatsApp code and unconditionally suppresses on-screen WhatsApp buckets.

**Tech Stack:** Bun, TypeScript (strict, `verbatimModuleSyntax`), `bun:sqlite`, `@whiskeysockets/baileys`, Zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-16-whatsapp-memory-service-design.md`

**Source references (read-only, current `screenpipe-distiller` code being moved/replaced):**
- Archive API: `src/whatsapp/archive.ts` — `WhatsAppArchive(path, {readonly})`, `listMessagesInWindow(startUnix, endUnix)`, `chatNames()`, `savedContacts()`, `listChats()`, `close()`. `ArchivedMessage = {id, jid, fromMe, sender, text, mediaType, timestamp(unix s), pushName}`.
- Group-filter + sender-naming logic to mirror: `src/whatsapp/conversations.ts`.
- Retry/backoff pattern to mirror: `src/upload.ts`.
- Day-window logic: `src/date-utils.ts` — `dayWindowUtc(dayKey, tz)`, `dayKeyFor(date, tz)`.
- Petals transcript contract: body `{transcriptId, scope?, occurredAt, content:{kind:"segmented",utterances:[{speakerLabel,content,timestamp?}]}, knownParticipants?, userSelfAliasesOverride?}` (no `userId` — Petals injects it); response `{message, jobId, sourceId}`.

---

## Important notes for the executor

- **Two repos, two git histories.** Phase 1 tasks run inside `~/code/whatsapp-memory` (a brand-new repo; commit to `main`). Phase 2 tasks run inside `~/code/screenpipe-distiller` on a **new branch** `feat/whatsapp-memory-extract`.
- **Never run the gateway during Phase 1.** No test imports `gateway.ts`; do not start it. The existing `com.screenpipe-distiller.whatsapp` LaunchAgent keeps the live sync running untouched until the single cutover step (Task 19). Two gateways on port 3036 would conflict.
- **`git add` explicit paths only.** Never `git add -A`/`.`. Never touch unrelated uncommitted changes.
- Run scripts via the project task runner: `bun test`, `bun run type-check`. Stop and report BLOCKED rather than hacking around a failure.

---

# Phase 1 — Build the `whatsapp-memory` repo

### Task 1: Scaffold the new repo

**Files:**
- Create: `~/code/whatsapp-memory/package.json`
- Create: `~/code/whatsapp-memory/tsconfig.json`
- Create: `~/code/whatsapp-memory/.gitignore`
- Create: `~/code/whatsapp-memory/.env.example`

- [ ] **Step 1: Create the repo and git-init**

```bash
mkdir -p ~/code/whatsapp-memory/src ~/code/whatsapp-memory/scripts
cd ~/code/whatsapp-memory && git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "whatsapp-memory",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "whatsapp": "bun run src/gateway.ts",
    "push": "bun run src/push.ts",
    "test": "bun test",
    "type-check": "bunx --bun tsc --noEmit"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^7.0.0-rc13",
    "pino": "^10.3.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`** (identical to the distiller's)

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
.env
*.log
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

- [ ] **Step 5: Write `.env.example`**

```bash
# === Memory upload (via Petals proxy) ===
PETALS_BASE_URL=https://petals.chat
# PETALS_API_KEY=            # required; created at Petals → Settings → API keys

# === Identity ===
# Comma-separated aliases that are YOU. The first is the speaker label emitted
# for your own messages; all are sent as userSelfAliasesOverride so the backend
# attributes your lines to user-self. e.g. "Marcel,Marcel Samyn,+32470000000"
# SELF_ALIASES=

# === WhatsApp archive (written by the gateway; read by the pusher) ===
# WHATSAPP_ARCHIVE_PATH=~/.screenpipe-distiller/whatsapp/messages.sqlite
# PUSH_STATE_PATH=~/.screenpipe-distiller/whatsapp/push-state.sqlite
# Group-message relevance: "contacts" (default) keeps only saved address-book
# contacts + your own messages; "all" keeps every group message. DMs unfiltered.
WHATSAPP_GROUP_FILTER=contacts

# === Scheduling / day boundaries ===
TIMEZONE=Europe/Brussels
# How many completed days back each run considers (and the initial backfill depth).
BACKFILL_DAYS=30

# === Gateway (Baileys sidecar) ===
# WHATSAPP_DATA_DIR=~/.screenpipe-distiller/whatsapp   # reuse existing session → no re-pair
# WHATSAPP_HTTP_PORT=3036
```

- [ ] **Step 6: Install dependencies**

Run: `cd ~/code/whatsapp-memory && bun install`
Expected: `bun.lock` created, `node_modules/` populated, no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/code/whatsapp-memory
git add package.json tsconfig.json .gitignore .env.example bun.lock
git commit -m "🔧 chore: scaffold whatsapp-memory repo"
```

---

### Task 2: Move the gateway + archive modules verbatim

These four modules and their tests move **unchanged** (they import each other relatively, e.g. `./archive`, so flattening into `src/` is safe). `conversations.ts` is NOT moved — it is replaced by `transcripts.ts` in Task 5.

**Files:**
- Create (copy): `~/code/whatsapp-memory/src/{archive,message,names,gateway}.ts`
- Create (copy): `~/code/whatsapp-memory/src/{archive,message,names}.test.ts`

- [ ] **Step 1: Copy the modules and tests**

```bash
SRC=~/code/screenpipe-distiller/src/whatsapp
DST=~/code/whatsapp-memory/src
cp "$SRC/archive.ts"      "$DST/archive.ts"
cp "$SRC/message.ts"      "$DST/message.ts"
cp "$SRC/names.ts"        "$DST/names.ts"
cp "$SRC/gateway.ts"      "$DST/gateway.ts"
cp "$SRC/archive.test.ts" "$DST/archive.test.ts"
cp "$SRC/message.test.ts" "$DST/message.test.ts"
cp "$SRC/names.test.ts"   "$DST/names.test.ts"
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd ~/code/whatsapp-memory && bun run type-check`
Expected: no errors. (`gateway.ts` still defaults its data dir to `~/.screenpipe-distiller/whatsapp` — intentional, so it reuses the existing session.)

- [ ] **Step 3: Run the moved tests**

Run: `cd ~/code/whatsapp-memory && bun test src/archive.test.ts src/message.test.ts src/names.test.ts`
Expected: all pass (same suites that passed in the distiller).

- [ ] **Step 4: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/archive.ts src/message.ts src/names.ts src/gateway.ts src/archive.test.ts src/message.test.ts src/names.test.ts
git commit -m "✨ feat: relocate Baileys gateway + archive from screenpipe-distiller"
```

---

### Task 3: Config module

**Files:**
- Create: `~/code/whatsapp-memory/src/config.ts`
- Test: `~/code/whatsapp-memory/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const base = { PETALS_API_KEY: "petals-x", SELF_ALIASES: "Marcel, +32123" };

describe("loadConfig", () => {
  test("parses SELF_ALIASES into a trimmed list and applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.SELF_ALIASES).toEqual(["Marcel", "+32123"]);
    expect(cfg.PETALS_BASE_URL).toBe("https://petals.chat");
    expect(cfg.WHATSAPP_GROUP_FILTER).toBe("contacts");
    expect(cfg.BACKFILL_DAYS).toBe(30);
    expect(cfg.TIMEZONE).toBe("Europe/Brussels");
    expect(cfg.WHATSAPP_ARCHIVE_PATH.startsWith("~")).toBe(false);
    expect(cfg.WHATSAPP_ARCHIVE_PATH.endsWith("/.screenpipe-distiller/whatsapp/messages.sqlite")).toBe(true);
    expect(cfg.PUSH_STATE_PATH.endsWith("/.screenpipe-distiller/whatsapp/push-state.sqlite")).toBe(true);
  });

  test("requires PETALS_API_KEY", () => {
    expect(() => loadConfig({ SELF_ALIASES: "Marcel" })).toThrow();
  });

  test("requires SELF_ALIASES", () => {
    expect(() => loadConfig({ PETALS_API_KEY: "petals-x" })).toThrow();
  });

  test("coerces BACKFILL_DAYS and honors overrides", () => {
    const cfg = loadConfig({ PETALS_API_KEY: "k", SELF_ALIASES: "Me", BACKFILL_DAYS: "7", WHATSAPP_GROUP_FILTER: "all", TIMEZONE: "UTC" });
    expect(cfg.BACKFILL_DAYS).toBe(7);
    expect(cfg.WHATSAPP_GROUP_FILTER).toBe("all");
    expect(cfg.TIMEZONE).toBe("UTC");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
/**
 * Loads + validates all runtime configuration from the environment.
 * Boundary parse: call once, then trust the typed Config everywhere.
 */
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~/` to the user's home dir; concrete requirement of the default paths. */
function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const configSchema = z.object({
  PETALS_BASE_URL: z.string().url().default("https://petals.chat"),
  PETALS_API_KEY: z.string().min(1),
  WHATSAPP_ARCHIVE_PATH: z
    .string()
    .default("~/.screenpipe-distiller/whatsapp/messages.sqlite")
    .transform(expandTilde),
  PUSH_STATE_PATH: z
    .string()
    .default("~/.screenpipe-distiller/whatsapp/push-state.sqlite")
    .transform(expandTilde),
  // Group-message relevance: "contacts" keeps only saved address-book contacts +
  // you; "all" keeps every group message. 1:1 chats are never filtered.
  WHATSAPP_GROUP_FILTER: z.enum(["contacts", "all"]).default("contacts"),
  TIMEZONE: z.string().min(1).default("Europe/Brussels"),
  BACKFILL_DAYS: z.coerce.number().int().positive().default(30),
  // Comma-separated; [0] is emitted as the speaker label for your own messages,
  // the full list is sent as userSelfAliasesOverride.
  SELF_ALIASES: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((a) => a.trim()).filter(Boolean))
    .refine((a) => a.length > 0, "SELF_ALIASES must list at least one alias"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/config.ts src/config.test.ts
git commit -m "✨ feat: config schema for whatsapp-memory"
```

---

### Task 4: Date utilities (day-window + completed-day enumeration)

**Files:**
- Create (copy + extend): `~/code/whatsapp-memory/src/date-utils.ts`
- Test: `~/code/whatsapp-memory/src/date-utils.test.ts`

- [ ] **Step 1: Copy `date-utils.ts` verbatim**

```bash
cp ~/code/screenpipe-distiller/src/date-utils.ts ~/code/whatsapp-memory/src/date-utils.ts
```

- [ ] **Step 2: Write the failing test for the new helpers**

```ts
import { describe, expect, test } from "bun:test";
import { previousDayKey, recentCompletedDayKeys, dayWindowUtc } from "./date-utils";

describe("previousDayKey", () => {
  test("steps back one calendar day across month/year boundaries", () => {
    expect(previousDayKey("2026-06-02")).toBe("2026-06-01");
    expect(previousDayKey("2026-06-01")).toBe("2026-05-31");
    expect(previousDayKey("2026-01-01")).toBe("2025-12-31");
  });
});

describe("recentCompletedDayKeys", () => {
  test("returns N completed local days, newest first, excluding today", () => {
    // 18:00Z on the 16th is still the 16th in Brussels (UTC+2) → today=16th, excluded.
    const now = new Date("2026-06-16T18:00:00Z");
    expect(recentCompletedDayKeys(now, "Europe/Brussels", 3)).toEqual([
      "2026-06-15",
      "2026-06-14",
      "2026-06-13",
    ]);
  });
});

describe("dayWindowUtc", () => {
  test("brackets a Brussels day in UTC (DST: UTC+2 in June)", () => {
    expect(dayWindowUtc("2026-06-15", "Europe/Brussels")).toEqual({
      startIso: "2026-06-14T22:00:00.000Z",
      endIso: "2026-06-15T22:00:00.000Z",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/date-utils.test.ts`
Expected: FAIL — `previousDayKey` / `recentCompletedDayKeys` not exported.

- [ ] **Step 4: Append the new helpers to `src/date-utils.ts`**

Add at the end of the file (after `dayWindowUtc`):

```ts
export function previousDayKey(dayKey: DayKey): DayKey {
  const prev = new Date(`${dayKey}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev.toISOString().slice(0, 10);
}

/**
 * The most recent `count` completed local day-keys, newest first: yesterday, the
 * day before, … back `count` days. The current (still-open) local day is excluded
 * so a transcript is only ever built once the day has closed.
 */
export function recentCompletedDayKeys(now: Date, timeZone: string, count: number): DayKey[] {
  const keys: DayKey[] = [];
  let key = previousDayKey(dayKeyFor(now, timeZone));
  for (let i = 0; i < count; i += 1) {
    keys.push(key);
    key = previousDayKey(key);
  }
  return keys;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/date-utils.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/date-utils.ts src/date-utils.test.ts
git commit -m "✨ feat: completed-day enumeration helpers"
```

---

### Task 5: Transcript builder (core mapping logic)

Builds one `(chat, day)` transcript per chat from a day's messages. Mirrors the group-filter + sender-naming rules of the old `conversations.ts`, but emits segmented utterances and **drops media-only messages** (captions are stored as text, so they survive).

**Files:**
- Create: `~/code/whatsapp-memory/src/transcripts.ts`
- Test: `~/code/whatsapp-memory/src/transcripts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildDayTranscripts } from "./transcripts";
import type { ArchivedMessage } from "./archive";

const msg = (
  over: Partial<ArchivedMessage> & Pick<ArchivedMessage, "id" | "jid" | "timestamp">,
): ArchivedMessage => ({
  fromMe: false,
  sender: over.jid,
  text: "hi",
  mediaType: null,
  pushName: null,
  ...over,
});

const build = (messages: ArchivedMessage[], opts: { names?: [string, string][]; saved?: string[] | null } = {}) =>
  buildDayTranscripts({
    messages,
    names: new Map(opts.names ?? []),
    savedSenders: opts.saved === undefined ? new Set() : opts.saved === null ? null : new Set(opts.saved),
    dayKey: "2026-06-15",
    selfAliases: ["Marcel", "+32123"],
  });

describe("buildDayTranscripts", () => {
  test("builds a 1:1 transcript with resolved labels, ordered utterances, occurredAt = first", () => {
    const [t] = build(
      [
        msg({ id: "2", jid: "p@s.whatsapp.net", timestamp: 110, fromMe: true, sender: "me", text: "hey" }),
        msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, sender: "p@s.whatsapp.net", text: "yo" }),
      ],
      { names: [["p@s.whatsapp.net", "Pat"]] },
    );
    expect(t?.jid).toBe("p@s.whatsapp.net");
    expect(t?.dayKey).toBe("2026-06-15");
    expect(t?.payload.transcriptId).toBe("whatsapp-p@s.whatsapp.net-2026-06-15");
    expect(t?.payload.scope).toBe("personal");
    expect(t?.payload.occurredAt).toBe(new Date(100_000).toISOString());
    expect(t?.payload.userSelfAliasesOverride).toEqual(["Marcel", "+32123"]);
    expect(t?.payload.content).toEqual({
      kind: "segmented",
      utterances: [
        { speakerLabel: "Pat", content: "yo", timestamp: new Date(100_000).toISOString() },
        { speakerLabel: "Marcel", content: "hey", timestamp: new Date(110_000).toISOString() },
      ],
    });
  });

  test("uses the group subject's participant names and drops media-only messages", () => {
    const [t] = build(
      [
        msg({ id: "1", jid: "trip@g.us", timestamp: 100, sender: "a@s.whatsapp.net", text: "boarding" }),
        msg({ id: "2", jid: "trip@g.us", timestamp: 110, sender: "a@s.whatsapp.net", text: null, mediaType: "image" }),
      ],
      { names: [["a@s.whatsapp.net", "Alice"]], saved: ["a@s.whatsapp.net"] },
    );
    expect(t?.payload.content.utterances).toEqual([
      { speakerLabel: "Alice", content: "boarding", timestamp: new Date(100_000).toISOString() },
    ]);
  });

  test("keeps a caption (stored as text) on a media message", () => {
    const [t] = build([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, text: "look at this", mediaType: "image" })]);
    expect(t?.payload.content.utterances[0]?.content).toBe("look at this");
  });

  test("in groups, keeps saved contacts + me and drops unknown senders", () => {
    const [t] = build(
      [
        msg({ id: "1", jid: "trip@g.us", timestamp: 100, sender: "saved@s.whatsapp.net", text: "from a friend" }),
        msg({ id: "2", jid: "trip@g.us", timestamp: 110, sender: "9999@lid", text: "from a stranger" }),
        msg({ id: "3", jid: "trip@g.us", timestamp: 120, fromMe: true, sender: "me", text: "my reply" }),
      ],
      { names: [["saved@s.whatsapp.net", "Friend"]], saved: ["saved@s.whatsapp.net"] },
    );
    expect(t?.payload.content.utterances.map((u) => u.speakerLabel)).toEqual(["Friend", "Marcel"]);
    expect(t?.payload.content.utterances.map((u) => u.content)).toEqual(["from a friend", "my reply"]);
  });

  test("drops a group entirely when only unknown senders participate", () => {
    expect(
      build(
        [
          msg({ id: "1", jid: "noise@g.us", timestamp: 100, sender: "1111@lid", text: "spam" }),
          msg({ id: "2", jid: "noise@g.us", timestamp: 110, sender: "2222@lid", text: "more spam" }),
        ],
        { saved: [] },
      ),
    ).toEqual([]);
  });

  test("groupFilter 'all' (savedSenders=null) keeps unknown group senders", () => {
    const [t] = build(
      [msg({ id: "1", jid: "noise@g.us", timestamp: 100, sender: "1111@lid", text: "stranger" })],
      { saved: null },
    );
    expect(t?.payload.content.utterances[0]?.content).toBe("stranger");
  });

  test("never filters 1:1 chats and falls back to +number for unknown senders", () => {
    const [t] = build([
      msg({ id: "1", jid: "31699999999@s.whatsapp.net", timestamp: 100, sender: "31699999999@s.whatsapp.net", text: "hi" }),
    ]);
    expect(t?.payload.content.utterances[0]?.speakerLabel).toBe("+31699999999");
  });

  test("skips a chat whose only message is media-only", () => {
    expect(build([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, text: null, mediaType: "image" })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/transcripts.test.ts`
Expected: FAIL — cannot resolve `./transcripts`.

- [ ] **Step 3: Write `src/transcripts.ts`**

```ts
/**
 * Builds per-(chat, day) WhatsApp transcript payloads from archived messages.
 * Aliases: whatsapp transcript builder, segmented utterances, day transcripts.
 */
import type { ArchivedMessage } from "./archive";

export interface TranscriptUtterance {
  speakerLabel: string;
  content: string;
  timestamp: string; // ISO
}

export interface TranscriptPayload {
  transcriptId: string;
  scope: "personal";
  occurredAt: string; // ISO
  content: { kind: "segmented"; utterances: TranscriptUtterance[] };
  userSelfAliasesOverride: string[];
}

/** One transcript plus the (jid, day) key used to watermark it. */
export interface DayTranscript {
  jid: string;
  dayKey: string;
  payload: TranscriptPayload;
}

export interface BuildParams {
  /** A single local day's messages (any order). */
  messages: readonly ArchivedMessage[];
  names: Map<string, string>;
  /** Saved-contact jids to keep in groups (+ me); null disables group filtering ("all"). */
  savedSenders: Set<string> | null;
  dayKey: string;
  /** Non-empty; [0] is the label emitted for the user's own messages. */
  selfAliases: string[];
}

function phoneFromJid(jid: string): string {
  const [user] = jid.split("@");
  return `+${user ?? jid}`;
}

export function buildDayTranscripts(params: BuildParams): DayTranscript[] {
  const self = params.selfAliases[0] ?? "Me";
  const byJid = new Map<string, ArchivedMessage[]>();
  for (const message of params.messages) {
    const list = byJid.get(message.jid) ?? [];
    list.push(message);
    byJid.set(message.jid, list);
  }

  const transcripts: DayTranscript[] = [];
  for (const [jid, msgs] of byJid) {
    const isGroup = jid.endsWith("@g.us");
    const ordered = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
    const utterances = ordered.flatMap((m): TranscriptUtterance[] => {
      // In groups, drop messages from senders who aren't saved contacts (or me).
      if (isGroup && params.savedSenders && !m.fromMe && !params.savedSenders.has(m.sender)) return [];
      const content = m.text?.trim();
      if (!content) return []; // drop media-only / empty (captions are stored as text and survive)
      const speakerLabel = m.fromMe ? self : (params.names.get(m.sender) ?? phoneFromJid(m.sender));
      return [{ speakerLabel, content, timestamp: new Date(m.timestamp * 1000).toISOString() }];
    });
    if (utterances.length === 0) continue;
    transcripts.push({
      jid,
      dayKey: params.dayKey,
      payload: {
        transcriptId: `whatsapp-${jid}-${params.dayKey}`,
        scope: "personal",
        occurredAt: utterances[0]!.timestamp,
        content: { kind: "segmented", utterances },
        userSelfAliasesOverride: params.selfAliases,
      },
    });
  }
  return transcripts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/transcripts.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/transcripts.ts src/transcripts.test.ts
git commit -m "✨ feat: build per-(chat,day) WhatsApp transcripts"
```

---

### Task 6: Push-state watermark store

**Files:**
- Create: `~/code/whatsapp-memory/src/push-state.ts`
- Test: `~/code/whatsapp-memory/src/push-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushState } from "./push-state";

const paths: string[] = [];
const tempPath = (): string => {
  const path = join(tmpdir(), `wa-push-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};

afterEach(() => {
  paths.forEach((p) => {
    rmSync(p, { force: true });
    rmSync(`${p}-shm`, { force: true });
    rmSync(`${p}-wal`, { force: true });
  });
  paths.length = 0;
});

describe("PushState", () => {
  test("has() is false until record(), then true", () => {
    const state = new PushState(tempPath());
    expect(state.has("p@s.whatsapp.net", "2026-06-15")).toBe(false);
    state.record("p@s.whatsapp.net", "2026-06-15", 1_700_000_000);
    expect(state.has("p@s.whatsapp.net", "2026-06-15")).toBe(true);
    expect(state.has("p@s.whatsapp.net", "2026-06-14")).toBe(false);
    state.close();
  });

  test("persists across reopen", () => {
    const path = tempPath();
    const first = new PushState(path);
    first.record("g@g.us", "2026-06-15", 1_700_000_000);
    first.close();
    const second = new PushState(path);
    expect(second.has("g@g.us", "2026-06-15")).toBe(true);
    second.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/push-state.test.ts`
Expected: FAIL — cannot resolve `./push-state`.

- [ ] **Step 3: Write `src/push-state.ts`**

```ts
/**
 * Tracks which (chat, day) transcripts have already been pushed to Memory.
 * A don't-redo-work watermark — backend ingest is idempotent by transcriptId.
 */
import { Database } from "bun:sqlite";

export class PushState {
  readonly #database: Database;

  constructor(path: string) {
    this.#database = new Database(path, { create: true });
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pushed_days (
        jid TEXT NOT NULL,
        day TEXT NOT NULL,
        pushed_at INTEGER NOT NULL,
        PRIMARY KEY (jid, day)
      );
    `);
  }

  has(jid: string, day: string): boolean {
    return (
      this.#database
        .query<{ one: number }, [string, string]>(
          `SELECT 1 AS one FROM pushed_days WHERE jid = ? AND day = ?`,
        )
        .get(jid, day) !== null
    );
  }

  record(jid: string, day: string, pushedAt: number): void {
    this.#database
      .query(`INSERT OR REPLACE INTO pushed_days (jid, day, pushed_at) VALUES (?, ?, ?)`)
      .run(jid, day, pushedAt);
  }

  close(): void {
    this.#database.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/push-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/push-state.ts src/push-state.test.ts
git commit -m "✨ feat: push-state watermark store"
```

---

### Task 7: Petals transcript client

Mirrors `screenpipe-distiller/src/upload.ts`: POST with `x-api-key`, retry network/5xx with exponential backoff (4 attempts, `250 * 2**attempt` ms), 4xx is a hard failure.

**Files:**
- Create: `~/code/whatsapp-memory/src/petals.ts`
- Test: `~/code/whatsapp-memory/src/petals.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { ingestTranscript, IngestError } from "./petals";
import type { TranscriptPayload } from "./transcripts";

const payload: TranscriptPayload = {
  transcriptId: "whatsapp-p@s.whatsapp.net-2026-06-15",
  scope: "personal",
  occurredAt: "2026-06-15T08:00:00.000Z",
  content: { kind: "segmented", utterances: [{ speakerLabel: "Pat", content: "yo", timestamp: "2026-06-15T08:00:00.000Z" }] },
  userSelfAliasesOverride: ["Marcel"],
};
const config = { baseUrl: "https://petals.test", apiKey: "petals-k" };
const noSleep = async () => {};

describe("ingestTranscript", () => {
  test("posts to the transcript endpoint with x-api-key and returns jobId", async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      return new Response(JSON.stringify({ message: "queued", jobId: "job_1", sourceId: "src_1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await ingestTranscript(payload, config, { fetchImpl, sleep: noSleep });
    expect(res.jobId).toBe("job_1");
    expect(seen!.url).toBe("https://petals.test/api/memory/ingest/transcript");
    expect(seen!.headers["x-api-key"]).toBe("petals-k");
    expect(seen!.body).toEqual(payload); // no userId sent
  });

  test("throws on 4xx without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(ingestTranscript(payload, config, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(IngestError);
    expect(calls).toBe(1);
  });

  test("retries 5xx then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2
        ? new Response("oops", { status: 503 })
        : new Response(JSON.stringify({ message: "queued", jobId: "job_2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await ingestTranscript(payload, config, { fetchImpl, sleep: noSleep });
    expect(res.jobId).toBe("job_2");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/petals.test.ts`
Expected: FAIL — cannot resolve `./petals`.

- [ ] **Step 3: Write `src/petals.ts`**

```ts
/**
 * Pushes a WhatsApp transcript into Memory via the Petals proxy. Petals injects
 * the userId from the API key, so the client sends none. Retries network/5xx
 * with exponential backoff; 4xx is a hard failure.
 */
import { z } from "zod";
import type { TranscriptPayload } from "./transcripts";

export class IngestError extends Error {}

const responseSchema = z.object({ message: z.string(), jobId: z.string() }).passthrough();

export interface IngestConfig {
  baseUrl: string;
  apiKey: string;
}

interface IngestDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function ingestTranscript(
  payload: TranscriptPayload,
  config: IngestConfig,
  deps: IngestDeps = {},
): Promise<{ jobId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = `${config.baseUrl}/api/memory/ingest/transcript`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify(payload),
  };

  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastErr = e;
    }
    if (res) {
      if (res.ok) return { jobId: responseSchema.parse(await res.json()).jobId };
      const text = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new IngestError(`transcript ingest rejected ${res.status}: ${text}`);
      }
      lastErr = new IngestError(`transcript ingest failed ${res.status}: ${text}`);
    }
    if (attempt < maxAttempts) await sleep(250 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new IngestError("transcript ingest failed after retries");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/petals.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/petals.ts src/petals.test.ts
git commit -m "✨ feat: Petals transcript ingest client"
```

---

### Task 8: Pusher orchestration

**Files:**
- Create: `~/code/whatsapp-memory/src/pusher.ts`
- Test: `~/code/whatsapp-memory/src/pusher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppArchive, type ArchivedMessage } from "./archive";
import { runPush } from "./pusher";
import type { Config } from "./config";
import type { TranscriptPayload } from "./transcripts";

const paths: string[] = [];
const tempPath = (tag: string): string => {
  const path = join(tmpdir(), `wa-${tag}-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};
afterEach(() => {
  paths.forEach((p) => {
    rmSync(p, { force: true });
    rmSync(`${p}-shm`, { force: true });
    rmSync(`${p}-wal`, { force: true });
  });
  paths.length = 0;
});

// 2026-06-15 ~10:00 Brussels (UTC+2) → 08:00:00Z, inside the completed day.
const TS_15 = Math.floor(Date.parse("2026-06-15T08:00:00Z") / 1000);
const NOW = new Date("2026-06-16T18:00:00Z");

const makeConfig = (archivePath: string, statePath: string): Config =>
  ({
    PETALS_BASE_URL: "https://petals.test",
    PETALS_API_KEY: "petals-k",
    WHATSAPP_ARCHIVE_PATH: archivePath,
    PUSH_STATE_PATH: statePath,
    WHATSAPP_GROUP_FILTER: "contacts",
    TIMEZONE: "Europe/Brussels",
    BACKFILL_DAYS: 5,
    SELF_ALIASES: ["Marcel"],
  }) satisfies Config;

const seedArchive = (messages: ArchivedMessage[], names: [string, string, boolean, boolean?][] = []): string => {
  const path = tempPath("archive");
  const archive = new WhatsAppArchive(path);
  archive.storeMessages(messages);
  names.forEach(([jid, name, isGroup, saved]) => archive.upsertChatName(jid, name, isGroup, saved ?? false));
  archive.close();
  return path;
};

describe("runPush", () => {
  test("pushes each completed-day chat once and records the watermark", async () => {
    const archivePath = seedArchive(
      [
        { id: "1", jid: "p@s.whatsapp.net", fromMe: false, sender: "p@s.whatsapp.net", text: "yo", mediaType: null, timestamp: TS_15, pushName: null },
      ],
      [["p@s.whatsapp.net", "Pat", false, true]],
    );
    const statePath = tempPath("state");
    const config = makeConfig(archivePath, statePath);
    const sent: TranscriptPayload[] = [];
    const ingest = async (payload: TranscriptPayload) => {
      sent.push(payload);
      return { jobId: "job_x" };
    };

    const first = await runPush(config, { now: NOW, ingest });
    expect(first).toEqual({ pushed: 1, skipped: 0, failed: 0 });
    expect(sent[0]?.transcriptId).toBe("whatsapp-p@s.whatsapp.net-2026-06-15");
    expect(sent[0]?.content.utterances[0]).toEqual({ speakerLabel: "Pat", content: "yo", timestamp: "2026-06-15T08:00:00.000Z" });

    // Second run: already recorded → skipped, no new ingest.
    sent.length = 0;
    const second = await runPush(config, { now: NOW, ingest });
    expect(second).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(sent.length).toBe(0);
  });

  test("counts a failed ingest and does not record it (retried next run)", async () => {
    const archivePath = seedArchive([
      { id: "1", jid: "p@s.whatsapp.net", fromMe: false, sender: "p@s.whatsapp.net", text: "yo", mediaType: null, timestamp: TS_15, pushName: null },
    ]);
    const statePath = tempPath("state");
    const config = makeConfig(archivePath, statePath);

    const failing = async () => {
      throw new Error("boom");
    };
    const failRun = await runPush(config, { now: NOW, ingest: failing });
    expect(failRun).toEqual({ pushed: 0, skipped: 0, failed: 1 });

    // Not recorded, so a later good run pushes it.
    const okRun = await runPush(config, { now: NOW, ingest: async () => ({ jobId: "job_ok" }) });
    expect(okRun).toEqual({ pushed: 1, skipped: 0, failed: 0 });
  });

  test("returns a zero summary when the archive file is missing", async () => {
    const config = makeConfig(join(tmpdir(), "does-not-exist.sqlite"), tempPath("state"));
    const summary = await runPush(config, { now: NOW, ingest: async () => ({ jobId: "x" }) });
    expect(summary).toEqual({ pushed: 0, skipped: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/code/whatsapp-memory && bun test src/pusher.test.ts`
Expected: FAIL — cannot resolve `./pusher`.

- [ ] **Step 3: Write `src/pusher.ts`**

```ts
/**
 * Reads completed-day WhatsApp messages from the archive and pushes each
 * (chat, day) as a transcript to Memory, skipping ones already recorded.
 */
import { existsSync } from "node:fs";
import { WhatsAppArchive } from "./archive";
import { PushState } from "./push-state";
import { buildDayTranscripts, type TranscriptPayload } from "./transcripts";
import { ingestTranscript } from "./petals";
import { dayWindowUtc, recentCompletedDayKeys } from "./date-utils";
import type { Config } from "./config";

export interface PushSummary {
  pushed: number;
  skipped: number;
  failed: number;
}

export interface PushDeps {
  now?: Date;
  ingest?: (payload: TranscriptPayload) => Promise<{ jobId: string }>;
}

export async function runPush(config: Config, deps: PushDeps = {}): Promise<PushSummary> {
  const now = deps.now ?? new Date();
  const ingest =
    deps.ingest ??
    ((payload: TranscriptPayload) =>
      ingestTranscript(payload, { baseUrl: config.PETALS_BASE_URL, apiKey: config.PETALS_API_KEY }));

  const summary: PushSummary = { pushed: 0, skipped: 0, failed: 0 };
  if (!existsSync(config.WHATSAPP_ARCHIVE_PATH)) {
    console.warn(`[push] archive not found at ${config.WHATSAPP_ARCHIVE_PATH}; nothing to push`);
    return summary;
  }

  const archive = new WhatsAppArchive(config.WHATSAPP_ARCHIVE_PATH, { readonly: true });
  const state = new PushState(config.PUSH_STATE_PATH);
  try {
    const names = archive.chatNames();
    const savedSenders = config.WHATSAPP_GROUP_FILTER === "all" ? null : archive.savedContacts();
    for (const dayKey of recentCompletedDayKeys(now, config.TIMEZONE, config.BACKFILL_DAYS)) {
      const { startIso, endIso } = dayWindowUtc(dayKey, config.TIMEZONE);
      const messages = archive.listMessagesInWindow(
        Math.floor(Date.parse(startIso) / 1000),
        Math.floor(Date.parse(endIso) / 1000),
      );
      const transcripts = buildDayTranscripts({
        messages,
        names,
        savedSenders,
        dayKey,
        selfAliases: config.SELF_ALIASES,
      });
      for (const t of transcripts) {
        if (state.has(t.jid, t.dayKey)) {
          summary.skipped += 1;
          continue;
        }
        try {
          await ingest(t.payload);
          state.record(t.jid, t.dayKey, Math.floor(now.getTime() / 1000));
          summary.pushed += 1;
        } catch (error) {
          summary.failed += 1;
          console.error(
            JSON.stringify({ type: "push-failed", transcriptId: t.payload.transcriptId, error: String(error) }),
          );
        }
      }
    }
    return summary;
  } finally {
    archive.close();
    state.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/code/whatsapp-memory && bun test src/pusher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/pusher.ts src/pusher.test.ts
git commit -m "✨ feat: pusher orchestration (read archive → push transcripts)"
```

---

### Task 9: CLI entry point

**Files:**
- Create: `~/code/whatsapp-memory/src/push.ts`

- [ ] **Step 1: Write `src/push.ts`**

```ts
/**
 * CLI entry: push completed-day WhatsApp transcripts into Memory.
 * Usage: `bun run push` or `bun run push --backfill 60` (one-shot deeper window).
 */
import { loadConfig } from "./config";
import { runPush } from "./pusher";

const args = process.argv.slice(2);
const backfillIdx = args.indexOf("--backfill");
const base = loadConfig();
const config =
  backfillIdx >= 0 && Number.isFinite(Number(args[backfillIdx + 1]))
    ? { ...base, BACKFILL_DAYS: Number(args[backfillIdx + 1]) }
    : base;

const summary = await runPush(config);
console.log(JSON.stringify({ type: "push-summary", ...summary }));
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd ~/code/whatsapp-memory && bun run type-check`
Expected: no errors.

- [ ] **Step 3: Verify the CLI runs against an empty/missing archive (no network)**

Run: `cd ~/code/whatsapp-memory && PETALS_API_KEY=test SELF_ALIASES=Tester WHATSAPP_ARCHIVE_PATH=/tmp/nope.sqlite PUSH_STATE_PATH=/tmp/wa-push-smoke.sqlite bun run push`
Expected: prints `{"type":"push-summary","pushed":0,"skipped":0,"failed":0}` and a `[push] archive not found …` warning; exit 0.
Cleanup: `rm -f /tmp/wa-push-smoke.sqlite*`

- [ ] **Step 4: Commit**

```bash
cd ~/code/whatsapp-memory
git add src/push.ts
git commit -m "✨ feat: push CLI entry"
```

---

### Task 10: LaunchAgent install scripts

**Files:**
- Create: `~/code/whatsapp-memory/scripts/install-gateway.sh`
- Create: `~/code/whatsapp-memory/scripts/install-pusher.sh`

- [ ] **Step 1: Write `scripts/install-gateway.sh`** (gateway keep-alive; reuses the existing data dir → no re-pair)

```bash
#!/usr/bin/env bash
# Installs the persistent WhatsApp gateway (Baileys sidecar) on macOS.
# Reuses the existing ~/.screenpipe-distiller/whatsapp session, so no re-pair.
set -euo pipefail

LABEL="com.whatsapp-memory.gateway"
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.screenpipe-distiller/whatsapp"
BUN="$(command -v bun || true)"

if [ -z "$BUN" ]; then
  echo "error: 'bun' not found on PATH." >&2
  exit 1
fi

mkdir -p "$AGENTS" "$DATA_DIR"
chmod 700 "$HOME/.screenpipe-distiller" "$DATA_DIR"

cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>whatsapp</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WHATSAPP_HTTP_PORT</key><string>3036</string>
    <key>WHATSAPP_DATA_DIR</key><string>$DATA_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$REPO/whatsapp.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/whatsapp.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
launchctl load "$AGENTS/$LABEL.plist"
echo "loaded $LABEL"
echo "status: curl -fsS http://127.0.0.1:3036/status"
```

- [ ] **Step 2: Write `scripts/install-pusher.sh`** (daily batch; relies on Bun auto-loading `$REPO/.env`)

```bash
#!/usr/bin/env bash
# Installs the daily WhatsApp → Memory pusher on macOS.
# Reads config from $REPO/.env (Bun auto-loads it from WorkingDirectory).
set -euo pipefail

LABEL="com.whatsapp-memory.pusher"
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || true)"

if [ -z "$BUN" ]; then
  echo "error: 'bun' not found on PATH." >&2
  exit 1
fi

mkdir -p "$AGENTS"

cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>push</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$REPO/push.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/push.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
launchctl load "$AGENTS/$LABEL.plist"
echo "loaded $LABEL (daily at 04:00)"
```

- [ ] **Step 3: Make the scripts executable**

Run: `chmod +x ~/code/whatsapp-memory/scripts/install-gateway.sh ~/code/whatsapp-memory/scripts/install-pusher.sh`

- [ ] **Step 4: Commit** (do NOT run these scripts yet — cutover is Task 19)

```bash
cd ~/code/whatsapp-memory
git add scripts/install-gateway.sh scripts/install-pusher.sh
git commit -m "🔧 chore: LaunchAgent installers for gateway + pusher"
```

---

### Task 11: README + full Phase 1 verification

**Files:**
- Create: `~/code/whatsapp-memory/README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# whatsapp-memory

Keeps a local WhatsApp Web sync alive (Baileys) and pushes each completed day's
chats into [Memory](https://petals.chat) as structured transcripts — one
`meeting_transcript` per `(chat, day)`, with per-person speaker attribution.

## Components

- **gateway** (`bun run whatsapp`) — Baileys sidecar. Pairs via QR, stores
  messages + contacts in `~/.screenpipe-distiller/whatsapp/messages.sqlite`,
  exposes `GET /status` `/qr` `/chats` `/messages` on `127.0.0.1:3036`. Reuses
  the existing session dir, so migrating from screenpipe-distiller needs **no
  re-pair**.
- **pusher** (`bun run push`) — reads completed days, builds transcripts, POSTs
  them to Petals `/api/memory/ingest/transcript`, and records a watermark in
  `push-state.sqlite`. `bun run push --backfill 60` for a deeper one-shot.

## Setup

```bash
bun install
cp .env.example .env   # fill PETALS_API_KEY and SELF_ALIASES
./scripts/install-gateway.sh   # keep-alive Baileys sidecar
./scripts/install-pusher.sh    # daily push at 04:00
```

Pairing (only if no existing session): start the gateway, then
`curl -fsS http://127.0.0.1:3036/qr | qrencode -t ANSIUTF8` and scan from
WhatsApp → Linked Devices.

## Config

See `.env.example`. Key vars: `PETALS_API_KEY`, `SELF_ALIASES` (comma-separated;
first is your emitted label), `WHATSAPP_GROUP_FILTER` (`contacts`|`all`),
`TIMEZONE`, `BACKFILL_DAYS`.
````

- [ ] **Step 2: Run the full suite + type-check**

Run: `cd ~/code/whatsapp-memory && bun run type-check && bun test`
Expected: type-check clean; ALL test files pass (config, date-utils, transcripts, push-state, petals, pusher, archive, message, names).

- [ ] **Step 3: Commit**

```bash
cd ~/code/whatsapp-memory
git add README.md
git commit -m "📚 docs: whatsapp-memory README"
```

---

# Phase 2 — Strip WhatsApp from `screenpipe-distiller`

All Phase 2 tasks run in `~/code/screenpipe-distiller`.

### Task 12: Branch + remove the WhatsApp modules and config

**Files:**
- Delete: `src/whatsapp/` (whole directory)
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Create the feature branch**

```bash
cd ~/code/screenpipe-distiller && git checkout -b feat/whatsapp-memory-extract
```

- [ ] **Step 2: Delete the WhatsApp module directory + drop the package script**

```bash
cd ~/code/screenpipe-distiller
git rm -r src/whatsapp
```

Then edit `package.json` — remove the `whatsapp` script line:

```json
    "whatsapp": "bun run src/whatsapp/gateway.ts",
```

(Leave `distill`, `health-check`, `test`, `type-check`.)

- [ ] **Step 3: Edit `src/config.ts`** — remove the three WhatsApp keys, the now-unused `expandTilde`, and its imports.

Replace the entire file with:

```ts
/**
 * Loads + validates all runtime configuration from the environment.
 * Boundary parse: call once, then trust the typed Config everywhere.
 */
import { z } from "zod";

const configSchema = z
  .object({
    SCREENPIPE_API_URL: z.string().url().default("http://localhost:3030"),
    SCREENPIPE_API_KEY: z.string().min(1),
    OPENROUTER_API_KEY: z.string().min(1),
    CURATION_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4.6"),
    USER_TIMEZONE: z.string().min(1).default("Europe/Brussels"),
    USER_NAME: z.string().min(1).default("the user"),
    // Upload target: "direct" → Assistant Memory; "petals" → Petals proxy.
    UPLOAD_MODE: z.enum(["direct", "petals"]).default("direct"),
    // direct mode (Assistant Memory)
    MEMORY_API_URL: z.string().url().default("http://localhost:3000"),
    MEMORY_API_KEY: z.string().optional(),
    MEMORY_USER_ID: z.string().optional(),
    // petals mode (Petals proxy)
    PETALS_BASE_URL: z.string().url().default("https://petals.chat"),
    PETALS_API_KEY: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.UPLOAD_MODE === "petals" && !cfg.PETALS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PETALS_API_KEY"],
        message: "PETALS_API_KEY is required when UPLOAD_MODE=petals",
      });
    }
    if (cfg.UPLOAD_MODE === "direct" && !cfg.MEMORY_USER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MEMORY_USER_ID"],
        message: "MEMORY_USER_ID is required when UPLOAD_MODE=direct",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
```

- [ ] **Step 4: Edit `src/config.test.ts`** — delete the two WhatsApp tests (the `"defaults the WhatsApp connector to auto …"` and `"honors an explicit connector value …"` tests, lines 33–46). Leave the other four tests unchanged.

- [ ] **Step 5: Run config tests**

Run: `cd ~/code/screenpipe-distiller && bun test src/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/whatsapp package.json src/config.ts src/config.test.ts
git commit -m "♻️ refactor(whatsapp): remove WhatsApp modules + config (moved to whatsapp-memory)"
```

---

### Task 13: Drop the `Conversation` types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Edit `src/types.ts`** — remove `ConversationMessage`, `Conversation`, and the `conversations` field on `DayDigest`.

Replace the `ConversationMessage`/`Conversation` interfaces (lines 18–30) — delete them entirely — and remove the `conversations: Conversation[];` line from `DayDigest`. The resulting `DayDigest` is:

```ts
export interface DayDigest {
  dayKey: string;
  apps: AppActivity[];
  audio: AudioSnippet[];
  totalFrames: number;
  isEmpty: boolean;
}
```

(Leave `AppActivity`, `AudioSnippet`, and `CuratedDoc` unchanged.)

- [ ] **Step 2: Verify the type error surface (expected to fail until Tasks 14–16)**

Run: `cd ~/code/screenpipe-distiller && bun run type-check`
Expected: FAIL with errors in `screenpipe.ts`, `distill.ts`, `curation-prompt.ts` referencing `Conversation`/`conversations`. This is expected — the next tasks fix each. Do not commit yet.

---

### Task 14: Unconditional WhatsApp suppression in screenpipe

**Files:**
- Modify: `src/screenpipe.ts`
- Modify: `src/screenpipe.condense.test.ts`
- Modify: `src/screenpipe.fetch.test.ts`

- [ ] **Step 1: Edit `src/screenpipe.ts` imports** — drop `Conversation`:

```ts
import type { AppActivity, DayDigest } from "./types";
```

- [ ] **Step 2: Edit `condenseItems` return** — remove the `conversations` local and field. Replace the block at the end of `condenseItems` (currently building `const conversations: Conversation[] = [];` and returning it) with:

```ts
  return {
    dayKey,
    apps,
    audio,
    totalFrames,
    isEmpty: apps.length === 0 && audio.length === 0,
  };
```

(Delete the `const conversations: Conversation[] = [];` line above it.)

- [ ] **Step 3: Rewrite `fetchDayActivity`** — drop the `loadConversations` parameter and make WhatsApp suppression unconditional:

```ts
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

  // WhatsApp is ingested into Memory as structured transcripts by the separate
  // whatsapp-memory service, so its low-fidelity on-screen capture is always
  // dropped here. Covers "WhatsApp" and "WhatsApp (web)".
  const suppress = (key: string) => key.toLowerCase().includes("whatsapp");
  return condenseItems([...ocr, ...audio, ...input], dayKey, { suppressBucket: suppress });
}
```

- [ ] **Step 4: Edit `src/screenpipe.condense.test.ts`** — delete the last test (`"digest carries an empty conversations array by default"`, the final `test(...)` block referencing `.conversations`). All other tests (including `"suppressBucket drops matching buckets entirely"`) stay.

- [ ] **Step 5: Rewrite `src/screenpipe.fetch.test.ts`** — remove the `Conversation` import + `conv` literal and replace the connector-coupled tests with unconditional-suppression tests:

```ts
import { describe, expect, test } from "bun:test";
import { fetchDayActivity, ScreenpipeClient } from "./screenpipe";

const ocrOnly = (app: string, text: string) =>
  (async (input: URL) => {
    const ct = new URL(input).searchParams.get("content_type")!;
    const data =
      ct === "ocr"
        ? [{ type: "OCR", content: { app_name: app, text, timestamp: "2026-06-09T10:00:00Z" } }]
        : [];
    return new Response(JSON.stringify({ data, pagination: {} }), { status: 200 });
  }) as unknown as typeof fetch;

describe("fetchDayActivity", () => {
  test("queries the three content types over the day window and condenses", async () => {
    const seen: string[] = [];
    const f = (async (input: URL) => {
      const ct = new URL(input).searchParams.get("content_type")!;
      seen.push(ct);
      const data =
        ct === "ocr"
          ? [{ type: "OCR", content: { app_name: "Chrome", text: "hi", timestamp: "2026-06-09T10:00:00Z" } }]
          : [];
      return new Response(JSON.stringify({ data, pagination: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ScreenpipeClient("http://localhost:3030", "tok", f);
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels");
    expect(seen.sort()).toEqual(["audio", "input", "ocr"]);
    expect(digest.apps[0]?.app).toBe("Chrome");
  });

  test("always suppresses on-screen WhatsApp buckets (now ingested separately)", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("WhatsApp", "sidebar preview"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels");
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeUndefined();
  });

  test("keeps non-WhatsApp on-screen apps", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("Zed", "code here"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels");
    expect(digest.apps.find((a) => a.app === "Zed")).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the screenpipe tests**

Run: `cd ~/code/screenpipe-distiller && bun test src/screenpipe.condense.test.ts src/screenpipe.fetch.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/screenpipe.ts src/screenpipe.condense.test.ts src/screenpipe.fetch.test.ts
git commit -m "✨ feat(screenpipe): always suppress on-screen WhatsApp buckets"
```

---

### Task 15: Simplify the distill wiring

**Files:**
- Modify: `src/distill.ts`
- Modify: `src/distill.test.ts`
- Modify: `src/curate.test.ts`

- [ ] **Step 1: Edit `src/distill.ts`** — drop the WhatsApp loader and `Conversation` import. Replace the top imports and `defaultDeps` with:

```ts
/**
 * Orchestrates one day's distillation: fetch → curate → upload.
 * Seams are injectable for testing; defaults wire the real implementations.
 */
import type { Config } from "./config";
import type { CuratedDoc, DayDigest } from "./types";
import { ScreenpipeClient, fetchDayActivity } from "./screenpipe";
import { curateDigest } from "./curate";
import { uploadDocument, type DocPayload } from "./upload";

export interface DistillDeps {
  fetchDay: (dayKey: string) => Promise<DayDigest>;
  curate: (digest: DayDigest) => Promise<CuratedDoc>;
  upload: (p: DocPayload, updateExisting: boolean) => Promise<{ jobId: string }>;
}

function defaultDeps(config: Config): DistillDeps {
  const client = new ScreenpipeClient(config.SCREENPIPE_API_URL, config.SCREENPIPE_API_KEY);
  return {
    fetchDay: (dayKey) => fetchDayActivity(client, dayKey, config.USER_TIMEZONE),
    curate: (digest) => curateDigest(digest, config),
    upload: (p, updateExisting) => uploadDocument(p, config, updateExisting),
  };
}
```

(Leave `runDistill` below unchanged.)

- [ ] **Step 2: Edit `src/distill.test.ts`** — remove `conversations: []` from all three `DayDigest` literals (lines 10, 23, and 36–43). Each literal becomes e.g.:

```ts
const digest: DayDigest = { dayKey: "2026-06-09", apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: [], firstSeen: "", lastSeen: "", frames: 1 }], audio: [], totalFrames: 1, isEmpty: false };
```

and

```ts
    const digest: DayDigest = { dayKey: "2026-06-09", apps: [], audio: [], totalFrames: 0, isEmpty: true };
```

and the dry-run literal:

```ts
    const digest: DayDigest = {
      dayKey: "2026-06-09",
      apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: [], firstSeen: "", lastSeen: "", frames: 1 }],
      audio: [],
      totalFrames: 1,
      isEmpty: false,
    };
```

- [ ] **Step 3: Edit `src/curate.test.ts`** — remove `conversations: []` from both `DayDigest` literals (the `nonEmpty` const and the inline `empty` const). They become:

```ts
const nonEmpty: DayDigest = {
  dayKey: "2026-06-09",
  apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: ["x"], firstSeen: "2026-06-09T10:00:00Z", lastSeen: "2026-06-09T11:00:00Z", frames: 3 }],
  audio: [],
  totalFrames: 3,
  isEmpty: false,
};
```

```ts
    const empty: DayDigest = { dayKey: "2026-06-09", apps: [], audio: [], totalFrames: 0, isEmpty: true };
```

- [ ] **Step 4: Run the distill + curate tests**

Run: `cd ~/code/screenpipe-distiller && bun test src/distill.test.ts src/curate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/distill.ts src/distill.test.ts src/curate.test.ts
git commit -m "♻️ refactor(distill): drop the WhatsApp connector wiring"
```

---

### Task 16: Remove the conversations block from the curation prompt

**Files:**
- Modify: `src/curation-prompt.ts`
- Modify: `src/curation-prompt.test.ts`

- [ ] **Step 1: Edit `src/curation-prompt.ts` — trim rule 6.** In `buildSystemPrompt`, rule 6 currently ends with connector-specific sentences. Remove the trailing two sentences so the rule ends at the sidebar-preview guidance. The rule 6 text becomes (ending exactly here):

```
6. Conversations: summarize the substance. For real exchanges — Slack, email, iMessage, WhatsApp and other messaging apps (including browser-based ones like WhatsApp Web or Gmail), meetings, PR threads, assistant chats — summarize WHAT was discussed, decided, or asked, and name the people involved. Do not merely list contact names. If audio transcripts of a meeting are present, summarize the discussion and any outcomes. A messaging app's captured text may be only a sidebar of recent-message previews rather than a full thread; treat each preview as the latest line of that conversation and summarize from it without inventing the rest.
```

(Delete from `" Some conversations are provided as a structured \"## Conversations\" section …"` through `"… prefer them over any on-screen capture of the same app."`)

- [ ] **Step 2: Edit `src/curation-prompt.ts` — remove the conversations renderer.** In `buildUserPrompt`, delete the entire block:

```ts
  if (digest.conversations.length) {
    lines.push("", "## Conversations");
    for (const conv of digest.conversations) {
      const heading = conv.isGroup ? `${conv.channel} — ${conv.chatName} (group)` : `${conv.channel} — ${conv.chatName}`;
      lines.push(`### ${heading}`);
      for (const m of conv.messages) {
        lines.push(`- ${m.timestamp.slice(11, 16)} ${m.sender}: ${m.text}`);
      }
    }
  }
```

(The function keeps the Apps loop and the Audio block.)

- [ ] **Step 3: Edit `src/curation-prompt.test.ts`** — three changes:
  1. Remove the `conversations: [...]` field from the `digest` literal (lines 9–16).
  2. In the system-prompt test, delete the assertion `expect(sys).toContain("authoritative");` (that word was in the removed sentences).
  3. Delete the test `"user prompt renders the conversations block with sender, time, and group marker"` entirely.

The resulting test file:

```ts
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, buildUserPrompt } from "./curation-prompt";
import type { DayDigest } from "./types";

const digest: DayDigest = {
  dayKey: "2026-06-09",
  apps: [{ app: "Ghostty", windows: ["zsh"], urls: [], sampleText: ["$ bun test"], firstSeen: "2026-06-09T10:00:00Z", lastSeen: "2026-06-09T11:00:00Z", frames: 12 }],
  audio: [{ speaker: "Marcel", text: "let's ship it", timestamp: "2026-06-09T11:00:00Z" }],
  totalFrames: 12,
  isEmpty: false,
};

describe("curation prompt", () => {
  test("system prompt forbids action items, infers nothing, and includes name + sections", () => {
    const sys = buildSystemPrompt("Marcel");
    expect(sys).toContain("No invented action items");
    expect(sys).toContain("DO capture real commitments");
    expect(sys.toLowerCase()).toContain("exposure");
    expect(sys).toContain("Never guess which project");
    expect(sys).toContain("Marcel");
    expect(sys).toContain("Notable knowledge");
    expect(sys).toContain("Conversations & meetings");
    expect(sys).toContain("Commitments & promises");
  });

  test("user prompt renders apps, urls, and audio for the day", () => {
    const p = buildUserPrompt(digest);
    expect(p).toContain("2026-06-09");
    expect(p).toContain("Ghostty");
    expect(p).toContain("$ bun test");
    expect(p).toContain("let's ship it");
  });
});
```

- [ ] **Step 4: Run the curation-prompt tests**

Run: `cd ~/code/screenpipe-distiller && bun test src/curation-prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add src/curation-prompt.ts src/curation-prompt.test.ts
git commit -m "♻️ refactor(curate): drop the connector conversations section"
```

---

### Task 17: Clean `.env.example` + full distiller verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Edit `.env.example`** — delete the entire `# === WhatsApp connector …` section (the final block, lines 28–36). The file ends after the petals-mode block.

- [ ] **Step 2: Type-check the whole distiller**

Run: `cd ~/code/screenpipe-distiller && bun run type-check`
Expected: no errors (all `Conversation`/`conversations`/`WHATSAPP_*` references are gone).

- [ ] **Step 3: Run the full distiller suite**

Run: `cd ~/code/screenpipe-distiller && bun test`
Expected: ALL tests pass. Confirm there is no remaining `src/whatsapp/` directory and no test references it.

- [ ] **Step 4: Final reference sweep**

Run: `cd ~/code/screenpipe-distiller && grep -rn "WHATSAPP\|loadWhatsAppConversations\|\.conversations\|ConversationMessage" src || echo "clean"`
Expected: only `channels.ts`/`channels.test.ts` doc-string mentions of "conversation" (the channel classifier, intentionally kept) — and no `WHATSAPP_*`, no `loadWhatsAppConversations`, no `.conversations`, no `ConversationMessage`.

- [ ] **Step 5: Commit**

```bash
cd ~/code/screenpipe-distiller
git add .env.example
git commit -m "🔧 chore(env): drop WhatsApp connector settings"
```

---

### Task 18: Update the spec status (optional bookkeeping)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-whatsapp-memory-service-design.md`

- [ ] **Step 1:** Change the `**Status:**` line to `Implemented`. Commit:

```bash
cd ~/code/screenpipe-distiller
git add docs/superpowers/specs/2026-06-16-whatsapp-memory-service-design.md
git commit -m "📚 docs: mark whatsapp-memory spec implemented"
```

---

# Phase 3 — Cutover (manual, requires explicit go-ahead)

> ⚠️ This is the only step that touches the live WhatsApp sync. Do it deliberately, in order. It needs the running Mac with the existing session. **Get explicit user confirmation before running** — and confirm the new gateway connects before installing the pusher.

### Task 19: Swap the gateway LaunchAgent + first backfill

- [ ] **Step 1: Stop the old sidecar** (frees port 3036; session files are left intact)

```bash
launchctl unload ~/Library/LaunchAgents/com.screenpipe-distiller.whatsapp.plist 2>/dev/null || true
```

- [ ] **Step 2: Install + start the new gateway** (reuses the same session dir)

```bash
cd ~/code/whatsapp-memory && bun install && ./scripts/install-gateway.sh
```

- [ ] **Step 3: Verify it reconnected with NO re-pair**

Run: `sleep 5 && curl -fsS http://127.0.0.1:3036/status | jq`
Expected: `"connected": true` with your `name`/`phone` populated and `qrReady: false`. If `qrReady` is true, STOP — the session did not carry over; investigate before proceeding (do not delete the session).

- [ ] **Step 4: Create `.env` and run the initial backfill**

```bash
cd ~/code/whatsapp-memory
cp .env.example .env   # then edit: set PETALS_API_KEY and SELF_ALIASES
bun run push --backfill 30
```

Expected: `{"type":"push-summary","pushed":<N>,...}` with `N > 0`.

**Note on the first backfill + Petals rate limit:** the Petals API key is limited to ~100 requests/hour, and a full 30-day backfill can attempt more than that in one run. So expect a non-zero `failed` count on the first pass — those are HTTP 429s. This is **not** data loss: 429s are retried within the run, and any still-failing `(chat, day)` is left unrecorded and retried automatically on the next run (each run reconsiders the whole `BACKFILL_DAYS` window), so the backlog drains over a few runs. To avoid the noise, backfill in smaller windows — e.g. `bun run push --backfill 7`, wait ~an hour, repeat — or just let the daily 04:00 pusher drain it. Only investigate `failed` counts that persist after the window has had time to drain, via `push.err.log`.

- [ ] **Step 5: Spot-check in Memory** — confirm a recent WhatsApp transcript appears (search Petals/Memory for a known contact name). Re-run `bun run push` and confirm the summary is now all-`skipped` (idempotent watermark working).

- [ ] **Step 6: Install the daily pusher agent**

```bash
cd ~/code/whatsapp-memory && ./scripts/install-pusher.sh
```

- [ ] **Step 7: Remove the obsolete old LaunchAgent plist**

```bash
rm -f ~/Library/LaunchAgents/com.screenpipe-distiller.whatsapp.plist
```

- [ ] **Step 8:** Merge `feat/whatsapp-memory-extract` in `screenpipe-distiller` (or open a PR) per the finishing-a-development-branch flow.

---

## Self-review notes (author)

- **Spec coverage:** Full extract (Tasks 1–11); reuse session in place / no re-pair (Task 2 keeps gateway data-dir default + Task 19 reuses session); transcript endpoint (Tasks 5, 7); DMs + filtered groups (Task 5, `savedSenders`); one-shot per completed day + watermark (Tasks 4, 6, 8); bounded backfill via `recentCompletedDayKeys`+`BACKFILL_DAYS` (Tasks 4, 8, 9); Petals transport, no `userId` (Task 7); distiller cleanup + unconditional suppression (Tasks 12–17). All spec sections map to a task.
- **Deviation from spec (intentional, surfaced for review):** spec said `SELF_ALIASES` defaults by seeding from the gateway `/status` name; this plan makes it explicit required config instead (deterministic, testable, no gateway dependency at push time). Documented in `.env.example`.
- **Type consistency:** `TranscriptPayload`/`DayTranscript`/`buildDayTranscripts` (Task 5) are consumed unchanged by `ingestTranscript` (Task 7) and `runPush` (Task 8); `Config` fields (Task 3) match every `config.X` access in `pusher.ts`/`push.ts`; archive method names (`listMessagesInWindow`, `chatNames`, `savedContacts`) match the moved `archive.ts`.
- **No placeholders:** every code/test step contains full content; verification steps give exact commands + expected output.
