import { clickRef, pressKey, scrollPage, selectRef, snapshotPage, typeRef } from "./page.js";

/**
 * malves' Chrome extension (§5). Connects to malves on this computer only, and
 * does what malves' browser tools ask — in the tab that's open, as Claude in
 * Chrome does. Every action was already approved on the phone before it gets
 * here; password and card fields are refused in the page itself.
 */

const RUNNER = "ws://127.0.0.1:7718";

type Status = "no-code" | "connecting" | "connected" | "offline" | "wrong-code";

let socket: WebSocket | undefined;
let status: Status = "offline";
let retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

async function savedCode(): Promise<string | undefined> {
  const { code } = await chrome.storage.local.get("code");
  return typeof code === "string" && code ? code : undefined;
}

async function connect(): Promise<void> {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  clearTimeout(retry);
  const code = await savedCode();
  if (!code) {
    status = "no-code";
    return;
  }
  status = "connecting";
  const ws = new WebSocket(RUNNER);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: code }));
  ws.onmessage = (event) => void handle(ws, String(event.data));
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = undefined;
    if (event.code === 4001) {
      status = "wrong-code"; // Don't retry with a code malves rejected.
      return;
    }
    status = "offline";
    // Capped backoff: malves may simply not be running yet.
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    retry = setTimeout(() => void connect(), delay);
  };
}

async function handle(ws: WebSocket, data: string): Promise<void> {
  let message: { type?: string; id?: string; op?: string; args?: Record<string, unknown> };
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message.type === "ready") {
    status = "connected";
    attempt = 0;
    return;
  }
  if (message.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (message.type !== "call" || typeof message.id !== "string") return;
  try {
    const value = await run(message.op ?? "", message.args ?? {});
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, value }));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: text }));
  }
}

/** The tab that's open in the window used last. */
async function activeTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("No Chrome tab is open.");
  return tab as chrome.tabs.Tab & { id: number };
}

/** Runs one of the page functions in the open tab. */
async function inPage<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<R> {
  const tab = await activeTab();
  if (!/^https?:/.test(tab.url ?? "")) {
    throw new Error(`Chrome doesn't let extensions work on this tab (${tab.url ?? "unknown"}).`);
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fn,
    args,
  });
  const result = injection?.result as R & { error?: string };
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(result.error);
  }
  return result;
}

/** Resolves when the tab has finished loading (or after 45 s). */
function loaded(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, change: { status?: string }) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, 45_000);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function run(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "info": {
      const tab = await activeTab();
      return { url: tab.url ?? "", title: tab.title ?? "" };
    }
    case "snapshot":
      return inPage(snapshotPage);
    case "navigate": {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url))
        throw new Error("Only http and https addresses can be opened.");
      const tab = await activeTab();
      const done = loaded(tab.id);
      await chrome.tabs.update(tab.id, { url });
      await done;
      return {};
    }
    case "back": {
      const tab = await activeTab();
      const done = loaded(tab.id);
      await chrome.tabs.goBack(tab.id);
      await done;
      return {};
    }
    case "click":
      return inPage(clickRef, String(args.ref));
    case "type":
      return inPage(typeRef, String(args.ref), String(args.text ?? ""), args.submit === true);
    case "select":
      return inPage(selectRef, String(args.ref), String(args.value ?? ""));
    case "press":
      return inPage(pressKey, String(args.key));
    case "scroll":
      return inPage(scrollPage, args.direction === "up" ? "up" : "down");
    default:
      throw new Error(`Unknown operation: ${op}`);
  }
}

// The popup asks for the status, and tells us when the code changes.
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, reply) => {
  if (message.type === "reconnect") {
    attempt = 0;
    socket?.close();
    socket = undefined;
    void connect().then(() => reply({ status }));
    return true;
  }
  reply({ status });
  return false;
});

// Chrome stops idle extension workers; an alarm brings this one back to reconnect.
chrome.alarms.create("malves-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
