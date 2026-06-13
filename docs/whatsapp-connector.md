# Connect WhatsApp Without the Screenpipe Desktop App

Screenpipe supports two different WhatsApp integrations:

- The personal WhatsApp gateway pairs an existing account using a QR code, like
  WhatsApp Web. This is the integration described below.
- `screenpipe connection whatsapp set` configures Meta's official WhatsApp
  Cloud API. It expects `phone_number_id` and `access_token`; it does not start
  QR pairing.

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

## Use the Local Gateway

Once paired, Screenpipe exposes the WhatsApp gateway on
`http://localhost:3035`:

```bash
curl -fsS http://localhost:3035/status | jq
curl -fsS http://localhost:3035/chats | jq
curl -fsS http://localhost:3035/contacts | jq
curl -fsS "http://localhost:3035/messages?phone=+32123456789&limit=50" | jq
```

Send a message:

```bash
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d '{"to":"+32123456789","text":"Hello from Screenpipe"}' \
  http://localhost:3035/send | jq
```

The contacts, chats, and message history exposed by the gateway are held in
memory and rebuilt from WhatsApp events and history synchronization after
startup.

## Disconnect

Disconnect WhatsApp and delete the saved session:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3030/connections/whatsapp/disconnect | jq
```

## Official WhatsApp Cloud API

To configure the separate official Meta Cloud API connector instead:

```bash
screenpipe connection whatsapp set \
  phone_number_id=123456789012345 \
  access_token=EAAB...

screenpipe connection test whatsapp
```

This credential-based connector sends messages through Meta's Graph API. It
does not expose the personal WhatsApp gateway or use QR pairing.
