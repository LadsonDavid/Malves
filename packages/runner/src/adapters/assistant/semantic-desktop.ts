import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type Command, command } from "@malves/core";
import { z } from "zod";
import { redact } from "../../redact.js";
import { readSecretJson } from "../../secure-file.js";
import { OFF_LIMITS } from "./desktop.js";

type Run = (cmd: Command, signal?: AbortSignal) => Promise<string>;
const execute = promisify(execFile);
const run: Run = async (cmd, signal) => {
  try {
    return (
      await execute(cmd.program, [...cmd.args], {
        windowsHide: true,
        shell: false,
        timeout: 20000,
        maxBuffer: 2_000_000,
        ...(signal ? { signal } : {}),
      })
    ).stdout;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim()) return stdout;
    throw new Error(
      "Accessibility provider did not confirm the operation. Inspect before retrying.",
    );
  }
};
const Envelope = z.object({
  version: z.literal("2.6"),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      disposition: z.object({ delivery: z.string(), retry: z.string() }),
    })
    .optional(),
});
export type SemanticTarget = { ref: string; name: string; role: string; actions: string[] };
type Snapshot = {
  context: string;
  app: string;
  windowId: string;
  title: string;
  targets: SemanticTarget[];
  at: number;
  revision: number;
};
export class SemanticDesktop {
  private readonly active = new Set<AbortController>();
  cancel(): void {
    this.snapshot = undefined;
    for (const controller of this.active) controller.abort();
  }
  private snapshot: Snapshot | undefined;
  constructor(
    private readonly o: {
      program: Command;
      allowed: () => boolean;
      revision: () => number;
      run?: Run;
    },
  ) {}
  private async call(args: string[]) {
    const controller = new AbortController();
    this.active.add(controller);
    try {
      return Envelope.parse(
        JSON.parse(
          await (this.o.run ?? run)(
            command(this.o.program.program, [...this.o.program.args, ...args]),
            controller.signal,
          ),
        ),
      );
    } finally {
      this.active.delete(controller);
    }
  }
  async windows(app: string) {
    if (!this.o.allowed())
      throw new Error("Window discovery is available only during explicit handover.");
    if (!app.trim() || app.length > 100 || app.startsWith("-"))
      throw new Error("An exact app name is required.");
    const response = await this.call(["list-windows", "--app", app]);
    if (!response.ok)
      throw new Error("Could not identify accessible windows. No desktop action is allowed.");
    return z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          app_name: z.string(),
          accessible: z.boolean(),
          pid: z.number().optional(),
        }),
      )
      .parse(response.data)
      .filter(
        (window) =>
          window.accessible &&
          !OFF_LIMITS.test(`${window.app_name} ${window.title}`) &&
          !/ladson\.md/i.test(window.title),
      )
      .slice(0, 20)
      .map((window) => ({
        id: window.id,
        title: window.title,
        app: window.app_name,
        ...(window.pid === undefined ? {} : { pid: window.pid }),
      }));
  }
  async apps() {
    if (!this.o.allowed())
      throw new Error("App discovery is available only during explicit handover.");
    const response = await this.call(["list-apps"]);
    if (!response.ok) throw new Error("Could not identify desktop apps.");
    return z
      .object({ apps: z.array(z.object({ name: z.string(), pid: z.number() })) })
      .parse(response.data)
      .apps.filter((app) => !OFF_LIMITS.test(app.name))
      .slice(0, 50);
  }
  async observe(app: string, windowId: string): Promise<Snapshot> {
    this.snapshot = undefined;
    if (!this.o.allowed())
      throw new Error(
        "Semantic desktop access is available only during explicit handover, without human control.",
      );
    if (
      !app.trim() ||
      app.length > 100 ||
      app.startsWith("-") ||
      !/^[\w.:-]{1,256}$/.test(windowId)
    )
      throw new Error("An app and exact window id are required. Ambiguous windows are refused.");
    const revision = this.o.revision();
    const response = await this.call(["snapshot", "--app", app, "--window-id", windowId]);
    if (!response.ok)
      throw new Error(
        `Observation refused: ${response.error?.code ?? "unknown"}. Take a fresh, unambiguous observation.`,
      );
    const data = z
      .object({ complete: z.boolean(), snapshot_id: z.string(), tree: z.unknown() })
      .parse(response.data);
    if (data.complete !== true)
      throw new Error("The accessibility snapshot is incomplete; no target can be acted on.");
    const nodes: Record<string, unknown>[] = [];
    const pending: unknown[] = [data.tree];
    while (pending.length && nodes.length < 1000) {
      const node = pending.pop();
      if (!node || typeof node !== "object") continue;
      const value = node as Record<string, unknown>;
      nodes.push(value);
      if (Array.isArray(value.children)) pending.push(...[...value.children].reverse());
    }
    if (pending.length) throw new Error("The accessibility tree exceeds the observation limit.");
    const title = typeof nodes[0]?.name === "string" ? nodes[0].name : "";
    if (/(^|[\s\\/])\.env\b|private.?key/i.test(title))
      throw new Error("A secret-bearing file is visible. Close it before sharing desktop context.");
    if (nodes.some((node) => typeof node.name === "string" && /ladson\.md/i.test(node.name)))
      throw new Error(
        "The private profile is visible. It must remain local and cannot be sent to the brain.",
      );
    if (OFF_LIMITS.test(`${app} ${title}`))
      throw new Error("Sign-in, password, payment and administrator windows are off limits.");
    const targets: SemanticTarget[] = [];
    const sensitive =
      /password|passcode|credential|card.?number|cvv|\botp\b|\bpin\b|api.?key|secret|token/i;
    const context = [
      ...new Set(
        nodes
          .filter((node) => !sensitive.test(`${node.name ?? ""} ${node.role ?? ""}`))
          .map((node) =>
            [node.name, node.value]
              .filter((value) => typeof value === "string")
              .join(": ")
              .trim(),
          )
          .filter(Boolean),
      ),
    ].join("\n");
    for (const node of nodes) {
      const ref = node.ref_id,
        name = node.name,
        role = node.role;
      if (
        typeof ref !== "string" ||
        !ref.startsWith(`@${data.snapshot_id}:`) ||
        typeof name !== "string" ||
        !name.trim() ||
        typeof role !== "string" ||
        !Array.isArray(node.available_actions)
      )
        continue;
      if (sensitive.test(`${name} ${role}`)) continue;
      if (nodes.filter((other) => other.name === name && other.role === role).length !== 1)
        continue;
      targets.push({
        ref,
        name: name.slice(0, 200),
        role: role.slice(0, 60),
        actions: node.available_actions
          .filter((a): a is string => typeof a === "string")
          .slice(0, 20),
      });
    }
    if (!this.o.allowed() || revision !== this.o.revision())
      throw new Error("Control changed during observation. Look again.");
    this.snapshot = {
      context: redact(context).slice(0, 6000),
      app,
      windowId,
      title,
      targets: targets.slice(0, 200),
      at: Date.now(),
      revision,
    };
    return this.snapshot;
  }
  target(ref: string, action: "click" | "set-value"): SemanticTarget {
    const s = this.snapshot;
    if (!this.o.allowed() || !s || s.revision !== this.o.revision() || Date.now() - s.at > 30000)
      throw new Error("The target observation is stale. Look again.");
    const target = s.targets.find((target) => target.ref === ref);
    if (
      !target?.actions.some(
        (a) =>
          a.toLowerCase().replaceAll("_", "-") === action ||
          (action === "set-value" && a.toLowerCase() === "setvalue"),
      )
    )
      throw new Error(
        "That target is ambiguous, absent, sensitive, or does not support this action.",
      );
    return target;
  }
  async act(ref: string, action: "click" | "set-value", text?: string): Promise<string> {
    if (action === "set-value" && (text === undefined || text.length > 2000 || text.includes("\0")))
      throw new Error("Invalid desktop field value.");
    this.target(ref, action);
    this.snapshot = undefined; // Consume before dispatch; uncertain delivery is never repeated.
    const args = action === "click" ? ["click", ref] : ["set-value", ref, "--", text ?? ""];
    try {
      const response = await this.call(args);
      const disposition = (
        response.ok
          ? (response.data as { disposition?: unknown } | undefined)?.disposition
          : response.error?.disposition
      ) as { delivery?: unknown; retry?: unknown } | undefined;
      const delivery = typeof disposition?.delivery === "string" ? disposition.delivery : "unknown";
      const retry = typeof disposition?.retry === "string" ? disposition.retry : "unknown";
      return `Accessibility result: ${response.ok ? "returned" : (response.error?.code ?? "failed")}. Delivery: ${delivery}. Retry: ${retry}. ${delivery === "delivered_verified" ? "The provider verified its stated postcondition." : "The intended outcome is not verified."} No automatic retry; take a fresh observation.`;
    } catch {
      return "Accessibility input may have happened, but delivery is unconfirmed. No automatic retry; inspect the app first.";
    }
  }
}
export async function semanticDesktopFromEnv(
  allowed: () => boolean,
  revision: () => number,
  dataDir?: string,
): Promise<SemanticDesktop | undefined> {
  const program = configuredSemanticProgram(dataDir);
  if (!program) return;
  if (!path.isAbsolute(program) || /\.(cmd|bat|ps1)$/i.test(program) || !statSync(program).isFile())
    throw new Error(
      "MALVES_AGENT_DESKTOP_BIN must point to an absolute native executable, not a shell helper.",
    );
  const version = Envelope.parse(JSON.parse(await run(command(program, ["version"]))));
  if (!version.ok) throw new Error("Agent Desktop did not confirm its protocol version.");
  return new SemanticDesktop({ program: command(program), allowed, revision });
}

export function configuredSemanticProgram(dataDir?: string): string | undefined {
  if (process.env.MALVES_AGENT_DESKTOP_BIN) return process.env.MALVES_AGENT_DESKTOP_BIN;
  if (!dataDir) return;
  const saved = readSecretJson<unknown>(path.join(dataDir, "desktop-provider.json"));
  if (saved === undefined) return;
  const config = z
    .object({
      version: z.literal(1),
      program: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(saved);
  if (!path.isAbsolute(config.program) || /\.(cmd|bat|ps1)$/i.test(config.program))
    throw new Error("The configured desktop provider must be a native executable.");
  if (createHash("sha256").update(readFileSync(config.program)).digest("hex") !== config.sha256)
    throw new Error(
      "The configured desktop provider changed; its checksum must be verified again.",
    );
  return config.program;
}
