import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type Command, command } from "@malves/core";
import { z } from "zod";
import { readSecretJson, writeSecretJson } from "../../secure-file.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const execute = promisify(execFile);
type Run = (cmd: Command) => Promise<string>;
const run: Run = async (cmd) =>
  (
    await execute(cmd.program, [...cmd.args], {
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
  ).stdout;

const identity = {
  threadId: z.string().regex(UUID).optional(),
  commandId: z.string().min(1).max(64),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const Entry = z.discriminatedUnion("state", [
  z.object({ ...identity, state: z.literal("pending") }),
  z.object({ ...identity, state: z.literal("queued"), messageId: z.string().regex(UUID) }),
]);
type Entry = z.infer<typeof Entry>;

export interface CodexDesktopSender {
  send(threadId: string, text: string, commandId: string): Promise<string>;
  history?(threadId: string): string;
}

/** A vendor control command addressing an existing conversation, never a new agent. */
export class CodexDesktopQueue implements CodexDesktopSender {
  private readonly records: Map<string, Entry>;
  private readonly inFlight = new Map<string, Promise<string>>();
  history(threadId: string): string {
    const recent = [...this.records.values()].filter((r) => r.threadId === threadId).slice(-5);
    return recent.length
      ? recent
          .map((r) =>
            r.state === "queued"
              ? receipt(r.messageId)
              : "An earlier message has uncertain delivery. Check the desktop chat before sending again.",
          )
          .join("\n")
      : "No retained delivery receipts for this conversation. A transcript reply is separate evidence.";
  }
  constructor(private readonly o: { program: Command; file: string; run?: Run }) {
    const saved = z.array(Entry).parse(readSecretJson<unknown>(o.file) ?? []);
    this.records = new Map(saved.map((entry) => [entry.commandId, entry]));
  }

  async send(threadId: string, text: string, commandId: string): Promise<string> {
    if (!UUID.test(threadId))
      throw new Error("Codex desktop queue requires an exact conversation UUID.");
    if (!text.trim() || text.length > 20_000 || text.includes("\0"))
      throw new Error("Invalid desktop message.");
    if (!commandId || commandId.length > 64) throw new Error("A desktop command id is required.");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([threadId, text]))
      .digest("hex");
    const known = this.records.get(commandId);
    if (known && known.fingerprint !== fingerprint)
      throw new Error("This command id belongs to a different desktop message.");
    if (known?.state === "queued") return receipt(known.messageId);
    const pending = this.inFlight.get(commandId);
    if (pending) return pending;
    if (known)
      throw new Error(
        "The previous delivery is uncertain. Check the desktop conversation before sending again.",
      );
    const entry: Entry = { commandId, fingerprint, threadId, state: "pending" };
    this.records.set(commandId, entry);
    const operation = this.enqueue(threadId, text, entry).finally(() =>
      this.inFlight.delete(commandId),
    );
    this.inFlight.set(commandId, operation);
    return operation;
  }

  private async enqueue(threadId: string, text: string, entry: Entry): Promise<string> {
    // Write ahead: a restart in the delivery window must not silently send twice.
    this.save();
    const cmd = command(this.o.program.program, [
      ...this.o.program.args,
      "queue",
      "--thread",
      threadId,
      "--message",
      text,
    ]);
    let output: string;
    try {
      output = await (this.o.run ?? run)(cmd);
    } catch {
      throw new Error(
        "Could not confirm delivery to Codex. Check the desktop conversation before sending again.",
      );
    }
    const match = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.$/im.exec(
      output.trim(),
    );
    const messageId = match?.[1];
    if (
      !messageId ||
      !UUID.test(messageId) ||
      match?.[2]?.toLowerCase() !== threadId.toLowerCase()
    ) {
      throw new Error(
        "Codex did not confirm queueing to the selected conversation. Check it before sending again.",
      );
    }
    this.records.set(entry.commandId, { ...entry, state: "queued", messageId });
    this.save();
    return receipt(messageId);
  }

  private save(): void {
    // Keep every uncertain delivery; completed receipts have a bounded replay window.
    const queued = [...this.records.values()].filter((e) => e.state === "queued").slice(-1000);
    const pending = [...this.records.values()].filter((e) => e.state === "pending");
    if (pending.length > 1000)
      throw new Error("Too many uncertain Codex deliveries; resolve them before sending more.");
    const retained = [...pending, ...queued];
    writeSecretJson(this.o.file, retained);
    this.records.clear();
    for (const entry of retained) this.records.set(entry.commandId, entry);
  }
}

function receipt(id: string): string {
  return `Queued in the existing Codex conversation (${id}). Keep that chat open in Codex desktop; queued does not mean answered.`;
}

/** Opt in to a particular installed binary; don't guess a version or execute a shell shim. */
export async function codexDesktopFromEnv(dataDir: string): Promise<CodexDesktopQueue | undefined> {
  const program = configuredCodexProgram(dataDir);
  if (!program) return undefined;
  if (
    !path.isAbsolute(program) ||
    /\.(cmd|bat|ps1)$/i.test(program) ||
    !statSync(program).isFile()
  ) {
    throw new Error(
      "MALVES_CODEX_DESKTOP_BIN must name an absolute Codex executable, not a shell shim.",
    );
  }
  const help = await run(command(program, ["queue", "--help"]));
  if (!help.includes("--thread") || !help.includes("--message"))
    throw new Error("This Codex version doesn't advertise the queue command.");
  return new CodexDesktopQueue({
    program: command(program),
    file: path.join(dataDir, "codex-desktop-queue.json"),
  });
}

export function configuredCodexProgram(dataDir: string): string | undefined {
  if (process.env.MALVES_CODEX_DESKTOP_BIN) return process.env.MALVES_CODEX_DESKTOP_BIN;
  const saved = readSecretJson<unknown>(path.join(dataDir, "codex-desktop.json"));
  if (saved === undefined) return;
  const config = z
    .object({
      version: z.literal(1),
      program: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(saved);
  if (!path.isAbsolute(config.program) || /\.(cmd|bat|ps1)$/i.test(config.program))
    throw new Error("Configured Codex must be a native executable.");
  if (createHash("sha256").update(readFileSync(config.program)).digest("hex") !== config.sha256)
    throw new Error(
      "Configured Codex checksum changed. Verify the new installed version before enabling it.",
    );
  return config.program;
}
