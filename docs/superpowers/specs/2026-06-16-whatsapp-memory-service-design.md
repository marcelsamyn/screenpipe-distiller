# Design: `whatsapp-memory` — standalone WhatsApp → Memory service

**Date:** 2026-06-16
**Status:** Implemented (code complete & reviewed; Phase 3 cutover pending)

## Problem

WhatsApp messages currently reach Memory by an indirect, lossy path. A Baileys
sidecar (today living in `screenpipe-distiller`) syncs WhatsApp Web into a local
SQLite archive; the daily distill job then folds those messages into the day's
digest alongside screen OCR/audio, runs the whole thing through an LLM curation
pass, and uploads **one Markdown narrative per day**. WhatsApp content thus
arrives in Memory as prose summary buried in an activity document.

The Memory backend (`~/code/assistant-memory`, fronted by Petals at
`~/code/petals`) already has **native, structured ingestion** that fits chat far
better than a daily narrative:

- `POST /ingest/conversation` — two-party chat (role + name + timestamp).
- `POST /transcript/ingest` (Petals: `POST /api/memory/ingest/transcript`) —
  multi-speaker transcripts. Resolves each speaker to a **Person node** in the
  graph and attributes claims per-person; the user's own lines resolve to
  user-self. Accepts `segmented` utterances with per-line timestamps.

We will stop routing WhatsApp through the screenpipe distiller and instead push
structured transcripts straight into Memory, letting the backend do its own
graph extraction. The local WhatsApp sync must keep running across this change
**without re-pairing**.

## Decisions (locked)

1. **Full extract.** A new repo owns the entire WhatsApp concern: the Baileys
   gateway, the SQLite archive, and a new pusher. `screenpipe-distiller` loses
   all WhatsApp code.
2. **Reuse the existing session in place.** The gateway keeps using
   `~/.screenpipe-distiller/whatsapp/{session/,messages.sqlite}`. Because the
   Baileys auth state is just files on disk and we never trigger a logout,
   **no re-pair is required**. (Renaming the data dir is deferred — harmless
   cosmetic wart.)
3. **Transcript endpoint.** Push as `segmented` transcripts via Petals for
   per-person graph attribution. Trade-off accepted: stored under the
   `meeting_transcript` source type (an odd label for chat, functionally ideal).
4. **DMs + filtered groups.** All 1:1 DMs, plus group chats filtered to the
   existing `WHATSAPP_GROUP_FILTER=contacts` rule (saved contacts + me).
5. **One-shot per completed day.** Unit = one transcript per `(chat, day)`;
   pushed exactly once, after the day closes; tracked by a watermark. Never
   re-push an in-progress transcript (avoids depending on append semantics).
6. **Bounded backfill.** Initial backfill of the last `BACKFILL_DAYS` (default
   30), then forward.
7. **Transport via Petals.** `x-api-key`; Petals derives `userId` from the key,
   so the client sends none. Direct-to-Memory mode is a possible later addition,
   not built now.

## Architecture

```
WhatsApp phone ──QR──┐
                     ▼
┌─────────────────────────────────────────────┐
│ gateway  (bun run whatsapp)                   │  keep-alive LaunchAgent (as today)
│  Baileys socket + QR + /status /qr /chats ... │  reuses existing session/ → NO re-pair
│         │ writes                              │
│         ▼                                     │
│  messages.sqlite  (existing archive)          │
│         │ reads (completed days only)         │
│         ▼                                     │
│ pusher   (bun run push)                        │  scheduled LaunchAgent (daily) + manual CLI
│  build per-(chat,day) transcripts             │
│  → POST Petals /api/memory/ingest/transcript  │
│  → record (jid,day) in push-state.sqlite      │
└─────────────────────────────────────────────┘
```

### Repo & components

- **Proposed location/name:** `~/code/whatsapp-memory`.
- **gateway** — today's sidecar relocated near-verbatim. Baileys socket, QR
  pairing, HTTP API (`/status`, `/qr`, `/chats`, `/messages`) on
  `WHATSAPP_HTTP_PORT` (3036). Keep-alive LaunchAgent; keeps the sync alive.
- **pusher** — net-new short-lived batch process and CLI (`bun run push`,
  `bun run push --backfill <N>`). Reads completed days, builds transcripts,
  posts to Petals, records watermark.
- **Two LaunchAgents:** keep-alive gateway (unchanged behavior) + daily-scheduled
  pusher. Independent lifecycles and failure domains.

### Reused vs new modules

| Module | Disposition |
|--------|-------------|
| `archive.ts` | Move near-verbatim (message/chat storage, read access) |
| `gateway.ts` | Move near-verbatim (Baileys, QR, HTTP API, event handlers) |
| `message.ts` | Move near-verbatim (WAMessage → ArchivedMessage) |
| `names.ts` | Move near-verbatim (contact/group/pushName resolution) |
| `conversations.ts` | **Replaced** by `transcripts.ts` (builds transcript payloads instead of `Conversation[]`) |
| pusher, Petals transcript client, push-state store, CLI | **New** |

## Message → transcript mapping

- **Unit:** one transcript per `(chat, day)`.
  `transcriptId = whatsapp-<jid>-<YYYY-MM-DD>`. Day boundaries computed in
  `TIMEZONE` (reuse the `dayWindowUtc` logic from the distiller).
- **`occurredAt`:** timestamp of the first message in the bucket. Each utterance
  carries its own ISO `timestamp`.
