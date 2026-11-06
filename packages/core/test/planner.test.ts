import { describe, expect, it } from "vitest";
import { checkAcyclic, parsePlan, plannerPrompt, validatePlan } from "../src/jobs/planner.js";

const AGENTS = ["claude", "codex", "assistant"];

describe("planner validation", () => {
  it("accepts a valid single-step plan", () => {
    const plan = [
      {
        id: "step-1",
        role: "implementer",
        agent: "claude",
        prompt: "Write the handshake logic in protocol v2",
        depends_on: [],
      },
    ];
    const validated = validatePlan(plan, AGENTS);
    expect(validated).toHaveLength(1);
    expect(validated[0]!.id).toBe("step-1");
  });

  it("accepts a multi-step parallel DAG", () => {
    const plan = [
      {
        id: "step-1",
        role: "implementer",
        agent: "claude",
        prompt: "Add protocol types",
        depends_on: [],
      },
      {
        id: "step-2",
        role: "implementer",
        agent: "codex",
        prompt: "Implement client parser",
        depends_on: ["step-1"],
      },
      {
        id: "step-3",
        role: "tester",
        agent: "claude",
        prompt: "Add unit tests for parser",
        depends_on: ["step-1"],
      },
    ];
    const validated = validatePlan(plan, AGENTS);
    expect(validated).toHaveLength(3);
  });

  it("rejects an empty plan", () => {
    expect(() => validatePlan([], AGENTS)).toThrow(/between 1 and 6 steps/i);
  });

  it("rejects plans with more than 6 steps", () => {
    const plan = Array.from({ length: 7 }, (_, i) => ({
      id: `step-${i + 1}`,
      role: "implementer",
      agent: "claude",
      prompt: `Step ${i + 1}`,
      depends_on: i > 0 ? [`step-${i}`] : [],
    }));
    expect(() => validatePlan(plan, AGENTS)).toThrow(/between 1 and 6 steps/i);
  });

  it("rejects duplicate step IDs", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "claude", prompt: "A", depends_on: [] },
      { id: "step-1", role: "tester", agent: "codex", prompt: "B", depends_on: [] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/duplicate step id/i);
  });

  it("rejects unknown agents", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "unknown-agent", prompt: "A", depends_on: [] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/unknown agent: unknown-agent/i);
  });

  it("rejects nonexistent dependencies", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "claude", prompt: "A", depends_on: ["ghost"] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/unknown dependency: ghost/i);
  });

  it("rejects self-dependencies", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "claude", prompt: "A", depends_on: ["step-1"] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/cycle detected/i);
  });

  it("rejects cyclic dependencies (A -> B -> A)", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "claude", prompt: "A", depends_on: ["step-2"] },
      { id: "step-2", role: "tester", agent: "codex", prompt: "B", depends_on: ["step-1"] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/cycle detected/i);
  });

  it("rejects indirect cyclic dependencies (A -> B -> C -> A)", () => {
    const plan = [
      { id: "step-1", role: "implementer", agent: "claude", prompt: "A", depends_on: ["step-3"] },
      { id: "step-2", role: "implementer", agent: "codex", prompt: "B", depends_on: ["step-1"] },
      { id: "step-3", role: "tester", agent: "claude", prompt: "C", depends_on: ["step-2"] },
    ];
    expect(() => validatePlan(plan, AGENTS)).toThrow(/cycle detected/i);
  });
});

describe("checkAcyclic", () => {
  it("detects no cycle in linear graph", () => {
    expect(
      checkAcyclic([
        { id: "1", depends_on: [] },
        { id: "2", depends_on: ["1"] },
        { id: "3", depends_on: ["2"] },
      ]),
    ).toBe(false);
  });

  it("detects cycle", () => {
    expect(
      checkAcyclic([
        { id: "1", depends_on: ["2"] },
        { id: "2", depends_on: ["1"] },
      ]),
    ).toBe(true);
  });
});

describe("parsePlan", () => {
  it("parses raw JSON string and strips markdown code fences", () => {
    const raw = `\`\`\`json
[
  {
    "id": "step-1",
    "role": "implementer",
    "agent": "claude",
    "prompt": "Update protocol types",
    "depends_on": []
  }
]
\`\`\``;
    const plan = parsePlan(raw, AGENTS);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.id).toBe("step-1");
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePlan("not json", AGENTS)).toThrow(/could not parse plan JSON/i);
  });
});

describe("plannerPrompt", () => {
  it("includes goal, available agents, and roles", () => {
    const prompt = plannerPrompt("Migrate to protocol v2", AGENTS, "Use strict typing");
    expect(prompt).toContain("Migrate to protocol v2");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("Use strict typing");
    expect(prompt).toContain("implementer");
    expect(prompt).toContain("tester");
  });
});
