import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sessionChanges } from "../src/adapters/sessions/changes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "malves-session-review-"));
  dirs.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(root, "app"));
  for (const file of ["app/a.txt", "app/staged.txt", "outside.txt", "app/.env", "app/ladson.md"])
    writeFileSync(path.join(root, file), "before\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return { root, git };
}

it("reviews staged and unstaged workspace edits, excludes secrets and siblings, and never changes the index", async () => {
  const { root, git } = repo();
  for (const file of ["app/a.txt", "app/staged.txt", "outside.txt", "app/.env", "app/ladson.md"])
    writeFileSync(path.join(root, file), `changed-${path.basename(file)}\n`);
  git("add", "app/staged.txt");
  writeFileSync(path.join(root, "app/new.txt"), "untracked-content\n");
  const index = readFileSync(path.join(root, ".git/index"));
  const result = await sessionChanges(path.join(root, "app"));
  expect(result).toContain("+changed-a.txt");
  expect(result).toContain("+changed-staged.txt");
  expect(result).not.toContain("changed-outside");
  expect(result).not.toContain("changed-.env");
  expect(result).not.toContain("changed-ladson");
  expect(result).not.toContain("untracked-content");
  expect(result).toContain("untracked");
  expect(result).toContain("not attributed");
  expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
});

it("reports a clean folder and refuses non-repositories", async () => {
  const { root } = repo();
  expect(await sessionChanges(root)).toContain("No tracked changes");
  const other = mkdtempSync(path.join(tmpdir(), "malves-no-git-"));
  dirs.push(other);
  await expect(sessionChanges(other)).rejects.toThrow(/Git repository/);
});

it("bounds large reviews and treats glob-like filenames literally", async () => {
  const { root, git } = repo();
  writeFileSync(path.join(root, "app/[x].txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "literal filename");
  writeFileSync(path.join(root, "app/[x].txt"), "literal-change\n");
  expect(await sessionChanges(path.join(root, "app"))).toContain("+literal-change");
  writeFileSync(path.join(root, "app/a.txt"), "long-line\n".repeat(10000));
  const result = await sessionChanges(root);
  expect(result.length).toBeLessThan(61000);
  expect(result).toContain("Review truncated");
});

it("labels the staged-only review for a repository without its first commit", async () => {
  const { root, git } = repo();
  git("checkout", "--orphan", "unborn");
  const result = await sessionChanges(root);
  expect(result).toContain("No commits yet: showing staged changes only");
  expect(result).toContain("+before");
  expect(result).not.toContain("diff --git a/app/.env");
});
