/**
 * Pure transforms from Baileys event payloads to chat-name updates.
 * Aliases: contact name extraction, group subject resolution, whatsapp names.
 */

export interface ChatNameUpdate {
  jid: string;
  name: string;
  isGroup: boolean;
}

interface BaileysContact {
  id?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

interface BaileysChat {
  id?: string | null;
  name?: string | null;
  subject?: string | null;
}

interface PushNameMessage {
  sender: string;
  fromMe: boolean;
  pushName?: string | null;
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Contact names from `contacts.upsert` / `contacts.update` or a history-set `contacts` array. */
export function contactNameUpdates(contacts: readonly BaileysContact[]): ChatNameUpdate[] {
  return contacts.flatMap((contact) => {
    const name = firstNonEmpty(contact.name, contact.notify, contact.verifiedName);
    return contact.id && name ? [{ jid: contact.id, name, isGroup: false }] : [];
  });
}

/** Group subjects from a history-set `chats` array or `groups.upsert` / `groups.update`. */
export function groupNameUpdates(chats: readonly BaileysChat[]): ChatNameUpdate[] {
  return chats.flatMap((chat) => {
    const name = firstNonEmpty(chat.name, chat.subject);
    return chat.id && chat.id.endsWith("@g.us") && name
      ? [{ jid: chat.id, name, isGroup: true }]
      : [];
  });
}

/**
 * Contact names carried on live-delivered messages. `pushName` is the sender's
 * own display name and is the one name signal reliably present on inbound
 * messages (history sync omits it). Keyed by the message's resolved sender jid
 * (the group participant, or the 1:1 chat jid); `fromMe` and blanks are skipped.
 */
export function pushNameUpdates(messages: readonly PushNameMessage[]): ChatNameUpdate[] {
  return messages.flatMap((message) => {
    const name = message.pushName?.trim();
    return !message.fromMe && name ? [{ jid: message.sender, name, isGroup: false }] : [];
  });
}
