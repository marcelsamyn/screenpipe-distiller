# WhatsApp connector integration

**Date:** 2026-06-13
**Status:** Approved, ready for planning

## Problem & context

The browser-conversation work (shipped earlier today) routed WhatsApp Web through
the comms path, but hit a hard **capture ceiling**: WhatsApp Web exposes only its
left sidebar (chat list + the single latest message per chat) to the accessibility
tree, never the open thread. So the distiller could see "the latest line of each
active conversation," not real exchanges.

Screenpipe advertises a personal WhatsApp connector ("native browser syncing
engine") that should read full message history. This spec integrates a structured
WhatsApp message source into the daily distill so conversations land with real
sender attribution, direction, and timestamps — and removes the now-redundant a11y
WhatsApp capture so the same messages don't appear twice.

## Investigation findings (evidence)

Empirical investigation on this machine (2026-06-13) reshaped the approach:

1. **Screenpipe's built-in gateway (`:3035`) is inadequate as a read source.** Its
   `~/.screenpipe/whatsapp-gateway.mjs` never requests history (`syncFullHistory`
   unset) and stores messages **in memory only** (`MAX_MESSAGES_PER_CHAT = 200`),
   reset on every daemon restart. After a full manual sync it held **8 message
   bodies across 1 chat** (own number, all empty-text). Chat/contact *metadata*
   synced (425 chats / 424 contacts) but not message bodies. It is **not** persisted
   to Screenpipe's `db.sqlite` (no whatsapp/message/connection tables exist there).
   We cannot fix it: that file is Screenpipe-managed and regenerated on updates.

2. **A custom sidecar (already built in this repo, `src/whatsapp/`) solves it.** It
   runs its own Baileys link with `syncFullHistory: true` +
   `shouldSyncHistoryMessage: () => true` and persists to a durable SQLite archive
   (`~/.screenpipe-distiller/whatsapp/messages.sqlite`, `INSERT OR IGNORE` dedup by
   message id, survives restarts). Measured archive: **24,432 messages / 343 chats /
   21,487 with text**, spanning 2018→2026, with **65 messages on 2026-06-12, 43 on
   06-11** — exactly the daily signal the a11y path cannot produce. `24,432 vs 8` is
   the whole justification for owning the gateway: a concrete capability gap, not NIH.

3. **The archive currently stores numbers, not names.** `push_name` is NULL for all
   21,095 received messages (Baileys attaches `pushName` only on live delivery, not
   history sync); 1:1 chats resolve to a phone number; group messages capture the
   sender's number (`participant`) but no contact name and no group subject. Names
   *do* exist in the Baileys event stream (Screenpipe's gateway pulled 424 contact
   names from it) — the sidecar just doesn't capture them yet.

## Goals

- Read the sidecar's archived WhatsApp messages for the target day and fold them into
  the digest as structured conversations with real names, sender, direction, time.
- Enrich the sidecar so contact and group names are stored and resolvable.
- Suppress the a11y/OCR WhatsApp buckets **only when** the connector contributed
  messages, so the same conversation is not counted twice (and the sidebar fallback
  is retained when the connector is absent).
- Degrade gracefully: if the archive is missing/empty/unreadable, run screen-only.

## Non-goals

- Modifying Screenpipe's own gateway (`:3035`) or depending on it at runtime.
- A bespoke `:3035` fallback adapter (the source is empty in practice — see finding 1).
- Gmail / Microsoft Teams structured readers (desktop-app-only; documented in
  `docs/messaging-connectors.md`, not built here).
- Media content beyond a type placeholder (`[image]`, `[video]`, …).

## Decisions (locked)

- **Read path:** the distiller opens the archive **read-only** and runs a day-window
  query (durable; works even if the sidecar process is momentarily down). Sidecar =
  sole writer, distiller = reader, sharing the `WhatsAppArchive` module.
- **No `:3035` fallback.** Single `WhatsAppSource` concept behind a configurable
  archive path; the sidecar is the one adapter. The genuine fallback is the existing
  a11y/OCR capture path.
- **Suppression is conditional:** only suppress a11y WhatsApp buckets when the
  connector returned ≥1 message for the day.
- **Names via sidecar enrichment** (one source of truth), not borrowed from `:3035`.
- **Caps:** 30 conversations · 40 messages/conversation · 2500 chars/message.
- **Detection:** `WHATSAPP_CONNECTOR=auto|off` (default `auto`); no explicit "on".

## Design

### Architecture

Two cooperating processes in one repo, with the SQLite archive as the contract:

- **Sidecar** (`src/whatsapp/gateway.ts`, runs under launchd via
  `scripts/install-whatsapp-sidecar.sh`): long-lived Baileys link → durable
  `messages.sqlite`. We *enrich* it to also store names. Sole writer.
- **Distiller** (daily run): opens the archive **read-only**, builds per-day
  conversations, folds them into the digest, suppresses redundant a11y WhatsApp
  buckets, curates, uploads.

### 1. Sidecar name enrichment — `src/whatsapp/archive.ts`, `src/whatsapp/gateway.ts`

- New table:
  ```sql
  CREATE TABLE IF NOT EXISTS chats (
    jid      TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0
  );
  ```
  Holds both contact names and group subjects, keyed by jid.
- `WhatsAppArchive.upsertChatName(jid, name, isGroup)` — `INSERT ... ON CONFLICT(jid)
  DO UPDATE SET name = excluded.name, is_group = excluded.is_group`. Only called with
  a non-empty `name` (never overwrite a real name with a blank).
- Gateway captures names from the events that already carry them:
  - `contacts.upsert` / `contacts.update`, and the `contacts` array inside
    `messaging-history.set` → contact name = `name || notify || verifiedName`
    (skip when all blank), `is_group = 0`.
  - the `chats` array inside `messaging-history.set` and `groups.update` /
    `groups.upsert` → group subject (`name` / `subject`), `is_group = 1`.
  - on `connection: "open"`, fetch `socket.groupMetadata(jid)` for known group jids
    still missing a name (guarantees group-subject coverage regardless of history).
- Purely additive — existing `messages` storage is untouched.

### 2. Archive read API additions — `src/whatsapp/archive.ts`

- Constructor gains `{ readonly?: boolean }`. When `readonly`, open with
  `new Database(path, { readonly: true })` and **skip** the `CREATE TABLE` / schema
  `exec` (read-only connections cannot run DDL). The distiller uses
  `new WhatsAppArchive(path, { readonly: true })`.
- `listMessagesInWindow(startUnix, endUnix): ArchivedMessage[]` —
  `SELECT … FROM messages WHERE timestamp >= ? AND timestamp < ? ORDER BY jid,
  timestamp ASC`.
- `chatNames(): Map<string, string>` — `SELECT jid, name FROM chats`. Wrapped in
  try/catch returning an empty map if the `chats` table is absent (compat with an
  archive written before enrichment).

### 3. Distiller reader — `src/whatsapp/conversations.ts` (new)

`loadWhatsAppConversations({ archivePath, startUnix, endUnix, caps }): Conversation[]`

- If the archive file does not exist → return `[]` (connector inactive; graceful).
- Open read-only, `listMessagesInWindow`, build `names = chatNames()`.
- Group messages by `jid` → one `Conversation` per chat.
- Name resolution:
  - `isGroup = jid.endsWith("@g.us")`.
  - `chatName = names.get(jid) ?? (isGroup ? "WhatsApp group" : "+" + jidNumber)`.
  - per message: `sender = fromMe ? "me" : (names.get(participantJid) ?? "+" +
    participantNumber)`, where `participantJid` is the stored `sender` column
    (the group speaker's jid, or the chat jid for 1:1).
  - `timestamp` → ISO `HH:MM` for rendering.
- Message text: `text ?? "[" + mediaType + "]"`; drop messages with neither.
- Caps (`MAX_CONVERSATIONS = 30`, `MAX_MESSAGES_PER_CONVERSATION = 40`,
  `MAX_MESSAGE_LEN = 2500`): rank conversations by most-recent activity (desc), keep
  the top 30; within each, keep the most-recent 40 in **chronological** order;
  truncate each message to 2500 chars.

### 4. Digest model + suppression — `src/types.ts`, `src/screenpipe.ts`

- `types.ts`:
  ```ts
  export interface ConversationMessage {
    sender: string;
    fromMe: boolean;
    text: string;
    timestamp: string; // ISO
  }
  export interface Conversation {
    channel: string;   // "WhatsApp"
    chatName: string;
    isGroup: boolean;
    messages: ConversationMessage[];
  }
  ```
  `DayDigest` gains `conversations: Conversation[]`; `isEmpty` becomes
  `apps.length === 0 && audio.length === 0 && conversations.length === 0`.
- `condenseItems(items, dayKey, opts?: { suppressBucket?: (key: string) => boolean })`
  — when `suppressBucket(bucketKey)` is true, skip the frame entirely (it never
  enters a bucket). Default (no opts) preserves current behavior; existing condense
  tests pass unchanged.
- `fetchDayActivity(client, dayKey, timeZone, loadConversations?)` composes the day:
  1. `conversations = await loadConversations?.(startIso, endIso) ?? []`.
  2. `suppress = conversations.length > 0 ? (k) => k.toLowerCase().includes("whatsapp")
     : undefined` — covers native `"WhatsApp"` and `"WhatsApp (web)"`; safe because
     `classifyChannel` only yields a whatsapp bucketKey for genuine comms frames.
  3. condense screen items with `{ suppressBucket: suppress }`.
  4. attach `conversations` to the returned `DayDigest`.

  `loadConversations` is injected for testability; `distill.ts`'s `defaultDeps` wires
  the real loader from config. When omitted/`off`, no conversations and no
  suppression (the a11y sidebar still flows).

### 5. Curation prompt — `src/curation-prompt.ts`

- `buildUserPrompt` renders a `## Conversations` block (after `## Apps`):
  ```
  ## Conversations
  ### WhatsApp — <chatName>[ (group)]
  - <HH:MM> <sender>: <text>
  ```
- Rule 6 gains a sentence: connector-sourced threads are full, authoritative
  transcripts (sender + direction + time) — summarize the substance, attribute to the
  named people, and prefer them over any on-screen capture of the same app.

### 6. Config / detection / degradation — `src/config.ts`, `.env.example`

- `WHATSAPP_ARCHIVE_PATH` — default `~/.screenpipe-distiller/whatsapp/messages.sqlite`
  (expand `~`).
- `WHATSAPP_CONNECTOR` — `z.enum(["auto","off"]).default("auto")`.
- "Active for the day" = `auto` ∧ archive file exists ∧ ≥1 message in the window →
  only then attach conversations + suppress. `off` → loader not wired at all.
- Archive missing / unreadable / empty window → `console.warn` once, proceed
  screen-only (a11y sidebar retained).

### 7. Hygiene fixes (must, before commit)

- `src/whatsapp/archive.test.ts` currently writes temp DBs into the **source dir**
  (`import.meta.dir`) and only `rmSync`s the base file, leaking `-shm`/`-wal` (≈12
  `archive-*.sqlite-*` files now litter `src/whatsapp/`). Fix: create temp DBs under
  `os.tmpdir()`, `close()` before removing, and delete base + `-shm` + `-wal`. Remove
  the existing litter.
- Add `.gitignore` entries: `*.sqlite`, `*.sqlite-*`, `whatsapp*.log`, and the Baileys
  **session dir** (a live credential — must never be committed).

## Day-window conversion

`dayWindowUtc(dayKey, timeZone)` returns `{ startIso, endIso }`. Convert to unix
seconds for the archive query: `startUnix = Math.floor(Date.parse(startIso) / 1000)`,
`endUnix = Math.floor(Date.parse(endIso) / 1000)`; query `timestamp >= startUnix AND
timestamp < endUnix`.

## Token budget

Typical day is small (~65 messages on 06-12). Worst case is bounded by the caps
(30 × 40 = 1,200 messages); at realistic average WhatsApp length (~tens of chars)
that is a few thousand tokens on top of the ~13.8k baseline. The 2500-char/message
cap preserves the occasional long message (a pasted block or note) without letting a
single message dominate. If a pathological day blows up, the caps are the tuning knob;
no LLM pre-filter is needed.

## Testing (all unit; injected fetch / temp sqlite; no live network)

- **archive:** `chats` upsert + `chatNames()` map; `listMessagesInWindow` bounds;
  read-only open skips DDL; reopen-persistence (existing test, adapted to temp dir);
  `chatNames()` returns empty map when the table is absent.
- **message:** existing mapping + group `participant` sender (extend existing tests).
- **conversations:** grouping by chat; 1:1 name from `chats`, group subject from
  `chats`, fallback to `+number`; group sender resolution via participant jid; media
  placeholder; caps (conversation count, message count, 2500-char truncation);
  empty-window → `[]`; missing-file → `[]`.
- **condense:** `suppressBucket` drops whatsapp buckets; absent → unchanged
  (existing tests pass).
- **fetchDayActivity:** conversations attached; suppression applied only when
  conversations non-empty.
- **prompt:** `## Conversations` block renders; rule-6 substring present.

Run: `bun test` and `bun run type-check`.

## Out of scope / follow-ups

- Gmail / Microsoft Teams structured readers (desktop-app-only — see
  `docs/messaging-connectors.md`).
- Richer media handling (transcribe audio notes, OCR images) beyond placeholders.
- Backfilling names for very old history if Baileys does not resend `contacts`/`chats`
  on reconnect (live events + `groupMetadata` cover the active set).
- Audio-transcription backlog (separate investigation; mic inactive, segments pending).

### Follow-ups surfaced in the post-implementation review (2026-06-13)

The implementation was reviewed and approved (no critical/important issues). These
name-quality robustness items were deferred to keep the merge at approved scope:

- **`@lid` sender resolution.** Baileys 7.x increasingly delivers group participants
  (and some 1:1s) as `@lid` JIDs, while the `chats` name table is keyed by the
  `@s.whatsapp.net` phone JID. Mismatched keys fall through to the `+number` fallback.
  A proper fix maps `@lid` ↔ phone JID via Baileys' LID mapping before resolving names.
- **`pushName` enrichment (highest value).** `messages.upsert` (live delivery) is the
  one place a sender's name is reliably present (`pushName`), yet it isn't written to
  the `chats` table. Wiring `pushName` → `upsertChatName(sender, pushName, false)` for
  inbound messages would meaningfully improve 1:1 name coverage. Needs a small
  `storeMessages` return-type refactor in `gateway.ts` (untested glue — handle with care).
- **Neutral label for non-phone JIDs.** `phoneFromJid` renders `+<user>` for any
  unresolved JID; gate the `+` on an `@s.whatsapp.net` domain so `@lid`/non-MSISDN
  identifiers don't render as bogus phone numbers (depends on the `@lid` item).
- **Sidecar log location.** `install-whatsapp-sidecar.sh` writes `whatsapp.{out,err}.log`
  into the repo tree (gitignored, so safe); moving them under
  `~/.screenpipe-distiller/whatsapp/` would be tidier. Cosmetic.
