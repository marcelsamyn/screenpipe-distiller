import { afterEach, describe, expect, test } from "bun:test";
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
});
