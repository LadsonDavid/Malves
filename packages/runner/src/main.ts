#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Workspace } from "@malves/core";
import qrcode from "qrcode-terminal";
import { secretsFor } from "./adapters/secrets/secrets.js";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import { agentCatalog, onPath } from "./agents.js";
import { loadConfig, userAgents } from "./config.js";
import {
  type ControlRequest,
  type ControlResponse,
  handleControl,
  sendControl,
} from "./control.js";
import { serve } from "./serve.js";
import { dataDir, parseDuration } from "./system.js";
import { openRunner, type Runner } from "./wire.js";

const USAGE = `malves — run coding agents from your phone

Start here:
  malves workspace add <folder> [--name <name>]   register a project folder
  malves serve [--listen host:port]               run, reachable over Tailscale
  malves pair                                     show a QR code for the phone

While serving:
  malves stop                                     stop every running task
  malves status
  malves devices list | revoke <id>

Other:
  malves workspace list | remove <id>
  malves agents                                   agents malves can start
  malves secret set <NAME> | delete <NAME>        API keys, kept in the OS keychain
  malves run [-w <workspace>] [-a <agent>] <task…>  one task, answered in this terminal
  malves log [--since <seq>]

Options: --timeout <duration> (default 10m) — unanswered questions stop the task.
Data is kept in $MALVES_HOME (default ~/.malves).`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      workspace: { type: "string", short: "w" },
      agent: { type: "string", short: "a", default: "demo" },
      timeout: { type: "string", short: "t", default: "10m" },
      listen: { type: "string" },
      since: { type: "string", default: "0" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 1;
  }
  const dir = dataDir();
  const questionTimeoutMs = parseDuration(values.timeout);

  switch (cmd) {
    case "serve":
      return serveForever(dir, questionTimeoutMs, values.listen);
    case "pair":
      return pair(dir);
    case "stop":
      return print(await daemon(dir, { cmd: "stop" }), "Stopped every running task.");
    case "status":
      return print(await daemon(dir, { cmd: "status" }));
    case "agents":
      for (const a of [...agentCatalog(), ...userAgents(loadConfig(dir))]) {
        const mark = onPath(a.requires) ? "✓" : "✗ (not installed)";
        console.log(`${a.name.padEnd(12)} ${mark}  ${a.label}`);
      }
      return 0;
    case "secret":
      return secret(dir, sub, rest[0]);
    case "workspace":
      return workspace(dir, sub, rest, values.name);
    case "devices":
      if (sub === "list") return print(await control(dir, { cmd: "devices.list" }));
      if (sub === "revoke" && rest[0]) {
        return print(await control(dir, { cmd: "devices.revoke", id: rest[0] }), "Removed.");
      }
      break;
    case "log":
    case "run": {
      const runner = openRunner({
        dir,
        questionTimeoutMs,
        agents: [...agentCatalog(), ...userAgents(loadConfig(dir))],
      });
      try {
        if (cmd === "log") {
          for (const e of runner.log.since(Number(values.since))) console.log(JSON.stringify(e));
          return 0;
        }
        return await run(runner, [sub, ...rest].filter((s) => s !== undefined).join(" "), values);
      } finally {
        runner.close();
      }
    }
  }
  console.error(`Unknown command.\n\n${USAGE}`);
  return 1;
}

async function serveForever(
  dir: string,
  questionTimeoutMs: number,
  listen?: string,
): Promise<number> {
  const served = await serve({
    dir,
    questionTimeoutMs,
    terminal: true,
    ...(listen ? { listen } : {}),
    browser: {
      ...(process.env.MALVES_BROWSER_EXECUTABLE
        ? { executable: process.env.MALVES_BROWSER_EXECUTABLE }
        : {}),
      // Only for containers running as root, where Chromium's sandbox can't start.
      ...(process.env.MALVES_BROWSER_NO_SANDBOX === "1" ? { noSandbox: true } : {}),
    },
  });
  console.log(`malves is running on ${served.runner.name}, reachable at ${served.linkUrl}`);
  console.log("Pair a phone with `malves pair` in another terminal. Ctrl-C stops everything.");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  console.log("\nStopping…");
  await served.stop();
  return 0;
}

