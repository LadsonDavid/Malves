import { JobStep, StepRole } from "@malves/protocol";

export const MAX_PLAN_STEPS = 6;

/**
 * Checks whether a dependency graph has any cycles using depth-first search.
 */
export function checkAcyclic(steps: Array<{ id: string; depends_on?: string[] }>): boolean {
  const ids = new Set(steps.map((s) => s.id));
  const graph = new Map<string, string[]>();
  for (const s of steps) {
    const deps = (s.depends_on ?? []).filter((d) => ids.has(d));
    graph.set(s.id, deps);
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(id: string): boolean {
    visited.add(id);
    inStack.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (inStack.has(dep)) return true;
      if (!visited.has(dep) && hasCycle(dep)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const id of ids) {
    if (!visited.has(id)) {
      if (hasCycle(id)) return true;
    }
  }
  return false;
}

/**
 * Validates a job plan against safety and structure invariants:
 * - 1 to 6 steps
 * - Unique step IDs
 * - Known roles and known available agents
 * - All dependencies reference valid step IDs
 * - Dependency graph is a directed acyclic graph (no cycles)
 */
export function validatePlan(input: unknown, availableAgents: string[]): JobStep[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PLAN_STEPS) {
    throw new Error(`Plan must have between 1 and ${MAX_PLAN_STEPS} steps`);
  }

  const agentsSet = new Set(availableAgents);
  const seenIds = new Set<string>();
  const parsedSteps: JobStep[] = [];

  for (const item of input) {
    const step = JobStep.parse(item);
    if (seenIds.has(step.id)) {
      throw new Error(`Duplicate step id: ${step.id}`);
    }
    seenIds.add(step.id);

    if (!agentsSet.has(step.agent)) {
      throw new Error(`Unknown agent: ${step.agent} (available: ${availableAgents.join(", ")})`);
    }

    parsedSteps.push(step);
  }

  for (const step of parsedSteps) {
    for (const dep of step.depends_on) {
      if (!seenIds.has(dep)) {
        throw new Error(`Step "${step.id}" references unknown dependency: ${dep}`);
      }
    }
  }

  if (checkAcyclic(parsedSteps)) {
    throw new Error("Cycle detected in plan dependencies");
  }

  // A reviewer is only independent if it is not the agent whose work it checks.
  if (agentsSet.size > 1) {
    for (const step of parsedSteps.filter((s) => s.role === "reviewer")) {
      for (const dep of step.depends_on) {
        const checked = parsedSteps.find((s) => s.id === dep);
        if (checked?.role === "implementer" && checked.agent === step.agent) {
          throw new Error(
            `Reviewer "${step.id}" must be a different agent than "${checked.id}" (both are ${step.agent})`,
          );
        }
      }
    }
  }

  // Steps that can run at the same time must not own the same paths.
  const before = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const known = before.get(id);
    if (known) return known;
    const out = new Set<string>();
    before.set(id, out);
    for (const dep of parsedSteps.find((s) => s.id === id)?.depends_on ?? []) {
      out.add(dep);
      for (const up of ancestors(dep)) out.add(up);
    }
    return out;
  };
  for (let i = 0; i < parsedSteps.length; i++) {
    for (let j = i + 1; j < parsedSteps.length; j++) {
      const a = parsedSteps[i];
      const b = parsedSteps[j];
      if (!a || !b || ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
      const clash = overlap(a.owns, b.owns);
      if (clash) {
        throw new Error(`Steps "${a.id}" and "${b.id}" run in parallel but both own ${clash}`);
      }
    }
  }

  return parsedSteps;
}

const clean = (p: string) =>
  p
    .trim()
    .replace(/^[.][/]/, "")
    .replace(/[/]+$/, "");

/** The first path two owner lists share (one inside the other counts), or undefined. */
export function overlap(a: string[], b: string[]): string | undefined {
  for (const x of a.map(clean)) {
    for (const y of b.map(clean)) {
      const whole = x === "" || x === "." || y === "" || y === ".";
      if (whole || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`))
        return x || y || "the whole repo";
    }
  }
  return undefined;
}

/**
 * Cleans a model's reply (stripping markdown code fences) and parses/validates the plan.
 */
export function parsePlan(rawText: string, availableAgents: string[]): JobStep[] {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```[a-z0-9_-]*\n?/i, "")
      .replace(/```$/, "")
      .trim();
  }
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Could not parse plan JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePlan(json, availableAgents);
}

/**
 * Prompt for the planner model to decompose a goal into 1-6 discrete steps.
 */
export function plannerPrompt(goal: string, agents: string[], projectNotes?: string): string {
  const roles = StepRole.options.join(", ");
  return `You are Malves' planner. Decompose the following software engineering goal into 1 to 6 coordinated steps.

Goal:
${goal}

Available agents:
${agents.map((a) => `- ${a}`).join("\n")}

Allowed roles:
${roles}
- implementer: writes or updates code in its designated scope.
- tester: creates or updates tests to verify the changes.
- reviewer: audits the changes, diffs, and security boundaries. It never edits files, depends on the implementer it checks, and must be a different agent from that implementer.
- verifier: runs test commands and linting.
- integrator: resolves merge conflicts between step branches.

${projectNotes ? `Project notes:\n${projectNotes}\n` : ""}
Rules:
1. Max 6 steps.
2. Steps run in isolated git worktrees. Each step gets its own branch malves/<job>/<step>.
3. Steps with no dependencies run in parallel.
4. Independent steps can share dependencies (DAG), but cycles are strictly forbidden.
5. Return ONLY a valid JSON array of steps matching this schema:
[
  {
    "id": "step-1",
    "role": "implementer",
    "agent": "${agents[0] ?? "claude"}",
    "prompt": "clear instructions for this step",
    "depends_on": [],
    "owns": ["src/feature/"]
  }
]
6. "owns" lists the paths a step may change. Steps that run in parallel must own different paths.`;
}
