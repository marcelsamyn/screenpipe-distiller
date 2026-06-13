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

  constructor(path: string) {
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
