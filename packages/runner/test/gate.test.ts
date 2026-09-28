import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The gate for real: a separate process, Playwright MCP behind it, headless
 * Chromium, and a local page with a link, a search form and a password field.
 * The test plays the agent (an MCP client) and the runner (the /ask endpoint).
 */

const gateScript = fileURLToPath(new URL("../src/browser-gate.ts", import.meta.url));
/** A Chromium or Chrome binary: MALVES_TEST_CHROMIUM, or this sandbox's pre-installed one. */
const chromium =
  process.env.MALVES_TEST_CHROMIUM ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const PAGE = `<!doctype html><title>Shop</title>
<a href="/next">Next page</a>
<form action="/search"><label>Search <input name="q"></label><button type="submit">Go</button></form>
<form action="/login"><label>Password <input type="password" name="pw"></label></form>`;

let site: Server;
let asker: Server;
let siteUrl = "";
let askUrl = "";
const questions: Array<{ text: string; risk: string }> = [];
let nextAnswer: string | null = "allow";
let client: Client;
let dir = "";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  if (!chromium) return;
  site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/next" ? "<title>Next</title><h1>Second page</h1>" : PAGE);
  });
  siteUrl = await listen(site);
  asker = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer test-token") return res.writeHead(401).end();
      questions.push(JSON.parse(body));
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choice: nextAnswer }));
    });
  });
  askUrl = await listen(asker);
  dir = mkdtempSync(path.join(tmpdir(), "malves-gate-"));

  client = new Client({ name: "test-agent", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", gateScript],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...(process.env as Record<string, string>),
        MALVES_GATE_URL: askUrl,
        MALVES_GATE_TOKEN: "test-token",
        MALVES_WORKSPACE: "/home/me/site",
        MALVES_BROWSER_DIR: dir,
        MALVES_BROWSER_EXECUTABLE: chromium as string,
        // This sandbox runs as root, where Chromium's own sandbox can't start.
        MALVES_BROWSER_NO_SANDBOX: "1",
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  site?.close();
  asker?.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;
const text = (r: CallToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function refOf(label: string): Promise<string> {
  const snapshot = text(await call("browser_read_snapshot", { limit: 6000 }));
  const line = snapshot.split("\n").find((l) => l.includes(label) && l.includes("[ref="));
  const ref = line && /\[ref=([a-z0-9]+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ref for ${label} in:\n${snapshot}`);
  return ref;
}

describe.skipIf(!chromium)("browser gate with a real browser", () => {
  it("hides page scripts from the agent", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_read_snapshot");
    expect(names).not.toContain("browser_evaluate");
    expect(names).not.toContain("browser_run_code_unsafe");
    expect(text(await call("browser_evaluate", { function: "() => document.cookie" }))).toMatch(
      /Refused/,
    );
  });

  it("asks before opening a page on this computer, then keeps the snapshot out of the reply", async () => {
    const result = await call("browser_navigate", { url: siteUrl });
    expect(questions.at(-1)).toMatchObject({ risk: "high" });
    expect(questions.at(-1)?.text).toContain("own computer or home network");
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("browser_read_snapshot");
    expect(text(await call("browser_read_snapshot"))).toContain("Next page");
  }, 60_000);

  it("follows a link without asking", async () => {
    const before = questions.length;
    const ref = await refOf("Next page");
    const result = await call("browser_click", { target: ref, element: "Next page link" });
    expect(result.isError).toBeFalsy();
    expect(questions.length).toBe(before);
    expect(text(await call("browser_read_snapshot"))).toContain("Second page");
    await call("browser_navigate_back");
  }, 60_000);

  it("never types into a password field, and doesn't even ask", async () => {
    const before = questions.length;
    const ref = await refOf("Password");
    const result = await call("browser_type", { target: ref, text: "hunter2" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/password or payment field/);
    expect(questions.length).toBe(before);
  }, 60_000);

  it("asks before typing in the search box, and does nothing when declined", async () => {
    nextAnswer = "deny";
    const ref = await refOf("Search");
    const result = await call("browser_type", { target: ref, text: "shoes", submit: true });
    expect(questions.at(-1)).toMatchObject({ risk: "high" });
    expect(questions.at(-1)?.text).toContain('Type "shoes"');
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/declined/);
    nextAnswer = "allow";
  }, 60_000);

  it("refuses everything once the task has been stopped", async () => {
    nextAnswer = null;
    const ref = await refOf("Search");
    expect(text(await call("browser_type", { target: ref, text: "x" }))).toMatch(/stopped/);
    const before = questions.length;
    expect(text(await call("browser_snapshot"))).toMatch(/stopped/);
    expect(questions.length).toBe(before);
  }, 60_000);
});
