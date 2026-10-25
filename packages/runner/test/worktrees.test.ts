import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktrees } from "../src/adapters/git/worktrees.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("GitWorktrees provisioner", () => {
  let tmpDir: string;
  let repoPath: string;
  let provisioner: GitWorktrees;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "malves-worktree-test-"));
    repoPath = path.join(tmpDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });

    git(repoPath, "init", "-b", "main");
    git(repoPath, "config", "user.name", "Malves Test");
    git(repoPath, "config", "user.email", "test@malves.dev");
    git(repoPath, "config", "commit.gpgsign", "false");

    fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
    git(repoPath, "add", "README.md");
    git(repoPath, "commit", "-m", "Initial commit");

    provisioner = new GitWorktrees();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on Windows if busy
    }
  });

  it("creates an isolated worktree and branch for a step", async () => {
    const { root, branch } = await provisioner.create(repoPath, "j1", "step-1");
    expect(branch).toBe("malves/j1/step-1");
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "README.md"))).toBe(true);

    // Modify a file in the worktree
    fs.writeFileSync(path.join(root, "step1.txt"), "hello from step 1");
    git(root, "add", "step1.txt");
    git(root, "commit", "-m", "Step 1 work");

    // Main repo should NOT see step1.txt
    expect(fs.existsSync(path.join(repoPath, "step1.txt"))).toBe(false);

    // Clean up
    await provisioner.remove(repoPath, "j1", "step-1");
    expect(fs.existsSync(root)).toBe(false);
  });

  it("merges changes from step branch into target branch", async () => {
    // Create step 1
    const s1 = await provisioner.create(repoPath, "j2", "step-1");
    fs.writeFileSync(path.join(s1.root, "feature1.txt"), "feature 1");
    git(s1.root, "add", "feature1.txt");
    git(s1.root, "commit", "-m", "Add feature 1");

    // Create integration branch in main repo
    git(repoPath, "branch", "malves/j2/integration", "main");

    const result = await provisioner.merge(repoPath, s1.branch, "malves/j2/integration");
    expect(result.success).toBe(true);

    // Checkout integration to verify
    git(repoPath, "checkout", "malves/j2/integration");
    expect(fs.existsSync(path.join(repoPath, "feature1.txt"))).toBe(true);

    await provisioner.cleanup(repoPath, "j2");
  });

  it("detects conflict files on concurrent overlapping changes", async () => {
    // Step 1 edits README
    const s1 = await provisioner.create(repoPath, "j3", "step-1");
    fs.writeFileSync(path.join(s1.root, "README.md"), "# Version A\n");
    git(s1.root, "add", "README.md");
    git(s1.root, "commit", "-m", "Change to Version A");

    // Step 2 edits README differently
    const s2 = await provisioner.create(repoPath, "j3", "step-2");
    fs.writeFileSync(path.join(s2.root, "README.md"), "# Version B\n");
    git(s2.root, "add", "README.md");
    git(s2.root, "commit", "-m", "Change to Version B");

    // Create integration branch from main
    git(repoPath, "branch", "malves/j3/integration", "main");

    // Merge s1 first
    const m1 = await provisioner.merge(repoPath, s1.branch, "malves/j3/integration");
    expect(m1.success).toBe(true);

    // Merge s2 into integration -> conflict on README.md
    const m2 = await provisioner.merge(repoPath, s2.branch, "malves/j3/integration");
    expect(m2.success).toBe(false);
    expect(m2.conflictFiles).toBeDefined();
    expect(m2.conflictFiles).toContain("README.md");

    await provisioner.cleanup(repoPath, "j3");
  });
});
