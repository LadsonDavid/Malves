import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentHost, command, createCore } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GitChanges } from "../src/adapters/git/changes.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * "What did the agent change?" and "Commit it?" against a real git repo. The
 * agent is a stand-in that writes malves-demo.txt, like the demo agent.
 */
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

function setup({ repo = true } = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-git-")));
  const site = path.join(dir, "site");
  mkdirSync(site);
  writeFileSync(path.join(site, "user.txt"), "v1\n");
  if (repo) {
    git(site, "init", "-q");
    git(site, "config", "core.autocrlf", "false");
    git(site, "config", "user.name", "Test");
    git(site, "config", "user.email", "test@example.com");
    git(site, "add", "-A");
    git(site, "commit", "-q", "-m", "first");
    // The user's own edit, made before the task: never the agent's, never committed.
    writeFileSync(path.join(site, "user.txt"), "v2, my own edit\n");
  }
  const store = new SqliteStore(path.join(dir, "malves.db"));
  const host: AgentHost = {
    start: (run) => ({
      finished: (async () => {
        const file = path.join(run.workspaceRoot, "malves-demo.txt");
        writeFileSync(file, "Written by the malves demo agent.\nTask: x\n");
        return "completed" as const;
      })(),
      cancel: async () => {},
    }),
  };
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: { questionOpened: async () => {} },
    host,
    agents: new Map([["demo", command("x")]]),
    questionTimeoutMs: 10_000,
  });
  const changes = new GitChanges(core, { questionTimeoutMs: 10_000 });
  const runner = { ...core, diff: (id: string) => changes.diff(id) };
  cleanup.push(() => {
    changes.close();
    core.questions.shutdown();
    store.close();
  });
  const ws = runner.workspaces.register("site", site);
  const events: LoggedEvent[] = [];
  runner.log.subscribe((e) => events.push(e));
  return { runner, site, ws, events };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Runs the stand-in agent; resolves once it's done. */
async function runTask(s: ReturnType<typeof setup>) {
  const id = s.runner.tasks.create({
    workspaceId: s.ws.id,
    agent: "demo",
    prompt: "Add the demo file",
  });
  await s.runner.tasks.whenFinished(id);
  return id;
}

const commitQuestion = (s: ReturnType<typeof setup>) =>
  s.runner.questions.pending().find((q) => q.kind === "commit_approval");

describe("view changes and commit", () => {
  it("shows only the agent's files, and commits only those when you approve", async () => {
    const s = setup();
    const id = await runTask(s);
    await waitFor(() => commitQuestion(s) !== undefined, "the commit question");

    const changes = s.events.find((e) => e.type === "task.changes");
    expect(changes?.type === "task.changes" && changes.data.files).toEqual([
      { path: "site/malves-demo.txt".slice(5), added: 2, removed: 0 },
    ]);
    expect(commitQuestion(s)?.text).toBe("Commit 1 changed file (+2 −0)?\nmalves-demo.txt +2 −0");
    expect(s.runner.diff(id)).toContain("+Written by the malves demo agent.");

    const q = commitQuestion(s);
    s.runner.questions.answer({
      questionId: q?.question_id ?? "",
      choiceId: "commit",
      commandId: "c",
    });
    await waitFor(() => s.events.some((e) => e.type === "task.committed"), "the commit");

    expect(git(s.site, "log", "-1", "--format=%s")).toBe("Add the demo file\n");
    expect(git(s.site, "show", "--name-only", "--format=", "HEAD").trim()).toBe("malves-demo.txt");
    // The user's own edit is still there, uncommitted.
    expect(git(s.site, "status", "--porcelain")).toBe(" M user.txt\n");
    expect(readFileSync(path.join(s.site, "user.txt"), "utf8")).toBe("v2, my own edit\n");
  }, 30_000);

  it("still knows a task's changes after a restart", async () => {
    const s = setup();
    const id = await runTask(s);
    await waitFor(() => s.events.some((e) => e.type === "task.changes"), "the changes");
    // A fresh tracker on the same log, as after restarting malves serve.
    const again = new GitChanges(s.runner, { questionTimeoutMs: 10_000 });
    cleanup.push(() => again.close());
    expect(again.files(id)?.files).toEqual(["malves-demo.txt"]);
    expect(again.diff(id)).toContain("+Written by the malves demo agent.");
  }, 30_000);

  it("'Leave uncommitted' commits nothing", async () => {
    const s = setup();
    await runTask(s);
    await waitFor(() => commitQuestion(s) !== undefined, "the commit question");
    const q = commitQuestion(s);
    s.runner.questions.answer({
      questionId: q?.question_id ?? "",
      choiceId: "leave",
      commandId: "c",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(git(s.site, "log", "--format=%s").trim()).toBe("first");
    expect(s.events.some((e) => e.type === "task.committed")).toBe(false);
  }, 30_000);

  it("a project that isn't a git repo: nothing to review, nothing asked", async () => {
    const s = setup({ repo: false });
    await runTask(s);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.events.some((e) => e.type === "task.changes")).toBe(false);
    expect(commitQuestion(s)).toBeUndefined();
  }, 30_000);
});
