import type { Task } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import { isQuiet, startWatcher } from "../src/adapters/assistant/watcher.js";

describe("watcher", () => {
  it("notifies finished and failed tasks, not stopped ones, and respects quiet hours", () => {
    let listener: (event: LoggedEvent) => void = () => {};
    const sent: string[] = [];
    let hour = 15;
    startWatcher({
      subscribe: (l) => {
        listener = l;
        return () => {};
      },
      task: (id) => ({ id, agent: "codex", prompt: "add a test" }) as Task,
      label: () => "Codex",
      notify: (title, message, click) => sent.push(`${title} | ${message} | ${click}`),
      quietHours: "22-7",
      now: () => new Date(2026, 9, 6, hour),
    });
    const update = (state: string, reason?: string) =>
      listener({
        seq: 1,
        at: "",
        type: "task.updated",
        data: { task_id: "t1", state, ...(reason ? { reason } : {}) },
      } as unknown as LoggedEvent);

    update("done");
    update("stopped");
    update("failed", "tests failed");
    hour = 23;
    update("done");
    expect(sent).toEqual([
      "Codex finished | add a test | malves://task/t1",
      "Codex couldn't finish | add a test: tests failed | malves://task/t1",
    ]);
  });

  it("reads quiet hours, overnight or not", () => {
    const at = (h: number) => new Date(2026, 9, 6, h);
    expect(isQuiet("22-7", at(23))).toBe(true);
    expect(isQuiet("22-7", at(6))).toBe(true);
    expect(isQuiet("22-7", at(7))).toBe(false);
    expect(isQuiet("13-14", at(13))).toBe(true);
    expect(isQuiet(undefined, at(3))).toBe(false);
    expect(isQuiet("nonsense", at(3))).toBe(false);
  });
});
