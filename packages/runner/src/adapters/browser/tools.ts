import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type * as acp from "@agentclientprotocol/sdk";
import type { Core } from "@malves/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Browser } from "./bridge.js";

/** The tool server's name, as agents see it (e.g. `mcp__malves-browser__browser_click`). */
export const TOOL_SERVER_NAME = "malves-browser";

const ALLOW_DENY = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Don't allow" },
];
const MAX_BODY = 1024 * 1024;

type Page = { url: string; title: string };
type Snapshot = Page & {
  text: string;
  elements: Array<{
    ref: string;
    role: string;
    label: string;
    href?: string;
    value?: string;
    sensitive?: boolean;
  }>;
};
type TaskBrowsing = {
  taskId: string;
  /** Sites the user has let this task use. */
  allowed: Set<string>;
  /** What each ref was called in the last snapshot, for the questions on the phone. */
  labels: Map<string, string>;
};

/**
 * Browser tools for agents (§5), served as an MCP server on 127.0.0.1. Each
 * task gets its own unguessable URL, and every tool goes through the gate:
 *
 * - a site this task hasn't used yet → the phone is asked first (reading too:
 *   it's the user's logged-in Chrome);
 * - every click, type, choice and Enter → the phone is asked first;
 * - password and card fields → refused by the extension, always.
 *
 * Questions go through `tasks.ask`, so silence stops the task (R3).
 */
export class BrowserTools {
  private server: Server | undefined;
  private port = 0;
  private readonly byToken = new Map<string, TaskBrowsing>();
  private readonly tokenOf = new Map<string, string>();

  constructor(
    private readonly core: Core,
    private readonly browser: Browser,
  ) {
    core.log.subscribe((event) => {
      if (
        event.type === "task.updated" &&
        ["done", "failed", "stopped"].includes(event.data.state)
      ) {
        this.forget(event.data.task_id);
      }
    });
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.port = (server.address() as AddressInfo).port;
  }

