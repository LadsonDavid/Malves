import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_KEPT, Outbox, TTL_MS } from "../src/adapters/push/outbox.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "malves-outbox-"));
const msg = (id: string, time: number) => ({ id, time, event: "message", title: id });

describe("notification outbox", () => {
  it("keeps what was sent, so a phone that was away can catch up", () => {
    let now = 1_000_000;
    const box = new Outbox({ now: () => now });
    box.add(msg("a", 100));
    box.add(msg("b", 200));
    box.add(msg("c", 300));
    expect(box.since("all").map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(box.since("latest").map((m) => m.id)).toEqual(["c"]);
    expect(box.since(undefined)).toEqual([]);
    now += 1;
  });

  it("replays after a message id, a time, or a duration", () => {
    const now = 1_800_000_000_000;
    const box = new Outbox({ now: () => now });
    box.add(msg("a", now / 1000 - 7200));
    box.add(msg("b", now / 1000 - 660));
    box.add(msg("c", now / 1000 - 30));
    expect(box.since("a").map((m) => m.id)).toEqual(["b", "c"]);
    expect(box.since("c")).toEqual([]);
    expect(box.since(String(now / 1000 - 700)).map((m) => m.id)).toEqual(["b", "c"]);
    expect(box.since("10m").map((m) => m.id)).toEqual(["c"]);
    expect(box.since("1h").map((m) => m.id)).toEqual(["b", "c"]);
    // An id it no longer holds: give everything kept; the phone drops repeats by id.
    expect(box.since("zzzzzzzzzzzz").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("forgets after a day and keeps at most 100", () => {
    let now = 1_000_000_000;
    const box = new Outbox({ now: () => now });
    box.add(msg("old", now / 1000));
    now += TTL_MS + 1;
    box.add(msg("new", now / 1000));
    expect(box.since("all").map((m) => m.id)).toEqual(["new"]);
    for (let i = 0; i < MAX_KEPT + 20; i++) box.add(msg(`m${i}`, now / 1000));
    expect(box.since("all")).toHaveLength(MAX_KEPT);
    expect(box.since("all").at(-1)?.id).toBe(`m${MAX_KEPT + 19}`);
  });

  it("survives a restart, and a damaged file just starts empty", () => {
    const file = path.join(dir(), "notifications.json");
    const first = new Outbox({ file });
    first.add(msg("a", Math.floor(Date.now() / 1000)));
    expect(existsSync(file)).toBe(true);
    expect(new Outbox({ file }).since("all").map((m) => m.id)).toEqual(["a"]);
    writeFileSync(file, "{not json");
    expect(new Outbox({ file }).since("all")).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});
