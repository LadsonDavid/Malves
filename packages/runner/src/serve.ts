import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@malves/protocol";
import qrcode from "qrcode-terminal";
import { BrowserBridge } from "./adapters/browser/bridge.js";
import { BrowserTools } from "./adapters/browser/tools.js";
import { LinkServer } from "./adapters/link/server.js";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import {
  extensionToken,
  lanAddresses,
  resolveFolder,
  runnerKeys,
  tailscaleAddress,
} from "./system.js";
import type { Runner } from "./wire.js";

const HELP = `Commands while serving:
  pair            show a new pairing QR code (valid 2 minutes)
  pair text       the same code as text, to paste into an emulator
  agents          check which agents are ready (e.g. after signing in)
  extension       how to connect Chrome, and its code
  extension new   replace the Chrome code (shuts out the old one)
  devices         list paired phones
  revoke <id>     unpair a phone immediately (lost phone)
  add <folder>    register a project folder the phone can start tasks in
  1, 2, …         answer the open question from this terminal
  stop            stop every running task`;

/**
 * Long-running mode: the phone link plus a terminal on the desktop. The desktop
 * always wins — `revoke` and `stop` work here even when the phone is gone (§8).
 */
export async function serve(
  runner: Runner,
  dir: string,
  o: { host?: string | undefined; port: string },
): Promise<number> {
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`--port must be a port number, not "${o.port}"`);
    return 1;
  }
  const host = o.host ?? tailscaleAddress() ?? "127.0.0.1";
  const computer = hostname();
  const server = new LinkServer(runner, {
    host,
    port,
    keys: runnerKeys(dir),
    computer,
    agents: runner.agents,
  });
  const url = await server.start();
  const say = (line: string) => console.log(line);

  say(`malves is serving ${computer} at ${url}`);
  if (host === "127.0.0.1") {
    say("\nOnly this computer can reach it. For your phone:");
    say("  • install Tailscale on both devices (works anywhere), or");
    for (const ip of lanAddresses()) say(`  • on the same Wi-Fi: malves serve --host ${ip}`);
  }

  // Chrome: the extension connects to 127.0.0.1 only; agents get the gated tools.
  let token = extensionToken(dir);
  let bridge = new BrowserBridge({ token });
  const tools = new BrowserTools(runner, {
    get connected() {
      return bridge.connected;
    },
    call: (op, args) => bridge.call(op, args),
  });
  await tools.start();
  runner.useBrowserTools(tools);
  const startBridge = async () => {
    try {
      await bridge.start();
      bridge.onChange((on) => say(on ? "Chrome connected." : "Chrome disconnected."));
    } catch (error) {
      say(
        `Chrome bridge couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await startBridge();

  const showExtension = () => {
    const folder = fileURLToPath(new URL("../../extension", import.meta.url));
    say(
      [
        "",
        "Connect Chrome (once):",
        "  1. In Chrome, open chrome://extensions and turn on Developer mode.",
        `  2. Click "Load unpacked" and choose: ${folder}`,
        "  3. Click the malves icon in Chrome's toolbar and paste this code:",
        "",
        `     ${token}`,
        "",
        `Chrome is ${bridge.connected ? "connected" : "not connected yet"}.`,
      ].join("\n"),
    );
  };

  const showPairing = () => {
    const offer = server.offerPairing();
    qrcode.generate(JSON.stringify(offer), { small: true }, (qr) => say(`\n${qr}`));
    say("Scan this with the malves app within 2 minutes. Type `pair` for a fresh code.");
  };

  const checkAgents = () => {
    say("Checking which agents are ready…");
    void runner.agents.checkAll().then(() => say(describeAgents(runner.agents.list())));
  };

  const commands: Record<string, (args: string[]) => void> = {
    help: () => say(HELP),
    agents: () => checkAgents(),
    extension: ([mode]) => {
      if (mode !== "new") return showExtension();
      token = extensionToken(dir, true);
      void bridge.close().then(async () => {
        bridge = new BrowserBridge({ token });
        await startBridge();
        say("New Chrome code made; the old one no longer works.");
        showExtension();
      });
    },
    pair: ([mode]) => {
      if (mode !== "text") return showPairing();
      // For emulators and screens that can't scan: paste this into the app.
      say(JSON.stringify(server.offerPairing()));
      say("Paste that line into the app within 2 minutes.");
    },
    devices: () => {
      const list = runner.devices.list();
      if (list.length === 0) say("No phones paired. Type `pair`.");
      for (const d of list) say(`${d.id}  ${d.name}`);
    },
    revoke: ([id]) => {
      if (id && runner.devices.revoke(id))
        say(`Revoked ${id}. It is disconnected and can't reconnect.`);
      else say("Usage: revoke <device id>  (see `devices`)");
    },
    add: (args) => {
      if (args.length === 0) return say("Usage: add <folder>");
      try {
        const folder = resolveFolder(args.join(" "));
        const ws = runner.workspaces.register(path.basename(folder), folder);
        say(`Added ${ws.name} (${ws.path}).`);
      } catch (error) {
        say(`Can't add that folder: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };

  if (runner.workspaces.list().length === 0) {
    say("\nNo project folders yet. Type `add <folder>` so the phone can start tasks.");
  }
  if (runner.devices.list().length === 0) showPairing();
  else say(`\n${runner.devices.list().length} phone(s) paired. Type \`help\` for commands.`);
  checkAgents();

  const terminal = attachTerminal(
    runner,
    { input: process.stdin, output: process.stdout },
    commands,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  say("\nStopping…");
  await runner.tasks.stopAll();
  await server.close();
  await tools.close();
  await bridge.close();
  terminal.close();
  return 0;
}

const STATE_WORDS: Record<AgentInfo["state"], string> = {
  checking: "checking…",
  ready: "ready",
  needs_sign_in: "needs sign-in",
  unavailable: "not available",
};

/** e.g. "Agents: Demo ready · Claude ready · Codex needs sign-in — On the computer, …" */
function describeAgents(agents: AgentInfo[]): string {
  const summary = agents.map((a) => `${a.label} ${STATE_WORDS[a.state]}`).join(" · ");
  const fixes = agents
    .filter((a) => a.hint)
    .map((a) => `  ${a.label}: ${a.hint}`)
    .join("\n");
  return fixes ? `Agents: ${summary}\n${fixes}` : `Agents: ${summary}`;
}