- **`content.kind = "segmented"`**, one utterance per message. Media-only
  messages dropped; captions kept (same rule as today's `buildConversations`).
- **Speaker labels:** resolved contact / group-participant name via existing
  name resolution (saved contacts, push names, group subjects). Masked/unknown
  senders fall back to phone number.
- **User's own messages (`from_me`):** labeled with the account name and emitted
  with `userSelfAliasesOverride` (config `SELF_ALIASES`, default seeded from the
  gateway `/status` name) so the backend resolves those lines to **user-self**.
- **`knownParticipants`:** omitted initially. We do not carry graph Person
  node-ids; the backend resolves speakers to Person nodes by label via its alias
  system. Clean extension point later.
- **Group filter:** `WHATSAPP_GROUP_FILTER=contacts` (saved contacts + me) by
  default; `all` to disable. DMs always included.
- **`scope`:** `personal`.

### Petals transcript payload (per `(chat, day)`)

```jsonc
{
  "transcriptId": "whatsapp-<jid>-2026-06-15",
  "scope": "personal",
  "occurredAt": "2026-06-15T08:12:00Z",   // first message in bucket
  "content": {
    "kind": "segmented",
    "utterances": [
      { "speakerLabel": "Alice Smith", "content": "…", "timestamp": "2026-06-15T08:12:00Z" },
      { "speakerLabel": "Marcel",      "content": "…", "timestamp": "2026-06-15T08:13:10Z" }
    ]
  },
  "userSelfAliasesOverride": ["Marcel", "+32…"]   // from SELF_ALIASES
}
```

`userId` is **not** sent — Petals injects `user_<id>` from the API key.

## Scheduling, watermark & backfill

- **Watermark store:** a dedicated `push-state.sqlite` in the data dir, table
  `pushed_days(jid TEXT, day TEXT, pushed_at INTEGER, PRIMARY KEY (jid, day))`.
  Kept separate from `messages.sqlite` so the pusher's bookkeeping never
  entangles the gateway's schema. Backend ingest is idempotent by
  `transcriptId`, so the watermark is a don't-redo-work optimization, not a
  correctness crutch.
- **Unified windowed rule (covers both backfill and steady state):** every run
  considers completed days in the window `[today - BACKFILL_DAYS, today)` (in
  `TIMEZONE`), pushes every `(chat, day)` in that window absent from
  `pushed_days`, and records on success. The still-open current day is never
  pushed until it closes → each transcript is written exactly once; days older
  than the window are never pushed (bounded). The first run therefore backfills
  the last `BACKFILL_DAYS`; subsequent daily runs naturally pick up yesterday
  plus any recently-missed days still inside the window.
- **`--backfill <N>`:** one-shot override of the window depth for a deeper
  manual catch-up.
- **Failure handling:** a `(chat, day)` that fails to push is simply not
  recorded and is retried on the next run. Network/5xx retried with the same
  exponential-backoff approach `screenpipe-distiller` already uses for upload.

## `screenpipe-distiller` cleanup

- Remove `src/whatsapp/`, the `WHATSAPP_*` config keys, the
  `loadWhatsAppConversations` wiring in `distill.ts` / `screenpipe.ts`, and the
  `Conversation` / `ConversationMessage` plumbing in `curation-prompt.ts` /
  `types.ts` (WhatsApp-fed only).
- **Keep WhatsApp out of the daily doc:** make the on-screen WhatsApp bucket
  suppression in `fetchDayActivity` / `condenseItems` **unconditional** (today it
  only suppresses when the connector supplied messages). WhatsApp now lives in
  Memory as structured transcripts; low-fidelity OCR of WhatsApp Web must not
  re-enter daily activity docs.
- The existing `com.screenpipe-distiller.whatsapp` LaunchAgent is replaced by the
  new repo's gateway agent, pointing at the **same** session dir so the running
  sync survives the swap.

## Config (new repo)

| Key | Purpose | Default |
|-----|---------|---------|
| `PETALS_BASE_URL` | Petals base URL | `https://petals.chat` |
| `PETALS_API_KEY` | `x-api-key` for Petals | (required) |
| `WHATSAPP_ARCHIVE_PATH` | Message SQLite path | `~/.screenpipe-distiller/whatsapp/messages.sqlite` |
| `WHATSAPP_DATA_DIR` | Session + data dir (gateway) | `~/.screenpipe-distiller/whatsapp` |
| `WHATSAPP_HTTP_PORT` | Gateway HTTP port | `3036` |
| `WHATSAPP_GROUP_FILTER` | `contacts` \| `all` | `contacts` |
| `TIMEZONE` | Day-boundary timezone | (required) |
| `BACKFILL_DAYS` | Initial backfill window | `30` |
| `SELF_ALIASES` | Aliases that resolve to user-self | (seed from gateway `/status` name) |

Push-state path defaults to `<WHATSAPP_DATA_DIR>/push-state.sqlite`.

## Testing

- **Transcript building:** day bucketing across timezone boundaries; speaker
  labeling (saved contact, push name, group participant, masked → phone);
  `from_me` → self alias; group filtering (`contacts` vs `all`); media-only drop
  with caption retention; `occurredAt` = first message.
- **Watermark/backfill:** no re-push of recorded `(chat, day)`; backfill respects
  `BACKFILL_DAYS`; failed push leaves the day un-recorded for retry.
- **Boundaries:** mock only the Petals HTTP endpoint (external service); never
  mock our own modules. Use realistic message shapes (LID jids, masked names,
  media-only, mixed group membership).

## Out of scope (deferred)

- Renaming the data dir out of `~/.screenpipe-distiller/`.
- `knownParticipants` linking to known Person node-ids.
- Direct-to-Memory transport (non-Petals).
- Near-real-time / same-day pushing of the open day.
