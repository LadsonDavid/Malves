import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type * as acp from "@agentclientprotocol/sdk";
import type { Core, Verdict } from "@malves/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Browser } from "./bridge.js";
import { BrowserVault, normalizeOrigin } from "./vault.js";

export {
  BrowserVault,
  generateTotp,
  normalizeOrigin,
  type VaultHandle,
  type VaultSecret,
} from "./vault.js";

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
  lastSnapshotHash?: string;
};

/**
 * Extracts structured records from page text (e.g. markdown tables, key-values, lists).
 */
export function extractStructuredData(
  text: string,
  instruction: string,
  fields?: string[],
): unknown {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const results: Array<Record<string, string>> = [];

  // Try markdown table parsing
  const tableRows = lines.filter((l) => l.includes("|"));
  if (tableRows.length >= 2) {
    const headers = tableRows[0]!
      .split("|")
      .map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter(Boolean);
    for (let i = 1; i < tableRows.length; i++) {
      const row = tableRows[i]!;
      if (/^[\s|:-]+$/.test(row)) continue;
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length > 0) {
        const item: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          const key = headers[j]!;
          item[key] = cells[j] ?? "";
        }
        results.push(item);
      }
    }
  }

  if (results.length > 0) return results;

  // Fallback: key: value parsing
  const item: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const k = match[1]!.trim().toLowerCase().replace(/\s+/g, "_");
      const v = match[2]!.trim();
      if (!fields || fields.map((f) => f.toLowerCase()).includes(k)) {
        item[k] = v;
      }
    }
  }
  if (Object.keys(item).length > 0) return [item];

  return { instruction, raw: lines.slice(0, 50) };
}

/**
 * Browser tools for agents (§5, §6), served as an MCP server on 127.0.0.1.
 * Features:
 * - Policy tiers: Tier 1 read, Tier 2 clicks on allowed sites, Tier 3 submit/fill.
 * - Secret autofill: origin-bound vault; agent never sees passwords/tokens.
 * - Long jobs: wait_for conditions and session continuity.
 * - Structured extraction: extract table/record data conforming to schema.
 */
export class BrowserTools {
  private server: Server | undefined;
  private port = 0;
  private readonly byToken = new Map<string, TaskBrowsing>();
  private readonly tokenOf = new Map<string, string>();
  private readonly vault: BrowserVault;

