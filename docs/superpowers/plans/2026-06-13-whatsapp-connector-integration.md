# WhatsApp Connector Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the WhatsApp sidecar's archived messages into the daily distill as structured conversations with real names, and suppress the now-redundant a11y/OCR WhatsApp capture when the connector contributed messages.

**Architecture:** Two cooperating processes share one SQLite archive as the contract. The **sidecar** (`src/whatsapp/gateway.ts`, runs under launchd) is the sole writer; we enrich it to also store contact/group names. The **distiller** opens the archive **read-only** for the target day, builds per-chat `Conversation`s, attaches them to the `DayDigest`, conditionally suppresses a11y WhatsApp buckets, and renders a `## Conversations` block for the curation LLM.

**Tech Stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `bun:sqlite`, Zod boundary parsing, `@whiskeysockets/baileys`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-13-whatsapp-connector-integration-design.md`

---

## Conventions for every task

- Tests live beside source as `src/**/<name>.test.ts` (Bun's `bun:test`). There is no `tests/` dir.
- Type-only imports MUST use `import type` (`verbatimModuleSyntax` is on). Mixed imports use inline `type`: `import { Foo, type Bar } from "./x"`.
- Indexed access is `T | undefined` (`noUncheckedIndexedAccess`); guard with `?? fallback`.
- Named exports only. No `any`. Validate external input with Zod at the boundary, then trust types.
- After **every** task run `bun test` (all green) and `bun run type-check` (no output = clean). The tree stays green after every commit — there is no intentionally-red intermediate state.
- Stage **explicit paths** in commits — never `git add -A` or `.`. Never stage `.cursor/`.
- Commit messages: `<emoji> <type>(<scope>): <subject>`. No AI mentions.

---

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `.gitignore`, `src/whatsapp/archive.test.ts` (fix) | Stop leaking sqlite/session artifacts; relocate test temp DBs | 1 |
| `src/whatsapp/archive.ts` (+test) | `chats` name store, read-only open, day-window query | 2 |
| `src/whatsapp/names.ts` (new, +test), `gateway.ts`, `message.test.ts` | Pure name extraction + sidecar wiring + group-sender test | 3 |
| `src/types.ts`, `src/screenpipe.ts` (condense), 3 test fixtures | `Conversation` types + `DayDigest.conversations` + `suppressBucket` | 4 |
| `src/whatsapp/conversations.ts` (new, +test) | Archive → per-day `Conversation[]` with names + caps | 5 |
| `src/screenpipe.ts` (fetch, +test) | `loadConversations` param, suppression, compose digest | 6 |
| `src/config.ts` (+test), `.env.example` | `WHATSAPP_CONNECTOR`, `WHATSAPP_ARCHIVE_PATH` (~ expand) | 7 |
| `src/distill.ts` | Wire the real loader into `defaultDeps` | 8 |
| `src/curation-prompt.ts` (+test) | `## Conversations` block + rule-6 sentence | 9 |
| `README.md`, `docs/messaging-connectors.md` | Note the connector now feeds the distill | 10 |

---

### Task 1: Foundation — commit the sidecar baseline, fix test litter, gitignore artifacts

The sidecar (`src/whatsapp/`), install script, ingestion docs, and `package.json` deps are currently **untracked/uncommitted**. Commit them as the clean baseline the rest of the work builds on. The existing `archive.test.ts` writes temp DBs into the **source dir** and leaks `-shm`/`-wal` files (24 now litter `src/whatsapp/`); fix that before committing.

**Files:**
- Modify: `src/whatsapp/archive.test.ts`, `.gitignore`
- Remove (untracked litter): `src/whatsapp/archive-*.sqlite*`
- Commit (untracked/modified baseline): `src/whatsapp/{gateway,archive,message}.ts`, `src/whatsapp/{archive,message}.test.ts`, `scripts/install-whatsapp-sidecar.sh`, `docs/messaging-connectors.md`, `docs/whatsapp-connector.md`, `README.md`, `package.json`, `.gitignore`

- [ ] **Step 1: Remove the leaked sqlite litter**

```bash
rm -f src/whatsapp/archive-*.sqlite src/whatsapp/archive-*.sqlite-shm src/whatsapp/archive-*.sqlite-wal
ls src/whatsapp/archive-*.sqlite* 2>/dev/null && echo "STILL DIRTY" || echo "clean"
```
Expected: `clean`

- [ ] **Step 2: Append artifact ignores to `.gitignore`**

Append these lines to the existing `.gitignore` (keep current contents):

```gitignore

# WhatsApp sidecar local state — never commit message DBs or live session creds
*.sqlite
*.sqlite-shm
*.sqlite-wal
**/whatsapp/session/
```

- [ ] **Step 3: Rewrite the `archive.test.ts` harness to use the OS temp dir and clean WAL siblings**

Replace lines 1–17 (imports through `afterEach`) with:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppArchive } from "./archive";

const paths: string[] = [];

