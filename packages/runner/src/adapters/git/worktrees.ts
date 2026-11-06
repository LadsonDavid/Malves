import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceProvisioner } from "@malves/core";

function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ? stdout.toString() : "",
        stderr: stderr ? stderr.toString() : "",
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

/**
 * Manages git worktrees in sibling directories for isolated multi-agent step execution.
 * Sibling path format: <repo-parent>/<repo-name>-malves/<jobId>-<stepId>
 * Branch naming: malves/<jobId>/<stepId>
 */
export class GitWorktrees implements WorkspaceProvisioner {
  private worktreePath(workspacePath: string, jobId: string, stepId: string): string {
    const parent = path.dirname(workspacePath);
    const repoName = path.basename(workspacePath);
    return path.join(parent, `${repoName}-malves`, `${jobId}-${stepId}`);
  }

  async create(
    workspacePath: string,
    jobId: string,
    stepId: string,
  ): Promise<{ root: string; branch: string }> {
    const branch = `malves/${jobId}/${stepId}`;
    const root = this.worktreePath(workspacePath, jobId, stepId);

    fs.mkdirSync(path.dirname(root), { recursive: true });

    // Remove any stale worktree or branch if lingering
    await git(workspacePath, ["worktree", "remove", "--force", root]);
    await git(workspacePath, ["branch", "-D", branch]);

    const res = await git(workspacePath, ["worktree", "add", "-B", branch, root, "HEAD"]);
    if (res.code !== 0) {
      throw new Error(`Failed to create worktree: ${res.stderr || res.stdout}`);
    }

    return { root, branch };
  }

  async remove(workspacePath: string, jobId: string, stepId: string): Promise<void> {
    const root = this.worktreePath(workspacePath, jobId, stepId);
    const branch = `malves/${jobId}/${stepId}`;

    await git(workspacePath, ["worktree", "remove", "--force", root]);
    await git(workspacePath, ["branch", "-D", branch]);

    try {
      if (fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error on busy locks
    }
  }

  async merge(
    workspacePath: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<{ success: boolean; conflictFiles?: string[] }> {
    const current = (await git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

    const checkout = await git(workspacePath, ["checkout", targetBranch]);
    if (checkout.code !== 0) {
      throw new Error(`Failed to checkout target branch ${targetBranch}: ${checkout.stderr}`);
    }

    const mergeRes = await git(workspacePath, [
      "merge",
      "--no-ff",
      "-m",
      `Merge ${sourceBranch} into ${targetBranch}`,
      sourceBranch,
    ]);

    if (mergeRes.code === 0) {
      if (current && current !== targetBranch) {
        await git(workspacePath, ["checkout", current]);
      }
      return { success: true };
    }

    // Detected conflicts
    const diff = await git(workspacePath, ["diff", "--name-only", "--diff-filter=U"]);
    const conflictFiles = diff.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    await git(workspacePath, ["merge", "--abort"]);
    if (current && current !== targetBranch) {
      await git(workspacePath, ["checkout", current]);
    }

    return { success: false, conflictFiles };
  }

  async cleanup(workspacePath: string, jobId: string): Promise<void> {
    const listRes = await git(workspacePath, ["worktree", "list", "--porcelain"]);
    const lines = listRes.stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const wtPath = line.slice("worktree ".length).trim();
        if (wtPath.includes(`${jobId}-`)) {
          await git(workspacePath, ["worktree", "remove", "--force", wtPath]);
          try {
            if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }
    }

    const branchRes = await git(workspacePath, ["branch", "--list", `malves/${jobId}/*`]);
    const branches = branchRes.stdout
      .split("\n")
      .map((b) => b.replace("*", "").trim())
      .filter(Boolean);

    for (const b of branches) {
      await git(workspacePath, ["branch", "-D", b]);
    }

    const parentFolder = path.join(
      path.dirname(workspacePath),
      `${path.basename(workspacePath)}-malves`,
    );
    try {
      if (fs.existsSync(parentFolder) && fs.readdirSync(parentFolder).length === 0) {
        fs.rmdirSync(parentFolder);
      }
    } catch {
      // ignore
    }
  }
}
