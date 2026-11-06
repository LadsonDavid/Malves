import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Command, command } from "@malves/core";
import { describe, expect, it, vi } from "vitest";
import {
  CodexDesktopQueue,
  configuredCodexProgram,
} from "../src/adapters/sessions/codex-desktop.js";

const thread = "11111111-1111-4111-8111-111111111111";
const message = "22222222-2222-4222-8222-222222222222";
const accepted = `Queued message ${message} for thread ${thread}.\n`;
const file = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "malves-codex-desktop-")), "queue.json");
const program = command(process.execPath, ["vendor-control.js"]);

describe("Codex desktop queue", () => {
  it("uses a locally verified native Codex manifest and refuses a changed executable", () => {
    vi.stubEnv("MALVES_CODEX_DESKTOP_BIN", "");
    try {
      const dir = path.dirname(file()),
        program = path.join(dir, "codex.exe");
      writeFileSync(program, "fixture");
      writeFileSync(
        path.join(dir, "codex-desktop.json"),
        JSON.stringify({
          version: 1,
          program,
          sha256: createHash("sha256").update("fixture").digest("hex"),
        }),
      );
      expect(configuredCodexProgram(dir)).toBe(program);
      writeFileSync(program, "changed");
      expect(() => configuredCodexProgram(dir)).toThrow(/checksum/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("queues to an exact existing conversation without launching or resuming an agent", async () => {
    const calls: Command[] = [];
    const ledger = file();
    const queue = new CodexDesktopQueue({
      program,
      file: ledger,
      run: async (cmd) => {
        calls.push(cmd);
        return accepted;
      },
    });
    expect(await queue.send(thread, "Only acknowledge; do not edit files", "command-1")).toContain(
      "Queued",
    );
    expect(calls).toEqual([
      command(process.execPath, [
        "vendor-control.js",
        "queue",
        "--thread",
        thread,
        "--message",
        "Only acknowledge; do not edit files",
      ]),
    ]);
    expect(readFileSync(ledger, "utf8")).not.toContain("Only acknowledge");
    // The same pending phone command after a runner restart must not enqueue twice.
    const reopened = new CodexDesktopQueue({
      program,
      file: ledger,
      run: async () => {
        throw new Error("must not run");
      },
    });
    expect(reopened.history(thread)).toContain(message);
    expect(reopened.history(message)).not.toContain("Queued in");
    expect(
      await reopened.send(thread, "Only acknowledge; do not edit files", "command-1"),
    ).toContain("Queued");
  });

  it("does not retry an uncertain delivery, including after restart", async () => {
    const ledger = file();
    const queue = new CodexDesktopQueue({
      program,
      file: ledger,
      run: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(queue.send(thread, "hello", "command-2")).rejects.toThrow(/confirm/);
    let ran = false;
    const reopened = new CodexDesktopQueue({
      program,
      file: ledger,
      run: async () => {
        ran = true;
        return accepted;
      },
    });
    await expect(reopened.send(thread, "hello", "command-2")).rejects.toThrow(/uncertain/);
    expect(ran).toBe(false);
  });

  it("refuses ambiguous thread names and acknowledgements for another thread", async () => {
    let calls = 0;
    const queue = new CodexDesktopQueue({
      program,
      file: file(),
      run: async () => {
        calls++;
        return accepted.replace(thread, message);
      },
    });
    await expect(queue.send("A chat name", "hello", "command-3")).rejects.toThrow(/UUID/);
    expect(calls).toBe(0);
    await expect(queue.send(thread, "hello", "command-3")).rejects.toThrow(/confirm/);
  });

  it("shares an in-flight command and rejects reuse of an id for different text", async () => {
    let resolve!: (text: string) => void;
    let calls = 0;
    const queue = new CodexDesktopQueue({
      program,
      file: file(),
      run: () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    const first = queue.send(thread, "hello", "command-4");
    const second = queue.send(thread, "hello", "command-4");
    resolve(accepted);
    expect(await first).toBe(await second);
    expect(calls).toBe(1);
    await expect(queue.send(thread, "different", "command-4")).rejects.toThrow(/different/);
  });
});
