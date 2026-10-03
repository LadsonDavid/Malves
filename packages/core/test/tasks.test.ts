import path from "node:path";
import {
  createCore,
  MAX_RESULT_CHARS,
  RUNNER_RESTARTED,
  STOPPED_BY_USER,
  STOPPED_WAITING,
} from "@malves/core";
import { describe, expect, it } from "vitest";
import { flush, setup, TIMEOUT } from "./fakes.js";

const choices = [
  { id: "allow", label: "Allow" },
  { id: "reject", label: "Reject" },
];

function withWorkspace() {
  const c = setup();
  const ws = c.workspaces.register("site", path.resolve("/home/me/site"));
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
      workspaceRoot: c.ws.path,
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

  it("two questions at once both reach the user, and the task waits until both are answered", async () => {
    const c = withWorkspace();
    c.host.script = async ({ callbacks, act }) => {
      const ask = (text: string) =>
        callbacks.decide({ kind: "permission", text, choices, risk: "medium" });
      const [first, second] = await Promise.all([ask("Edit a?"), ask("Edit b?")]);
      if (first === "allow") act("edit a");
      if (second === "allow") act("edit b");
      return "completed";
    };
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await flush();

    const [qa, qb] = c.questions.pending();
    expect([qa?.text, qb?.text]).toEqual(["Edit a?", "Edit b?"]);
    expect(c.tasks.get(id)?.state).toBe("waiting");

    c.questions.answer({ questionId: qa!.question_id, choiceId: "allow", commandId: "c1" });
    await flush();
    expect(c.tasks.get(id)?.state).toBe("waiting");

    c.questions.answer({ questionId: qb!.question_id, choiceId: "allow", commandId: "c2" });
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.host.actions).toEqual(["edit a", "edit b"]);
  });

  it("keeps only the end of a very long result", async () => {
    const c = withWorkspace();
    c.host.script = async ({ callbacks }) => {
      callbacks.output("x".repeat(MAX_RESULT_CHARS));
      callbacks.output("THE END");
      return "completed";
    };
    const task = await c.tasks.whenFinished(
      c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" }),
    );
    expect(task.result?.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(task.result?.endsWith("THE END")).toBe(true);
    expect(task.result?.startsWith("…")).toBe(true);
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
    expect(inside).toBe(path.join(c.ws.path, "src", "index.html"));
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

describe("continuing a conversation", () => {
  /** An agent that opens session `s-<n>` for a new task, or the one it was asked to continue. */
  function withSessions() {
    const c = withWorkspace();
    let opened = 0;
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    c.host.script = async ({ callbacks }) => {
      const run = c.host.runs.at(-1);
      callbacks.session(run?.resume ?? `s-${++opened}`);
      if (run?.prompt === "slow") await hold;
      return "completed";
    };
    return { ...c, release };
  }

  it("remembers the agent's session, and a reply continues it with the same agent and project", async () => {
    const c = withSessions();
    const first = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "fix it" });
    expect(await c.tasks.whenFinished(first)).toMatchObject({ state: "done", sessionId: "s-1" });

    const reply = c.tasks.reply(first, "now add a test");
    expect(c.tasks.get(reply)).toMatchObject({
      workspaceId: c.ws.id,
      agent: "demo",
      resume: "s-1",
    });
    await c.tasks.whenFinished(reply);
    expect(c.host.runs.at(-1)).toMatchObject({ prompt: "now add a test", resume: "s-1" });
    expect(c.tasks.get(reply)?.sessionId).toBe("s-1");
  });

  it("a reply waits for the task to finish, and needs a conversation to continue", async () => {
    const c = withSessions();
    const running = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "slow" });
    await flush();
    expect(() => c.tasks.reply(running, "more")).toThrow(/Wait for this task to finish/);
    c.release();
    await c.tasks.whenFinished(running);

    c.host.script = async () => "completed"; // an agent that never reports a session
    const plain = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await c.tasks.whenFinished(plain);
    expect(() => c.tasks.reply(plain, "more")).toThrow(/didn't keep a conversation/);
  });

  it("never runs two tasks in one conversation at once", async () => {
    const c = withSessions();
    const first = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    await c.tasks.whenFinished(first);
    c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "slow", resume: "s-1" });
    await flush();
    expect(() => c.tasks.reply(first, "again")).toThrow(/already running in another task/);
    c.release();
  });
});
