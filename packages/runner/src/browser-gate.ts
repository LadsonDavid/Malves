#!/usr/bin/env node
/**
 * The browser gate (§5): an MCP server the agent talks to instead of
 * Playwright's. It runs as its own process — a hung browser can't stall the
 * runner — and starts Playwright MCP behind it with a fresh in-memory profile
 * (no saved logins), headless, writing snapshots to a per-task directory.
 *
 * Every tool call goes through policy.ts. When a call needs a person, the gate
 * asks the runner, which asks the phone through questions.ask(). Silence means
 * the task is stopped, and after that the gate refuses everything.
 *
 * Configuration comes from the environment the runner sets:
 *   MALVES_GATE_URL, MALVES_GATE_TOKEN   where to ask, and this task's token
 *   MALVES_WORKSPACE                     uploads must come from here
 *   MALVES_BROWSER_DIR                   per-task directory for snapshots
 *   MALVES_BROWSER_EXECUTABLE            optional browser binary
 *   MALVES_BROWSER_NO_SANDBOX=1          only for root containers (tests)
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type ElementInfo,
  EXPOSED_TOOLS,
  judge,
  type Risk,
} from "./adapters/browser_gate/policy.js";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`browser gate: ${name} is not set`);
  return value;
};

const gateUrl = env("MALVES_GATE_URL");
const token = env("MALVES_GATE_TOKEN");
const workspace = env("MALVES_WORKSPACE");
const outputDir = env("MALVES_BROWSER_DIR");

const INLINE_LIMIT = 6000;
let halted = false;
let lastSnapshot = "";

// ---- upstream: Playwright MCP --------------------------------------------------

const require = createRequire(import.meta.url);
const playwrightCli = require
  .resolve("@playwright/mcp/package.json")
  .replace(/package\.json$/, "cli.js");
const upstreamArgs = [
  playwrightCli,
  "--headless",
  "--isolated",
  "--output-dir",
  outputDir,
  "--timeout-navigation",
  "30000",
  "--timeout-action",
  "5000",
];
if (process.env.MALVES_BROWSER_EXECUTABLE) {
  upstreamArgs.push("--executable-path", process.env.MALVES_BROWSER_EXECUTABLE);
}
if (process.env.MALVES_BROWSER_NO_SANDBOX === "1") upstreamArgs.push("--no-sandbox");

const upstream = new Client({ name: "malves-browser-gate", version: "0.1.0" });
await upstream.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: upstreamArgs,
    cwd: outputDir,
    stderr: "ignore",
  }),
);
const upstreamTools = (await upstream.listTools()).tools;

// ---- asking the runner ------------------------------------------------------------

async function askRunner(text: string, risk: Risk): Promise<boolean> {
  const response = await fetch(`${gateUrl}/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text, risk }),
  });
  if (!response.ok) throw new Error(`runner answered ${response.status}`);
  const { choice } = (await response.json()) as { choice: string | null };
  if (choice === null) halted = true;
  return choice === "allow";
}

// ---- inspecting an element, without reading its value ------------------------------

const INSPECT = `(el) => {
  const form = el.closest ? el.closest("form") : null;
  const label = (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  const isButton = el.tagName === "INPUT" && ["submit", "button"].includes((el.type || "").toLowerCase());
  return {
    tag: el.tagName,
    type: (el.getAttribute("type") || "").toLowerCase(),
    autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: String(label).slice(0, 80),
    text: String(isButton ? el.value : (el.innerText || "")).slice(0, 80),
    href: el.tagName === "A" ? el.href : "",
    inForm: Boolean(form),
  };
}`;

async function inspect(target: string): Promise<ElementInfo | undefined> {
  if (!target) return undefined;
  try {
    const result = (await upstream.callTool({
      name: "browser_evaluate",
      arguments: { target, function: INSPECT },
    })) as CallToolResult;
    if (result.isError) return undefined;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const match = /### Result\n([\s\S]*?)(\n### |$)/.exec(text);
    return match ? (JSON.parse(match[1] as string) as ElementInfo) : undefined;
  } catch {
    return undefined;
  }
}

// ---- keeping big snapshots out of the agent's context --------------------------------

async function compact(result: CallToolResult): Promise<CallToolResult> {
  const content = [];
  for (const item of result.content) {
    if (item.type !== "text") {
      content.push(item);
      continue;
    }
    let text = item.text;
    // Playwright links snapshot files relative to its working directory (outputDir).
    const link = /\[Snapshot\]\(([^)]+)\)/.exec(text);
    if (link) {
      const file = path.resolve(outputDir, link[1] as string);
      if (!path.relative(outputDir, file).startsWith("..")) {
        lastSnapshot = await readFile(file, "utf8").catch(() => "");
        text = text.replace(
          link[0],
          `(page snapshot saved, ${lastSnapshot.length} characters; read it with browser_read_snapshot)`,
        );
      }
    }
    if (text.length > INLINE_LIMIT) {
      lastSnapshot = text;
      text = `${text.slice(0, INLINE_LIMIT)}\n… (${text.length - INLINE_LIMIT} more characters; use browser_read_snapshot with offset ${INLINE_LIMIT})`;
    }
    content.push({ ...item, text });
  }
  return { ...result, content };
}

const readSnapshotTool: Tool = {
  name: "browser_read_snapshot",
  description:
    "Read the latest page snapshot (accessibility tree with element refs) in pages. " +
    "Snapshots are kept out of tool results to save tokens.",
  inputSchema: {
    type: "object",
    properties: {
      offset: { type: "number", description: "Character offset to start from (default 0)" },
      limit: {
        type: "number",
        description: `Characters to return (default and max ${INLINE_LIMIT})`,
      },
    },
  },
  annotations: { readOnlyHint: true },
};

// ---- the MCP server the agent sees --------------------------------------------------

const refused = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

const server = new Server(
  { name: "malves-browser", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "A web browser behind an approval gate. Reading pages and following links is free. " +
      "Clicking buttons, typing and submitting forms ask the user first and may be declined. " +
      "Password and payment fields are never filled: tell the user that step needs them.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...upstreamTools.filter((t) => EXPOSED_TOOLS.has(t.name)), readSnapshotTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (halted) return refused("The task was stopped. No further browser actions.");
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  if (name === "browser_read_snapshot") {
    const offset = Math.max(0, Number(args.offset ?? 0));
    const limit = Math.min(INLINE_LIMIT, Math.max(1, Number(args.limit ?? INLINE_LIMIT)));
    const page = lastSnapshot.slice(offset, offset + limit);
    const rest = lastSnapshot.length - offset - page.length;
    return {
      content: [
        {
          type: "text",
          text: page + (rest > 0 ? `\n… (${rest} more; next offset ${offset + page.length})` : ""),
        },
      ],
    };
  }

  const verdict = await judge(name, args, inspect, workspace);
  if (verdict.action === "refuse") return refused(verdict.reason);
  if (verdict.action === "ask") {
    let allowed: boolean;
    try {
      allowed = await askRunner(verdict.text, verdict.risk);
    } catch (error) {
      return refused(`Could not get approval (${String(error)}). Nothing was done.`);
    }
    if (halted) return refused("The task was stopped. No further browser actions.");
    if (!allowed) return refused("The user declined this action. Nothing was done.");
  }
  const result = (await upstream.callTool({ name, arguments: verdict.args })) as CallToolResult;
  return compact(result);
});

await server.connect(new StdioServerTransport());

const shutdown = () => {
  void upstream.close().finally(() => process.exit(0));
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
