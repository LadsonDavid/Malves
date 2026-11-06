import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/log.js";
import { Jobs } from "../src/jobs/jobs.js";
import type {
  AgentEnd,
  JobVerifier,
  PullRequestOpener,
  WorkspaceProvisioner,
} from "../src/ports.js";
import { Questions } from "../src/questions/questions.js";
import { Tasks } from "../src/tasks/tasks.js";
import { Workspaces } from "../src/workspaces/workspaces.js";

class MemoryStore {
  private events: any[] = [];
  append(body: any, at: number) {
    const event = { ...body, seq: this.events.length + 1, at };
    this.events.push(event);
    return event;
  }
  since(after: number, limit: number) {
    return this.events.filter((e) => e.seq > after).slice(0, limit);
  }
}

class FakeProvisioner implements WorkspaceProvisioner {
  created: Array<{ jobId: string; stepId: string }> = [];
  removed: Array<{ jobId: string; stepId: string }> = [];
  merged: Array<{ source: string; target: string }> = [];
  cleaned: string[] = [];
  /** Worktrees (by step) a test marks as having uncommitted changes. */
  changedSteps = new Set<string>();
  async hasChanges(worktree: string) {
    return [...this.changedSteps].some((step) => worktree.endsWith(`/${step}`));
  }

  async create(_ws: string, jobId: string, stepId: string) {
    this.created.push({ jobId, stepId });
    return { root: `/mock/${jobId}/${stepId}`, branch: `malves/${jobId}/${stepId}` };
  }
  async remove(_ws: string, jobId: string, stepId: string) {
    this.removed.push({ jobId, stepId });
  }
  async merge(_ws: string, sourceBranch: string, targetBranch: string) {
    this.merged.push({ source: sourceBranch, target: targetBranch });
    return { success: true };
  }
  async cleanup(_ws: string, jobId: string) {
    this.cleaned.push(jobId);
  }
}

class FakeHost {
  sessions = new Map<
    string,
    { finished: Promise<AgentEnd>; resolve: (end: AgentEnd) => void; callbacks: any }
  >();

  start(run: any, callbacks: any) {
    let resolve!: (end: AgentEnd) => void;
    const finished = new Promise<AgentEnd>((r) => {
      resolve = r;
    });
    this.sessions.set(run.taskId, { finished, resolve, callbacks });
    return {
      finished,
      cancel: async () => {},
    };
  }

  completeTask(taskId: string, result = "done") {
    const s = this.sessions.get(taskId);
    if (s) {
      s.callbacks.output(result);
      s.resolve("completed");
    }
  }

  failTask(taskId: string, error = "failed") {
    const s = this.sessions.get(taskId);
    if (s) {
      s.callbacks.output(error);
      s.resolve("refused");
    }
  }
}

