import { EventBody } from "@malves/protocol";
import { describe, expect, it } from "vitest";

describe("EventBody", () => {
  it("accepts a well-formed question", () => {
    const parsed = EventBody.parse({
      type: "question.opened",
      data: {
        question_id: "q1",
        task_id: "t1",
        kind: "permission",
        text: "Edit config.json?",
        choices: [{ id: "allow", label: "Allow" }],
        risk: "medium",
        expires_at: 1000,
      },
    });
    expect(parsed.type).toBe("question.opened");
  });

  it("rejects a question with no choices", () => {
    const result = EventBody.safeParse({
      type: "question.opened",
      data: {
        question_id: "q1",
        task_id: "t1",
        kind: "permission",
        text: "?",
        choices: [],
        risk: "low",
        expires_at: 1000,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    expect(EventBody.safeParse({ type: "shell.exec", data: {} }).success).toBe(false);
  });
});
