import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command, createCore, type Notifier, STOPPED_WAITING } from "@malves/core";
import { afterEach, describe, expect, it } from "vitest";
import { AcpHost } from "../src/adapters/acp/host.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * End to end over real ACP: the demo agent runs as a child process, speaking
 * ACP over stdio, and the core decides what it may do.
 */
const demoAgent = fileURLToPath(new URL("../src/demo-agent.ts", import.meta.url));
const noPush: Notifier = { questionOpened: async () => {} };
const opened: Array<() => void> = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
  delete process.env.MALVES_DEMO_FILE;
  delete process.env.MALVES_DEMO_AUTH;
});

function setup(questionTimeoutMs = 10_000) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-acp-")));
  const site = path.join(dir, "site");
  const store = new SqliteStore(path.join(dir, "malves.db"));
  const host = new AcpHost();
  opened.push(() => {
    host.killAll();
    store.close();
  });
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: noPush,
    host,
    agents: new Map([["demo", command(process.execPath, [demoAgent])]]),
    questionTimeoutMs,
  });
  mkdirSync(site);
  const ws = core.workspaces.register("site", site);
  return { ...core, dir, site, ws, store };
}

function answerNext(core: ReturnType<typeof setup>, choiceId: string) {
  const unsubscribe = core.log.subscribe((event) => {
    if (event.type !== "question.opened") return;
    unsubscribe();
    setImmediate(() =>
      core.questions.answer({ questionId: event.data.question_id, choiceId, commandId: "test" }),
    );
  });
}

describe("ACP agent, end to end", () => {
  it("asks, and acts only after the answer", async () => {
    const c = setup();
    answerNext(c, "allow");
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "make the file" });
    const task = await c.tasks.whenFinished(id);
    expect(task).toMatchObject({ state: "done", result: "Wrote malves-demo.txt." });
    expect(readFileSync(path.join(c.site, "malves-demo.txt"), "utf8")).toContain("make the file");
  }, 20_000);

  it("does nothing when the answer is no", async () => {
    const c = setup();
    answerNext(c, "reject");
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    expect((await c.tasks.whenFinished(id)).state).toBe("done");
    expect(existsSync(path.join(c.site, "malves-demo.txt"))).toBe(false);
  }, 20_000);

  it("R3: silence stops the task, and the agent writes nothing", async () => {
    const c = setup(500);
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    const task = await c.tasks.whenFinished(id);
    expect(task).toMatchObject({ state: "stopped", reason: STOPPED_WAITING });
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(path.join(c.site, "malves-demo.txt"))).toBe(false);
  }, 20_000);

  it("refuses to write outside the workspace, even when allowed", async () => {
    const c = setup();
    const outside = path.join(c.dir, "outside.txt");
    process.env.MALVES_DEMO_FILE = outside;
    answerNext(c, "allow");
    const id = c.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    expect((await c.tasks.whenFinished(id)).state).toBe("failed");
    expect(existsSync(outside)).toBe(false);
    const errors = c.store.since(0, 100).filter((e) => e.type === "error");
    expect(errors.map((e) => e.data)).toContainEqual(
      expect.objectContaining({ code: "outside_workspace" }),
    );
  }, 20_000);

  it("reports an agent that cannot start", async () => {
    const c = setup();
    const core = createCore({
      store: c.store,
      clock: systemClock,
      ids: randomIds,
      notifier: noPush,
      host: new AcpHost(),
      agents: new Map([["missing", command("malves-no-such-program")]]),
      questionTimeoutMs: 1000,
    });
    const id = core.tasks.create({ workspaceId: c.ws.id, agent: "missing", prompt: "x" });
    const task = await core.tasks.whenFinished(id);
    expect(task.state).toBe("failed");
    expect(task.reason).toMatch(/Could not start the agent/);
  }, 20_000);

  it("an agent that isn't signed in fails with a plain message, and says so", async () => {
    const c = setup();
    process.env.MALVES_DEMO_AUTH = "required";
    const needsSignIn: string[] = [];
    const core = createCore({
      store: c.store,
      clock: systemClock,
      ids: randomIds,
      notifier: noPush,
      host: new AcpHost({
        onSignInNeeded: (agent) => needsSignIn.push(agent),
        signInMessage: (agent) => `${agent} isn't signed in. Sign in, then try again.`,
      }),
      agents: new Map([["demo", command(process.execPath, [demoAgent])]]),
      questionTimeoutMs: 1000,
    });
    const id = core.tasks.create({ workspaceId: c.ws.id, agent: "demo", prompt: "x" });
    const task = await core.tasks.whenFinished(id);
    expect(task).toMatchObject({
      state: "failed",
      reason: "demo isn't signed in. Sign in, then try again.",
    });
    expect(needsSignIn).toEqual(["demo"]);
  }, 20_000);
});

describe("checking whether an agent is ready", () => {
  const demo = command(process.execPath, [demoAgent]);

  it("a working agent is ready", async () => {
    expect(await new AcpHost().probe(demo, tmpdir())).toEqual({ state: "ready" });
  }, 20_000);

  it("an agent that isn't signed in needs sign-in", async () => {
    process.env.MALVES_DEMO_AUTH = "required";
    expect(await new AcpHost().probe(demo, tmpdir())).toEqual({ state: "needs_sign_in" });
  }, 20_000);

  it("a missing program isn't available, and says why", async () => {
    const result = await new AcpHost().probe(command("malves-no-such-program"), tmpdir());
    expect(result.state).toBe("unavailable");
    expect(result.detail).toMatch(/Could not start it/);
  }, 20_000);
});
