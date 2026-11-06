import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEARTBEAT_FILE, Heartbeat } from "../src/adapters/assistant/heartbeat.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(
  note: string,
  tasks: Array<{ id: string; agent: string; prompt: string }> = [],
  quietHours?: string,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "malves-beat-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, HEARTBEAT_FILE), note);
  let clock = new Date(2026, 10, 6, 8, 0, 0);
  const sent: string[] = [];
  const beat = new Heartbeat({
    vault: dir,
    dataDir: dir,
    subscribe: () => () => {},
    running: () => tasks,
    label: (a) => a,
    notify: (title, message) => void sent.push(`${title}: ${message}`),
    quietHours,
    now: () => clock,
  });
  return {
    beat,
    sent,
    dir,
    at: (h: number, m = 0) => {
      clock = new Date(2026, 10, 6, h, m, 0);
    },
    plus: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
  };
}

describe("the heartbeat", () => {
  it("fires a timed reminder once a day, within three hours of its time", () => {
    const s = setup("- at 09:00 remind: Look at the open tasks\n");
    expect(s.beat.tick()).toEqual([]);
    s.at(9, 5);
    expect(s.beat.tick()).toEqual(["Look at the open tasks"]);
    s.at(9, 40);
    expect(s.beat.tick()).toEqual([]);
    // Remembered on disk, so a restart doesn't repeat it.
    expect(readFileSync(path.join(s.dir, "heartbeat.json"), "utf8")).toContain("at:09:00");
    // Missed by more than three hours (the computer was off): skipped for today.
    const late = setup("- at 09:00 remind: Look at the open tasks\n");
    late.at(14, 0);
    expect(late.beat.tick()).toEqual([]);
  });

  it("repeats an interval reminder, starting the clock on the first look", () => {
    const s = setup("- every 2h remind: Drink water\n");
    expect(s.beat.tick()).toEqual([]);
    s.plus(119);
    expect(s.beat.tick()).toEqual([]);
    s.plus(2);
    expect(s.beat.tick()).toEqual(["Drink water"]);
    s.plus(30);
    expect(s.beat.tick()).toEqual([]);
  });

  it("ignores lines that don't match, and intervals under five minutes", () => {
    const s = setup(
      "# Heartbeat\nremind me of everything\n- every 1m remind: spam\n- at 25:00 remind: no\n",
    );
    s.plus(600);
    expect(s.beat.tick()).toEqual([]);
  });

  it("says when a running task has been quiet too long, once", () => {
    const s = setup("", [{ id: "t1", agent: "Claude", prompt: "fix the footer" }]);
    expect(s.beat.tick()).toEqual([]);
    s.plus(30);
    expect(s.beat.tick()).toEqual([]);
    s.plus(20);
    const said = s.beat.tick();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Claude has been quiet for 50 minutes on "fix the footer"');
    s.plus(30);
    expect(s.beat.tick()).toEqual([]);
  });

  it("stays quiet during quiet hours", () => {
    const s = setup("- at 23:00 remind: Sleep soon\n", [], "22-7");
    s.at(23, 10);
    expect(s.beat.tick()).toEqual([]);
    expect(s.sent).toEqual([]);
  });
});