describe("Jobs orchestrator", () => {
  let log: EventLog;
  let workspaces: Workspaces;
  let questions: Questions;
  let tasks: Tasks;
  let host: FakeHost;
  let provisioner: FakeProvisioner;
  let verifier: JobVerifier;
  let prOpener: PullRequestOpener;
  let jobs: Jobs;
  const now = 1000;
  let seq = 0;

  const ids = { next: (prefix: string) => `${prefix}-${++seq}` };
  const clock = { now: () => now, schedule: (_ms: number, fn: () => void) => () => {} };
  const notifier = { questionOpened: async () => {}, questionReminder: async () => {} };

  beforeEach(() => {
    const store = new MemoryStore();
    log = new EventLog(store, clock);
    workspaces = new Workspaces(log, ids);
    questions = new Questions(log, clock, ids, notifier);
    host = new FakeHost();
    tasks = new Tasks({
      log,
      clock,
      ids,
      questions,
      workspaces,
      host: host as any,
      agents: new Map([["claude", "claude"] as any, ["codex", "codex"] as any]),
      questionTimeoutMs: 60_000,
    });
    provisioner = new FakeProvisioner();
    verifier = { verify: async () => ({ passed: true, output: "All tests green" }) };
    prOpener = { createPr: async () => ({ url: "https://github.com/org/repo/pull/42" }) };

    workspaces.register("repo", path.resolve("test-workspaces", "repo"));

    jobs = new Jobs({
      log,
      clock,
      ids,
      tasks,
      workspaces,
      questions,
      provisioner,
      verifier,
      prOpener,
      availableAgents: ["claude"],
      maxConcurrentSteps: 2,
    });
  });

  it("plans a job, approves it, runs steps in topological order, and completes", async () => {
    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
      {
        id: "s2",
        role: "implementer" as const,
        agent: "claude",
        prompt: "Step 2",
        depends_on: ["s1"],
      },
    ];

    const jobId = jobs.create({
      workspaceId: ws.id,
      goal: "Build feature",
      plan,
    });

    const job = jobs.get(jobId);
    expect(job).toBeDefined();
    expect(job?.state).toBe("awaiting_plan");

    // Approve job
    await jobs.approve(jobId);
    expect(jobs.get(jobId)?.state).toBe("running");

    // s1 should have started (s2 must wait for s1)
    expect(provisioner.created).toHaveLength(1);
    expect(provisioner.created[0]!.stepId).toBe("s1");
    const s1TaskId = jobs.get(jobId)?.plan.find((s) => s.id === "s1")?.task_id;
    expect(s1TaskId).toBeDefined();

    // Complete s1
    host.completeTask(s1TaskId!, "step 1 finished");
    await new Promise((r) => setTimeout(r, 10));

    // Now s2 should start
    expect(provisioner.created).toHaveLength(2);
    expect(provisioner.created[1]!.stepId).toBe("s2");
    const s2TaskId = jobs.get(jobId)?.plan.find((s) => s.id === "s2")?.task_id;
    expect(s2TaskId).toBeDefined();

    // Complete s2
    host.completeTask(s2TaskId!, "step 2 finished");
    await new Promise((r) => setTimeout(r, 10));

    // Both steps done -> verifies -> merges -> awaits PR
    const updated = jobs.get(jobId);
    expect(updated?.state).toBe("awaiting_pr");

    // Approve PR
    await jobs.approvePr(jobId);

    const finished = jobs.get(jobId);
    expect(finished?.state).toBe("done");
    expect(finished?.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(provisioner.cleaned).toContain(jobId);
  });

  it("respects concurrency limits on independent steps", async () => {
    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "S1", depends_on: [] },
      { id: "s2", role: "implementer" as const, agent: "claude", prompt: "S2", depends_on: [] },
      { id: "s3", role: "implementer" as const, agent: "claude", prompt: "S3", depends_on: [] },
    ];

    const jobId = jobs.create({
      workspaceId: ws.id,
      goal: "Parallel features",
      plan,
    });

    await jobs.approve(jobId);

    // Max concurrency is 2, so only 2 steps start initially
    expect(provisioner.created).toHaveLength(2);

    // Complete one step
    const s1Task = jobs.get(jobId)?.plan.find((s) => s.id === "s1")?.task_id;
    if (!s1Task) throw new Error("Expected the first step to have a task");
    host.completeTask(s1Task);
    await new Promise((r) => setTimeout(r, 10));

    // The 3rd step should now have started
    expect(provisioner.created).toHaveLength(3);
  });

  it("triggers reflection loop when verification fails up to twice", async () => {
    let verifyCount = 0;
    verifier.verify = async () => {
      verifyCount++;
      return { passed: verifyCount >= 2, output: verifyCount === 1 ? "Tests failed" : "All green" };
    };

    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
    ];

    const jobId = jobs.create({ workspaceId: ws.id, goal: "Fix bug", plan });
    await jobs.approve(jobId);

    // First run of s1
    const task1 = jobs.get(jobId)!.plan[0]!.task_id!;
    host.completeTask(task1);
    await new Promise((r) => setTimeout(r, 10));

    // Verifier failed once -> reflected back to implementer!
    const updated = jobs.get(jobId);
    expect(updated?.returnCount).toBe(1);
    expect(updated?.state).toBe("running");

    // Complete reflected task
    const task2 = updated!.plan[0]!.task_id!;
    host.completeTask(task2);
    await new Promise((r) => setTimeout(r, 10));

    // 2nd verify passes -> awaiting PR
    expect(jobs.get(jobId)?.state).toBe("awaiting_pr");
  });

  it("retries a failed step once, and fails the job if retry fails", async () => {
    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
    ];

    const jobId = jobs.create({ workspaceId: ws.id, goal: "Unstable task", plan });
    await jobs.approve(jobId);

    const task1 = jobs.get(jobId)!.plan[0]!.task_id!;
    // Fail first time
    host.failTask(task1, "Compilation error");
    await new Promise((r) => setTimeout(r, 10));

    // Step should be retried: still running with a new task!
    const retriedJob = jobs.get(jobId);
    expect(retriedJob?.state).toBe("running");
    const task2 = retriedJob!.plan[0]!.task_id!;
    expect(task2).toBeDefined();

    // Fail second time -> exhausted retries -> job fails
    host.failTask(task2, "Compilation error again");
    await new Promise((r) => setTimeout(r, 10));

    const failedJob = jobs.get(jobId);
    expect(failedJob?.state).toBe("failed");
    expect(failedJob!.plan[0]!.state).toBe("failed");
  });

  it("stops running tasks when job is stopped", async () => {
    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
    ];

    const jobId = jobs.create({ workspaceId: ws.id, goal: "Cancel me", plan });
    await jobs.approve(jobId);

    const task1 = jobs.get(jobId)!.plan[0]!.task_id!;
    expect(tasks.get(task1)?.state).toBe("running");

    await jobs.stop(jobId, "User cancelled");
    expect(jobs.get(jobId)?.state).toBe("stopped");
    expect(tasks.get(task1)?.state).toBe("stopped");
    expect(provisioner.cleaned).toContain(jobId);
  });

  it("handles merge conflict during integration", async () => {
    provisioner.merge = async () => ({ success: false, conflictFiles: ["index.ts"] });

    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
    ];

    const jobId = jobs.create({ workspaceId: ws.id, goal: "Conflict task", plan });
    await jobs.approve(jobId);

    const task1 = jobs.get(jobId)!.plan[0]!.task_id!;
    host.completeTask(task1);
    await new Promise((r) => setTimeout(r, 10));

    const job = jobs.get(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.reason).toContain("Merge conflict on integration: index.ts");
  });

  it("marks running steps as failed on recover", async () => {
    const ws = workspaces.list()[0]!;
    const plan = [
      { id: "s1", role: "implementer" as const, agent: "claude", prompt: "Step 1", depends_on: [] },
    ];

    const jobId = jobs.create({ workspaceId: ws.id, goal: "Restart task", plan });
    await jobs.approve(jobId);

    // Call recover directly (simulating runner restart before task finishes)
    jobs.recover();
    const job = jobs.get(jobId);
    expect(job!.plan[0]!.state).toBe("failed");
  });

  describe("a team: reviewer, owned paths and budget", () => {
    const step = (id: string, role: string, agent: string, extra: object = {}) => ({
      id,
      role: role as "implementer",
      agent,
      prompt: `Do ${id}`,
      depends_on: [] as string[],
      ...extra,
    });
    const team = (): Jobs =>
      new Jobs({
        log,
        clock,
        ids,
        tasks,
        workspaces,
        questions,
        provisioner,
        verifier,
        prOpener,
        availableAgents: ["claude", "codex"],
        maxConcurrentSteps: 2,
      });
    const taskOf = (id: string, stepId: string) =>
      tasks.get(jobsRef(id).plan.find((p) => p.id === stepId)?.task_id ?? "");
    let jobsRef: (id: string) => ReturnType<Jobs["get"]> & object;
    const settle = () => new Promise((r) => setTimeout(r, 10));

    it("refuses a reviewer that is the same agent as the implementer it checks", () => {
      const ws = workspaces.list()[0]!;
      const t = team();
      expect(() =>
        t.create({
          workspaceId: ws.id,
          goal: "g",
          plan: [
            step("a", "implementer", "claude"),
            step("r", "reviewer", "claude", { depends_on: ["a"] }),
          ],
        }),
      ).toThrow(/different agent/);
      expect(() =>
        t.create({
          workspaceId: ws.id,
          goal: "g",
          plan: [
            step("a", "implementer", "claude"),
            step("r", "reviewer", "codex", { depends_on: ["a"] }),
          ],
        }),
      ).not.toThrow();
    });

    it("refuses parallel steps that own the same path, but not ordered ones", () => {
      const ws = workspaces.list()[0]!;
      const t = team();
      const make = (a: object, b: object) =>
        t.create({
          workspaceId: ws.id,
          goal: "g",
          plan: [step("a", "implementer", "claude", a), step("b", "implementer", "codex", b)],
        });
      expect(() => make({ owns: ["src/api/"] }, { owns: ["src/api/users.ts"] })).toThrow(
        /both own/,
      );
      expect(() => make({ owns: ["src/api"] }, { owns: ["src/ui"] })).not.toThrow();
      expect(() =>
        make({ owns: ["src/api"] }, { owns: ["src/api"], depends_on: ["a"] }),
      ).not.toThrow();
    });

    it("sends work back when the reviewer asks for changes, then passes it", async () => {
      const ws = workspaces.list()[0]!;
      const t = team();
      jobsRef = (id) => t.get(id)!;
      const id = t.create({
        workspaceId: ws.id,
        goal: "g",
        plan: [
          step("a", "implementer", "claude"),
          step("r", "reviewer", "codex", { depends_on: ["a"] }),
        ],
      });
      await t.approve(id);
      host.completeTask(taskOf(id, "a")!.id, "built the feature");
      await settle();

      // The reviewer starts with its rules and the branch it must check.
      const first = taskOf(id, "r")!;
      expect(first.prompt).toContain("You are the REVIEWER");
      expect(first.prompt).toContain(`malves/${id}/a`);
      host.completeTask(first.id, "CHANGES REQUESTED\nmissing a null check in users.ts");
      await settle();

      // The implementer runs again with the review notes.
      const again = taskOf(id, "a")!;
      expect(again.prompt).toContain("[REVIEW, round 1/2]");
      expect(again.prompt).toContain("missing a null check");
      host.completeTask(again.id, "fixed");
      await settle();
      host.completeTask(taskOf(id, "r")!.id, "APPROVED\nlooks right");
      await settle();
      expect(t.get(id)?.state).toBe("awaiting_pr");
    });

    it("stops and asks after two rounds of changes", async () => {
      const ws = workspaces.list()[0]!;
      const t = team();
      jobsRef = (id) => t.get(id)!;
      const id = t.create({
        workspaceId: ws.id,
        goal: "g",
        plan: [
          step("a", "implementer", "claude"),
          step("r", "reviewer", "codex", { depends_on: ["a"] }),
        ],
      });
      await t.approve(id);
      for (let round = 0; round < 3; round++) {
        host.completeTask(taskOf(id, "a")!.id, "attempt");
        await settle();
        host.completeTask(taskOf(id, "r")!.id, "CHANGES REQUESTED\nstill wrong");
        await settle();
      }
      const job = t.get(id);
      expect(job?.state).toBe("failed");
      expect(job?.reason).toContain("still asks for changes after 2 rounds");
    });

    it("fails the job when a reviewer left changes in its worktree", async () => {
      const ws = workspaces.list()[0]!;
      const t = team();
      jobsRef = (id) => t.get(id)!;
      const id = t.create({
        workspaceId: ws.id,
        goal: "g",
        plan: [
          step("a", "implementer", "claude"),
          step("r", "reviewer", "codex", { depends_on: ["a"] }),
        ],
      });
      await t.approve(id);
      host.completeTask(taskOf(id, "a")!.id, "done");
      await settle();
      provisioner.changedSteps.add("r");
      host.completeTask(taskOf(id, "r")!.id, "APPROVED");
      await settle();
      expect(t.get(id)?.state).toBe("failed");
      expect(t.get(id)?.reason).toContain("must never do");
    });
  });
});
