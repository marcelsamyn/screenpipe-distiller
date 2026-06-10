# screenpipe-distiller

Turn your daily computer activity into durable, searchable memory.

`screenpipe-distiller` reads a day of [Screenpipe](https://screenpi.pe) capture (screen OCR, UI, audio), distills it with an LLM into a single concise Markdown document — what you worked on, who you talked to, the tools you used, what you read, and any notable things you articulated — and ingests it into an Assistant Memory backend (or any compatible endpoint).

It is deliberately **not** a to-do generator. The curation contract forbids action items, refuses to infer intent from passive viewing, and won't guess which project an ambiguous reference belongs to — so your memory stays clean.

## How it works

```
Screenpipe (local capture) -> condense -> curate (LLM) -> ingest into Assistant Memory
```

- **condense** (deterministic, no LLM): groups a day's frames by app / window / URL, keeps the longest substantive text blocks, drops noise — turning thousands of frames into a few KB.
- **curate** (one LLM call via OpenRouter): writes a durable activity document under a strict contract (durable over ephemeral, no action items, exposure != intent, no cross-project misattribution, capture notable knowledge).
- **ingest**: uploads as a `personal`-scope document, idempotent per day (re-running a day replaces it).

## Requirements

- [Bun](https://bun.sh) (the core tool is cross-platform; the scheduling helpers are macOS/launchd)
- [Screenpipe](https://screenpi.pe) running locally
- An [OpenRouter](https://openrouter.ai) API key (any model)
- An Assistant Memory backend — or a Petals proxy

## Setup

```bash
bun install
cp .env.example .env   # then fill it in
```

Get your Screenpipe token with `screenpipe auth token`. At minimum set `SCREENPIPE_API_KEY`, `OPENROUTER_API_KEY`, `USER_NAME`, and — for the default direct mode — `MEMORY_API_URL` + `MEMORY_USER_ID`.

## Usage

```bash
bun run distill                                # distill (today after noon, else yesterday)
bun run distill --date 2026-06-05              # a specific day
bun run distill --date 2026-06-05 --dry-run    # preview the document without uploading
bun run health-check                           # check Screenpipe recording health
bun test                                       # run the test suite
```

## Scheduling (macOS)

```bash
./scripts/install-record-autostart.sh   # keep `screenpipe record` running at login
./scripts/install-schedules.sh          # daily distill (22:00) + health checks (12:00 & 20:00)
```

The daily run targets the current day in the evening; if the machine was asleep and the job fires the next morning instead, it falls back to the previous day so the right day is always captured. If a launchd microphone-permission issue makes audio-enabled recording crash-loop, run the record installer with `RECORD_AUDIO=0`.

## Upload modes

- `UPLOAD_MODE=direct` (default): posts to `{MEMORY_API_URL}/ingest/document` with your `MEMORY_USER_ID` (and optional `MEMORY_API_KEY`).
- `UPLOAD_MODE=petals`: posts through a Petals proxy with `PETALS_API_KEY`.

## License

MIT (c) 2026 Marcel Samyn
