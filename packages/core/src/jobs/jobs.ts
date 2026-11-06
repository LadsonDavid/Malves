import {
  type JobId,
  type JobState,
  type JobStep,
  type JobStepInput,
  type StepState,
  TERMINAL_STATES,
} from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Clock, Ids, JobVerifier, PullRequestOpener, WorkspaceProvisioner } from "../ports.js";
import type { Questions } from "../questions/questions.js";
import type { Task, Tasks } from "../tasks/tasks.js";
import type { Workspaces } from "../workspaces/workspaces.js";
import { validatePlan } from "./planner.js";

export type Job = {
  id: string;
  goal: string;
  workspaceId: string;
  state: JobState;
  plan: JobStep[];
  returnCount: number;
  /** How many times a reviewer has sent the work back. */
  reviewRounds: number;
  prUrl?: string | undefined;
  reason?: string | undefined;
};

export type JobsOptions = {
  log: EventLog;
  clock: Clock;
  ids: Ids;
  tasks: Tasks;
  workspaces: Workspaces;
  questions: Questions;
  provisioner: WorkspaceProvisioner;
  verifier: JobVerifier;
  prOpener: PullRequestOpener;
  availableAgents: string[];
  maxConcurrentSteps?: number | undefined;
};

/** A reviewer may send the work back this many times before the job stops and asks. */
export const MAX_REVIEW_ROUNDS = 2;
/** Step runs allowed in one job (retries and re-runs included): a loop can't spend without end. */
export const MAX_STEP_RUNS = 12;

