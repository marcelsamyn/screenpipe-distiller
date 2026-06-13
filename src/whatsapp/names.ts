/**
 * Pure transforms from Baileys event payloads to chat-name updates.
 * Aliases: contact name extraction, group subject resolution, whatsapp names.
 */

export interface ChatNameUpdate {
  jid: string;
  name: string;
  isGroup: boolean;
  /** True only for address-book contacts (Baileys `Contact.name`), used to filter group noise. */
  saved: boolean;
}

interface BaileysContact {
  /** Preferred id, in lid or phone-number form. */
  id?: string | null;
  /** Explicit LID-form jid (@lid), when WA provides it. */
  lid?: string | null;
  /** Explicit phone-number-form jid (@s.whatsapp.net), when WA provides it. */
  phoneNumber?: string | null;
  /** The name YOU saved for this contact (address book). */
  name?: string | null;
  /** The name the contact set for themselves. */
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

function distinctJids(...values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Contact names from `contacts.*` events, a history-set `contacts` array, or group
 * participants (which are `Contact`s). Each name is keyed under every identity the
 * contact exposes (id / lid / phoneNumber) so both @lid- and phone-addressed
 * messages resolve. `saved` is set only when the user's address-book name is present.
 */
export function contactNameUpdates(contacts: readonly BaileysContact[]): ChatNameUpdate[] {
  return contacts.flatMap((contact) => {
    const name = firstNonEmpty(contact.name, contact.notify, contact.verifiedName);
    if (!name) return [];
    const saved = Boolean(contact.name?.trim());
    return distinctJids(contact.id, contact.lid, contact.phoneNumber).map((jid) => ({
      jid,
      name,
      isGroup: false,
      saved,
    }));
  });
}

/** Group subjects from a history-set `chats` array or `groups.upsert` / `groups.update`. */
export function groupNameUpdates(chats: readonly BaileysChat[]): ChatNameUpdate[] {
  return chats.flatMap((chat) => {
    const name = firstNonEmpty(chat.name, chat.subject);
    return chat.id && chat.id.endsWith("@g.us") && name
      ? [{ jid: chat.id, name, isGroup: true, saved: false }]
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
    return !message.fromMe && name ? [{ jid: message.sender, name, isGroup: false, saved: false }] : [];
  });
}
