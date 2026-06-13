# Pair WhatsApp for Persistent Message Ingestion

This project includes an independent WhatsApp ingestion sidecar. Use it instead
of Screenpipe's generated gateway when you want the best chance of receiving
historical messages and need messages to survive restarts.

The sidecar:

- pairs as a macOS desktop companion and requests full history;
- accepts every Baileys history-sync type;
- stores history and new messages in
  `~/.screenpipe-distiller/whatsapp/messages.sqlite`;
- exposes its read API on `http://127.0.0.1:3036`;
- runs independently from Screenpipe, so Screenpipe updates cannot overwrite it.

> [!WARNING]
> The sidecar uses the unofficial Baileys WhatsApp Web integration. WhatsApp may
> restrict accounts that use unofficial integrations. Use it at your own risk.

## Install and Pair the Persistent Sidecar

Install its launch agent:

```bash
./scripts/install-whatsapp-sidecar.sh
```

Wait for a QR payload and render it:

```bash
until QR="$(curl -fsS http://127.0.0.1:3036/qr 2>/dev/null)"; do sleep 1; done
qrencode -t ANSIUTF8 "$QR"
```

In WhatsApp, open **Settings > Linked Devices > Link a Device**, then scan the
QR code. Keep the phone online while the initial history sync runs.

Monitor progress:

```bash
watch -n 2 'curl -fsS http://127.0.0.1:3036/status | jq'
tail -f whatsapp.out.log
```

Read persisted messages:

```bash
curl -fsS http://127.0.0.1:3036/chats | jq
curl -fsS "http://127.0.0.1:3036/messages?jid=PHONE@s.whatsapp.net&limit=100" | jq
```

WhatsApp controls how much history a newly linked companion receives. Requesting
full history improves the odds but cannot guarantee a complete archive.

## Screenpipe's Built-In Gateway

Screenpipe supports two different WhatsApp integrations:

- The personal WhatsApp gateway pairs an existing account using a QR code, like
  WhatsApp Web. It exposes recent chats and messages for reading. This is the
  integration described below.
- `screenpipe connection whatsapp set` configures Meta's official WhatsApp
  Cloud API. It is send-only and does not help message ingestion.

The Screenpipe desktop app starts personal WhatsApp pairing through the local
Screenpipe HTTP API. You can call the same API from a terminal.

> [!WARNING]
> The personal WhatsApp gateway uses the unofficial Baileys WhatsApp Web
> integration. WhatsApp may restrict or ban accounts that use unofficial
> integrations. Use it at your own risk.

## Prerequisites

- Screenpipe is running locally.
- `bun`, `curl`, `jq`, and `qrencode` are installed.

On macOS with Homebrew:

```bash
brew install oven-sh/bun/bun jq qrencode
```

Confirm that Screenpipe is running and read its local API token:

```bash
screenpipe status
TOKEN="$(screenpipe auth token)"
```

## Pair WhatsApp

Start the pairing process:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bun_path":""}' \
  http://localhost:3030/connections/whatsapp/pair | jq
```

The first run may take a while because Screenpipe installs the Baileys gateway
dependencies.

Poll until Screenpipe receives the QR payload, then render it in the terminal:

```bash
while :; do
  STATUS="$(curl -fsS \
    -H "Authorization: Bearer $TOKEN" \
    http://localhost:3030/connections/whatsapp/status)"

  QR="$(jq -r '.status.qr_ready.qr // empty' <<< "$STATUS")"

  if [[ -n "$QR" ]]; then
    qrencode -t ANSIUTF8 "$QR"
    break
  fi

  echo "$STATUS" | jq
  sleep 2
done
```

In WhatsApp, open **Settings > Linked Devices > Link a Device**, then scan the
terminal QR code.

Verify the connection:

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3030/connections/whatsapp/status | jq

screenpipe connection get whatsapp --json
```

Screenpipe stores the paired session under `~/.screenpipe/whatsapp-session/`
and reconnects it when the Screenpipe daemon restarts.

## Read Messages from the Local Gateway

Once paired, Screenpipe exposes the WhatsApp gateway on
`http://localhost:3035`:

```bash
curl -fsS http://localhost:3035/status | jq
curl -fsS http://localhost:3035/chats | jq
curl -fsS http://localhost:3035/contacts | jq
curl -fsS "http://localhost:3035/messages?phone=+32123456789&limit=50" | jq
```

The contacts, chats, and message history exposed by Screenpipe's gateway are held in
memory. Screenpipe keeps at most 200 messages per chat and rebuilds state from
WhatsApp events and any history synchronization received after startup. This
is not a complete durable WhatsApp archive.

With Baileys `7.0.0-rc13`, Screenpipe's current generated gateway also reads the
history event using an outdated nested message shape. It can crash when actual
historical messages arrive. The independent sidecar uses the current flat
`WAMessage[]` event contract.

`screenpipe-distiller` does not yet fetch this gateway. Pairing makes the read
API available for future structured ingestion; today, WhatsApp messages enter
the distiller through Screenpipe's visible-app or WhatsApp Web capture.

## Disconnect

Disconnect WhatsApp and delete the saved session:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3030/connections/whatsapp/disconnect | jq
```

Do not configure the separate official WhatsApp Cloud API connector for this
project. It sends messages through Meta's Graph API and cannot read personal
WhatsApp conversations.
