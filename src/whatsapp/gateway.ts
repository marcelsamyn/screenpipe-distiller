import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { WhatsAppArchive, type ArchivedMessage } from "./archive";
import { toArchivedMessage } from "./message";
import { contactNameUpdates, groupNameUpdates, pushNameUpdates, type ChatNameUpdate } from "./names";

process.umask(0o077);

const dataDirectory =
  process.env.WHATSAPP_DATA_DIR ??
  join(process.env.HOME ?? ".", ".screenpipe-distiller", "whatsapp");
const port = Number(process.env.WHATSAPP_HTTP_PORT ?? "3036");
mkdirSync(dataDirectory, { recursive: true });

const archive = new WhatsAppArchive(join(dataDirectory, "messages.sqlite"));
let connected = false;
let name: string | null = null;
let phone: string | null = null;
let qr: string | null = null;
let historyChunks = 0;
let historyMessages = 0;
let lastHistorySyncAt: string | null = null;
const disconnectErrorSchema = z.object({
  output: z.object({ statusCode: z.number() }),
});

const storeMessages = (messages: readonly WAMessage[]): ArchivedMessage[] => {
  const archived = messages.flatMap((message) => {
    const result = toArchivedMessage(message);
    return result ? [result] : [];
  });
  archive.storeMessages(archived);
  return archived;
};

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

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        connected,
        name,
        phone,
        qrReady: qr !== null,
        historyChunks,
        historyMessages,
        lastHistorySyncAt,
        ...archive.status(),
      });
    }
    if (url.pathname === "/qr") {
      return qr ? new Response(qr) : Response.json({ error: "QR not ready" }, { status: 404 });
    }
    if (url.pathname === "/chats") return Response.json(archive.listChats());
    if (url.pathname === "/messages") {
      const jid = url.searchParams.get("jid");
      if (!jid) return Response.json({ error: "provide jid" }, { status: 400 });
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return Response.json({ jid, messages: archive.listMessages(jid, limit) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

const start = async (): Promise<void> => {
  const { state, saveCreds } = await useMultiFileAuthState(join(dataDirectory, "session"));
  const { version } = await fetchLatestBaileysVersion();
  const socket = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    logger: pino({ level: "warn" }),
  });

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("messaging-history.set", ({ messages, contacts, chats, syncType, chunkOrder }) => {
    const archived = storeMessages(messages);
    applyNames(contactNameUpdates(contacts ?? []));
    applyNames(groupNameUpdates(chats ?? []));
    applyNames(pushNameUpdates(archived));
    historyChunks += 1;
    historyMessages += archived.length;
    lastHistorySyncAt = new Date().toISOString();
    console.log(JSON.stringify({ type: "history-sync", syncType, chunkOrder, stored: archived.length }));
  });
  socket.ev.on("messages.upsert", ({ messages }) => {
    applyNames(pushNameUpdates(storeMessages(messages)));
  });
  socket.ev.on("contacts.upsert", (contacts) => applyNames(contactNameUpdates(contacts)));
  socket.ev.on("contacts.update", (contacts) => applyNames(contactNameUpdates(contacts)));
  socket.ev.on("groups.upsert", (groups) => applyNames(groupNameUpdates(groups)));
  socket.ev.on("groups.update", (groups) => applyNames(groupNameUpdates(groups)));
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr: nextQr }) => {
    if (nextQr) qr = nextQr;
    if (connection === "open") {
      connected = true;
      qr = null;
      name = socket.user?.name ?? null;
      phone = socket.user?.id.split(":")[0] ?? null;
      console.log(JSON.stringify({ type: "connected", name, phone }));
      void backfillGroupNames(socket);
    }
    if (connection !== "close") return;

    connected = false;
    const parsedError = disconnectErrorSchema.safeParse(lastDisconnect?.error);
    const statusCode = parsedError.success ? parsedError.data.output.statusCode : null;
    if (statusCode === DisconnectReason.loggedOut) {
      console.error("WhatsApp session logged out; delete the sidecar session and pair again.");
      return;
    }
    void start();
  });
};

console.log(JSON.stringify({ type: "http", port, dataDirectory }));
await start();