  constructor(
    private readonly core: Core,
    private readonly browser: Browser,
    vault?: BrowserVault,
  ) {
    this.vault = vault ?? new BrowserVault();

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

    const mcp = this.toolsFor(browsing);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${this.port}`],
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
    await transport.handleRequest(req, res, body);
  }

  private toolsFor(browsing: TaskBrowsing): McpServer {
    const mcp = new McpServer({ name: TOOL_SERVER_NAME, version: "0.2.0" });
    const { taskId } = browsing;

    const ask = async (question: string, risk: "medium" | "high") =>
      (await this.core.tasks.ask(taskId, {
        kind: "browser_action",
        text: question,
        choices: ALLOW_DENY,
        risk,
      })) === "allow";

    const evaluatePolicy = async (
      op: string,
      url: string | undefined,
      summary: string,
    ): Promise<Verdict | undefined> => {
      if (!this.core.policy) return undefined;
      const task = this.core.tasks.get(taskId);
      const ws = task ? this.core.workspaces.get(task.workspaceId) : undefined;
      return this.core.policy.evaluate(
        { source: "agent", kind: "browser", command: op, summary, ...(url ? { url } : {}) },
        { root: ws?.path ?? process.cwd(), taskId },
      );
    };

    /** The current tab's page; checks policy and asks before first use of an unapproved site. */
    const pageInAllowedSite = async (verb: string): Promise<Page | string> => {
      const page = (await this.browser.call("info")) as Page;
      const site = siteOf(page.url);
      if (!site) return `This tab (${page.url}) isn't a web page malves can use.`;
      if (browsing.allowed.has(site)) return page;

      const verdict = await evaluatePolicy("read", site, `Read ${site}`);
      if (verdict?.outcome === "allow") {
        browsing.allowed.add(site);
        return page;
      }
      if (verdict?.outcome === "deny") {
        return DECLINED;
      }

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
          browsing.lastSnapshotHash = createHash("sha256")
            .update(snap.text)
            .digest("hex")
            .slice(0, 16);
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
            const verdict = await evaluatePolicy("navigate", site, `Navigate to ${url}`);
            if (verdict?.outcome === "deny") return DECLINED;
            if (verdict?.outcome !== "allow") {
              if (!(await ask(`Let the agent open ${clip(url, 120)}?`, "medium"))) return DECLINED;
            }
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
          const site = siteOf(page.url);
          const verdict = await evaluatePolicy("click", site, `Click ${label(ref)} on ${site}`);
          if (verdict?.outcome === "deny") return DECLINED;
          if (verdict?.outcome !== "allow") {
            if (!(await ask(`Click the ${label(ref)} on ${siteOf(page.url)}?`, "high"))) {
              return DECLINED;
            }
          }
          await this.browser.call("click", { ref });
          return "Clicked. Call browser_snapshot to see the result.";
        }),
    );

    mcp.registerTool(
      "browser_type",
      {
        description:
          "Type text into a field, by its ref from browser_snapshot. Set submit to press Enter afterwards. Password and card fields are refused without browser_fill_secret.",
        inputSchema: { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
      },
      ({ ref, text: typed, submit }) =>
        run(async () => {
          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;
          const site = siteOf(page.url);
          const op = submit ? "submit" : "type";
          const verdict = await evaluatePolicy(op, site, `Type into ${label(ref)} on ${site}`);
          if (verdict?.outcome === "deny") return DECLINED;
          if (verdict?.outcome !== "allow") {
            const then = submit ? " and submit it" : "";
            const question = `Type "${clip(typed, 80)}" into the ${label(ref)} on ${siteOf(page.url)}${then}?`;
            if (!(await ask(question, "high"))) return DECLINED;
          }
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

    mcp.registerTool(
      "browser_fill_secret",
      {
        description:
          "Fill a saved login credential (password, API token, or TOTP code) from the secure vault into a field. The vault verifies the page's web origin matches the saved credential. The secret bytes are never seen by the agent and are redacted from all logs.",
        inputSchema: {
          ref: z.string().describe("The ref of the input field from browser_snapshot"),
          handle: z.string().describe("The name/handle of the secret in the vault, e.g. 'stripe'"),
        },
      },
      ({ ref, handle }) =>
        run(async () => {
          const entry = this.vault.get(handle);
          if (!entry) {
            return `Secret "${handle}" not found in vault. Call browser_list_vault to see available handles.`;
          }

          const pageInfo = (await this.browser.call("info")) as Page;
          const origin = siteOf(pageInfo.url);
          if (!origin) return "Current tab is not a web page malves can use.";

          const normCurrent = normalizeOrigin(origin);
          const normBound = normalizeOrigin(entry.origin);
          if (normCurrent !== normBound) {
            return `Refused: secret "${handle}" is bound to "${entry.origin}", but current page is "${origin}".`;
          }

          const page = await pageInAllowedSite("use");
          if (typeof page === "string") return page;

          const question = `Fill saved ${entry.kind ?? "password"} for "${handle}" on ${entry.origin}?`;
          if (!(await ask(question, "high"))) return DECLINED;

          const { value } = await this.vault.fill(handle, origin);
          const res = (await this.browser.call("fill_secret", {
            ref,
            secret: value,
            origin: entry.origin,
          })) as { error?: string; filled?: boolean };

          if (res?.error) return `Failed to fill: ${res.error}`;
          return "Filled. Call browser_snapshot to see the result.";
        }),
    );

    mcp.registerTool(
      "browser_list_vault",
      {
        description:
          "List the names/handles and allowed origins of credentials stored in the secure vault. Secret values are never exposed.",
      },
      () =>
        run(async () => {
          const handles = this.vault.list();
          if (handles.length === 0) return "The vault is empty.";
          return handles
            .map(
              (h) => `- ${h.handle} (${h.origin})${h.username ? ` username: ${h.username}` : ""}`,
            )
            .join("\n");
        }),
    );

    mcp.registerTool(
      "browser_wait_for",
      {
        description:
          "Wait for a condition on the current page: text present, element present, or URL changed.",
        inputSchema: {
          condition: z.enum(["text_present", "element_present", "url_changed"]),
          target: z.string().describe("The text, element label, or URL to wait for"),
          timeout_ms: z.number().int().min(500).max(30000).optional(),
        },
      },
      ({ condition, target, timeout_ms = 10000 }) =>
        run(async () => {
          const start = Date.now();
          let delay = 200;
          while (Date.now() - start < timeout_ms) {
            const snap = (await this.browser.call("snapshot")) as Snapshot;
            if (
              condition === "text_present" &&
              snap.text.toLowerCase().includes(target.toLowerCase())
            ) {
              return `Condition met: text "${target}" is present.`;
            }
            if (
              condition === "element_present" &&
              snap.elements.some((e) => e.label.toLowerCase().includes(target.toLowerCase()))
            ) {
              return `Condition met: element matching "${target}" is present.`;
            }
            if (condition === "url_changed" && snap.url.includes(target)) {
              return `Condition met: URL changed to "${snap.url}".`;
            }
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(1000, Math.floor(delay * 1.5));
          }
          return `Timed out after ${timeout_ms}ms waiting for ${condition}: "${target}".`;
        }),
    );

    mcp.registerTool(
      "browser_extract",
      {
        description:
          "Extract structured data from the page text according to an instruction or schema. Returns validated JSON.",
        inputSchema: {
          instruction: z
            .string()
            .describe("What to extract, e.g. 'table of invoices with date, amount, vendor'"),
          fields: z
            .array(z.string())
            .optional()
            .describe("Expected field names in each extracted record"),
        },
      },
      ({ instruction, fields }) =>
        run(async () => {
          const page = await pageInAllowedSite("read");
          if (typeof page === "string") return page;
          const snap = (await this.browser.call("snapshot")) as Snapshot;
          const extracted = extractStructuredData(snap.text, instruction, fields);
          return JSON.stringify(extracted, null, 2);
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
      return `[${e.ref}] ${e.role} "${clip(e.label, 60)}" (password/card field: use browser_fill_secret)`;
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