async function pair(dir: string): Promise<number> {
  const response = await daemon(dir, { cmd: "pair" });
  if (!response.ok) return print(response);
  const { invite, expires_at } = response.data as { invite: string; expires_at: number };
  qrcode.generate(invite, { small: true });
  const seconds = Math.round((expires_at - Date.now()) / 1000);
  console.log(`Scan this with the malves app within ${seconds} seconds. It works once.`);
  return 0;
}

/** Talks to the running daemon; errors if there isn't one. */
async function daemon(dir: string, req: ControlRequest): Promise<ControlResponse> {
  const response = await sendControl(dir, req);
  if (!response) throw new Error("malves is not running. Start it with `malves serve`.");
  return response;
}

/** Uses the daemon if it is running, otherwise opens the runner directly. */
async function control(dir: string, req: ControlRequest): Promise<ControlResponse> {
  const viaDaemon = await sendControl(dir, req);
  if (viaDaemon) return viaDaemon;
  const runner = openRunner({ dir, questionTimeoutMs: 60_000 });
  try {
    return await handleControl(runner, req, {});
  } finally {
    runner.close();
  }
}

async function workspace(dir: string, sub: string | undefined, rest: string[], name?: string) {
  if (sub === "add" && rest[0]) {
    const folder = realpathSync(path.resolve(rest[0]));
    const response = await control(dir, {
      cmd: "workspace.add",
      name: name ?? path.basename(folder),
      path: folder,
    });
    if (!response.ok) return print(response);
    const ws = response.data as Workspace;
    console.log(`${ws.id}  ${ws.name}  ${ws.path}`);
    return 0;
  }
  if (sub === "list") {
    const response = await control(dir, { cmd: "workspace.list" });
    if (!response.ok) return print(response);
    const list = response.data as Workspace[];
    if (list.length === 0)
      console.log("No workspaces yet. Add one with `malves workspace add <folder>`.");
    for (const ws of list) console.log(`${ws.id}  ${ws.name}  ${ws.path}`);
    return 0;
  }
  if (sub === "remove" && rest[0]) {
    return print(await control(dir, { cmd: "workspace.remove", id: rest[0] }), "Removed.");
  }
  console.error(USAGE);
  return 1;
}

async function secret(dir: string, sub: string | undefined, name: string | undefined) {
  if (!name || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
    console.error("Usage: malves secret set|delete NAME   (NAME like CURSOR_API_KEY)");
    return 1;
  }
  const secrets = secretsFor(dir);
  if (sub === "delete") {
    secrets.delete(name);
    console.log(`Deleted ${name}.`);
    return 0;
  }
  if (sub !== "set") return 1;
  // Read from stdin, never from arguments, so the key stays out of shell history.
  process.stdout.write(`Paste ${name} and press Enter: `);
  const value = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
  if (!value) return 1;
  secrets.set(name, value);
  console.log(`\nSaved ${name} in the OS keychain.`);
  return 0;
}

async function run(
  runner: Runner,
  prompt: string,
  values: { workspace?: string | undefined; agent: string },
): Promise<number> {
  const ws = pickWorkspace(runner.workspaces.list(), values.workspace);
  const terminal = attachTerminal(runner, { input: process.stdin, output: process.stdout });
  const interrupt = () => void runner.tasks.stopAll();
  process.once("SIGINT", interrupt);
  try {
    const id = runner.tasks.create({ workspaceId: ws.id, agent: values.agent, prompt });
    console.log(`Started ${id} in ${ws.name} with ${values.agent}. Ctrl-C or \`stop\` stops it.`);
    const task = await runner.tasks.whenFinished(id);
    return task.state === "done" ? 0 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    terminal.close();
  }
}

function pickWorkspace(list: Workspace[], wanted?: string): Workspace {
  if (wanted) {
    const ws = list.find((w) => w.id === wanted || w.name === wanted);
    if (!ws)
      throw new Error(`No registered workspace called ${wanted}. See \`malves workspace list\`.`);
    return ws;
  }
  const cwd = realpathSync(process.cwd());
  const here = list.find((w) => w.path === cwd);
  if (here) return here;
  if (list.length === 1 && list[0]) return list[0];
  throw new Error("Choose a workspace with --workspace (see `malves workspace list`).");
}

function print(response: ControlResponse, success?: string): number {
  if (!response.ok) {
    console.error(response.error);
    return 1;
  }
  if (success) console.log(success);
  else if (response.data !== undefined) console.log(JSON.stringify(response.data, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
