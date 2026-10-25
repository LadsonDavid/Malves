import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import { isoWeek, rollUpWeeks, startJournal } from "../src/adapters/assistant/journal.js";

const vault = () => mkdtempSync(path.join(tmpdir(), "malves-journal-"));
const read = (file: string) => readFileSync(file, "utf8");

function harness(tasks: Record<string, Partial<Task>>, now = new Date("2026-10-25T15:45:00")) {
  const dir = vault();
  let listener: (event: LoggedEvent) => void = () => {};
  let clock = now;
  const stop = startJournal({
    vault: dir,
    subscribe: (l) => {
      listener = l;
      return () => {};
    },
    task: (id) => tasks[id] as Task | undefined,
    workspaceName: () => "site",
    label: (agent) => (agent === "claude" ? "Claude" : agent),
    now: () => clock,
  });
  const emit = (body: object) =>
    listener({ seq: 1, at: clock.getTime(), ...body } as unknown as LoggedEvent);
  return {
    dir,
    stop,
    emit,
    at: (d: Date) => {
      clock = d;
    },
    day: () => path.join(dir, "Journal", "2026-10-25.md"),
  };
}

describe("journal of finished tasks", () => {
  it("writes one line per finished task, with what, where, who and the outcome", () => {
    const h = harness({
      t1: { agent: "claude", prompt: "Fix the footer year", workspaceId: "w" },
      t2: { agent: "codex", prompt: "Add tests", workspaceId: "w" },
      t3: { agent: "claude", prompt: "Refactor the nav", workspaceId: "w" },
    });
    h.emit({
      type: "task.changes",
      data: {
        task_id: "t1",
        files: [
          { path: "a", added: 1, removed: 0 },
          { path: "b", added: 2, removed: 1 },
        ],
      },
    });
    h.emit({ type: "task.updated", data: { task_id: "t1", state: "running" } });
    h.emit({ type: "task.updated", data: { task_id: "t1", state: "done" } });
    h.emit({
      type: "task.updated",
      data: { task_id: "t2", state: "failed", reason: "Not signed in" },
    });
    h.emit({ type: "task.updated", data: { task_id: "t3", state: "stopped" } });
    expect(read(h.day())).toBe(
      [
        "# Journal 2026-10-25",
        "",
        "- 15:45 ✓ **Claude** in *site*: Fix the footer year (2 files changed)",
        "- 15:45 ✗ **codex** in *site*: Add tests. Couldn't finish: Not signed in",
        "- 15:45 ■ **Claude** in *site*: Refactor the nav. Stopped.",
        "",
      ].join("\n"),
    );
  });

  it("hides secrets and flattens long, multi-line prompts", () => {
    const h = harness({
      t1: {
        agent: "claude",
        prompt: `Use key ghp_abcdefghijklmnopqrstuvwxyz0123456789\nthen deploy ${"word ".repeat(80)}`,
        workspaceId: "w",
      },
    });
    h.emit({ type: "task.updated", data: { task_id: "t1", state: "done" } });
    const text = read(h.day());
    expect(text).not.toContain("ghp_");
    expect(text).toContain("[hidden]");
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(text.length).toBeLessThan(400);
  });

  it("ignores running states and tasks it can't find", () => {
    const h = harness({ t1: { agent: "claude", prompt: "x", workspaceId: "w" } });
    h.emit({ type: "task.updated", data: { task_id: "t1", state: "running" } });
    h.emit({ type: "task.updated", data: { task_id: "gone", state: "done" } });
    expect(existsSync(h.day())).toBe(false);
  });
});

describe("weekly roll-up", () => {
  const dayFile = (dir: string, date: string, lines: string[]) => {
    mkdirSync(path.join(dir, "Journal"), { recursive: true });
    writeFileSync(
      path.join(dir, "Journal", `${date}.md`),
      [`# Journal ${date}`, "", ...lines, ""].join("\n"),
    );
  };

  it("names ISO weeks", () => {
    expect(isoWeek(new Date("2026-01-01T12:00:00"))).toBe("2026-W01");
    expect(isoWeek(new Date("2026-10-25T12:00:00"))).toBe("2026-W43");
    expect(isoWeek(new Date("2026-10-26T12:00:00"))).toBe("2026-W44");
  });

  it("summarises each finished week once, and never the current one", () => {
    const dir = vault();
    dayFile(dir, "2026-10-12", [
      "- 09:00 ✓ **Claude** in *site*: Fix the footer year (2 files changed)",
      "- 10:00 ✗ **Codex** in *site*: Add tests. Couldn't finish: Not signed in",
    ]);
    dayFile(dir, "2026-10-14", [
      "- 11:00 ✓ **Claude** in *api*: Add login (5 files changed)",
      "- 12:00 ■ **Claude** in *api*: Refactor. Stopped.",
    ]);
    dayFile(dir, "2026-10-26", ["- 09:00 ✓ **Claude** in *site*: This week, not finished"]);

    const made = rollUpWeeks(dir, new Date("2026-10-27T09:00:00"));
    expect(made).toEqual(["2026-W42"]);
    const summary = read(path.join(dir, "Journal", "Weeks", "2026-W42.md"));
    expect(summary).toContain("# Week 2026-W42");
    expect(summary).toContain("4 tasks: 2 finished, 1 couldn't finish, 1 stopped");
    expect(summary).toContain("Claude 3");
    expect(summary).toContain("Codex 1");
    expect(summary).toContain("site 2");
    expect(summary).toContain("api 2");
    expect(summary).toContain("7 files changed");
    expect(existsSync(path.join(dir, "Journal", "Weeks", "2026-W44.md"))).toBe(false);

    // Running it again changes nothing.
    expect(rollUpWeeks(dir, new Date("2026-10-27T09:00:00"))).toEqual([]);
  });

  it("does nothing when there is no journal yet", () => {
    expect(rollUpWeeks(vault(), new Date("2026-10-27T09:00:00"))).toEqual([]);
  });
});
