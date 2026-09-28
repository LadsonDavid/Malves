import type { AgentRun } from "@malves/core";
import type { RunExtras } from "./adapters/acp/host.js";
import { startLinkServer } from "./adapters/link/server.js";
import { tailscaleAddress } from "./adapters/link/tailscale.js";
import type { Secrets } from "./adapters/secrets/secrets.js";
import { attachTerminal } from "./adapters/terminal/terminal.js";
import type { AgentSpec } from "./agents.js";
import { startControlServer } from "./control.js";
import { openRunner, type Runner } from "./wire.js";

export type ServeOptions = {
  dir: string;
  questionTimeoutMs: number;
  /** "host:port". Defaults to this machine's Tailscale address, port 7420. */
  listen?: string;
  /** Show events and accept answers in this terminal too. */
  terminal?: boolean;
  agents?: AgentSpec[];
  secrets?: Secrets;
};

export type Served = { runner: Runner; linkUrl: string; stop(): Promise<void> };

export const DEFAULT_PORT = 7420;

/** Runs the runner as a long-lived process: the phone link plus local control. */
export async function serve(o: ServeOptions): Promise<Served> {
  const listen = await resolveListen(o.listen);
  const extras: Array<(run: AgentRun) => RunExtras | Promise<RunExtras>> = [];
  const runner = openRunner({
    dir: o.dir,
    questionTimeoutMs: o.questionTimeoutMs,
    extras,
    ...(o.agents ? { agents: o.agents } : {}),
    ...(o.secrets ? { secrets: o.secrets } : {}),
  });
  const cleanups: Array<() => unknown> = [];
  try {
    const link = await startLinkServer(
      {
        core: runner,
        keyPair: runner.identity.keyPair,
        runnerId: runner.identity.runnerId,
        name: runner.name,
        agents: () => runner.agentInfo(),
      },
      listen,
    );
    cleanups.push(() => link.close());

    const control = await startControlServer(runner, { linkUrl: link.url });
    cleanups.push(() => control.close());

    if (o.terminal) {
      const terminal = attachTerminal(runner, { input: process.stdin, output: process.stdout });
      cleanups.push(() => terminal.close());
    }

    return {
      runner,
      linkUrl: link.url,
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
