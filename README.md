# screenpipe-distiller

Daily tool that distills Screenpipe computer-use capture into one durable
activity document and ingests it into Assistant Memory via the hosted Petals
proxy. See the design spec in `assistant-memory/docs/superpowers/specs/`.

## Usage
- `bun run distill [--date YYYY-MM-DD] [--dry-run]` — distill a day (default: yesterday). `--dry-run` prints the curated document without uploading.
- `bun run health-check` — check Screenpipe recording health; notify if down.

Config via `.env` (see `.env.example`). Get the Screenpipe token with
`screenpipe auth token`.
