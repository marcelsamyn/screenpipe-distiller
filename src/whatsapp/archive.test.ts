import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhatsAppArchive } from "./archive";

const paths: string[] = [];

const tempPath = (): string => {
  const path = join(tmpdir(), `wa-archive-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
};

const createArchive = (): WhatsAppArchive => new WhatsAppArchive(tempPath());

afterEach(() => {
  paths.forEach((path) => {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  });
  paths.length = 0;
});

describe("WhatsAppArchive", () => {
  test("persists messages and ignores duplicate message IDs", () => {
    const archive = createArchive();
    const message = {
      id: "message-1",
      jid: "person@s.whatsapp.net",
      fromMe: false,
      sender: "person@s.whatsapp.net",
      text: "hello",
      mediaType: null,
      timestamp: 1_700_000_000,
      pushName: "Person",
    };

    archive.storeMessages([message, message]);

    expect(archive.listMessages(message.jid, 50)).toEqual([message]);
    expect(archive.status()).toEqual({ chatCount: 1, messageCount: 1 });
    archive.close();
  });

  test("keeps persisted messages after reopening", () => {
    const path = tempPath();
    const message = {
      id: "message-2",
      jid: "group@g.us",
      fromMe: true,
      sender: "me",
      text: null,
      mediaType: "image",
      timestamp: 1_700_000_001,
      pushName: null,
    };

    const first = new WhatsAppArchive(path);
    first.storeMessages([message]);
    first.close();

    const second = new WhatsAppArchive(path);
    expect(second.listChats()).toEqual([
      {
        jid: message.jid,
        messageCount: 1,
        lastMessageTimestamp: message.timestamp,
      },
    ]);
    second.close();
  });

  test("stores and reads back chat names; upsert overwrites", () => {
    const archive = createArchive();
    archive.upsertChatName("person@s.whatsapp.net", "Alice", false);
    archive.upsertChatName("group@g.us", "Trip 2026", true);
    archive.upsertChatName("person@s.whatsapp.net", "Alice Smith", false);

    expect(archive.chatNames()).toEqual(
      new Map([
        ["person@s.whatsapp.net", "Alice Smith"],
        ["group@g.us", "Trip 2026"],
      ]),
    );
    archive.close();
  });

  test("lists only messages inside the window, ordered by jid then time", () => {
    const archive = createArchive();
    const at = (jid: string, ts: number, id: string) => ({
      id,
      jid,
      fromMe: false,
      sender: jid,
      text: `m-${id}`,
      mediaType: null,
      timestamp: ts,
      pushName: null,
    });
    archive.storeMessages([
      at("b@s.whatsapp.net", 100, "1"),
      at("a@s.whatsapp.net", 150, "2"),
      at("a@s.whatsapp.net", 250, "3"), // outside window (end is exclusive)
      at("a@s.whatsapp.net", 50, "4"), // before window
    ]);

    expect(archive.listMessagesInWindow(100, 250).map((m) => m.id)).toEqual(["2", "1"]);
    archive.close();
  });

  test("opens read-only without running DDL and reads existing data", () => {
    const path = tempPath();
    const writer = new WhatsAppArchive(path);
    writer.storeMessages([
      { id: "1", jid: "p@s.whatsapp.net", fromMe: false, sender: "p@s.whatsapp.net", text: "hi", mediaType: null, timestamp: 200, pushName: null },
    ]);
    writer.upsertChatName("p@s.whatsapp.net", "Pat", false);
    writer.close();

    const reader = new WhatsAppArchive(path, { readonly: true });
    expect(reader.listMessagesInWindow(100, 300).map((m) => m.text)).toEqual(["hi"]);
    expect(reader.chatNames()).toEqual(new Map([["p@s.whatsapp.net", "Pat"]]));
    reader.close();
  });

  test("chatNames returns an empty map when the chats table is absent", () => {
    const path = tempPath();
    const raw = new Database(path, { create: true });
    raw.exec(
      `CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT, media_type TEXT, timestamp INTEGER NOT NULL, push_name TEXT)`,
    );
    raw.close();

    const archive = new WhatsAppArchive(path, { readonly: true });
    expect(archive.chatNames()).toEqual(new Map());
    archive.close();
  });

  test("tracks saved (address-book) contacts; saved is sticky and keeps the saved name", () => {
    const archive = createArchive();
    archive.upsertChatName("a@s.whatsapp.net", "Alice (saved)", false, true);
    archive.upsertChatName("b@s.whatsapp.net", "Bob notify", false, false);
    expect(archive.savedContacts()).toEqual(new Set(["a@s.whatsapp.net"]));

    // A later non-saved display name must not clear saved nor overwrite the saved name.
    archive.upsertChatName("a@s.whatsapp.net", "alice-pushname", false, false);
    expect(archive.savedContacts()).toEqual(new Set(["a@s.whatsapp.net"]));
    expect(archive.chatNames().get("a@s.whatsapp.net")).toBe("Alice (saved)");

    // Promoting a previously-unsaved contact to saved updates both the flag and the name.
    archive.upsertChatName("b@s.whatsapp.net", "Bob Smith", false, true);
    expect(archive.savedContacts().has("b@s.whatsapp.net")).toBe(true);
    expect(archive.chatNames().get("b@s.whatsapp.net")).toBe("Bob Smith");
    archive.close();
  });

  test("savedContacts is empty when the chats table is absent", () => {
    const path = tempPath();
    const raw = new Database(path, { create: true });
    raw.exec(
      `CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT, media_type TEXT, timestamp INTEGER NOT NULL, push_name TEXT)`,
    );
    raw.close();

    const archive = new WhatsAppArchive(path, { readonly: true });
    expect(archive.savedContacts()).toEqual(new Set());
    archive.close();
  });
});