  /** The tool server for one task, in the form ACP's `session/new` takes. */
  serversFor(taskId: string): acp.McpServer[] {
    if (!this.server) return [];
    let token = this.tokenOf.get(taskId);
    if (!token) {
      token = randomBytes(24).toString("base64url");
      this.tokenOf.set(taskId, token);
      this.byToken.set(token, { taskId, allowed: new Set(), labels: new Map() });
    }
    return [
      {
        type: "http",
        name: TOOL_SERVER_NAME,
        url: `http://127.0.0.1:${this.port}/mcp/${token}`,
        headers: [],
      },
    ];
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private forget(taskId: string): void {
    const token = this.tokenOf.get(taskId);
    if (!token) return;
    this.tokenOf.delete(taskId);
    this.byToken.delete(token);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = (req.url ?? "").match(/^\/mcp\/([\w-]+)$/)?.[1];
    const browsing = token ? this.byToken.get(token) : undefined;
    if (!browsing) {
      res.writeHead(404).end();
      return;
    }
    const body = req.method === "POST" ? await readJson(req) : undefined;

    // Stateless: one MCP server per request, bound to this task.
    const mcp = this.toolsFor(browsing);
    // No sessionIdGenerator: that is the SDK's stateless mode.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      // A web page can't reach this through DNS rebinding: only our own host name.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${this.port}`],
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK's own transport type trips our exactOptionalPropertyTypes; it is the right type.
    await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
    await transport.handleRequest(req, res, body);
  }

  private toolsFor(browsing: TaskBrowsing): McpServer {
    const mcp = new McpServer({ name: TOOL_SERVER_NAME, version: "0.1.0" });
    const { taskId } = browsing;

    const ask = async (question: string, risk: "medium" | "high") =>
      (await this.core.tasks.ask(taskId, {
        kind: "browser_action",
        text: question,
        choices: ALLOW_DENY,
        risk,
      })) === "allow";

    /** The current tab's page; asks before this task first uses its site. */
    const pageInAllowedSite = async (verb: string): Promise<Page | string> => {
      const page = (await this.browser.call("info")) as Page;
      const site = siteOf(page.url);
      if (!site) return `This tab (${page.url}) isn't a web page malves can use.`;
      if (browsing.allowed.has(site)) return page;
      if (!(await ask(`Let the agent ${verb} ${site}?\n${clip(page.title)}`, "medium"))) {
        return DECLINED;
      }
      browsing.allowed.add(site);
      return page;
    };

    const label = (ref: string) => browsing.labels.get(ref) ?? `element ${ref}`;

    const run = async (fn: () => Promise<string>) => {
      try {
        return text(await fn());
      } catch (error) {
        return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
      }
    };

    mcp.registerTool(
      "browser_snapshot",
      {
        description:
          "Read the page in the user's current Chrome tab: its address, title, text, and the links, buttons and fields on it, each with a ref for the other browser tools. Call this before clicking or typing, and again after the page changes.",
      },
      () =>
        run(async () => {
          const page = await pageInAllowedSite("read");
          if (typeof page === "string") return page;
          const snap = (await this.browser.call("snapshot")) as Snapshot;
          browsing.labels = new Map(
            snap.elements.map((e) => [e.ref, `${e.role} "${clip(e.label, 60)}"`]),
          );
          return describe(snap);
        }),
    );

    mcp.registerTool(
      "browser_navigate",
      {
        description: "Open a web address (http or https) in the user's current Chrome tab.",
        inputSchema: { url: z.string().describe("The full address, e.g. https://example.com") },
      },
      ({ url }) =>
        run(async () => {
          const site = siteOf(url);
          if (!site) return "Only http and https addresses can be opened.";
          if (!browsing.allowed.has(site)) {
            if (!(await ask(`Let the agent open ${clip(url, 120)}?`, "medium"))) return DECLINED;
            browsing.allowed.add(site);
          }
          await this.browser.call("navigate", { url });
          return `Opened ${url}. Call browser_snapshot to read it.`;
        }),
    );

    mcp.registerTool(
      "browser_click",
      {
        description: "Click a link or button, by its ref from browser_snapshot.",
        inputSchema: { ref: z.string() },
      },
      ({ ref }) =>
        run(async () => {
          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;
          if (!(await ask(`Click the ${label(ref)} on ${siteOf(page.url)}?`, "high"))) {
            return DECLINED;
          }
          await this.browser.call("click", { ref });
          return "Clicked. Call browser_snapshot to see the result.";
        }),
    );

    mcp.registerTool(
      "browser_type",
      {
        description:
          "Type text into a field, by its ref from browser_snapshot. Set submit to press Enter afterwards. Password and card fields are always refused.",
        inputSchema: { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
      },
      ({ ref, text: typed, submit }) =>
        run(async () => {
          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;
          const then = submit ? " and submit it" : "";
          const question = `Type "${clip(typed, 80)}" into the ${label(ref)} on ${siteOf(page.url)}${then}?`;
          if (!(await ask(question, "high"))) return DECLINED;
          const result = (await this.browser.call("type", {
            ref,
            text: typed,
            submit: !!submit,
          })) as { refused?: string } | undefined;
          return result?.refused ?? "Typed. Call browser_snapshot to see the result.";
        }),
    );

    mcp.registerTool(
      "browser_select",
      {
        description: "Choose an option in a drop-down, by its ref from browser_snapshot.",
        inputSchema: { ref: z.string(), value: z.string() },
      },
      ({ ref, value }) =>
        run(async () => {
          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;
          const question = `Choose "${clip(value, 60)}" in the ${label(ref)} on ${siteOf(page.url)}?`;
          if (!(await ask(question, "high"))) return DECLINED;
          await this.browser.call("select", { ref, value });
          return "Chosen.";
        }),
    );

    mcp.registerTool(
      "browser_press",
      {
        description: "Press a key in the page: Enter, Tab, Escape, ArrowUp or ArrowDown.",
        inputSchema: { key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"]) },
      },
      ({ key }) =>
        run(async () => {
          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;
          // Enter can submit a form: that's an action, so it's asked.
          const question = `Press Enter on ${siteOf(page.url)}? It may submit a form.`;
          if (key === "Enter" && !(await ask(question, "high"))) return DECLINED;
          await this.browser.call("press", { key });
          return `Pressed ${key}.`;
        }),
    );

    mcp.registerTool(
      "browser_scroll",
      {
        description: "Scroll the current page up or down by most of a screen.",
        inputSchema: { direction: z.enum(["up", "down"]) },
      },
      ({ direction }) =>
        run(async () => {
          const page = await pageInAllowedSite("read");
          if (typeof page === "string") return page;
          await this.browser.call("scroll", { direction });
          return `Scrolled ${direction}. Call browser_snapshot to read the page.`;
        }),
    );

    mcp.registerTool(
      "browser_back",
      { description: "Go back to the previous page in the current tab." },
      () =>
        run(async () => {
          await this.browser.call("back");
          return "Went back. Call browser_snapshot to read the page.";
        }),
    );

    return mcp;
  }
}

const DECLINED =
  "The user didn't allow that. Don't try it again; explain in your reply what you wanted to do.";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** "https://github.com" for an http(s) address; undefined for anything else. */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Web pages choose these words: one line, and short, before they reach the phone. */
function clip(value: string, max = 100): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describe(snap: Snapshot): string {
  const elements = snap.elements.map((e) => {
    if (e.sensitive) {
      return `[${e.ref}] ${e.role} "${clip(e.label, 60)}" (password/card field: malves never types here)`;
    }
    const extra = e.href ? ` → ${e.href}` : e.value ? ` = "${clip(e.value, 40)}"` : "";
    return `[${e.ref}] ${e.role} "${clip(e.label, 80)}"${extra}`;
  });
  return [
    `Page: ${snap.title}`,
    `Address: ${snap.url}`,
    "",
    "Elements:",
    ...(elements.length ? elements : ["(none)"]),
    "",
    "Text:",
    snap.text,
  ].join("\n");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
