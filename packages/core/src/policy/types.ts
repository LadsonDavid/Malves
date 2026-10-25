import type { ActionKind, ActionSource, Tier } from "@malves/protocol";

/**
 * Something an agent, the assistant, an automation, the computer operator or the
 * browser wants to do. Structured, so the policy judges what it is, not how a
 * model worded it (plan F1).
 */
export type Action = {
  source: ActionSource;
  kind: ActionKind;
  /** execute: the text, parsed and never trusted. browser/computer: the operation name. */
  command?: string;
  /** edit/delete/move/read: the files involved. */
  paths?: string[];
  /** browser/network: the address. */
  url?: string;
  /** computer: the application in front. */
  app?: string;
  /** What the phone shows. */
  summary: string;
};

export type Verdict = {
  outcome: "allow" | "deny" | "ask";
  tier: Tier;
  why: string;
  /** An allow at tier 3 exists only because the same action was answered yes a moment ago. */
  remembered?: true;
};

/** Where an action happens. `root` is the project folder: the limit of what is "inside". */
export type PolicyContext = {
  root: string;
  workspaceId?: string | undefined;
  taskId?: string | undefined;
};

export type Classification = { tier: Tier; why: string; unknown?: true };
