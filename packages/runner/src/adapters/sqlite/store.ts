import type { Store } from "@malves/core";
import { EventBody, type LoggedEvent } from "@malves/protocol";
import Database from "better-sqlite3";

type Row = { seq: number; at: number; type: string; data: string };

/** The event log in one SQLite file. Append-only, enforced by the database itself. */
export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement<[string, number, string]>;
  private readonly select: Database.Statement<[number, number], Row>;
  private readonly selectBefore: Database.Statement<[number, number], Row>;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq  INTEGER PRIMARY KEY AUTOINCREMENT,
        at   INTEGER NOT NULL,
        type TEXT    NOT NULL,
        data TEXT    NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
    `);
    this.insert = this.db.prepare("INSERT INTO events (type, at, data) VALUES (?, ?, ?)");
    this.select = this.db.prepare(
      "SELECT seq, at, type, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    this.selectBefore = this.db.prepare(
      "SELECT seq, at, type, data FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?",
    );
  }

  append(body: EventBody, at: number): LoggedEvent {
    const { lastInsertRowid } = this.insert.run(body.type, at, JSON.stringify(body.data));
    return { ...body, seq: Number(lastInsertRowid), at };
  }

  since(after: number, limit: number): LoggedEvent[] {
    return this.select.all(after, limit).map(toEvent);
  }

  before(before: number, limit: number): LoggedEvent[] {
    return this.selectBefore.all(before, limit).map(toEvent);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(row: Row): LoggedEvent {
  const body = EventBody.parse({ type: row.type, data: JSON.parse(row.data) });
  return { ...body, seq: row.seq, at: row.at };
}
