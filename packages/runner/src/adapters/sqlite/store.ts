import type { MonitorSnapshot, MonitorState, Store } from "@malves/core";
import { EventBody, type LoggedEvent } from "@malves/protocol";
import Database from "better-sqlite3";

type Row = { seq: number; at: number; type: string; data: string };

/** The event log in one SQLite file. Append-only, enforced by the database itself. */
export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement<[string, number, string]>;
  private readonly select: Database.Statement<[number, number], Row>;
  private _monitorState?: SqliteMonitorState;

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
  }

  get database(): Database.Database {
    return this.db;
  }

  get monitorState(): MonitorState {
    return (this._monitorState ??= new SqliteMonitorState(this.db));
  }

  append(body: EventBody, at: number): LoggedEvent {
    const { lastInsertRowid } = this.insert.run(body.type, at, JSON.stringify(body.data));
    return { ...body, seq: Number(lastInsertRowid), at };
  }

  since(after: number, limit: number): LoggedEvent[] {
    return this.select.all(after, limit).map((row) => {
      const body = EventBody.parse({ type: row.type, data: JSON.parse(row.data) });
      return { ...body, seq: row.seq, at: row.at };
    });
  }

  close(): void {
    this.db.close();
  }
}

/** Stores monitor snapshots in SQLite so change detection survives restarts. */
export class SqliteMonitorState implements MonitorState {
  private readonly select: Database.Statement<[string], { hash: string; text: string }>;
  private readonly upsert: Database.Statement<[string, string, string]>;
  private readonly deleteStmt: Database.Statement<[string]>;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        rule_id TEXT PRIMARY KEY,
        hash    TEXT NOT NULL,
        text    TEXT NOT NULL
      );
    `);
    this.select = db.prepare("SELECT hash, text FROM monitor_state WHERE rule_id = ?");
    this.upsert = db.prepare(`
      INSERT INTO monitor_state (rule_id, hash, text)
      VALUES (?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET hash = excluded.hash, text = excluded.text
    `);
    this.deleteStmt = db.prepare("DELETE FROM monitor_state WHERE rule_id = ?");
  }

  get(ruleId: string): MonitorSnapshot | undefined {
    const row = this.select.get(ruleId);
    return row ? { hash: row.hash, text: row.text } : undefined;
  }

  set(ruleId: string, snapshot: MonitorSnapshot): void {
    this.upsert.run(ruleId, snapshot.hash, snapshot.text);
  }

  remove(ruleId: string): void {
    this.deleteStmt.run(ruleId);
  }
}

