import type { ToolProgress } from "@malves/protocol";

/** Collapse only consecutive, completed routine operations; failures stay visible. */
export function groupOperations(operations: ToolProgress[]): ToolProgress[][] {
  const groups: ToolProgress[][] = [];
  const routine = (op: ToolProgress) =>
    op.status === "completed" && (op.kind === "read" || op.kind === "search");
  for (const op of operations) {
    const previous = groups.at(-1);
    if (routine(op) && previous?.every(routine)) previous.push(op);
    else groups.push([op]);
  }
  return groups;
}
