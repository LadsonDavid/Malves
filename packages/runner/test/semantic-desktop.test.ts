import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "@malves/core";
import { expect, it, vi } from "vitest";
import {
  configuredSemanticProgram,
  SemanticDesktop,
} from "../src/adapters/assistant/semantic-desktop.js";

const snapshot = (complete = true) =>
  JSON.stringify({
    version: "2.6",
    ok: true,
    data: {
      complete,
      snapshot_id: "s1",
      tree: {
        role: "window",
        name: "Document",
        children: [
          { role: "button", name: "Save", ref_id: "@s1:e1", available_actions: ["Click"] },
          {
            role: "textfield",
            name: "Project name",
            ref_id: "@s1:e2",
            available_actions: ["SetValue"],
          },
          { role: "button", name: "Duplicate", ref_id: "@s1:e3", available_actions: ["Click"] },
          { role: "button", name: "Duplicate", ref_id: "@s1:e4", available_actions: ["Click"] },
          {
            role: "textfield",
            name: "Password",
            ref_id: "@s1:e5",
            available_actions: ["SetValue"],
          },
        ],
      },
    },
  });
it("offers only unique non-sensitive refs and reports the provider's delivery proof", async () => {
  const calls: string[][] = [];
  const provider = new SemanticDesktop({
    program: command(process.execPath, []),
    allowed: () => true,
    revision: () => 1,
    run: async (cmd) => {
      calls.push([...cmd.args]);
      return cmd.args[0] === "snapshot"
        ? snapshot()
        : JSON.stringify({
            version: "2.6",
            ok: true,
            data: { disposition: { delivery: "delivered_verified", retry: "unsafe" } },
          });
    },
  });
  const observed = await provider.observe("Notepad", "w-1");
  expect(observed.targets.map((t) => t.ref)).toEqual(["@s1:e1", "@s1:e2"]);
  expect(() => provider.target("@s1:e3", "click")).toThrow(/ambiguous/);
  expect(await provider.act("@s1:e1", "click")).toContain("provider verified");
  await expect(provider.act("@s1:e1", "click")).rejects.toThrow(/stale/);
  expect(calls).toEqual([
    ["snapshot", "--app", "Notepad", "--window-id", "w-1"],
    ["click", "@s1:e1"],
  ]);
});
it("reads native question context while excluding named secret fields", async () => {
  const provider = new SemanticDesktop({
    program: command(process.execPath, []),
    allowed: () => true,
    revision: () => 1,
    run: async () =>
      JSON.stringify({
        version: "2.6",
        ok: true,
        data: {
          complete: true,
          snapshot_id: "s1",
          tree: {
            role: "window",
            name: "Question",
            children: [
              { role: "text", name: "Run npm test in this project?" },
              {
                role: "textfield",
                name: "API key",
                value: "private-value",
                ref_id: "@s1:e1",
                available_actions: ["SetValue"],
              },
              { role: "button", name: "Allow", ref_id: "@s1:e2", available_actions: ["Click"] },
            ],
          },
        },
      }),
  });
  const observed = await provider.observe("Fixture", "w-1");
  expect(observed.context).toContain("Run npm test");
  expect(observed.context).not.toContain("private-value");
  expect(observed.targets.map((target) => target.name)).toEqual(["Allow"]);
});
it("refuses incomplete observations, ownership changes and unsupported actions without dispatch", async () => {
  let revision = 1,
    complete = false,
    allowed = true;
  const calls: string[][] = [];
  const provider = new SemanticDesktop({
    program: command(process.execPath, []),
    allowed: () => allowed,
    revision: () => revision,
    run: async (cmd) => {
      calls.push([...cmd.args]);
      return snapshot(complete);
    },
  });
  await expect(provider.observe("Notepad", "w-1")).rejects.toThrow(/incomplete/);
  complete = true;
  await provider.observe("Notepad", "w-1");
  revision++;
  await expect(provider.act("@s1:e1", "click")).rejects.toThrow(/stale/);
  allowed = false;
  await expect(provider.observe("Notepad", "w-1")).rejects.toThrow(/handover/);
  expect(calls.every((args) => args[0] === "snapshot")).toBe(true);
});
it("does not retry uncertain delivery or execute a provider recovery command", async () => {
  let actions = 0;
  const provider = new SemanticDesktop({
    program: command(process.execPath, []),
    allowed: () => true,
    revision: () => 1,
    run: async (cmd) => {
      if (cmd.args[0] === "snapshot") return snapshot();
      actions++;
      throw new Error("connection lost after delivery");
    },
  });
  await provider.observe("Notepad", "w-1");
  expect(await provider.act("@s1:e2", "set-value", "--literal value")).toContain("unconfirmed");
  await expect(provider.act("@s1:e2", "set-value", "again")).rejects.toThrow(/stale/);
  expect(actions).toBe(1);
});

it("accepts a locally verified provider manifest and refuses a modified binary", () => {
  vi.stubEnv("MALVES_AGENT_DESKTOP_BIN", "");
  const dir = mkdtempSync(path.join(tmpdir(), "malves-provider-"));
  try {
    const program = path.join(dir, "provider.exe");
    writeFileSync(program, "fixture");
    writeFileSync(
      path.join(dir, "desktop-provider.json"),
      JSON.stringify({
        version: 1,
        program,
        sha256: createHash("sha256").update("fixture").digest("hex"),
      }),
    );
    expect(configuredSemanticProgram(dir)).toBe(program);
    writeFileSync(program, "changed");
    expect(() => configuredSemanticProgram(dir)).toThrow(/checksum/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
it("cancels an in-flight provider call when human control is taken", async () => {
  let allowed = true;
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new SemanticDesktop({
    program: command(process.execPath, []),
    allowed: () => allowed,
    revision: () => 1,
    run: async (cmd, signal) => {
      if (cmd.args[0] === "snapshot") return snapshot();
      started();
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    },
  });
  await provider.observe("Notepad", "w-1");
  const action = provider.act("@s1:e1", "click");
  await entered;
  allowed = false;
  provider.cancel();
  expect(await action).toContain("unconfirmed");
  await expect(provider.act("@s1:e1", "click")).rejects.toThrow(/stale/);
});
