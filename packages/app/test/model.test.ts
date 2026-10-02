import type { AgentInfo, EventBody, LoggedEvent } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import {
  type Action,
  emptyModel,
  needsYou,
  pickAgent,
  recent,
  reduce,
  running,
} from "../src/model";

const demoReady: AgentInfo = { name: "demo", label: "Demo", state: "ready" };
const claudeReady: AgentInfo = { name: "claude", label: "Claude", state: "ready" };

let seq = 0;
const event = (body: EventBody, at = 1000 + seq): Action => ({
  type: "event",
  event: { ...body, seq: ++seq, at } as LoggedEvent,
});
const play = (...actions: Action[]) => actions.reduce(reduce, emptyModel);

const created = (id: string) =>
  event({
    type: "task.created",
    data: { task_id: id, workspace_id: "ws1", agent: "demo", prompt: `do ${id}` },
  });
const state = (id: string, s: "running" | "waiting" | "done" | "failed", reason?: string) =>
  event({
    type: "task.updated",
    data: { task_id: id, state: s, ...(reason ? { reason } : {}) },
  });
const opened = (id: string, taskId: string, expiresAt: number) =>
  event({
    type: "question.opened",
    data: {
      question_id: id,
      task_id: taskId,
      kind: "permission",
      text: `Allow ${id}?`,
      choices: [{ id: "allow", label: "Allow" }],
      risk: "high",
      expires_at: expiresAt,
    },
  });

describe("phone model", () => {
  it("follows a task from created to done, keeping its result", () => {
    const m = play(
      created("t1"),
      state("t1", "running"),
      event({ type: "task.result", data: { task_id: "t1", text: "All done." } }),
      state("t1", "done"),
    );
    expect(running(m)).toEqual([]);
    expect(recent(m)).toEqual([
      expect.objectContaining({ id: "t1", state: "done", result: "All done." }),
    ]);
  });

  it("shows open questions oldest-expiry first, and drops closed ones", () => {
    const m = play(
      created("t1"),
      opened("q-late", "t1", 9000),
      opened("q-soon", "t1", 5000),
      opened("q-done", "t1", 7000),
      event({
        type: "question.closed",
        data: { question_id: "q-done", task_id: "t1", outcome: "answered", choice_id: "allow" },
      }),
    );
    expect(needsYou(m).map((q) => q.id)).toEqual(["q-soon", "q-late"]);
  });

  it("clears an old reason when the task moves on", () => {
    const m = play(created("t1"), state("t1", "failed", "agent crashed"));
    expect(m.tasks.t1?.reason).toBe("agent crashed");
    const again = reduce(m, state("t1", "running"));
    expect(again.tasks.t1?.reason).toBeUndefined();
  });

  it("never mutates the previous state", () => {
    const before = play(created("t1"));
    const snapshot = JSON.stringify(before);
    reduce(before, state("t1", "running"));
    reduce(before, opened("q1", "t1", 5000));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("ignores updates for tasks it never saw", () => {
    const m = play(state("ghost", "done"));
    expect(m.tasks).toEqual({});
  });

  it("takes workspaces from the welcome, then keeps up with events", () => {
    const m = play(
      {
        type: "welcome",
        welcome: {
          type: "welcome",
          v: 1,
          device_id: "dev1",
          computer: "work-pc",
          workspaces: [{ id: "ws1", name: "site" }],
          agents: [demoReady, claudeReady],
          last_seq: 3,
        },
      },
      event({
        type: "workspace.registered",
        data: { workspace_id: "ws2", name: "api", path: "/x/api" },
      }),
      event({ type: "workspace.removed", data: { workspace_id: "ws1" } }),
    );
    expect(m.computer).toBe("work-pc");
    expect(m.workspaces).toEqual([{ id: "ws2", name: "api" }]);
    expect(m.agents).toEqual([demoReady, claudeReady]);
  });
});

describe("which agent a new task suggests", () => {
  const agent = (name: string, state: AgentInfo["state"]): AgentInfo => ({
    name,
    label: name,
    state,
  });

  it("the one used last, if it's ready", () => {
    expect(pickAgent([agent("claude", "ready"), agent("codex", "ready")], "codex")).toBe("codex");
  });

  it("never one that needs sign-in — even if it was used last", () => {
    const agents = [agent("claude", "needs_sign_in"), agent("demo", "ready")];
    expect(pickAgent(agents, "claude")).toBe("demo");
  });

  it("Claude when nothing was used yet and Claude is ready", () => {
    expect(pickAgent([agent("demo", "ready"), agent("claude", "ready")])).toBe("claude");
  });

  it("nothing while everything is still being checked", () => {
    expect(pickAgent([agent("claude", "checking"), agent("demo", "checking")])).toBeUndefined();
  });

  it("follows live updates from the computer", () => {
    const m = reduce(emptyModel, { type: "agents", agents: [agent("claude", "needs_sign_in")] });
    expect(m.agents[0]?.state).toBe("needs_sign_in");
  });
});
