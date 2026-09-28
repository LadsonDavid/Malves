import type { AgentRun } from "@malves/core";
import type { RunExtras } from "./adapters/acp/host.js";
import { GateBroker } from "./adapters/browser_gate/broker.js";
import { BudgetGuard } from "./adapters/budget_proxy/guard.js";
import { connectRelay } from "./adapters/link/relay_link.js";
import { startLinkServer } from "./adapters/link/server.js";
import type { SessionContext } from "./adapters/link/session.js";
import { tailscaleAddress } from "./adapters/link/tailscale.js";
import { loadVapid, type Vapid, WebPushNotifier } from "./adapters/push/webpush.js";
import type { Secrets } from "./adapters/secrets/secrets.js";
import { secretsFor } from "./adapters/secrets/secrets.js";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import type { AgentSpec } from "./agents.js";
import { agentCatalog } from "./agents.js";
import { guardConfig, loadConfig, userAgents } from "./config.js";
import { startControlServer } from "./control.js";
import { openRunner, type Runner } from "./wire.js";

export type ServeOptions = {
  dir: string;
  questionTimeoutMs: number;
  /** "host:port". Defaults to this machine's Tailscale address, port 7420 (topology A). */
  listen?: string;
  /** Topology B: dial out to the owner's relay. Defaults to config.json + keychain token. */
  relay?: { url: string; token: string };
  /** Show events and accept answers in this terminal too. */
  terminal?: boolean;
  agents?: AgentSpec[];
  secrets?: Secrets;
  /** Send questions as Web Push to paired phones (default on). */
  push?: boolean;
  /** Budget guard upstreams; defaults to config.json (§6). */
  guard?: import("./adapters/budget_proxy/guard.js").GuardConfig;
  /** Browser gate options (§5). */
  browser?: {
    executable?: string;
    noSandbox?: boolean;
    gateCommand?: { command: string; args: string[] };
  };
};

export type Served = {
  runner: Runner;
  /** The address that goes into the pairing QR code. */
  linkUrl: string;
  stop(): Promise<void>;
};

export const DEFAULT_PORT = 7420;

/** Runs the runner as a long-lived process: the phone link plus local control. */
export async function serve(o: ServeOptions): Promise<Served> {
  const extras: Array<(run: AgentRun) => RunExtras | Promise<RunExtras>> = [];
  const config = loadConfig(o.dir);
  const secrets = o.secrets ?? secretsFor(o.dir);
  const relay = o.relay ?? relayFromConfig(config, secrets);
  // Topology A listens on the tailnet; B only dials out, unless --listen asks for both.
  const listen = o.listen || !relay ? await resolveListen(o.listen) : undefined;
  const agents = o.agents ?? [...agentCatalog(), ...userAgents(config)];
  const styles = new Map(agents.map((a) => [a.name, a.budget]));
  let vapid: Vapid | undefined;
  let pusher: WebPushNotifier | undefined;
  const runner = openRunner({
    dir: o.dir,
    questionTimeoutMs: o.questionTimeoutMs,
    extras,
    ...(o.push === false
      ? {}
      : {
          notifier: (ctx) => {
            vapid = loadVapid(ctx.secrets);
            pusher = new WebPushNotifier({
              devices: () => ctx.core().devices.list(),
              runnerId: ctx.identity.runnerId,
              name: ctx.name,
              vapid,
            });
            return pusher;
          },
        }),
    agents,
    secrets,
    budget: { floor: config.budget.floor },
  });
  const cleanups: Array<() => unknown> = [];
  try {
    const broker = new GateBroker({
      core: () => runner,
      ...(o.browser?.executable ? { browserExecutable: o.browser.executable } : {}),
      ...(o.browser?.noSandbox ? { noSandbox: true } : {}),
      ...(o.browser?.gateCommand ? { gateCommand: o.browser.gateCommand } : {}),
    });
    await broker.start();
    cleanups.push(() => broker.close());
    extras.push((run) => broker.extrasFor(run));

    const guard = new BudgetGuard(() => runner, o.guard ?? guardConfig(config, secrets));
    await guard.start();
    cleanups.push(() => guard.close());
    extras.push((run) => guard.extrasFor(run, styles.get(run.agent)));

    // Clear a question's notification once it's answered, times out or is cancelled.
    const push = pusher;
    if (push) {
      cleanups.push(
        runner.log.subscribe((event) => {
          if (event.type === "question.closed") {
            push.questionClosed(event.data.question_id).catch(() => {});
          }
        }),
      );
    }
    const ctx: SessionContext = {
      core: runner,
      keyPair: runner.identity.keyPair,
      runnerId: runner.identity.runnerId,
      name: runner.name,
      agents: () => runner.agentInfo(),
      ...(vapid ? { vapidPublicKey: vapid.publicKey } : {}),
    };
    let inviteUrl = "";
    if (listen) {
      const link = await startLinkServer(ctx, listen);
      cleanups.push(() => link.close());
      inviteUrl = link.url;
    }
    if (relay) {
      const viaRelay = connectRelay(ctx, relay);
      cleanups.push(() => viaRelay.close());
      inviteUrl = viaRelay.phoneUrl;
    }

    const control = await startControlServer(runner, { linkUrl: inviteUrl });
    cleanups.push(() => control.close());

    if (o.terminal) {
      const terminal = attachTerminal(runner, { input: process.stdin, output: process.stdout });
      cleanups.push(() => terminal.close());
    }

    return {
      runner,
      linkUrl: inviteUrl,
      async stop() {
        await runner.tasks.stopAll("The computer's runner was shut down.");
        for (const cleanup of cleanups.reverse()) await cleanup();
        runner.close();
      },
    };
  } catch (error) {
    for (const cleanup of cleanups.reverse()) await cleanup();
    runner.close();
    throw error;
  }
}

function relayFromConfig(
  config: ReturnType<typeof loadConfig>,
  secrets: Secrets,
): { url: string; token: string } | undefined {
  if (!config.relay) return undefined;
  const token = secrets.get(config.relay.token);
  if (!token) {
    throw new Error(
      `config.json names a relay, but the keychain has no ${config.relay.token}. ` +
        `Run \`malves secret set ${config.relay.token}\` with the relay's token.`,
    );
  }
  return { url: config.relay.url, token };
}

async function resolveListen(listen?: string): Promise<{ host: string; port: number }> {
  if (listen) {
    const at = listen.lastIndexOf(":");
    const host = listen.slice(0, at).replace(/^\[|\]$/g, "");
    const port = Number(listen.slice(at + 1));
    if (at < 0 || !host || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--listen must be host:port, e.g. 127.0.0.1:${DEFAULT_PORT}`);
    }
    if (host === "0.0.0.0" || host === "::") {
      throw new Error("Refusing to listen on every interface. Use the Tailscale address.");
    }
    return { host, port };
  }
  const ip = await tailscaleAddress();
  if (!ip) {
    throw new Error(
      "Tailscale is not running on this computer, so the phone can't reach it. Start Tailscale " +
        "(https://tailscale.com/download), or use a relay (topology B), or pass --listen " +
        `127.0.0.1:${DEFAULT_PORT} to try it on this machine only.`,
    );
  }
  return { host: ip, port: DEFAULT_PORT };
}
