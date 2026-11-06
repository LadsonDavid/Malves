import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Core } from "@malves/core";

/**
 * After a task in a git project, "what did the agent change?" and "commit it?"
 * (point 3: review and approve from the phone, without a remote desktop).
 *
 * Snapshot differences in a shared checkout do not establish authorship.
 * Automatic attribution and commit prompts require an explicitly exclusive
 * task checkout; shared changes must be inspected as workspace changes.
 * Committing is a question like any other: no answer means no commit (R3).
 */
export type ChangedFile = { path: string; added: number; removed: number };

/** Uncommitted files at a moment: repo-relative path → content hash ("" if deleted). */
type Snapshot = Map<string, string>;

const MAX_DIFF_CHARS = 60_000;

export class GitChanges {
  private readonly before = new Map<string, { root: string; snapshot: Snapshot; scope: string }>();
  private readonly changed = new Map<string, { root: string; files: string[] }>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: Core,
    private readonly o: {
      questionTimeoutMs: number;
      /** Snapshot deltas prove authorship only in an exclusively task-owned checkout. */
      exclusiveWorkspace?: (taskId: string, root: string) => boolean;
    },
  ) {
    this.restore();
    // Old releases inferred ownership from shared repository snapshots. Never
    // revive those commit buttons after an upgrade or runner restart.
    for (const question of core.questions.pending()) {
      if (question.kind !== "commit_approval") continue;
      const workspaceId = core.tasks.get(question.task_id)?.workspaceId;
      const workspace = workspaceId ? core.workspaces.get(workspaceId) : undefined;
      const root = workspace ? repoRoot(workspace.path) : undefined;
      if (root && this.o.exclusiveWorkspace?.(question.task_id, root)) continue;
      if (question.choices.some((choice) => choice.id === "leave"))
        core.questions.answer({
          questionId: question.question_id,
          choiceId: "leave",
          commandId: `scope-invalidated-${question.question_id}`,
        });
    }
    this.unsubscribe = core.log.subscribe((event) => {
      // Synchronous on purpose: this runs before the agent is even started.
      if (event.type === "task.created") this.snapshot(event.data.task_id, event.data.workspace_id);
      if (event.type === "task.updated" && event.data.state === "done") {
        void this.finished(event.data.task_id).catch((error: unknown) =>
          this.report(event.data.task_id, error),
        );
      }
      if (
        event.type === "task.updated" &&
        (event.data.state === "failed" || event.data.state === "stopped")
      ) {
        this.before.delete(event.data.task_id);
      }
    });
  }

  close(): void {
    this.unsubscribe();
  }

  /**
   * Earlier tasks' changes, from the log: without this, "open the changes" and
   * "view changes" forgot every task from before the last restart.
   */
  private restore(): void {
    const roots = new Map<string, string | undefined>();
    let after = 0;
    for (;;) {
      const page = this.core.log.since(after, 500);
      for (const event of page) {
        if (event.type !== "task.changes") continue;
        const workspaceId = this.core.tasks.get(event.data.task_id)?.workspaceId;
        const workspace = workspaceId ? this.core.workspaces.get(workspaceId) : undefined;
        if (!workspace) continue;
        if (!roots.has(workspace.path)) roots.set(workspace.path, repoRoot(workspace.path));
        const root = roots.get(workspace.path);
        if (root && this.o.exclusiveWorkspace?.(event.data.task_id, root)) {
          this.changed.set(event.data.task_id, {
            root,
            files: event.data.files.map((f) => f.path),
          });
        }
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return;
      after = last.seq;
    }
  }

  /** The task's changed files (repo-relative) and the repo they're in. */
  files(taskId: string): { root: string; files: string[] } | undefined {
    const known = this.changed.get(taskId);
    return known && { root: known.root, files: [...known.files] };
  }

  /** The task's changes as a diff, for "View changes". */
  diff(taskId: string): string {
    const known = this.changed.get(taskId);
    if (!known) return "No changes recorded for this task.";
    const tracked = known.files.filter((f) => isTracked(known.root, f));
    let text = "";
    try {
      if (tracked.length > 0) text = git(known.root, ["diff", "HEAD", "--", ...tracked]);
    } catch {
      text = "(A project with no commits yet: only new files are shown.)\n";
    }
    for (const file of known.files.filter((f) => !tracked.includes(f))) {
      const full = path.join(known.root, file);
      if (!existsSync(full)) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      text += `\nnew file ${file}\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    }
    return text.length > MAX_DIFF_CHARS
      ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (cut: open it on your computer for the rest)`
      : text || "No changes.";
  }

  private snapshot(taskId: string, workspaceId: string): void {
    const workspace = this.core.workspaces.get(workspaceId);
    if (!workspace) return;
    const root = repoRoot(workspace.path);
    if (!root) return;
    if (!this.o.exclusiveWorkspace?.(taskId, root)) return;
    const scope = path.relative(root, workspace.path) || ".";
    this.before.set(taskId, { root, scope, snapshot: dirty(root, scope) });
  }

  private async finished(taskId: string): Promise<void> {
    const start = this.before.get(taskId);
    this.before.delete(taskId);
    if (!start) return;
    const now = dirty(start.root, start.scope);
    const files = [...now]
      // A dirty file at task start includes pre-existing work, even if this
      // task subsequently changes it. Never include that whole file in a commit.
      .filter(([file]) => !start.snapshot.has(file))
      .map(([f]) => f);
    if (files.length === 0) return;

    const counted = files.map((file) => count(start.root, file));
    this.changed.set(taskId, { root: start.root, files });
    this.core.log.append({ type: "task.changes", data: { task_id: taskId, files: counted } });

    const added = counted.reduce((n, f) => n + f.added, 0);
    const removed = counted.reduce((n, f) => n + f.removed, 0);
    const list = counted.slice(0, 8).map((f) => `${f.path} +${f.added} −${f.removed}`);
    if (counted.length > 8) list.push(`…and ${counted.length - 8} more`);
    const answer = await this.core.questions.ask({
      taskId,
      kind: "commit_approval",
      text: `Commit ${files.length} changed file${files.length === 1 ? "" : "s"} (+${added} −${removed})?\n${list.join("\n")}`,
      choices: [
        { id: "commit", label: "Commit" },
        { id: "leave", label: "Leave uncommitted" },
      ],
      risk: "medium",
      timeoutMs: this.o.questionTimeoutMs,
    });
    if (answer.outcome !== "answered" || answer.choiceId !== "commit") return;
    if (!this.o.exclusiveWorkspace?.(taskId, start.root)) return;
    const latest = dirty(start.root, start.scope);
    if (files.some((file) => latest.get(file) !== now.get(file))) {
      throw new Error("Reviewed files changed while waiting for approval; nothing was committed.");
    }

    const task = this.core.tasks.get(taskId);
    const message = (task?.prompt.split("\n")[0] ?? "Changes by malves").slice(0, 72);
    git(start.root, ["add", "-A", "--", ...files]);
    git(start.root, ["commit", "-m", message, "--", ...files]);
    const commit = git(start.root, ["rev-parse", "--short", "HEAD"]).trim();
    this.core.log.append({ type: "task.committed", data: { task_id: taskId, commit } });
  }

  private report(taskId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.core.log.append({
      type: "error",
      data: { code: "git", message: `Couldn't commit: ${detail.split("\n")[0]}`, task_id: taskId },
    });
  }
}

/** Runs git without a shell. Throws with git's own message on failure. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repoRoot(folder: string): string | undefined {
  try {
    return path.resolve(git(folder, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return undefined; // not a git project: nothing to review or commit
  }
}

/** Every uncommitted file under `scope`, with a hash of what's on disk now. */
function dirty(root: string, scope: string): Snapshot {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", scope]);
  const entries = out.split("\0").filter(Boolean);
  const snapshot: Snapshot = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const file = entry.slice(3);
    // A rename lists the old path next; it is part of the same change.
    if (entry[0] === "R" || entry[0] === "C") i++;
    const full = path.join(root, file);
    snapshot.set(
      file,
      existsSync(full) ? createHash("sha1").update(readFileSync(full)).digest("hex") : "",
    );
  }
  return snapshot;
}

function isTracked(root: string, file: string): boolean {
  try {
    git(root, ["ls-files", "--error-unmatch", "--", file]);
    return true;
  } catch {
    return false;
  }
}

/** Lines added and removed, against the last commit (a new file counts every line). */
function count(root: string, file: string): ChangedFile {
  if (isTracked(root, file)) {
    try {
      const [added, removed] = git(root, ["diff", "--numstat", "HEAD", "--", file]).split("\t");
      return { path: file, added: Number(added) || 0, removed: Number(removed) || 0 };
    } catch {
      return { path: file, added: 0, removed: 0 };
    }
  }
  const full = path.join(root, file);
  const lines = existsSync(full)
    ? readFileSync(full, "utf8").split("\n").filter(Boolean).length
    : 0;
  return { path: file, added: lines, removed: 0 };
}
