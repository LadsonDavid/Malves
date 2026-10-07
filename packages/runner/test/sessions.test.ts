import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Core } from "@malves/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { antigravitySessions } from "../src/adapters/sessions/antigravity.js";
import { claudeSessions } from "../src/adapters/sessions/claude.js";
import { codexSessions } from "../src/adapters/sessions/codex.js";
import { continuation, Sessions } from "../src/adapters/sessions/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "malves-sessions-"));
  dirs.push(d);
  return d;
};
const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

/** A tiny protobuf writer: [field, value] pairs, values are strings or nested pairs. */
type Pb = Array<[number, string | Pb]>;
function pb(fields: Pb): Buffer {
  const varint = (n: number) => {
    const out: number[] = [];
    let v = n;
    while (v > 127) {
      out.push((v & 127) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return Buffer.from(out);
  };
  return Buffer.concat(
    fields.map(([field, value]) => {
      const body = typeof value === "string" ? Buffer.from(value, "utf8") : pb(value);
      return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
    }),
  );
}

describe("sessions across tools", () => {
  it("reads Claude Code sessions: folder, your latest title, messages; skips side-chains and stubs", async () => {
    const root = temp();
    const dir = path.join(root, "D--work-site");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "11111111-aaaa.jsonl"),
      jsonl([
        { type: "mode", mode: "normal" },
        { type: "user", cwd: "D:\\work\\site", message: { content: "fix the footer" } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hm" },
              { type: "text", text: "Done: footer fixed." },
            ],
          },
        },
        { type: "user", isSidechain: true, message: { content: "sub-agent chatter" } },
        { type: "custom-title", customTitle: "Footer work" },
      ]),
    );
    writeFileSync(path.join(dir, "22222222-bbbb.jsonl"), jsonl([{ type: "mode", mode: "normal" }]));
    const source = claudeSessions(root);
    const list = await source.list();
    expect(list).toMatchObject([
      {
        tool: "claude",
        id: "11111111-aaaa",
        title: "Footer work",
        folder: "D:\\work\\site",
        how: "resume",
      },
    ]);
    expect(await source.read("11111111-aaaa", 10)).toEqual([
      { who: "you", text: "fix the footer" },
      { who: "agent", text: "Done: footer fixed." },
    ]);
  });

  it("reads Codex sessions from their rollout files", async () => {
    const root = temp();
    const day = path.join(root, "2026", "10", "07");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      path.join(day, "rollout-2026-10-07T10-00-00-abc.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "abc-123", cwd: "/home/me/app" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "add a test" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Added one." }],
          },
        },
      ]),
    );
    const source = codexSessions(root);
    expect(await source.list()).toMatchObject([
      { tool: "codex", id: "abc-123", title: "add a test", folder: "/home/me/app", how: "resume" },
    ]);
    expect(await source.read("abc-123", 10)).toEqual([
      { who: "you", text: "add a test" },
      { who: "agent", text: "Added one." },
    ]);
  });

  it("decodes Antigravity's editor conversations: title, folder, your words and its visible replies", async () => {
    const root = temp();
    const db = new Database(path.join(root, "conv-1234-5678.db"));
    db.prepare("CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)").run();
    db.prepare("CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)").run();
    const step = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
    step.run(0, 14, pb([[19, [[2, "plan the moderation feature"]]]]));
    step.run(
      1,
      15,
      pb([
        [
          20,
          [
            [3, "private thinking"],
            [1, "Here is the plan."],
          ],
        ],
      ]),
    );
    step.run(2, 23, pb([[30, [[4, "Planning Moderation"]]]]));
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
      pb([[1, [[3, "file:///d%3A/Pavilion/Web"]]]]),
    );
    db.close();
    const source = antigravitySessions(root);
    const [info] = await source.list();
    expect(info).toMatchObject({
      tool: "antigravity",
      title: "Planning Moderation",
      how: "new",
      source: "editor",
    });
    expect(info?.folder?.replace(/\\/g, "/")).toMatch(/Pavilion\/Web$/);
    expect(await source.read("conv-1234-5678", 10)).toEqual([
      { who: "you", text: "plan the moderation feature" },
      { who: "agent", text: "Here is the plan." },
    ]);
  });

  it("continues the right way, and only in folders you've worked in", async () => {
    const folder = temp();
    const created: Array<Record<string, unknown>> = [];
    const registered: string[] = [];
    const core = {
      workspaces: {
        list: () => [],
        register: (_name: string, root: string) => {
          registered.push(root);
          return { id: "ws_1", name: "site", path: root };
        },
      },
      tasks: {
        create: (input: Record<string, unknown>) => {
          created.push(input);
          return `t_${created.length}`;
        },
      },
    } as unknown as Core;
    const fake = (tool: "claude" | "antigravity", how: "resume" | "new") => ({
      tool,
      list: async () => [
        { tool, id: `${tool}-1`, title: `${tool} work`, folder, updatedAt: 1, how },
      ],
      read: async () => [
        { who: "you" as const, text: "make the plan" },
        { who: "agent" as const, text: "Plan written." },
      ],
    });
    const sessions = new Sessions(core, [fake("claude", "resume"), fake("antigravity", "new")]);
    const ready = () => true;

    const resumed = await sessions.continue("claude", "claude-1", "now build it", ready);
    expect(resumed.taskId).toBe("t_1");
    expect(created[0]).toMatchObject({
      agent: "claude",
      prompt: "now build it",
      resume: "claude-1",
    });

    const fresh = await sessions.continue("antigravity", "antigravity-1", "now build it", ready);
    expect(fresh.taskId).toBe("t_2");
    expect(created[1]?.agent).toBe("antigravity");
    expect(String(created[1]?.prompt)).toContain("Me: make the plan");
    expect(String(created[1]?.prompt)).toContain("Now: now build it");
    expect(registered).toEqual([folder, folder]);

    // A folder that never appeared in a session (and wasn't added) is refused.
    await expect(sessions.workspaceFor(path.join(folder, "..", "somewhere-else"))).rejects.toThrow(
      /isn't one you've worked in/,
    );
  });

  it("keeps the follow-on message within budget, newest history first", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      who: "agent" as const,
      text: `step ${i} ${"x".repeat(500)}`,
    }));
    const text = continuation("Antigravity", "Big job", long, "finish it");
    expect(text.length).toBeLessThan(4500);
    expect(text).toContain("step 19");
    expect(text).not.toContain("step 0 ");
  });
});
