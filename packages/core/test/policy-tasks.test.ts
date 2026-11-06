import path from "node:path";
import type { Action, Decision } from "@malves/core";
import { describe, expect, it } from "vitest";
import { flush, setup, types } from "./fakes.js";

/**
 * With the policy on, a decision that carries an `action` is judged first:
 * silent reads run, hard denies are refused, everything else is a question.
 */
const root = path.resolve("/work/site");

const permission = (action: Action): Decision => ({
  kind: "permission",
  text: action.summary,
  risk: "high",
  choices: [
    { id: "allow", label: "Allow once" },
    { id: "reject", label: "Reject" },
  ],
  action,
  allowChoice: "allow",
});

const read: Action = {
  source: "agent",
  kind: "read",
  paths: [path.join(root, "a.ts")],
  summary: "Read a.ts",
};
const edit: Action = {
  source: "agent",
  kind: "edit",
  paths: [path.join(root, "a.ts")],
  summary: "Edit a.ts",
};
const push: Action = { source: "agent", kind: "execute", command: "git push", summary: "git push" };
const wipe: Action = { source: "agent", kind: "execute", command: "rm -rf /", summary: "rm -rf /" };

function start(policy = true) {
  const c = setup(policy ? { policy: {} } : {});
  const ws = c.workspaces.register("site", root);
  const answers: Array<string | null> = [];
  let todo: Action[] = [];
  c.host.script = async ({ callbacks }) => {
    for (const action of todo) answers.push(await callbacks.decide(permission(action)));
    return "completed";
  };
  const go = async (actions: Action[]) => {
    todo = actions;
    const id = c.tasks.create({ workspaceId: ws.id, agent: "demo", prompt: "work" });
    await flush();
    return id;
  };
  const answerOpen = (choiceId: string) => {
    const [q] = c.questions.pending();
    if (!q) throw new Error("no open question");
    c.questions.answer({ questionId: q.question_id, choiceId, commandId: `cmd-${q.question_id}` });
  };
  return { ...c, ws, answers, go, answerOpen };
}

describe("policy in front of questions", () => {
  it("a silent read is allowed without asking anyone", async () => {
    const c = start();
    const id = await c.go([read]);
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.answers).toEqual(["allow"]);
    expect(types(c.store)).not.toContain("question.opened");
  });

  it("an edit in a careful project is a question, and the answer is what the agent hears", async () => {
    const c = start();
    const id = await c.go([edit]);
    expect(c.questions.pending()).toHaveLength(1);
    c.answerOpen("allow");
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.answers).toEqual(["allow"]);
    const decided = c.store.events.filter((e) => e.type === "policy.decided");
    expect(decided).toHaveLength(1);
  });

  it("in a normal project the same edit runs without a question, and is in the log", async () => {
    const c = start();
    c.policy?.setAutonomy(c.ws.id, "normal");
    const id = await c.go([edit]);
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.answers).toEqual(["allow"]);
    expect(types(c.store)).not.toContain("question.opened");
    expect(
      c.store.events.some((e) => e.type === "policy.decided" && e.data.outcome === "allow"),
    ).toBe(true);
  });

  it("a hard deny is refused with no question at all, even when trusting", async () => {
    const c = start();
    c.policy?.setAutonomy(c.ws.id, "trusting");
    const id = await c.go([wipe]);
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(c.answers).toEqual([null]);
    expect(types(c.store)).not.toContain("question.opened");
  });

  it("a push always asks; under trusting one yes carries the identical push, no other", async () => {
    const c = start();
    c.policy?.setAutonomy(c.ws.id, "trusting");
    const first = await c.go([push]);
    expect(c.questions.pending()).toHaveLength(1);
    c.answerOpen("allow");
    await c.tasks.whenFinished(first);

    const second = await c.go([push]);
    expect((await c.tasks.whenFinished(second)).state).toBe("done");
    expect(c.answers).toEqual(["allow", "allow"]);
    expect(c.store.events.filter((e) => e.type === "question.opened")).toHaveLength(1);

    const third = await c.go([
      { ...push, command: "git push origin other", summary: "git push origin other" },
    ]);
    expect(c.questions.pending()).toHaveLength(1);
    c.answerOpen("reject");
    await c.tasks.whenFinished(third);
    expect(c.answers.at(-1)).toBe("reject");
  });

  it("saying no is not remembered as a yes", async () => {
    const c = start();
    c.policy?.setAutonomy(c.ws.id, "trusting");
    const first = await c.go([push]);
    c.answerOpen("reject");
    await c.tasks.whenFinished(first);
    await c.go([push]);
    expect(c.questions.pending()).toHaveLength(1);
  });

  it("silence still stops the task (R3), policy or not", async () => {
    const c = start();
    const id = await c.go([push]);
    c.clock.advance(60_000);
    await flush();
    expect((await c.tasks.whenFinished(id)).state).toBe("stopped");
  });

  it("with the policy off, nothing changes: every decision is a question", async () => {
    const c = start(false);
    const id = await c.go([read]);
    expect(c.questions.pending()).toHaveLength(1);
    c.answerOpen("allow");
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
  });
});