const REVIEWER_RULES = [
  "You are the REVIEWER. You must not edit, create or delete any file, and you must not commit.",
  "Look at the work with git (for example: git diff HEAD...<branch>) and run read-only checks.",
  "Your reply must start with exactly APPROVED or CHANGES REQUESTED on its own line, then your reasons: file, line, what is wrong.",
].join("\n");

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly taskToStep = new Map<string, { jobId: string; stepId: string }>();
  private readonly maxConcurrentSteps: number;
  private readonly stepRetries = new Map<string, number>();
  private readonly stepRuns = new Map<string, number>();

  constructor(private readonly o: JobsOptions) {
    this.maxConcurrentSteps = o.maxConcurrentSteps ?? 3;
    this.o.log.subscribe((event) => {
      switch (event.type) {
        case "job.created": {
          this.jobs.set(event.data.job_id, {
            id: event.data.job_id,
            goal: event.data.goal,
            workspaceId: event.data.workspace_id,
            state: "planning",
            plan: [],
            returnCount: 0,
            reviewRounds: 0,
          });
          break;
        }
        case "job.planned": {
          const job = this.jobs.get(event.data.job_id);
          if (job) {
            job.plan = event.data.plan.map((s) => ({ ...s }));
            job.state = "awaiting_plan";
          }
          break;
        }
        case "job.approved": {
          const job = this.jobs.get(event.data.job_id);
          if (job) job.state = "running";
          break;
        }
        case "job.step.updated": {
          const job = this.jobs.get(event.data.job_id);
          const step = job?.plan.find((s) => s.id === event.data.step_id);
          if (step) {
            step.state = event.data.state;
            if (event.data.task_id) step.task_id = event.data.task_id;
            if (event.data.branch) step.branch = event.data.branch;
            if (event.data.worktree) step.worktree = event.data.worktree;
            if (event.data.summary) step.summary = event.data.summary;
          }
          break;
        }
        case "job.verified": {
          const job = this.jobs.get(event.data.job_id);
          if (job) {
            job.returnCount = event.data.return_count;
            if (event.data.passed) {
              job.state = "awaiting_pr";
            }
          }
          break;
        }
        case "job.finished": {
          const job = this.jobs.get(event.data.job_id);
          if (job) {
            job.state = event.data.state;
            if (event.data.pr_url) job.prUrl = event.data.pr_url;
            if (event.data.reason) job.reason = event.data.reason;
          }
          break;
        }
        case "task.updated": {
          if (TERMINAL_STATES.includes(event.data.state)) {
            void this.onTaskEnded(
              event.data.task_id,
              event.data.state as "done" | "failed" | "stopped",
            );
          }
          break;
        }
      }
    });
  }

  create(input: {
    workspaceId: string;
    goal: string;
    plan: Array<JobStep | JobStepInput>;
  }): string {
    const ws = this.o.workspaces.get(input.workspaceId);
    if (!ws) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const validated = validatePlan(input.plan, this.o.availableAgents);

    const jobId = this.o.ids.next("job");
    this.o.log.append({
      type: "job.created",
      data: { job_id: jobId, goal: input.goal, workspace_id: ws.id },
    });
    this.o.log.append({
      type: "job.planned",
      data: { job_id: jobId, plan: validated },
    });

    return jobId;
  }

  async approve(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.state !== "awaiting_plan") return;

    this.o.log.append({
      type: "job.approved",
      data: { job_id: jobId },
    });

    await this.advance(jobId);
  }

  async approvePr(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.state !== "awaiting_pr") return;

    const ws = this.o.workspaces.get(job.workspaceId);
    if (!ws) throw new Error(`Unknown workspace: ${job.workspaceId}`);

    const integrationBranch = `malves/${jobId}/integration`;
    const res = await this.o.prOpener.createPr(
      ws.path,
      integrationBranch,
      job.goal,
      `Job completed by Malves: ${job.goal}\n\nSteps:\n${job.plan.map((s) => `- [x] ${s.prompt}`).join("\n")}`,
    );

    await this.o.provisioner.cleanup(ws.path, jobId);

    this.o.log.append({
      type: "job.finished",
      data: { job_id: jobId, state: "done", pr_url: res.url },
    });
  }

  async stop(jobId: string, reason = "Stopped by user"): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state === "done" || job.state === "failed" || job.state === "stopped") return;

    for (const step of job.plan) {
      if (step.task_id && step.state === "running") {
        await this.o.tasks.stop(step.task_id, reason);
      }
    }

    const ws = this.o.workspaces.get(job.workspaceId);
    if (ws) {
      await this.o.provisioner.cleanup(ws.path, jobId).catch(() => {});
    }

    this.o.log.append({
      type: "job.finished",
      data: { job_id: jobId, state: "stopped", reason },
    });
  }

  get(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job, plan: job.plan.map((s) => ({ ...s })) } : undefined;
  }

  list(): Job[] {
    return [...this.jobs.values()].map((j) => ({ ...j, plan: j.plan.map((s) => ({ ...s })) }));
  }

  recover(): void {
    for (const job of this.jobs.values()) {
      if (job.state === "running" || job.state === "verifying") {
        for (const step of job.plan) {
          if (step.state === "running") {
            step.state = "failed";
          }
        }
      }
    }
  }

  private async advance(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "running") return;

    const ws = this.o.workspaces.get(job.workspaceId);
    if (!ws) return;

    const doneIds = new Set(job.plan.filter((s) => s.state === "done").map((s) => s.id));
    const runningCount = job.plan.filter((s) => s.state === "running").length;

    if (doneIds.size === job.plan.length) {
      await this.runVerification(jobId);
      return;
    }

    let slots = this.maxConcurrentSteps - runningCount;
    if (slots <= 0) return;

    for (const step of job.plan) {
      if (slots <= 0) break;
      if (step.state !== "pending") continue;

      const depsMet = step.depends_on.every((d) => doneIds.has(d));
      if (!depsMet) continue;

      const runs = (this.stepRuns.get(jobId) ?? 0) + 1;
      if (runs > MAX_STEP_RUNS) {
        this.o.log.append({
          type: "job.finished",
          data: {
            job_id: jobId,
            state: "failed",
            reason: `Stopped: this job used its ${MAX_STEP_RUNS} step runs. Look at the branches and decide.`,
          },
        });
        return;
      }
      this.stepRuns.set(jobId, runs);
      step.state = "running";
      slots--;

      const { root, branch } = await this.o.provisioner.create(ws.path, jobId, step.id);
      step.branch = branch;
      step.worktree = root;

      const taskId = this.o.tasks.create({
        workspaceId: job.workspaceId,
        agent: step.agent,
        prompt: this.promptFor(job, step),
        root,
      });
      step.task_id = taskId;
      this.taskToStep.set(taskId, { jobId, stepId: step.id });

      this.o.log.append({
        type: "job.step.updated",
        data: {
          job_id: jobId,
          step_id: step.id,
          state: "running",
          task_id: taskId,
          branch,
          worktree: root,
        },
      });
    }
  }

  private async onTaskEnded(taskId: string, state: "done" | "failed" | "stopped"): Promise<void> {
    const binding = this.taskToStep.get(taskId);
    if (!binding) return;
    this.taskToStep.delete(taskId);

    const { jobId, stepId } = binding;
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "running") return;

    const step = job.plan.find((s) => s.id === stepId);
    if (!step) return;

    if (state === "done") {
      const task = this.o.tasks.get(taskId);
      step.state = "done";
      step.summary = task?.result ?? "Completed";
      if (step.role === "reviewer" && (await this.reviewOutcome(job, step))) return;
      this.o.log.append({
        type: "job.step.updated",
        data: {
          job_id: jobId,
          step_id: stepId,
          state: "done",
          summary: step.summary,
        },
      });
      await this.advance(jobId);
    } else {
      const retries = this.stepRetries.get(stepId) ?? 0;
      if (retries < 1 && state === "failed") {
        this.stepRetries.set(stepId, retries + 1);
        step.state = "pending";
        await this.advance(jobId);
      } else {
        step.state = "failed";
        this.o.log.append({
          type: "job.step.updated",
          data: { job_id: jobId, step_id: stepId, state: "failed" },
        });
        this.o.log.append({
          type: "job.finished",
          data: { job_id: jobId, state: "failed", reason: `Step "${step.id}" failed` },
        });
      }
    }
  }

  /** What a step is told. A reviewer gets its rules and the branches it must check. */
  private promptFor(job: Job, step: JobStep): string {
    if (step.role !== "reviewer") return step.prompt;
    const checked = step.depends_on
      .map((id) => job.plan.find((s) => s.id === id))
      .filter((s): s is JobStep => s !== undefined && s.branch !== undefined)
      .map((s) => `- branch ${s.branch}: ${(s.summary ?? "").slice(0, 600)}`);
    return [
      REVIEWER_RULES,
      checked.length ? `Work to review:\n${checked.join("\n")}` : "",
      step.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * After a reviewer finishes: it must have left no changes, and if it asked
   * for changes the implementers it checked run again with its notes, up to
   * MAX_REVIEW_ROUNDS times. Returns true when it handled the step (the job
   * went back, or stopped), false when the review passed.
   */
  private async reviewOutcome(job: Job, step: JobStep): Promise<boolean> {
    if (step.worktree && this.o.provisioner.hasChanges) {
      const changed = await this.o.provisioner.hasChanges(step.worktree).catch(() => false);
      if (changed) {
        this.finishFailed(
          job,
          `Reviewer "${step.id}" changed files, which a reviewer must never do`,
        );
        return true;
      }
    }
    if (!/^\s*CHANGES REQUESTED/i.test(step.summary ?? "")) return false;
    job.reviewRounds++;
    if (job.reviewRounds > MAX_REVIEW_ROUNDS) {
      this.finishFailed(
        job,
        `The reviewer still asks for changes after ${MAX_REVIEW_ROUNDS} rounds. Look at the branches yourself.`,
      );
      return true;
    }
    const notes = `\n\n[REVIEW, round ${job.reviewRounds}/${MAX_REVIEW_ROUNDS}] The reviewer asked for changes:\n${(step.summary ?? "").slice(0, 3000)}`;
    for (const id of step.depends_on) {
      const implementer = job.plan.find((s) => s.id === id && s.role === "implementer");
      if (!implementer) continue;
      implementer.state = "pending";
      implementer.prompt += notes;
      this.o.log.append({
        type: "job.step.updated",
        data: { job_id: job.id, step_id: implementer.id, state: "pending" },
      });
    }
    step.state = "pending";
    this.o.log.append({
      type: "job.step.updated",
      data: { job_id: job.id, step_id: step.id, state: "pending" },
    });
    await this.advance(job.id);
    return true;
  }

  private finishFailed(job: Job, reason: string): void {
    this.o.log.append({
      type: "job.finished",
      data: { job_id: job.id, state: "failed", reason },
    });
  }

  private async runVerification(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const ws = this.o.workspaces.get(job.workspaceId);
    if (!ws) return;

    job.state = "verifying";

    // Merge all steps into integration branch
    const integrationBranch = `malves/${jobId}/integration`;
    for (const step of job.plan) {
      if (step.branch) {
        const mergeRes = await this.o.provisioner.merge(ws.path, step.branch, integrationBranch);
        if (!mergeRes.success) {
          // Merge conflict
          this.o.log.append({
            type: "job.finished",
            data: {
              job_id: jobId,
              state: "failed",
              reason: `Merge conflict on integration: ${mergeRes.conflictFiles?.join(", ") ?? "unknown"}`,
            },
          });
          return;
        }
      }
    }

    // Run verifier
    const verifyResult = await this.o.verifier.verify(ws.path);

    if (verifyResult.passed) {
      this.o.log.append({
        type: "job.verified",
        data: {
          job_id: jobId,
          passed: true,
          output: verifyResult.output.slice(0, 4000),
          return_count: job.returnCount,
        },
      });
    } else {
      if (job.returnCount < 2) {
        job.returnCount++;
        this.o.log.append({
          type: "job.verified",
          data: {
            job_id: jobId,
            passed: false,
            output: verifyResult.output.slice(0, 4000),
            return_count: job.returnCount,
          },
        });

        // Reflection loop: re-run the implementer step with test output
        job.state = "running";
        const implementer = job.plan.find((s) => s.role === "implementer") ?? job.plan[0];
        if (implementer) {
          implementer.state = "pending";
          implementer.prompt = `${implementer.prompt}\n\n[VERIFICATION FAILED (Attempt ${job.returnCount}/2)]:\n${verifyResult.output}`;
          await this.advance(jobId);
        }
      } else {
        this.o.log.append({
          type: "job.verified",
          data: {
            job_id: jobId,
            passed: false,
            output: verifyResult.output.slice(0, 4000),
            return_count: job.returnCount,
          },
        });
        this.o.log.append({
          type: "job.finished",
          data: {
            job_id: jobId,
            state: "failed",
            reason: `Verification failed after 2 reflection attempts:\n${verifyResult.output.slice(0, 500)}`,
          },
        });
      }
    }
  }
}