const tempPath = (): string => {
  const path = join(tmpdir(), `wa-archive-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};

const createArchive = (): WhatsAppArchive => new WhatsAppArchive(tempPath());

afterEach(() => {
  paths.forEach((path) => {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  });
  paths.length = 0;
});
```

Then in the `"keeps persisted messages after reopening"` test, replace its first two lines:
```ts
    const path = join(import.meta.dir, `archive-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
```
with:
```ts
    const path = tempPath();
```

- [ ] **Step 4: Run the suite and confirm no litter is created**

Run: `bun test src/whatsapp/archive.test.ts && ls src/whatsapp/archive-*.sqlite* 2>/dev/null && echo "DIRTY" || echo "clean"`
Expected: tests PASS, then `clean`.

- [ ] **Step 5: Confirm the whole baseline is green**

Run: `bun test && bun run type-check`
Expected: all tests pass; type-check prints nothing.

- [ ] **Step 6: Commit the foundation (explicit paths only — never `.cursor/`)**

```bash
git add src/whatsapp/gateway.ts src/whatsapp/archive.ts src/whatsapp/message.ts \
        src/whatsapp/archive.test.ts src/whatsapp/message.test.ts \
        scripts/install-whatsapp-sidecar.sh docs/messaging-connectors.md \
        docs/whatsapp-connector.md README.md package.json .gitignore
git commit -m "✨ feat(whatsapp): persistent ingestion sidecar + ingestion docs"
```

---

### Task 2: Archive — name store, read-only open, day-window query

Add a `chats(jid, name, is_group)` table with an upsert + reader, a read-only constructor option that skips DDL, and a timestamp-window message query. Purely additive to the existing `messages` storage.

**Files:**
- Modify: `src/whatsapp/archive.ts`
- Test: `src/whatsapp/archive.test.ts`

- [ ] **Step 1: Write failing tests for the new archive API**

Add `import { Database } from "bun:sqlite";` to the test imports, then add these tests inside the existing `describe("WhatsAppArchive", …)` block:

```ts
  test("stores and reads back chat names; upsert overwrites", () => {
    const archive = createArchive();
    archive.upsertChatName("person@s.whatsapp.net", "Alice", false);
    archive.upsertChatName("group@g.us", "Trip 2026", true);
    archive.upsertChatName("person@s.whatsapp.net", "Alice Smith", false);

    expect(archive.chatNames()).toEqual(
      new Map([
        ["person@s.whatsapp.net", "Alice Smith"],
        ["group@g.us", "Trip 2026"],
      ]),
    );
    archive.close();
  });

  test("lists only messages inside the window, ordered by jid then time", () => {
    const archive = createArchive();
    const at = (jid: string, ts: number, id: string) => ({
      id,
      jid,
      fromMe: false,
      sender: jid,
      text: `m-${id}`,
      mediaType: null,
      timestamp: ts,
      pushName: null,
    });
    archive.storeMessages([
      at("b@s.whatsapp.net", 100, "1"),
      at("a@s.whatsapp.net", 150, "2"),
      at("a@s.whatsapp.net", 250, "3"), // outside window (end is exclusive)
      at("a@s.whatsapp.net", 50, "4"), // before window
    ]);

    expect(archive.listMessagesInWindow(100, 250).map((m) => m.id)).toEqual(["2", "1"]);
    archive.close();
  });

  test("opens read-only without running DDL and reads existing data", () => {
    const path = tempPath();
    const writer = new WhatsAppArchive(path);
    writer.storeMessages([
      { id: "1", jid: "p@s.whatsapp.net", fromMe: false, sender: "p@s.whatsapp.net", text: "hi", mediaType: null, timestamp: 200, pushName: null },
    ]);
    writer.upsertChatName("p@s.whatsapp.net", "Pat", false);
    writer.close();

    const reader = new WhatsAppArchive(path, { readonly: true });
    expect(reader.listMessagesInWindow(100, 300).map((m) => m.text)).toEqual(["hi"]);
    expect(reader.chatNames()).toEqual(new Map([["p@s.whatsapp.net", "Pat"]]));
    reader.close();
  });

  test("chatNames returns an empty map when the chats table is absent", () => {
    const path = tempPath();
    const raw = new Database(path, { create: true });
    raw.exec(
      `CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT, media_type TEXT, timestamp INTEGER NOT NULL, push_name TEXT)`,
    );
    raw.close();

    const archive = new WhatsAppArchive(path, { readonly: true });
    expect(archive.chatNames()).toEqual(new Map());
    archive.close();
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `bun test src/whatsapp/archive.test.ts -t "chat names"`
Expected: FAIL (e.g. `upsertChatName is not a function`).

- [ ] **Step 3: Implement the archive changes**

Replace the constructor (lines 25–42) with an options-aware version that skips DDL when read-only:

```ts
  constructor(path: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      // Read-only connections cannot run DDL; the sidecar owns the schema.
      this.#database = new Database(path, { readonly: true });
      return;
    }
    this.#database = new Database(path, { create: true });
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        sender TEXT NOT NULL,
        text TEXT,
        media_type TEXT,
        timestamp INTEGER NOT NULL,
        push_name TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_jid_timestamp
        ON messages (jid, timestamp);
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
```

Add these methods to the class (after `listMessages`, before `listChats`):

```ts
  upsertChatName(jid: string, name: string, isGroup: boolean): void {
    this.#database
      .query(`
        INSERT INTO chats (jid, name, is_group) VALUES (?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET name = excluded.name, is_group = excluded.is_group
      `)
      .run(jid, name, isGroup ? 1 : 0);
  }

  chatNames(): Map<string, string> {
    try {
      const rows = this.#database
        .query<{ jid: string; name: string }, []>(`SELECT jid, name FROM chats`)
        .all();
      return new Map(rows.map((row) => [row.jid, row.name]));
    } catch {
      // Archive written before name enrichment has no `chats` table — treat as no names.
      return new Map();
    }
  }

  listMessagesInWindow(startUnix: number, endUnix: number): ArchivedMessage[] {
    const rows = this.#database
      .query<MessageRow, [number, number]>(`
        SELECT
          id,
          jid,
          from_me AS fromMe,
          sender,
          text,
          media_type AS mediaType,
          timestamp,
          push_name AS pushName
        FROM messages
        WHERE timestamp >= ? AND timestamp < ?
        ORDER BY jid, timestamp ASC
      `)
      .all(startUnix, endUnix);

    return rows.map((row) => ({ ...row, fromMe: row.fromMe === 1 }));
  }
```

- [ ] **Step 4: Run archive tests and type-check**

Run: `bun test src/whatsapp/archive.test.ts && bun run type-check`
Expected: all PASS; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/archive.ts src/whatsapp/archive.test.ts
git commit -m "✨ feat(whatsapp): archive name store + read-only day-window query"
```

---

### Task 3: Sidecar name capture — pure transforms + gateway wiring

The archive holds no names yet (`push_name` is NULL across history). Capture contact names and group subjects from the Baileys events that carry them. Put the transforms in a pure, tested module; the gateway wires events to `upsertChatName`. Also pin the message-side group-sender behavior that name resolution depends on.

**Files:**
- Create: `src/whatsapp/names.ts`, `src/whatsapp/names.test.ts`
- Modify: `src/whatsapp/gateway.ts`, `src/whatsapp/message.test.ts`

- [ ] **Step 1: Write failing tests for the pure transforms**

Create `src/whatsapp/names.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { contactNameUpdates, groupNameUpdates } from "./names";

describe("contactNameUpdates", () => {
  test("prefers name, then notify, then verifiedName; skips blanks and id-less", () => {
    expect(
      contactNameUpdates([
        { id: "a@s.whatsapp.net", name: "Alice" },
        { id: "b@s.whatsapp.net", notify: "Bob" },
        { id: "c@s.whatsapp.net", verifiedName: "Carol Inc" },
        { id: "d@s.whatsapp.net", name: "  ", notify: "" },
        { name: "No Id" },
      ]),
    ).toEqual([
      { jid: "a@s.whatsapp.net", name: "Alice", isGroup: false },
      { jid: "b@s.whatsapp.net", name: "Bob", isGroup: false },
      { jid: "c@s.whatsapp.net", name: "Carol Inc", isGroup: false },
    ]);
  });
});

describe("groupNameUpdates", () => {
  test("keeps group jids with a name/subject; drops non-groups and blanks", () => {
    expect(
      groupNameUpdates([
        { id: "trip@g.us", subject: "Trip 2026" },
        { id: "fam@g.us", name: "Family" },
        { id: "person@s.whatsapp.net", name: "Not A Group" },
        { id: "empty@g.us", subject: "  " },
      ]),
    ).toEqual([
      { jid: "trip@g.us", name: "Trip 2026", isGroup: true },
      { jid: "fam@g.us", name: "Family", isGroup: true },
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/whatsapp/names.test.ts`
Expected: FAIL (module not found / not a function).

- [ ] **Step 3: Implement `src/whatsapp/names.ts`**

```ts
/**
 * Pure transforms from Baileys event payloads to chat-name updates.
 * Aliases: contact name extraction, group subject resolution, whatsapp names.
 */

export interface ChatNameUpdate {
  jid: string;
  name: string;
  isGroup: boolean;
}

interface BaileysContact {
  id?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

interface BaileysChat {
  id?: string | null;
  name?: string | null;
  subject?: string | null;
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Contact names from `contacts.upsert` / `contacts.update` or a history-set `contacts` array. */
export function contactNameUpdates(contacts: readonly BaileysContact[]): ChatNameUpdate[] {
  return contacts.flatMap((contact) => {
    const name = firstNonEmpty(contact.name, contact.notify, contact.verifiedName);
    return contact.id && name ? [{ jid: contact.id, name, isGroup: false }] : [];
  });
}

/** Group subjects from a history-set `chats` array or `groups.upsert` / `groups.update`. */
export function groupNameUpdates(chats: readonly BaileysChat[]): ChatNameUpdate[] {
  return chats.flatMap((chat) => {
    const name = firstNonEmpty(chat.name, chat.subject);
    return chat.id && chat.id.endsWith("@g.us") && name
      ? [{ jid: chat.id, name, isGroup: true }]
      : [];
  });
}
```

- [ ] **Step 4: Run the transform tests**

Run: `bun test src/whatsapp/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the group-sender mapping test to `message.test.ts`**

Add this test inside the existing `describe("toArchivedMessage", …)` block in `src/whatsapp/message.test.ts`:

```ts
  test("uses the group participant as the sender", () => {
    expect(
      toArchivedMessage({
        key: {
          id: "g1",
          remoteJid: "trip@g.us",
          fromMe: false,
          participant: "alice@s.whatsapp.net",
        },
        messageTimestamp: 1_700_000_000,
        message: { conversation: "boarding now" },
      }),
    ).toMatchObject({
      jid: "trip@g.us",
      sender: "alice@s.whatsapp.net",
      text: "boarding now",
    });
  });
```

Run: `bun test src/whatsapp/message.test.ts`
Expected: PASS (this pins existing `message.ts` behavior — no source change needed).

- [ ] **Step 6: Wire the transforms into the gateway**

In `src/whatsapp/gateway.ts`:

Add to the imports (after the `./message` import on line 13):
```ts
import { contactNameUpdates, groupNameUpdates, type ChatNameUpdate } from "./names";
```

Add these helpers immediately after the `storeMessages` function (after line 42):
```ts
const applyNames = (updates: readonly ChatNameUpdate[]): void => {
  updates.forEach((update) => archive.upsertChatName(update.jid, update.name, update.isGroup));
};

const backfillGroupNames = async (socket: ReturnType<typeof makeWASocket>): Promise<void> => {
  const known = archive.chatNames();
  const missing = archive
    .listChats()
    .map((chat) => chat.jid)
    .filter((jid) => jid.endsWith("@g.us") && !known.has(jid));
  for (const jid of missing) {
    try {
      const meta = await socket.groupMetadata(jid);
      const subject = meta.subject?.trim();
      if (subject) archive.upsertChatName(jid, subject, true);
    } catch {
      // Group may be inaccessible (left/removed); skip and continue.
    }
  }
};
```

Replace the `messaging-history.set` handler (lines 90–96) so it also captures names:
```ts
  socket.ev.on("messaging-history.set", ({ messages, contacts, chats, syncType, chunkOrder }) => {
    const stored = storeMessages(messages);
    applyNames(contactNameUpdates(contacts ?? []));
    applyNames(groupNameUpdates(chats ?? []));
    historyChunks += 1;
    historyMessages += stored;
    lastHistorySyncAt = new Date().toISOString();
    console.log(JSON.stringify({ type: "history-sync", syncType, chunkOrder, stored }));
  });
```

Add live name events immediately after the `messages.upsert` handler (after line 99):
```ts
  socket.ev.on("contacts.upsert", (contacts) => applyNames(contactNameUpdates(contacts)));
  socket.ev.on("contacts.update", (contacts) => applyNames(contactNameUpdates(contacts)));
  socket.ev.on("groups.upsert", (groups) => applyNames(groupNameUpdates(groups)));
  socket.ev.on("groups.update", (groups) => applyNames(groupNameUpdates(groups)));
```

In the `connection === "open"` branch of `connection.update`, add the backfill after the existing `console.log(JSON.stringify({ type: "connected", … }))` line:
```ts
      void backfillGroupNames(socket);
```

- [ ] **Step 7: Type-check and run the whatsapp tests**

Run: `bun run type-check && bun test src/whatsapp/`
Expected: type-check clean; tests PASS. (The gateway is process glue with no unit test — coverage is the pure `names.ts` + type-check.)

- [ ] **Step 8: Commit**

```bash
git add src/whatsapp/names.ts src/whatsapp/names.test.ts src/whatsapp/gateway.ts src/whatsapp/message.test.ts
git commit -m "✨ feat(whatsapp): capture contact & group names in the sidecar"
```

---

### Task 4: Digest model — conversations + condense suppression

Add the `Conversation` types and the required `DayDigest.conversations` field, teach `condenseItems` to skip suppressed buckets and emit `conversations: []`, and update every `DayDigest` literal in the test suite so the tree stays green in one commit.

**Files:**
- Modify: `src/types.ts`, `src/screenpipe.ts`
- Test: `src/screenpipe.condense.test.ts`
- Fixture fixups: `src/curate.test.ts`, `src/distill.test.ts`, `src/curation-prompt.test.ts`

- [ ] **Step 1: Add the conversation types and extend `DayDigest`**

In `src/types.ts`, add after `AudioSnippet` (line 16):
```ts
export interface ConversationMessage {
  sender: string;
  fromMe: boolean;
  text: string;
  timestamp: string; // ISO
}

export interface Conversation {
  channel: string; // e.g. "WhatsApp"
  chatName: string;
  isGroup: boolean;
  messages: ConversationMessage[];
}
```

Replace the `DayDigest` interface to include `conversations`:
```ts
export interface DayDigest {
  dayKey: string;
  apps: AppActivity[];
  audio: AudioSnippet[];
  conversations: Conversation[];
  totalFrames: number;
  isEmpty: boolean;
}
```

- [ ] **Step 2: Write failing condense tests**

Add to `src/screenpipe.condense.test.ts` inside the `describe("condenseItems", …)` block:
```ts
  test("suppressBucket drops matching buckets entirely", () => {
    const items: SearchItem[] = [
      ocr("WhatsApp", "Lorena: hi", "2026-06-12T09:00:00Z"),
      ocr("Zed", "code", "2026-06-12T09:01:00Z"),
    ];
    const digest = condenseItems(items, "2026-06-12", {
      suppressBucket: (key) => key.toLowerCase().includes("whatsapp"),
    });
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeUndefined();
    expect(digest.apps.find((a) => a.app === "Zed")).toBeDefined();
  });

  test("digest carries an empty conversations array by default", () => {
    expect(condenseItems([], "2026-06-12").conversations).toEqual([]);
  });
```

- [ ] **Step 3: Run to confirm failure**

Run: `bun test src/screenpipe.condense.test.ts -t "suppressBucket"`
Expected: FAIL.

- [ ] **Step 4: Implement the condense changes**

In `src/screenpipe.ts`, update the type import on line 6:
```ts
import type { AppActivity, Conversation, DayDigest } from "./types";
```

Change the `condenseItems` signature (line 107) to accept options:
```ts
export function condenseItems(
  items: SearchItem[],
  dayKey: string,
  opts: { suppressBucket?: (key: string) => boolean } = {},
): DayDigest {
```

Right after `const { bucketKey, isComms } = classifyChannel(c);` (line 126), add:
```ts
    if (opts.suppressBucket?.(bucketKey)) continue;
```

Replace the final return (line 186) with:
```ts
  const conversations: Conversation[] = [];
  return {
    dayKey,
    apps,
    audio,
    conversations,
    totalFrames,
    isEmpty: apps.length === 0 && audio.length === 0 && conversations.length === 0,
  };
```

- [ ] **Step 5: Update the `DayDigest` literals in the other test files**

These are mechanical type fixes (add `conversations: []`). Apply each:

`src/curate.test.ts` — in the `nonEmpty` fixture, add `conversations: [],` after its `audio: [],` line. And replace the inline `empty`:
```ts
    const empty: DayDigest = { dayKey: "2026-06-09", apps: [], audio: [], conversations: [], totalFrames: 0, isEmpty: true };
```

`src/distill.test.ts` — replace the line-10 `digest`:
```ts
    const digest: DayDigest = { dayKey: "2026-06-09", apps: [{ app: "Ghostty", windows: [], urls: [], sampleText: [], firstSeen: "", lastSeen: "", frames: 1 }], audio: [], conversations: [], totalFrames: 1, isEmpty: false };
```
and in the dry-run `digest` literal add `conversations: [],` after its `audio: [],` line.

`src/curation-prompt.test.ts` — in the `digest` fixture add `conversations: [],` after its `audio: [...],` line.

- [ ] **Step 6: Run the full suite + type-check**

Run: `bun test && bun run type-check`
Expected: ALL PASS; type-check clean.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/screenpipe.ts src/screenpipe.condense.test.ts src/curate.test.ts src/distill.test.ts src/curation-prompt.test.ts
git commit -m "✨ feat(digest): conversations on the day digest + condense suppression"
```

---

### Task 5: Distiller reader — build per-day conversations from the archive

**Files:**
- Create: `src/whatsapp/conversations.ts`, `src/whatsapp/conversations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/whatsapp/conversations.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppArchive, type ArchivedMessage } from "./archive";
import { loadWhatsAppConversations } from "./conversations";

const paths: string[] = [];
const tempPath = (): string => {
  const path = join(tmpdir(), `wa-conv-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};
const seed = (messages: readonly ArchivedMessage[], names: [string, string, boolean][] = []): string => {
  const path = tempPath();
  const archive = new WhatsAppArchive(path);
  archive.storeMessages(messages);
  names.forEach(([jid, name, isGroup]) => archive.upsertChatName(jid, name, isGroup));
  archive.close();
  return path;
};
const msg = (over: Partial<ArchivedMessage> & Pick<ArchivedMessage, "id" | "jid" | "timestamp">): ArchivedMessage => ({
  fromMe: false,
  sender: over.jid,
  text: "hi",
  mediaType: null,
  pushName: null,
  ...over,
});

afterEach(() => {
  paths.forEach((path) => {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  });
  paths.length = 0;
});

describe("loadWhatsAppConversations", () => {
  test("returns [] when the archive file does not exist", () => {
    expect(
      loadWhatsAppConversations({ archivePath: join(tmpdir(), "nope.sqlite"), startUnix: 0, endUnix: 9_999_999_999 }),
    ).toEqual([]);
  });

  test("returns [] when the window is empty", () => {
    const path = seed([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 50 })]);
    expect(loadWhatsAppConversations({ archivePath: path, startUnix: 100, endUnix: 200 })).toEqual([]);
  });

  test("names a 1:1 chat from the chats table and resolves my/their messages", () => {
    const path = seed(
      [
        msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, fromMe: false, sender: "p@s.whatsapp.net", text: "yo" }),
        msg({ id: "2", jid: "p@s.whatsapp.net", timestamp: 110, fromMe: true, sender: "me", text: "hey" }),
      ],
      [["p@s.whatsapp.net", "Pat", false]],
    );
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv).toMatchObject({ channel: "WhatsApp", chatName: "Pat", isGroup: false });
    expect(conv?.messages).toEqual([
      { sender: "Pat", fromMe: false, text: "yo", timestamp: new Date(100_000).toISOString() },
      { sender: "me", fromMe: true, text: "hey", timestamp: new Date(110_000).toISOString() },
    ]);
  });

  test("uses the group subject and resolves the participant's name", () => {
    const path = seed(
      [msg({ id: "1", jid: "trip@g.us", timestamp: 100, sender: "a@s.whatsapp.net", text: "boarding" })],
      [
        ["trip@g.us", "Trip 2026", true],
        ["a@s.whatsapp.net", "Alice", false],
      ],
    );
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv).toMatchObject({ chatName: "Trip 2026", isGroup: true });
    expect(conv?.messages[0]?.sender).toBe("Alice");
  });

  test("falls back to +number and renders media placeholders", () => {
    const path = seed([
      msg({ id: "1", jid: "31612345678@s.whatsapp.net", timestamp: 100, sender: "31612345678@s.whatsapp.net", text: null, mediaType: "image" }),
    ]);
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv?.chatName).toBe("+31612345678");
    expect(conv?.messages[0]).toMatchObject({ sender: "+31612345678", text: "[image]" });
  });

  test("ranks conversations by recency and applies caps", () => {
    const messages: ArchivedMessage[] = [];
    for (let chat = 0; chat < 35; chat += 1) {
      messages.push(msg({ id: `c${chat}`, jid: `chat${chat}@s.whatsapp.net`, timestamp: 1000 + chat }));
    }
    for (let i = 0; i < 50; i += 1) {
      messages.push(msg({ id: `recent-${i}`, jid: "recent@s.whatsapp.net", timestamp: 5000 + i, text: `m${i}` }));
    }
    const path = seed(messages);
    const convs = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 100_000 });
    expect(convs.length).toBe(30); // 36 chats capped to 30
    expect(convs[0]?.chatName).toBe("+recent"); // most recent activity first (no name → +user)
    expect(convs[0]?.messages.length).toBe(40); // 50 capped to most-recent 40
    expect(convs[0]?.messages[0]?.text).toBe("m10"); // chronological order kept
    expect(convs[0]?.messages.at(-1)?.text).toBe("m49");
  });

  test("truncates long messages to the cap", () => {
    const path = seed([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, text: "x".repeat(3000) })]);
    const [conv] = loadWhatsAppConversations({
      archivePath: path,
      startUnix: 0,
      endUnix: 1000,
      caps: { maxConversations: 30, maxMessagesPerConversation: 40, maxMessageLen: 2500 },
    });
    expect(conv?.messages[0]?.text.length).toBe(2501); // 2500 chars + ellipsis
    expect(conv?.messages[0]?.text.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/whatsapp/conversations.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/whatsapp/conversations.ts`**

```ts
/**
 * Builds per-day WhatsApp conversations from the sidecar archive for the digest.
 * Aliases: whatsapp day conversations, connector reader, archive to digest.
 */
import { existsSync } from "node:fs";
import { WhatsAppArchive, type ArchivedMessage } from "./archive";
import type { Conversation, ConversationMessage } from "../types";

export interface ConversationCaps {
  maxConversations: number;
  maxMessagesPerConversation: number;
  maxMessageLen: number;
}

export const DEFAULT_CONVERSATION_CAPS: ConversationCaps = {
  maxConversations: 30,
  maxMessagesPerConversation: 40,
  maxMessageLen: 2500,
};

interface LoadParams {
  archivePath: string;
  startUnix: number;
  endUnix: number;
  caps?: ConversationCaps;
}

function phoneFromJid(jid: string): string {
  const [user] = jid.split("@");
  return `+${user ?? jid}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function messageText(message: ArchivedMessage): string | null {
  return message.text ?? (message.mediaType ? `[${message.mediaType}]` : null);
}

export function loadWhatsAppConversations(params: LoadParams): Conversation[] {
  const caps = params.caps ?? DEFAULT_CONVERSATION_CAPS;
  if (!existsSync(params.archivePath)) return [];

  const archive = new WhatsAppArchive(params.archivePath, { readonly: true });
  try {
    const messages = archive.listMessagesInWindow(params.startUnix, params.endUnix);
    return buildConversations(messages, archive.chatNames(), caps);
  } finally {
    archive.close();
  }
}

function buildConversations(
  messages: readonly ArchivedMessage[],
  names: Map<string, string>,
  caps: ConversationCaps,
): Conversation[] {
  const byJid = new Map<string, ArchivedMessage[]>();
  for (const message of messages) {
    const list = byJid.get(message.jid) ?? [];
    list.push(message);
    byJid.set(message.jid, list);
  }

  return [...byJid.entries()]
    .map(([jid, msgs]) => {
      const isGroup = jid.endsWith("@g.us");
      const chatName = names.get(jid) ?? (isGroup ? "WhatsApp group" : phoneFromJid(jid));
      const lastTimestamp = msgs.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0);
      const rendered = msgs.flatMap((m): ConversationMessage[] => {
        const text = messageText(m);
        if (text === null) return [];
        const sender = m.fromMe ? "me" : (names.get(m.sender) ?? phoneFromJid(m.sender));
        return [
          {
            sender,
            fromMe: m.fromMe,
            text: truncate(text, caps.maxMessageLen),
            timestamp: new Date(m.timestamp * 1000).toISOString(),
          },
        ];
      });
      return { isGroup, chatName, lastTimestamp, rendered };
    })
    .filter((conv) => conv.rendered.length > 0)
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, caps.maxConversations)
    .map((conv) => ({
      channel: "WhatsApp",
      chatName: conv.chatName,
      isGroup: conv.isGroup,
      messages: conv.rendered.slice(-caps.maxMessagesPerConversation),
    }));
}
```

- [ ] **Step 4: Run the tests + type-check**

Run: `bun test src/whatsapp/conversations.test.ts && bun run type-check`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/conversations.ts src/whatsapp/conversations.test.ts
git commit -m "✨ feat(whatsapp): build per-day conversations from the archive"
```

---

### Task 6: fetch — load conversations, suppress, compose digest

**Files:**
- Modify: `src/screenpipe.ts`
- Test: `src/screenpipe.fetch.test.ts`

- [ ] **Step 1: Write failing tests**

Replace the contents of `src/screenpipe.fetch.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { fetchDayActivity, ScreenpipeClient } from "./screenpipe";
import type { Conversation } from "./types";

const ocrOnly = (app: string, text: string) =>
  (async (input: URL) => {
    const ct = new URL(input).searchParams.get("content_type")!;
    const data =
      ct === "ocr"
        ? [{ type: "OCR", content: { app_name: app, text, timestamp: "2026-06-09T10:00:00Z" } }]
        : [];
    return new Response(JSON.stringify({ data, pagination: {} }), { status: 200 });
  }) as unknown as typeof fetch;

const conv: Conversation = {
  channel: "WhatsApp",
  chatName: "Pat",
  isGroup: false,
  messages: [{ sender: "Pat", fromMe: false, text: "hi", timestamp: "2026-06-09T10:00:00Z" }],
};

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
    expect(digest.conversations).toEqual([]);
  });

  test("attaches conversations and suppresses on-screen WhatsApp when the connector contributed", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("WhatsApp", "sidebar preview"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels", async () => [conv]);
    expect(digest.conversations).toEqual([conv]);
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeUndefined(); // suppressed
    expect(digest.isEmpty).toBe(false);
  });

  test("keeps on-screen WhatsApp when the connector returned nothing", async () => {
    const client = new ScreenpipeClient("http://localhost:3030", "tok", ocrOnly("WhatsApp", "sidebar preview"));
    const digest = await fetchDayActivity(client, "2026-06-09", "Europe/Brussels", async () => []);
    expect(digest.apps.find((a) => a.app === "WhatsApp")).toBeDefined(); // not suppressed
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/screenpipe.fetch.test.ts`
Expected: FAIL (the 4-arg call / suppression not implemented).

- [ ] **Step 3: Implement**

In `src/screenpipe.ts`, replace `fetchDayActivity` (lines 204–216) with:

```ts
export async function fetchDayActivity(
  client: ScreenpipeClient,
  dayKey: string,
  timeZone: string,
  loadConversations?: (startIso: string, endIso: string) => Promise<Conversation[]>,
): Promise<DayDigest> {
  const { startIso, endIso } = dayWindowUtc(dayKey, timeZone);
  const [ocr, audio, input, conversations] = await Promise.all([
    client.searchAll({ contentType: "ocr", startIso, endIso, minLength: 50 }),
    client.searchAll({ contentType: "audio", startIso, endIso }),
    client.searchAll({ contentType: "input", startIso, endIso }),
    loadConversations?.(startIso, endIso) ?? Promise.resolve<Conversation[]>([]),
  ]);

  // Suppress the a11y/OCR WhatsApp buckets only when the connector contributed,
  // so the same thread is not counted twice. Covers "WhatsApp" and "WhatsApp (web)".
  const suppress =
    conversations.length > 0 ? (key: string) => key.toLowerCase().includes("whatsapp") : undefined;
  const digest = condenseItems([...ocr, ...audio, ...input], dayKey, { suppressBucket: suppress });
  if (conversations.length === 0) return digest;
  return { ...digest, conversations, isEmpty: false };
}
```

- [ ] **Step 4: Run the full suite + type-check**

Run: `bun test && bun run type-check`
Expected: ALL PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/screenpipe.ts src/screenpipe.fetch.test.ts
git commit -m "✨ feat(digest): fold WhatsApp conversations into fetchDayActivity"
```

---

### Task 7: Config — connector toggle + archive path

**Files:**
- Modify: `src/config.ts`, `.env.example`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/config.test.ts` inside `describe("loadConfig", …)`:
```ts
  test("defaults the WhatsApp connector to auto and expands the archive ~path", () => {
    const cfg = loadConfig(directBase);
    expect(cfg.WHATSAPP_CONNECTOR).toBe("auto");
    expect(cfg.WHATSAPP_ARCHIVE_PATH.startsWith("~")).toBe(false);
    expect(cfg.WHATSAPP_ARCHIVE_PATH.endsWith("/.screenpipe-distiller/whatsapp/messages.sqlite")).toBe(true);
  });

  test("honors an explicit connector value and absolute archive path", () => {
    const cfg = loadConfig({ ...directBase, WHATSAPP_CONNECTOR: "off", WHATSAPP_ARCHIVE_PATH: "/tmp/wa.sqlite" });
    expect(cfg.WHATSAPP_CONNECTOR).toBe("off");
    expect(cfg.WHATSAPP_ARCHIVE_PATH).toBe("/tmp/wa.sqlite");
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/config.test.ts -t "WhatsApp"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/config.ts`, add after the zod import (line 5):
```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~/` to the user's home dir; concrete requirement of the default path. */
function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
```

Add these two fields to the `configSchema` object (after `USER_NAME` on line 14):
```ts
    // WhatsApp connector (structured message ingestion via the sidecar archive)
    WHATSAPP_CONNECTOR: z.enum(["auto", "off"]).default("auto"),
    WHATSAPP_ARCHIVE_PATH: z
      .string()
      .default("~/.screenpipe-distiller/whatsapp/messages.sqlite")
      .transform(expandTilde),
```

- [ ] **Step 4: Add to `.env.example`**

Append:
```
# === WhatsApp connector (structured message ingestion) ===
# "auto" -> fold archived WhatsApp messages into the digest when the sidecar
#           archive exists; "off" -> ignore the connector (screen capture only).
WHATSAPP_CONNECTOR=auto
# WHATSAPP_ARCHIVE_PATH=~/.screenpipe-distiller/whatsapp/messages.sqlite
```

- [ ] **Step 5: Run config tests + type-check**

Run: `bun test src/config.test.ts && bun run type-check`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts .env.example
git commit -m "✨ feat(config): WhatsApp connector + archive path settings"
```

---

### Task 8: Distill — wire the real loader

**Files:**
- Modify: `src/distill.ts`

- [ ] **Step 1: Implement the wiring**

In `src/distill.ts`, add imports after line 9:
```ts
import type { Conversation } from "./types";
import { loadWhatsAppConversations } from "./whatsapp/conversations";
```

Replace `defaultDeps` (lines 17–24) with:
```ts
function defaultDeps(config: Config): DistillDeps {
  const client = new ScreenpipeClient(config.SCREENPIPE_API_URL, config.SCREENPIPE_API_KEY);
  const loadConversations =
    config.WHATSAPP_CONNECTOR === "off"
      ? undefined
      : async (startIso: string, endIso: string): Promise<Conversation[]> => {
          try {
            return loadWhatsAppConversations({
              archivePath: config.WHATSAPP_ARCHIVE_PATH,
              startUnix: Math.floor(Date.parse(startIso) / 1000),
              endUnix: Math.floor(Date.parse(endIso) / 1000),
            });
          } catch (error) {
            console.warn(
              `[whatsapp] archive read failed (${config.WHATSAPP_ARCHIVE_PATH}); continuing screen-only:`,
              error,
            );
            return [];
          }
        };
  return {
    fetchDay: (dayKey) => fetchDayActivity(client, dayKey, config.USER_TIMEZONE, loadConversations),
    curate: (digest) => curateDigest(digest, config),
    upload: (p) => uploadDocument(p, config),
  };
}
```

- [ ] **Step 2: Run full suite + type-check**

Run: `bun test && bun run type-check`
Expected: ALL PASS; clean. (`distill.test.ts` injects its own deps, so `defaultDeps` is composition glue verified by type-check.)

- [ ] **Step 3: Commit**

```bash
git add src/distill.ts
git commit -m "✨ feat(distill): wire the WhatsApp conversation loader"
```

---

### Task 9: Curation prompt — conversations block + connector rule

**Files:**
- Modify: `src/curation-prompt.ts`
- Test: `src/curation-prompt.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/curation-prompt.test.ts`, replace the `digest` fixture (it currently has `conversations: []` from Task 4) so it carries a real conversation:
```ts
const digest: DayDigest = {
  dayKey: "2026-06-09",
  apps: [{ app: "Ghostty", windows: ["zsh"], urls: [], sampleText: ["$ bun test"], firstSeen: "2026-06-09T10:00:00Z", lastSeen: "2026-06-09T11:00:00Z", frames: 12 }],
  audio: [{ speaker: "Marcel", text: "let's ship it", timestamp: "2026-06-09T11:00:00Z" }],
  conversations: [
    {
      channel: "WhatsApp",
      chatName: "Trip 2026",
      isGroup: true,
      messages: [{ sender: "Alice", fromMe: false, text: "boarding now", timestamp: "2026-06-09T08:30:00Z" }],
    },
  ],
  totalFrames: 12,
  isEmpty: false,
};
```

Add `expect(sys).toContain("authoritative");` to the existing system-prompt test, and add a new user-prompt test:
```ts
  test("user prompt renders the conversations block with sender, time, and group marker", () => {
    const p = buildUserPrompt(digest);
    expect(p).toContain("## Conversations");
    expect(p).toContain("### WhatsApp — Trip 2026 (group)");
    expect(p).toContain("- 08:30 Alice: boarding now");
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test src/curation-prompt.test.ts`
Expected: FAIL (`## Conversations` absent; `authoritative` absent).

- [ ] **Step 3: Implement the block and the rule**

In `src/curation-prompt.ts`, in `buildUserPrompt`, insert between the apps loop and the audio block (after line 42, before `if (digest.audio.length)`):
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

In `buildSystemPrompt`, append this sentence to the end of rule 6 (immediately after `…without inventing the rest.`):
```
 Some conversations are provided as a structured "## Conversations" section sourced directly from a connector — full threads with real sender, direction, and timestamp per line. These are authoritative transcripts, not sidebar previews: summarize their substance, attribute statements to the named people, and prefer them over any on-screen capture of the same app.
```

- [ ] **Step 4: Run prompt tests + full suite + type-check**

Run: `bun test && bun run type-check`
Expected: ALL PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/curation-prompt.ts src/curation-prompt.test.ts
git commit -m "✨ feat(curation): render conversations block + connector rule"
```

---

### Task 10: Docs — note the connector now feeds the distill

**Files:**
- Modify: `docs/messaging-connectors.md`, `README.md`

- [ ] **Step 1: Update the messaging-connectors support table**

In `docs/messaging-connectors.md`, change the Personal WhatsApp sidecar row's "Distiller support today?" cell from:
```
Structured archive available; not yet included in daily distill
```
to:
```
Included in the daily distill (auto when the archive exists; disable with WHATSAPP_CONNECTOR=off)
```

Add one sentence at the end of the intro paragraph of the "Structured Read APIs Available in Screenpipe" section:
```
The Personal WhatsApp sidecar archive is now read directly into each daily distill: messages for the day are folded in as structured conversations and the redundant on-screen WhatsApp capture is suppressed for that day. Set `WHATSAPP_CONNECTOR=off` to disable this and fall back to screen capture only.
```

- [ ] **Step 2: Update the README ingestion note**

In `README.md`, under the "Message ingestion" bullets, add:
```
- WhatsApp messages from the paired sidecar are folded into each daily distill automatically (set `WHATSAPP_CONNECTOR=off` to use screen capture only).
```

- [ ] **Step 3: Verify nothing else broke**

Run: `bun test && bun run type-check`
Expected: ALL PASS; clean.

- [ ] **Step 4: Commit**

```bash
git add docs/messaging-connectors.md README.md
git commit -m "📚 docs: note WhatsApp connector ingestion in the pipeline"
```

---

## Final verification (after all tasks)

- [ ] `bun test` — entire suite green.
- [ ] `bun run type-check` — no output.
- [ ] `git status --short` — only intended files committed; `.cursor/` still untracked and untouched; no `*.sqlite*` litter in `src/whatsapp/`.
- [ ] Walk the flow: a day with sidecar messages → `fetchDayActivity` attaches `conversations`, suppresses on-screen WhatsApp; a day with `WHATSAPP_CONNECTOR=off` or no archive → unchanged screen-only behavior.
- [ ] Dispatch a final independent code review over the whole branch, then use `superpowers:finishing-a-development-branch`.
