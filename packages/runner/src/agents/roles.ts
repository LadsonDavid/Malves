import type { StepRole } from "@malves/protocol";

export type RoleContract = {
  role: StepRole;
  title: string;
  scope: string;
  handover: string;
  approvalRules: string;
  stopCriteria: string;
};

export const ROLE_CONTRACTS: Record<StepRole, RoleContract> = {
  implementer: {
    role: "implementer",
    title: "Implementer (Specialist Lane)",
    scope:
      "Source files, components, and libraries relevant to your assigned task. Stay within your worktree.",
    handover:
      "Provide a concise summary of all files created or modified and key architectural decisions.",
    approvalRules:
      "Tier 3 operations (external network requests, deleting unmanaged files, spending) require user approval.",
    stopCriteria: "Stop as soon as the implementation satisfies the prompt and compiles cleanly.",
  },
  tester: {
    role: "tester",
    title: "Tester (Verification Lane)",
    scope:
      "Test directories, fixtures, test suites, and mock setups. Do not rewrite production code unless fixing minor typings.",
    handover:
      "Provide a list of new and updated test cases, assertion coverage, and pass/fail verification results.",
    approvalRules: "Modifying production logic outside of test harness requires approval.",
    stopCriteria: "Stop when test cases cover the specified behaviors, run reliably, and pass.",
  },
  reviewer: {
    role: "reviewer",
    title: "Reviewer (Quality & Security Lane)",
    scope:
      "Read-only inspection of the git diff, modified files, types, boundary invariants, and security posture.",
    handover:
      "Deliver a structured critique: identified regressions, missing edge cases, security concerns, or approval.",
    approvalRules: "Read-only lane: all write operations are forbidden.",
    stopCriteria:
      "Stop after writing the review summary with a clear recommendation (PASS or CHANGES_REQUESTED).",
  },
  verifier: {
    role: "verifier",
    title: "Verifier (Build & Quality Gate Lane)",
    scope: "Execution of automated test suites, lint checks, typecheck, and build steps.",
    handover: "Provide stdout/stderr summary, exit codes, and timing of test suites.",
    approvalRules:
      "Only read and test commands may execute silently; network or destructive commands require approval.",
    stopCriteria: "Stop once test and lint commands have run to completion.",
  },
  integrator: {
    role: "integrator",
    title: "Integrator (Merge & Conflict Resolution Lane)",
    scope: "Git branch merging, conflict marker resolution across parallel step branches.",
    handover:
      "Provide a summary of resolved conflicts, preserved features, and verification of clean merge.",
    approvalRules: "Discarding entire files or bypassing conflict resolution requires approval.",
    stopCriteria: "Stop when all step branches are cleanly integrated and git status is clean.",
  },
};

/**
 * Decorates a step prompt with the role's specialist lane contract.
 */
export function formatRoleContract(role: StepRole, prompt: string): string {
  const contract = ROLE_CONTRACTS[role];
  if (!contract) return prompt;

  return `[ROLE CONTRACT: ${contract.title.toUpperCase()}]
Scope: ${contract.scope}
Handover: ${contract.handover}
Approval Rules: ${contract.approvalRules}
Stop Criteria: ${contract.stopCriteria}

TASK INSTRUCTION:
${prompt}`;
}
