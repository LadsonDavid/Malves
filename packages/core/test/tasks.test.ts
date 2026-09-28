import { createCore, RUNNER_RESTARTED, STOPPED_BY_USER, STOPPED_WAITING } from "@malves/core";
import { describe, expect, it } from "vitest";
import { flush, setup, TIMEOUT } from "./fakes.js";

const choices = [
  { id: "allow", label: "Allow" },
  { id: "reject", label: "Reject" },
];

function withWorkspace() {
  const c = setup();
  const ws = c.workspaces.register("site", "/home/me/site");
  return { ...c, ws };
}

describe("tasks", () => {
  it("runs a task to done and keeps the agent's text as the result", async () => {
    const c = withWorkspace();
    c.host.script = async ({ callbacks }) => {
      callbacks.output("All ");
      callbacks.output("done.");
      return "completed";
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "fix the footer" });
    const task = await c.tasks.whenFinished(id);
    expect(task).toMatchObject({ state: "done", result: "All done." });
    expect(c.host.runs[0]).toMatchObject({
      workspaceRoot: "/home/me/site",
      prompt: "fix the footer",
    });
    const states = c.store.events.flatMap((e) => (e.type === "task.updated" ? [e.data.state] : []));
    expect(states).toEqual(["running", "done"]);
  });

  it("goes running → waiting → running around a question", async () => {
    const c = withWorkspace();
    c.host.script = async ({ callbacks, act }) => {
      const choice = await callbacks.decide({
        kind: "permission",
        text: "Edit?",
        choices,
        risk: "medium",
      });
      if (choice === "allow") act("edit");
      return "completed";
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await flush();
    expect(c.tasks.get(id)?.state).toBe("waiting");
    const q = c.questions.pending()[0]!;
    c.questions.answer({ questionId: q.question_id, choiceId: "allow", commandId: "c1" });
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.host.actions).toEqual(["edit"]);
  });

  it("R3: a timed-out question stops the task, and the agent takes no further action", async () => {
    const c = withWorkspace();
    c.host.script = async ({ callbacks, act }) => {
      const choice = await callbacks.decide({
        kind: "permission",
        text: "Edit?",
        choices,
        risk: "high",
      });
      // A misbehaving agent that carries on regardless of the answer:
      act(`after-question:${choice}`);
      return "completed";
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await flush();
    c.clock.advance(TIMEOUT);
    const task = await c.tasks.whenFinished(id);
    expect(task).toMatchObject({ state: "stopped", reason: STOPPED_WAITING });
    await flush();
    expect(c.host.actions).toEqual([]);
    expect(c.host.cancelled).toEqual([id]);
  });

  it("stopping a waiting task cancels its question and the agent", async () => {
    const c = withWorkspace();
    let answered: string | null | undefined;
    c.host.script = async ({ callbacks }) => {
      answered = await callbacks.decide({
        kind: "permission",
        text: "Edit?",
        choices,
        risk: "low",
      });
      return "cancelled";
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await flush();
    await c.tasks.stop(id);
    await flush();
    expect(c.tasks.get(id)).toMatchObject({ state: "stopped", reason: STOPPED_BY_USER });
    expect(c.questions.pending()).toEqual([]);
    expect(answered).toBeNull();
    expect(c.host.cancelled).toEqual([id]);
  });

  it("a crashing agent fails the task with its error", async () => {
    const c = withWorkspace();
    c.host.script = async () => {
      throw new Error("agent exited with code 1");
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    expect(await c.tasks.whenFinished(id)).toMatchObject({
      state: "failed",
      reason: "agent exited with code 1",
    });
  });

  it("maps agent end reasons honestly", async () => {
    const c = withWorkspace();
    c.host.script = async () => "limit_reached";
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    expect((await c.tasks.whenFinished(id)).state).toBe("failed");
  });

  it("a re-sent command never starts a second task, even after a restart", async () => {
    const c = withWorkspace();
    const input = { workspaceId: c.ws.id, agent: "demo", prompt: "x", commandId: "phone-7" };
    const id = c.tasks.create(input);
    expect(c.tasks.create(input)).toBe(id);
    await c.tasks.whenFinished(id);
    const restarted = createCore({ ...c.options, store: c.store });
    expect(restarted.tasks.create(input)).toBe(id);
    expect(c.host.runs).toHaveLength(1);
  });

  it("only starts tasks in registered workspaces, with known agents", () => {
    const c = withWorkspace();
    expect(() => c.tasks.create({ workspaceId: "ws-unknown", agent: "demo", prompt: "x" })).toThrow(
      /workspace/,
    );
    expect(() => c.tasks.create({ workspaceId: c.ws.id, agent: "rm -rf", prompt: "x" })).toThrow(
      /agent/,
    );
    expect(() => c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "  " })).toThrow();
    expect(c.host.runs).toEqual([]);
  });

  it("confines the agent's file paths to the workspace", async () => {
    const c = withWorkspace();
    let inside = "";
    let outside: unknown;
    c.host.script = async ({ callbacks }) => {
      inside = callbacks.confine("src/index.html");
      try {
        callbacks.confine("../../etc/passwd");
      } catch (error) {
        outside = error;
      }
      return "completed";
    };
    await c.tasks.whenFinished(
      c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" }),
    );
    expect(inside).toBe("/home/me/site/src/index.html");
    expect(outside).toBeInstanceOf(Error);
    expect(c.store.events.filter((e) => e.type === "error").map((e) => e.data)).toEqual([
      expect.objectContaining({ code: "outside_workspace", message: "Refused: ../../etc/passwd" }),
    ]);
  });

  it("stopAll stops every active task", async () => {
    const c = withWorkspace();
    c.host.script = ({ callbacks }) =>
      callbacks
        .decide({ kind: "permission", text: "?", choices, risk: "low" })
        .then(() => "cancelled");
    const a = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "a" });
    const b = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "b" });
    await flush();
    await c.tasks.stopAll();
    expect([c.tasks.get(a)?.state, c.tasks.get(b)?.state]).toEqual(["stopped", "stopped"]);
  });

  it("after a restart, tasks that were active are marked failed", async () => {
    const c = withWorkspace();
    c.host.script = () => new Promise(() => {});
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await flush();
    const restarted = createCore({ ...c.options, store: c.store });
    expect(restarted.tasks.get(id)).toMatchObject({ state: "failed", reason: RUNNER_RESTARTED });
    expect(restarted.workspaces.list()).toEqual([c.ws]);
  });
});
