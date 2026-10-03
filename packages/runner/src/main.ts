#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { samePath, type Workspace } from "@malves/core";
import { DEFAULT_PORT } from "@malves/protocol";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import { knownAgents } from "./agents.js";
import { serve } from "./serve.js";
import { dataDir, parseDuration, resolveFolder } from "./system.js";
import { openRunner, type Runner } from "./wire.js";

const USAGE = `malves — run coding agents and answer their questions

  malves serve [--host <ip>] [--port ${DEFAULT_PORT}] [--timeout 10m] [--leads <url>]
                                         phone link + terminal; --leads is signalstack
  malves workspace add <folder> [--name <name>]
  malves workspace list
  malves workspace remove <id>
  malves agents
  malves run [--workspace <id|name>] [--agent <name>] [--timeout 10m] <task description…>
  malves log [--since <seq>]

Data is kept in $MALVES_HOME (default ~/.malves).
The lead engine URL can also come from MALVES_LEADS_URL; its UI_KEY from MALVES_LEADS_KEY.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      workspace: { type: "string", short: "w" },
      agent: { type: "string", short: "a", default: "demo" },
      timeout: { type: "string", short: "t", default: "10m" },
      since: { type: "string", default: "0" },
      host: { type: "string" },
      port: { type: "string", default: String(DEFAULT_PORT) },
      leads: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  if (cmd === "agents") {
    for (const [name, c] of knownAgents())
      console.log(`${name.padEnd(8)} ${c.program} ${c.args.join(" ")}`);
    return 0;
  }

  const dir = dataDir();
  const runner = openRunner({ dir, questionTimeoutMs: parseDuration(values.timeout) });
  try {
    switch (cmd) {
      case "serve":
        return await serve(runner, dir, values);
      case "workspace":
        return workspace(runner, sub, rest, values.name);
      case "log": {
        const since = Number(values.since);
        if (!Number.isInteger(since) || since < 0) {
          console.error(`--since must be a whole number, not "${values.since}"`);
          return 1;
        }
        for (const e of runner.log.since(since)) console.log(JSON.stringify(e));
        return 0;
      }
      case "run":
        return await run(runner, [sub, ...rest].filter((s) => s !== undefined).join(" "), values);
      default:
        console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    runner.close();
  }
}

function workspace(runner: Runner, sub: string | undefined, rest: string[], name?: string): number {
  if (sub === "add" && rest[0]) {
    const folder = resolveFolder(rest[0]);
    const ws = runner.workspaces.register(name ?? path.basename(folder), folder);
    console.log(`${ws.id}  ${ws.name}  ${ws.path}`);
    return 0;
  }
  if (sub === "list") {
    const list = runner.workspaces.list();
    if (list.length === 0)
      console.log("No workspaces yet. Add one with `malves workspace add <folder>`.");
    for (const ws of list) console.log(`${ws.id}  ${ws.name}  ${ws.path}`);
    return 0;
  }
  if (sub === "remove" && rest[0]) {
    if (runner.workspaces.remove(rest[0])) return 0;
    console.error(`No workspace ${rest[0]}`);
    return 1;
  }
  console.error(USAGE);
  return 1;
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
  const cwd = resolveFolder(process.cwd());
  const here = list.find((w) => samePath(w.path, cwd));
  if (here) return here;
  if (list.length === 1 && list[0]) return list[0];
  throw new Error("Choose a workspace with --workspace (see `malves workspace list`).");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
