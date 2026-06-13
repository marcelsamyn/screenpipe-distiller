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
  /**
   * Group-message relevance filter. "contacts" (default) keeps only messages from
   * saved address-book contacts and yourself — dropping unknown senders in large
   * groups; "all" keeps every group message. 1:1 chats are never filtered.
   */
  groupFilter?: "contacts" | "all";
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
    // null = no group filtering ("all"); a set = keep only these senders (+ me) in groups.
    const saved = params.groupFilter === "all" ? null : archive.savedContacts();
    return buildConversations(messages, archive.chatNames(), saved, caps);
  } finally {
    archive.close();
  }
}

function buildConversations(
  messages: readonly ArchivedMessage[],
  names: Map<string, string>,
  savedSenders: Set<string> | null,
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
        // In groups, drop messages from senders who aren't saved contacts (or me).
        if (isGroup && savedSenders && !m.fromMe && !savedSenders.has(m.sender)) return [];
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
