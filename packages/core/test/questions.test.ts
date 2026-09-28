import { createCore } from "@malves/core";
import { describe, expect, it } from "vitest";
import { flush, setup } from "./fakes.js";

const choices = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

function ask(q: ReturnType<typeof setup>["questions"], timeoutMs = 1000) {
  return q.ask({
    taskId: "t1",
    kind: "agent_question",
    text: "Use existing?",
    choices,
    risk: "low",
    timeoutMs,
  });
}

describe("questions.ask", () => {
  it("logs the question before sending the push", async () => {
    const c = setup();
    void ask(c.questions);
    expect(c.store.events.at(-1)?.type).toBe("question.opened");
    await flush();
    expect(c.notifier.sent).toHaveLength(1);
    expect(c.notifier.sent[0]?.question_id).toBe(c.questions.pending()[0]?.question_id);
  });

  it("resolves with the chosen answer", async () => {
    const c = setup();
    const answer = ask(c.questions);
    const [q] = c.questions.pending();
    expect(
      c.questions.answer({ questionId: q!.question_id, choiceId: "no", commandId: "c1" }),
    ).toBe("applied");
    await expect(answer).resolves.toEqual({ outcome: "answered", choiceId: "no" });
    expect(c.questions.pending()).toEqual([]);
  });

  it("times out as timed_out, never as a default answer (R3)", async () => {
    const c = setup();
    const answer = ask(c.questions, 1000);
    c.clock.advance(999);
    expect(c.questions.pending()).toHaveLength(1);
    c.clock.advance(1);
    await expect(answer).resolves.toEqual({ outcome: "timed_out" });
    expect(c.store.events.at(-1)).toMatchObject({
      type: "question.closed",
      data: { outcome: "timed_out" },
    });
  });

  it("lets the first answer win", async () => {
    const c = setup();
    const answer = ask(c.questions);
    const id = c.questions.pending()[0]!.question_id;
    expect(c.questions.answer({ questionId: id, choiceId: "yes", commandId: "phone-1" })).toBe(
      "applied",
    );
    expect(c.questions.answer({ questionId: id, choiceId: "no", commandId: "phone-2" })).toBe(
      "closed",
    );
    await expect(answer).resolves.toEqual({ outcome: "answered", choiceId: "yes" });
  });

  it("recognises a re-sent command instead of treating it as a second answer", () => {
    const c = setup();
    void ask(c.questions);
    const id = c.questions.pending()[0]!.question_id;
    c.questions.answer({ questionId: id, choiceId: "yes", commandId: "phone-1" });
    expect(c.questions.answer({ questionId: id, choiceId: "yes", commandId: "phone-1" })).toBe(
      "duplicate",
    );
    expect(c.store.events.filter((e) => e.type === "question.closed")).toHaveLength(1);
  });

  it("rejects an answer after the timeout", async () => {
    const c = setup();
    const answer = ask(c.questions, 1000);
    const id = c.questions.pending()[0]!.question_id;
    c.clock.advance(1000);
    expect(c.questions.answer({ questionId: id, choiceId: "yes", commandId: "late" })).toBe(
      "closed",
    );
    await expect(answer).resolves.toEqual({ outcome: "timed_out" });
  });

  it("rejects unknown questions and choices", () => {
    const c = setup();
    void ask(c.questions);
    const id = c.questions.pending()[0]!.question_id;
    expect(c.questions.answer({ questionId: "nope", choiceId: "yes", commandId: "c" })).toBe(
      "unknown_question",
    );
    expect(c.questions.answer({ questionId: id, choiceId: "maybe", commandId: "c" })).toBe(
      "invalid_choice",
    );
    expect(c.questions.pending()).toHaveLength(1);
  });

  it("an answer after the timer was cancelled does not fire the timeout later", async () => {
    const c = setup();
    const answer = ask(c.questions, 1000);
    c.questions.answer({
      questionId: c.questions.pending()[0]!.question_id,
      choiceId: "yes",
      commandId: "c",
    });
    c.clock.advance(5000);
    await expect(answer).resolves.toEqual({ outcome: "answered", choiceId: "yes" });
    expect(c.store.events.filter((e) => e.type === "question.closed")).toHaveLength(1);
  });

  it("a failed push is logged and changes nothing", async () => {
    const c = setup();
    c.notifier.fail = true;
    const answer = ask(c.questions);
    await flush();
    expect(c.store.events.some((e) => e.type === "error" && e.data.code === "push_failed")).toBe(
      true,
    );
    c.questions.answer({
      questionId: c.questions.pending()[0]!.question_id,
      choiceId: "yes",
      commandId: "c",
    });
    await expect(answer).resolves.toEqual({ outcome: "answered", choiceId: "yes" });
  });

  it("cancelTask closes only that task's questions", async () => {
    const c = setup();
    const a = ask(c.questions);
    void c.questions.ask({
      taskId: "t2",
      kind: "permission",
      text: "?",
      choices,
      risk: "low",
      timeoutMs: 1000,
    });
    c.questions.cancelTask("t1");
    await expect(a).resolves.toEqual({ outcome: "cancelled" });
    expect(c.questions.pending().map((q) => q.task_id)).toEqual(["t2"]);
  });

  it("refuses bad input", () => {
    const c = setup();
    expect(() => ask(c.questions, 0)).toThrow();
    expect(() =>
      c.questions.ask({
        taskId: "t",
        kind: "permission",
        text: "?",
        choices: [],
        risk: "low",
        timeoutMs: 1,
      }),
    ).toThrow();
    expect(() =>
      c.questions.ask({
        taskId: "t",
        kind: "permission",
        text: "?",
        choices: [choices[0]!, choices[0]!],
        risk: "low",
        timeoutMs: 1,
      }),
    ).toThrow();
  });

  it("after a restart, questions nobody is waiting for are cancelled, and old commands are still recognised", () => {
    const first = setup();
    void ask(first.questions);
    void ask(first.questions);
    const [q1, q2] = first.questions.pending();
    first.questions.answer({ questionId: q1!.question_id, choiceId: "yes", commandId: "phone-1" });

    const second = createCore({ ...first.options, store: first.store });
    expect(second.questions.pending()).toEqual([]);
    expect(first.store.events.at(-1)).toMatchObject({
      type: "question.closed",
      data: { question_id: q2!.question_id, outcome: "cancelled" },
    });
    expect(
      second.questions.answer({
        questionId: q1!.question_id,
        choiceId: "yes",
        commandId: "phone-1",
      }),
    ).toBe("duplicate");
    expect(
      second.questions.answer({ questionId: q2!.question_id, choiceId: "yes", commandId: "x" }),
    ).toBe("closed");
  });
});
