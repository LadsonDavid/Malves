import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/adapters/sqlite/store.js";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "malves-")), "malves.db");

describe("SqliteStore", () => {
  it("numbers events from 1 and pages through them", () => {
    const store = new SqliteStore(file());
    for (let i = 0; i < 5; i++) {
      store.append({ type: "workspace.removed", data: { workspace_id: `ws${i}` } }, 100 + i);
    }
    expect(store.since(0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.since(2, 10).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.since(4, 10)[0]).toEqual({
      type: "workspace.removed",
      data: { workspace_id: "ws4" },
      seq: 5,
      at: 104,
    });
    store.close();
  });

  it("keeps events across reopening", () => {
    const f = file();
    const a = new SqliteStore(f);
    a.append({ type: "workspace.removed", data: { workspace_id: "x" } }, 1);
    a.close();
    const b = new SqliteStore(f);
    expect(b.since(0, 10)).toHaveLength(1);
    expect(b.append({ type: "workspace.removed", data: { workspace_id: "y" } }, 2).seq).toBe(2);
    b.close();
  });

  it("refuses updates and deletes at the database level", () => {
    const f = file();
    const store = new SqliteStore(f);
    store.append({ type: "workspace.removed", data: { workspace_id: "x" } }, 1);
    store.close();
    const raw = new Database(f);
    expect(() => raw.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    raw.close();
  });
});
