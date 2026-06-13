import type { WAMessage } from "@whiskeysockets/baileys";
import type { ArchivedMessage } from "./archive";

export const toArchivedMessage = (message: WAMessage): ArchivedMessage | null => {
  const id = message.key.id;
  const jid = message.key.remoteJid;
  const content = message.message;
  if (!id || !jid || !content || jid === "status@broadcast") return null;

  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    null;
  const mediaType =
    content.imageMessage ? "image"
    : content.videoMessage ? "video"
    : content.audioMessage ? "audio"
    : content.documentMessage ? "document"
    : content.stickerMessage ? "sticker"
    : null;
  if (text === null && mediaType === null) return null;

  return {
    id,
    jid,
    fromMe: message.key.fromMe ?? false,
    sender: message.key.fromMe ? "me" : (message.key.participant ?? jid),
    text,
    mediaType,
    timestamp: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    pushName: message.pushName ?? null,
  };
};
