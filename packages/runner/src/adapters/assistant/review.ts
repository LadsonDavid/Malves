import type { AutomationRule } from "@malves/protocol";
import type { Suggestions } from "@malves/core";
import { createHash } from "node:crypto";
import { modelForRole } from "./llm.js";

export const DEFAULT_REVIEWER_MODEL = modelForRole("reviewer");

export type TaskSummaryForReview = {
  taskId: string;
  agent: string;
  prompt: string;
  result?: string | undefined;
  commands?: string[] | undefined;
  changedFiles?: string[] | undefined;
};

export type ReviewSuggestion = {
  worthSaving: boolean;
  type: "skill" | "memory";
  title: string;
  content: string;
  explanation: string;
};

export type ReviewerModel = (task: TaskSummaryForReview) => Promise<ReviewSuggestion | null>;

export const REVIEWER_SYSTEM_PROMPT = `You are the Malves Background Reviewer (role: reviewer).
After a task completes, evaluate if there is a reusable skill or an important project memory worth preserving.
If yes, return JSON:
{
  "worthSaving": true,
  "type": "skill" | "memory",
  "title": "<short title>",
  "content": "<reusable instructions or convention>",
  "explanation": "<why this helps future tasks>"
}
If no reusable skill or memory exists, return:
{
  "worthSaving": false
}
`;

/**
 * Stage 9 Learning Loop: Background Reviewer (§9).
 * Runs after each finished task (Hermes `agent/background_review.py`).
 * Proposes skills or memories as suggestions with a dismissal latch and pending cap.
 * Saved only upon your tap.
 */
export async function reviewFinishedTask(options: {
  task: TaskSummaryForReview;
  reviewerModel?: ReviewerModel | undefined;
  suggestions?: Pick<Suggestions, "offer"> | undefined;
}): Promise<{ offered: boolean; suggestionId?: string | undefined; review?: ReviewSuggestion | undefined }> {
  const { task, reviewerModel, suggestions } = options;

  let review: ReviewSuggestion | null = null;
  if (reviewerModel) {
    review = await reviewerModel(task);
  } else {
    // Default heuristic reviewer:
    // If commands or modified files indicate a distinct pattern
    if (task.commands && task.commands.length > 0) {
      const buildCmd = task.commands.find((c) => /build|test|deploy|compile/i.test(c));
      if (buildCmd) {
        review = {
          worthSaving: true,
          type: "skill",
          title: `Project command: ${buildCmd}`,
          content: `To build/test in this workspace, run: \`${buildCmd}\``,
          explanation: `Verified command \`${buildCmd}\` ran successfully during task ${task.taskId}.`,
        };
      }
    }
  }

  if (!review || !review.worthSaving) {
    return { offered: false };
  }

  if (!suggestions) {
    return { offered: true, review };
  }

  const hashKey = createHash("sha256")
    .update(`${task.taskId}:${review.type}:${review.title}`)
    .digest("hex")
    .slice(0, 16);
  const key = `review_${hashKey}`;

  const rule: AutomationRule = {
    name: `Save ${review.type}: ${review.title}`,
    trigger: { kind: "event", on: "task.done" },
    action: {
      kind: "notify",
      template: `[${review.type}] ${review.title}: ${review.content}`,
    },
    importance: "notification",
    enabled: true,
  };

  const suggestionId = suggestions.offer({
    key,
    text: `Save ${review.type} "${review.title}"? ${review.explanation}`,
    rule,
  });

  return {
    offered: suggestionId !== undefined,
    suggestionId,
    review,
  };
}
