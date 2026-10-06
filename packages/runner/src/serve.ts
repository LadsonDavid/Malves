import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@malves/protocol";
import qrcode from "qrcode-terminal";
import { startBackups } from "./adapters/assistant/backup.js";
import { assistantFromEnv } from "./adapters/assistant/setup.js";
import { startWatcher } from "./adapters/assistant/watcher.js";
import { BrowserBridge } from "./adapters/browser/bridge.js";
import { BrowserTools } from "./adapters/browser/tools.js";
import { IdeBridge } from "./adapters/ide/bridge.js";
import { ideControl } from "./adapters/ide/control.js";
import { startDigest } from "./adapters/leads/digest.js";
import { signalstack } from "./adapters/leads/signalstack.js";
import { RelayClient } from "./adapters/link/relay-client.js";
import { LinkServer } from "./adapters/link/server.js";
import { NtfyPush } from "./adapters/push/ntfy.js";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import { transcriberFromEnv } from "./adapters/voice/whisper.js";
import { agentProfiles } from "./agents.js";
import {
  extensionToken,
  ideToken,
  lanAddresses,
  pushTopic,
  resolveFolder,
  runnerKeys,
  tailscaleAddress,
} from "./system.js";
import type { Runner } from "./wire.js";

const HELP = `Commands while serving:
  pair            show a new pairing QR code (valid 2 minutes)
  pair text       the same code as text, to paste into an emulator
  agents          check which agents are ready (e.g. after signing in)
  push            notifications: status and how to set them up
  push new        new notification topic (cuts off every subscribed phone)
  extension       how to connect Chrome, and its code
  ide             how to connect VS Code, Cursor, Antigravity or Windsurf
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
  o: {
    host?: string | undefined;
    port: string;
    leads?: string | undefined;
    relay?: string | undefined;
  },
): Promise<number> {
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`--port must be a port number, not "${o.port}"`);
    return 1;
  }
  const host = o.host ?? tailscaleAddress() ?? "127.0.0.1";
  const computer = hostname();
  // Notifications are plain JSON to the ntfy app, so only over Tailscale's encrypted network.
  const push =
    host === tailscaleAddress() ? new NtfyPush(runner, { host, topic: pushTopic(dir) }) : undefined;
  const relayUrl = o.relay ?? process.env.MALVES_RELAY_URL;
  const relayToken = process.env.MALVES_RELAY_TOKEN ?? "";
  if (relayUrl && (!/^wss?:\/\/\S+$/.test(relayUrl) || relayToken.length < 24)) {
    console.error(
      "--relay needs a wss:// address and MALVES_RELAY_TOKEN (the same long secret as on the relay).",
    );
    return 1;
  }
  const keys = runnerKeys(dir);
  const relay = relayUrl
    ? new RelayClient({
        relay: relayUrl,
        token: relayToken,
        key: keys.publicKey,
        // `server` is created just below; phones only arrive after it has started.
        adopt: (ws) => server.accept(ws),
        onStatus: (on) =>
          console.log(on ? "Relay connected." : "Relay disconnected; reconnecting…"),
      })
    : undefined;
  const leadsUrl = o.leads ?? process.env.MALVES_LEADS_URL;
  if (leadsUrl && !URL.canParse(leadsUrl)) {
    console.error(
      `--leads must be the lead engine URL, e.g. http://127.0.0.1:8000, not "${leadsUrl}"`,
    );
    return 1;
  }
  const leads = leadsUrl
    ? signalstack({ url: leadsUrl, key: process.env.MALVES_LEADS_KEY })
    : undefined;
  // IDEs (VS Code, Cursor, Antigravity, Windsurf) with malves' extension connect here.
  const profiles = agentProfiles(dir);
  const label = (agent: string) => profiles.get(agent)?.label ?? agent;
  const ides = new IdeBridge(runner, { token: ideToken(dir), agentLabel: label });
  const idesOn = await ides
    .start()
    .then(() => true)
    .catch((error: unknown) => {
      console.log(
        `IDE bridge couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    });
  let ideNames = "";
  ides.onChange((list) => {
    const now = list.map((w) => w.app).join(", ");
    if (now !== ideNames) console.log(now ? `IDEs connected: ${now}.` : "No IDE connected.");
    ideNames = now;
  });
  const ideCtl = idesOn
    ? ideControl(ides, {
        workspaces: () => runner.workspaces.list(),
        workspace: (id) => runner.workspaces.get(id),
        changedFiles: (taskId) => runner.changedFiles(taskId),
        agentLabel: label,
      })
    : undefined;
  // Malves, the assistant: its brain on your freellmapi, its memory in your Obsidian vault.
  const malves = assistantFromEnv({
    core: runner,
    dataDir: dir,
    agents: () => runner.agents.list(),
    ide: ideCtl,
    leads: leads ? () => leads.fetch() : undefined,
  });
  const server = new LinkServer(runner, {
    host,
    port,
    keys,
    publicUrl: relay?.phoneUrl,
    computer,
    agents: runner.agents,
    pushLink: () => (pushOn ? push?.subscribeLink : undefined),
    listSessions: (agent, workspaceId) => runner.listSessions(agent, workspaceId),
    diff: (taskId) => runner.diff(taskId),
    transcriber: transcriberFromEnv(),
    ide: ideCtl,
    assistant: malves?.port,
    leads,
  });
  const say = (line: string) => console.log(line);
  let pushOn = false;
  if (push) {
    try {
      await push.start();
      runner.usePush(push);
      pushOn = true;
    } catch (error) {
      say(
        `Notifications couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // A revoked phone may still have the ntfy app subscribed: cut it off too.
  const stopRenewing = runner.log.subscribe((event) => {
    if (event.type === "device.revoked" && push) push.renew(pushTopic(dir, true));
  });
  const url = await server.start();
  const stopActivity = runner.onActivity((taskId, text) => server.activity(taskId, text));
  relay?.start();
  const stopDigest =
    leads && pushOn && push
      ? startDigest({ leads, dir, notify: (title, message) => push.notify(title, message) })
      : () => {};
  const stopWatcher =
    pushOn && push
      ? startWatcher({
          subscribe: (listener) => runner.log.subscribe(listener),
          task: (id) => runner.tasks.get(id),
          label: (agent) => runner.agents.list().find((a) => a.name === agent)?.label ?? agent,
          notify: (title, message, click) => push.notify(title, message, click),
          quietHours: process.env.MALVES_QUIET_HOURS,
        })
      : () => {};
  const backupTarget = process.env.MALVES_BACKUP_SSH;
  const vault = process.env.MALVES_VAULT;
  const stopBackups =
    malves && backupTarget && vault
      ? startBackups(
          {
            vault,
            dataDir: dir,
            target: backupTarget,
            ...(process.env.MALVES_BACKUP_SSH_KEY
              ? { sshKey: process.env.MALVES_BACKUP_SSH_KEY }
              : {}),
          },
          say,
        )
      : () => {};

  say(`malves is serving ${computer} at ${url}`);
  say(
    malves
      ? `Malves (assistant): on — memory in ${process.env.MALVES_VAULT}.`
      : "Malves (assistant): off (set MALVES_MODELS_URL, MALVES_MODELS_KEY and MALVES_VAULT).",
  );
  if (leadsUrl) say(`Leads come from ${new URL(leadsUrl).origin}.`);
  say(
    pushOn
      ? "Notifications: on (type `push` to set up the phone)."
      : "Notifications: off (they need Tailscale).",
  );
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
      bridge.onChange((on) => {
        say(on ? "Chrome connected." : "Chrome disconnected.");
        server.setChrome(on);
      });
      server.setChrome(bridge.connected);
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

  const showPush = () => {
    if (!pushOn || !push) {
      say(
        "Notifications are off. They need Tailscale: start malves with Tailscale running on this computer.",
      );
      return;
    }
    say(
      [
        "Notifications are on. On your phone:",
        "  1. Install the ntfy app (Google Play or F-Droid).",
        '  2. In the malves app, tap "Set up notifications" — or add this in ntfy by hand:',
        `     ${push.subscribeUrl}`,
        "  3. In ntfy, allow notifications, and let it run in the background.",
      ].join("\n"),
    );
  };

  const checkAgents = () => {
    say("Checking which agents are ready…");
    void runner.agents.checkAll().then(() => say(describeAgents(runner.agents.list())));
  };

  const commands: Record<string, (args: string[]) => void> = {
    help: () => say(HELP),
    agents: () => checkAgents(),
    ide: () => {
      const vsix = fileURLToPath(new URL("../../ide/malves.vsix", import.meta.url));
      say(
        [
          "",
          "Connect an IDE (VS Code, Cursor, Antigravity, Windsurf) — once per IDE:",
          "  1. Build the extension (once): pnpm --filter malves-ide package",
          "  2. In the IDE: Extensions panel → ⋯ → Install from VSIX… and choose:",
          `     ${vsix}`,
          '  3. It connects by itself while malves serve runs (look for "malves" in the status bar).',
          "",
          `Connected now: ${
            ides
              .list()
              .map((w) => `${w.app} (${w.folders.map((f) => path.basename(f)).join(", ")})`)
              .join("; ") || "none"
          }.`,
        ].join("\n"),
      );
    },
    push: ([mode]) => {
      if (mode === "new" && push) {
        push.renew(pushTopic(dir, true));
        say("New notification topic made; phones must set up notifications again.");
      }
      showPush();
    },
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
  relay?.close();
  await server.close();
  stopRenewing();
  malves?.close();
  await ides.close();
  stopActivity();
  stopDigest();
  stopWatcher();
  stopBackups();
  await push?.close();
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
