# Message Ingestion Sources

`screenpipe-distiller` cares only about reading messages into the daily digest.
Screenpipe's connector list is broader than that: most connectors are designed
only to let agents send notifications.

## What the Distiller Ingests Today

The distiller currently reads Screenpipe's `/search` endpoint for:

- screen OCR;
- keyboard input; and
- microphone audio transcripts.

Messages are therefore ingested when they appear in a visible desktop app or
browser tab captured by Screenpipe. No messaging connector is required.

The distiller recognizes native communication apps including:

- WhatsApp
- Slack
- Mail and other mail clients
- Messenger
- Discord
- Telegram
- Microsoft Teams
- Signal

It also recognizes the web versions of WhatsApp, Slack, Gmail, Messenger,
Discord, Telegram, and Microsoft Teams.

Conversation sources receive a larger, recency-first text budget so recent
messages are less likely to be lost among ordinary application activity.

This capture-based approach has important limits:

- only captured on-screen text and keyboard input are available;
- conversations not opened during the day may be absent;
- OCR can lose sender, thread, timestamp, and message-boundary structure; and
- scrolling and repeated captures can create partial or duplicate text.

## Structured Read APIs Available in Screenpipe

Screenpipe exposes structured read access for only three main messaging
connections:

| Source | Can read messages? | Headless setup? | Distiller support today? |
| --- | --- | --- | --- |
| Personal WhatsApp sidecar | Yes, persistent chats and messages | Yes, QR pairing | Included in the daily distill (auto when the archive exists; disable with WHATSAPP_CONNECTOR=off) |
| Gmail OAuth | Yes, search and full-message reads | No, desktop app required | Not yet |
| Microsoft Teams OAuth | Yes, chats and channel messages | No, desktop app required | Not yet |

The Personal WhatsApp sidecar archive is now read directly into each daily
distill: messages for the day are folded in as structured conversations and the
redundant on-screen WhatsApp capture is suppressed for that day. Set
`WHATSAPP_CONNECTOR=off` to disable this and fall back to screen capture only.

The Gmail and Microsoft Teams read APIs are useful future ingestion sources but
are not yet wired into the distiller — connecting one does not automatically add
its messages to a distill run.

## Connectors That Do Not Help Ingestion

The following Screenpipe connectors are send-only and should not be configured
for this project's ingestion use case:

| Connector | Why it does not help |
| --- | --- |
| Telegram | Stores a bot token and destination chat ID for sending messages |
| Discord | Stores a channel webhook for sending messages |
| Slack | OAuth requests only an incoming webhook for sending to one channel |
| Email (SMTP) | Stores SMTP credentials for sending email |
| Microsoft Teams webhook | Sends messages to one channel |
| WhatsApp Cloud API credentials | Sends messages through Meta's Graph API |

Screenpipe can still capture these services from their native apps or web UIs.

## Personal WhatsApp Read API

Personal WhatsApp is the only structured message source that can currently be
paired without the Screenpipe desktop app. The project sidecar requests full
history and persists messages across restarts. Follow the
[persistent WhatsApp pairing guide](whatsapp-connector.md).

Once paired, the sidecar exposes:

```bash
curl -fsS http://localhost:3036/chats | jq
curl -fsS "http://localhost:3036/messages?jid=32123456789@s.whatsapp.net&limit=50" | jq
```

The sidecar stores messages in
`~/.screenpipe-distiller/whatsapp/messages.sqlite`. WhatsApp decides how much
history a newly linked device receives, so the archive may still be incomplete.

## Gmail Read API

After Gmail has been connected through the Screenpipe desktop app, Screenpipe
can search messages and fetch full message bodies:

```bash
TOKEN="$(screenpipe auth token)"

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3030/connections/gmail/messages?q=newer_than:1d&maxResults=100" |
  jq

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3030/connections/gmail/messages/<message-id>" |
  jq
```

List connected accounts:

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3030/connections/gmail/instances | jq
```

When multiple accounts are connected, add `instance=<email>` to the query.

As of Screenpipe `0.4.15` and the upstream source reviewed on June 13, 2026,
the Gmail OAuth flow can only be started by the desktop app's Tauri command.
The CLI cannot complete it.

## Microsoft Teams Read API

After Teams OAuth has been connected through the Screenpipe desktop app,
Screenpipe proxies Microsoft Graph read requests:

```bash
TOKEN="$(screenpipe auth token)"
BASE=http://localhost:3030/connections/teams/proxy

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/me/chats" | jq

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/me/chats/<chat-id>/messages" | jq

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/me/joinedTeams" | jq

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/teams/<team-id>/channels/<channel-id>/messages" | jq
```

Teams OAuth requires a work or school Microsoft account with a Teams license.
It cannot currently be connected through the Screenpipe CLI. Configuring a
Teams webhook is unrelated: webhooks are send-only.

## Slack, Telegram, and Discord

Screenpipe currently exposes no structured read API for Slack, Telegram, or
Discord. Their Screenpipe connectors are send-only.

For now, the distiller can ingest these sources only through visible native-app
or browser capture. Structured ingestion would require a new provider-specific
reader in this project or new read support in Screenpipe.
