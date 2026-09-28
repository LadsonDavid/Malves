import { normaliseModel, sameModel } from "@malves/core";
import { describe, expect, it } from "vitest";
import { setup } from "./fakes.js";

describe("budget", () => {
  it("normalises model names from different gateways", () => {
    expect(normaliseModel("openai/GPT-4o-2024-08-06")).toBe("gpt-4o");
    expect(normaliseModel("meta-llama/llama-3.3-70b-instruct:free")).toBe("llama-3.3-70b-instruct");
    expect(normaliseModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(sameModel("gpt-4o", "openai/gpt-4o-2024-08-06")).toBe(true);
    expect(sameModel("gpt-4o", "gpt-4o-mini")).toBe(false);
  });

  it("with no floor, any model is fine unless a different one answered than was asked for", () => {
    const { budget } = setup();
    const base = { taskId: "t1", browser: false };
    expect(budget.check({ ...base, requested: "qwen3-coder", answered: "qwen3-coder" }).ok).toBe(
      true,
    );
    expect(budget.check({ ...base, requested: "auto", answered: "llama-3.1-8b" }).ok).toBe(true);
    expect(budget.check({ ...base, answered: "llama-3.1-8b" }).ok).toBe(true);
    expect(
      budget.check({ ...base, requested: "qwen3-coder", answered: "llama-3.1-8b" }),
    ).toMatchObject({
      ok: false,
      reason: "switched",
    });
  });

  it("enforces the floor for coding tasks, not browser tasks", () => {
    const { budget } = setup({ budget: { floor: ["claude-*", "gpt-5*", "qwen3-coder*"] } });
    const coding = { taskId: "t1", browser: false, requested: "auto" };
    expect(budget.check({ ...coding, answered: "anthropic/claude-sonnet-4-5" }).ok).toBe(true);
    expect(budget.check({ ...coding, answered: "qwen3-coder-480b" }).ok).toBe(true);
    expect(budget.check({ ...coding, answered: "llama-3.1-8b" })).toMatchObject({
      ok: false,
      reason: "below_floor",
    });
    expect(budget.check({ taskId: "t2", browser: true, answered: "llama-3.1-8b" }).ok).toBe(true);
  });

  it("remembers a model a person allowed, for that task only", () => {
    const { budget } = setup({ budget: { floor: ["claude-*"] } });
    budget.allow("t1", "llama-3.1-8b");
    expect(budget.check({ taskId: "t1", browser: false, answered: "llama-3.1-8b" }).ok).toBe(true);
    expect(budget.check({ taskId: "t2", browser: false, answered: "llama-3.1-8b" }).ok).toBe(false);
  });

  it("records which model answered", () => {
    const c = setup();
    c.budget.record({
      task_id: "t1",
      model: "gpt-4o",
      via: "free",
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(c.store.events.at(-1)).toMatchObject({
      type: "budget.updated",
      data: { model: "gpt-4o" },
    });
  });
});
