import { Database } from "bun:sqlite";

export type ArchivedMessage = {
  id: string;
  jid: string;
  fromMe: boolean;
  sender: string;
  text: string | null;
  mediaType: string | null;
  timestamp: number;
  pushName: string | null;
};

export type ArchivedChat = {
  jid: string;
  messageCount: number;
  lastMessageTimestamp: number;
};

type MessageRow = Omit<ArchivedMessage, "fromMe"> & { fromMe: number };

export class WhatsAppArchive {
  readonly #database: Database;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      // Read-only connections cannot run DDL; the sidecar owns the schema.
      this.#database = new Database(path, { readonly: true });
      return;
    }
    this.#database = new Database(path, { create: true });
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        sender TEXT NOT NULL,
        text TEXT,
        media_type TEXT,
        timestamp INTEGER NOT NULL,
        push_name TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_jid_timestamp
        ON messages (jid, timestamp);
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  storeMessages(messages: readonly ArchivedMessage[]): void {
    const insert = this.#database.query(`
      INSERT OR IGNORE INTO messages (
        id, jid, from_me, sender, text, media_type, timestamp, push_name
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    this.#database.transaction((items: readonly ArchivedMessage[]) => {
      items.forEach((message) =>
        insert.run(
          message.id,
          message.jid,
          message.fromMe,
          message.sender,
          message.text,
          message.mediaType,
          message.timestamp,
          message.pushName,
        ),
      );
    })(messages);
  }

  listMessages(jid: string, limit: number): ArchivedMessage[] {
    const rows = this.#database
      .query<MessageRow, [string, number]>(`
        SELECT
          id,
          jid,
          from_me AS fromMe,
          sender,
          text,
          media_type AS mediaType,
          timestamp,
          push_name AS pushName
        FROM messages
        WHERE jid = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(jid, limit);

    return rows.reverse().map((row) => ({ ...row, fromMe: row.fromMe === 1 }));
  }

  upsertChatName(jid: string, name: string, isGroup: boolean): void {
    this.#database
      .query(`
        INSERT INTO chats (jid, name, is_group) VALUES (?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET name = excluded.name, is_group = excluded.is_group
      `)
      .run(jid, name, isGroup ? 1 : 0);
  }

  chatNames(): Map<string, string> {
    try {
      const rows = this.#database
        .query<{ jid: string; name: string }, []>(`SELECT jid, name FROM chats`)
        .all();
      return new Map(rows.map((row) => [row.jid, row.name]));
    } catch {
      // Archive written before name enrichment has no `chats` table — treat as no names.
      return new Map();
    }
  }

  listMessagesInWindow(startUnix: number, endUnix: number): ArchivedMessage[] {
    const rows = this.#database
      .query<MessageRow, [number, number]>(`
        SELECT
          id,
          jid,
          from_me AS fromMe,
          sender,
          text,
          media_type AS mediaType,
          timestamp,
          push_name AS pushName
        FROM messages
        WHERE timestamp >= ? AND timestamp < ?
        ORDER BY jid, timestamp ASC
      `)
      .all(startUnix, endUnix);

    return rows.map((row) => ({ ...row, fromMe: row.fromMe === 1 }));
  }

  listChats(): ArchivedChat[] {
    return this.#database
      .query<ArchivedChat, []>(`
        SELECT
          jid,
          COUNT(*) AS messageCount,
          MAX(timestamp) AS lastMessageTimestamp
        FROM messages
        GROUP BY jid
        ORDER BY lastMessageTimestamp DESC
      `)
      .all();
  }

  status(): { chatCount: number; messageCount: number } {
    const row = this.#database
      .query<{ chatCount: number; messageCount: number }, []>(`
        SELECT
          COUNT(DISTINCT jid) AS chatCount,
          COUNT(*) AS messageCount
        FROM messages
      `)
      .get();

    return row ?? { chatCount: 0, messageCount: 0 };
  }

  close(): void {
    this.#database.close();
  }
}
