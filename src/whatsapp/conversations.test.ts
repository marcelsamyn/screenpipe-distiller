import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppArchive, type ArchivedMessage } from "./archive";
import { loadWhatsAppConversations } from "./conversations";

const paths: string[] = [];
const tempPath = (): string => {
  const path = join(tmpdir(), `wa-conv-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};
const seed = (messages: readonly ArchivedMessage[], names: [string, string, boolean][] = []): string => {
  const path = tempPath();
  const archive = new WhatsAppArchive(path);
  archive.storeMessages(messages);
  names.forEach(([jid, name, isGroup]) => archive.upsertChatName(jid, name, isGroup));
  archive.close();
  return path;
};
const msg = (over: Partial<ArchivedMessage> & Pick<ArchivedMessage, "id" | "jid" | "timestamp">): ArchivedMessage => ({
  fromMe: false,
  sender: over.jid,
  text: "hi",
  mediaType: null,
  pushName: null,
  ...over,
});

afterEach(() => {
  paths.forEach((path) => {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  });
  paths.length = 0;
});

describe("loadWhatsAppConversations", () => {
  test("returns [] when the archive file does not exist", () => {
    expect(
      loadWhatsAppConversations({ archivePath: join(tmpdir(), "nope.sqlite"), startUnix: 0, endUnix: 9_999_999_999 }),
    ).toEqual([]);
  });

  test("returns [] when the window is empty", () => {
    const path = seed([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 50 })]);
    expect(loadWhatsAppConversations({ archivePath: path, startUnix: 100, endUnix: 200 })).toEqual([]);
  });

  test("names a 1:1 chat from the chats table and resolves my/their messages", () => {
    const path = seed(
      [
        msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, fromMe: false, sender: "p@s.whatsapp.net", text: "yo" }),
        msg({ id: "2", jid: "p@s.whatsapp.net", timestamp: 110, fromMe: true, sender: "me", text: "hey" }),
      ],
      [["p@s.whatsapp.net", "Pat", false]],
    );
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv).toMatchObject({ channel: "WhatsApp", chatName: "Pat", isGroup: false });
    expect(conv?.messages).toEqual([
      { sender: "Pat", fromMe: false, text: "yo", timestamp: new Date(100_000).toISOString() },
      { sender: "me", fromMe: true, text: "hey", timestamp: new Date(110_000).toISOString() },
    ]);
  });

  test("uses the group subject and resolves the participant's name", () => {
    const path = seed(
      [msg({ id: "1", jid: "trip@g.us", timestamp: 100, sender: "a@s.whatsapp.net", text: "boarding" })],
      [
        ["trip@g.us", "Trip 2026", true],
        ["a@s.whatsapp.net", "Alice", false],
      ],
    );
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv).toMatchObject({ chatName: "Trip 2026", isGroup: true });
    expect(conv?.messages[0]?.sender).toBe("Alice");
  });

  test("falls back to +number and renders media placeholders", () => {
    const path = seed([
      msg({ id: "1", jid: "31612345678@s.whatsapp.net", timestamp: 100, sender: "31612345678@s.whatsapp.net", text: null, mediaType: "image" }),
    ]);
    const [conv] = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 1000 });
    expect(conv?.chatName).toBe("+31612345678");
    expect(conv?.messages[0]).toMatchObject({ sender: "+31612345678", text: "[image]" });
  });

  test("ranks conversations by recency and applies caps", () => {
    const messages: ArchivedMessage[] = [];
    for (let chat = 0; chat < 35; chat += 1) {
      messages.push(msg({ id: `c${chat}`, jid: `chat${chat}@s.whatsapp.net`, timestamp: 1000 + chat }));
    }
    for (let i = 0; i < 50; i += 1) {
      messages.push(msg({ id: `recent-${i}`, jid: "recent@s.whatsapp.net", timestamp: 5000 + i, text: `m${i}` }));
    }
    const path = seed(messages);
    const convs = loadWhatsAppConversations({ archivePath: path, startUnix: 0, endUnix: 100_000 });
    expect(convs.length).toBe(30); // 36 chats capped to 30
    expect(convs[0]?.chatName).toBe("+recent"); // most recent activity first (no name → +user)
    expect(convs[0]?.messages.length).toBe(40); // 50 capped to most-recent 40
    expect(convs[0]?.messages[0]?.text).toBe("m10"); // chronological order kept
    expect(convs[0]?.messages.at(-1)?.text).toBe("m49");
  });

  test("truncates long messages to the cap", () => {
    const path = seed([msg({ id: "1", jid: "p@s.whatsapp.net", timestamp: 100, text: "x".repeat(3000) })]);
    const [conv] = loadWhatsAppConversations({
      archivePath: path,
      startUnix: 0,
      endUnix: 1000,
      caps: { maxConversations: 30, maxMessagesPerConversation: 40, maxMessageLen: 2500 },
    });
    expect(conv?.messages[0]?.text.length).toBe(2501); // 2500 chars + ellipsis
    expect(conv?.messages[0]?.text.endsWith("…")).toBe(true);
  });
});
