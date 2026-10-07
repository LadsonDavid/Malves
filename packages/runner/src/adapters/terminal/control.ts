import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

/**
 * Typing serve's commands (`pair`, `devices`, `revoke`…) from any terminal
 * while serve runs in the background: `malves console`. Only on 127.0.0.1,
 * only with the secret in the malves data folder, and never from a web page
 * (browsers always send an Origin header; this refuses any request that has one).
 */
export const CONTROL_PORT = 7722;

export async function startControl(o: {
  token: string;
  /** Runs one command line, as if typed into serve. */
  run: (line: string) => void;
  /** Lines serve prints, while a command's output is being collected. */
  listen: (listener: (line: string) => void) => () => void;
  /** Tests use 0 (any free port). */
  port?: number;
}): Promise<Server> {
  const server = createServer((req, res) => {
    const given = Buffer.from(String(req.headers["x-malves-token"] ?? ""));
    const expected = Buffer.from(o.token);
    const allowed =
      req.method === "POST" &&
      req.url === "/run" &&
      req.headers.origin === undefined &&
      given.length === expected.length &&
      timingSafeEqual(given, expected);
    if (!allowed) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      const lines: string[] = [];
      const stop = o.listen((line) => lines.push(line));
      try {
        o.run(String((JSON.parse(body) as { line?: unknown }).line ?? "").slice(0, 1000));
      } catch {
        lines.push("That command didn't work.");
      }
      // Most commands answer at once; some (a QR code, agents) a moment later.
      setTimeout(() => {
        stop();
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(lines.join("\n"));
      }, 1500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? CONTROL_PORT, "127.0.0.1", resolve);
  });
  return server;
}

/** `malves console [command]`: one command, or a prompt for many. */
export async function console_(token: string, oneShot: string[]): Promise<number> {
  const send = async (line: string): Promise<string> => {
    try {
      const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/run`, {
        method: "POST",
        headers: { "x-malves-token": token, "content-type": "application/json" },
        body: JSON.stringify({ line }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? await response.text() : "malves serve refused that.";
    } catch {
      return "malves serve isn't running. Start it with: pnpm malves serve (or autostart start).";
    }
  };
  if (oneShot.length > 0) {
    console.log(await send(oneShot.join(" ")));
    return 0;
  }
  console.log(
    "Connected to malves serve. Type its commands (help, pair, devices…); Ctrl+C to leave.",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "malves> " });
  rl.prompt();
  for await (const line of rl) {
    if (line.trim()) console.log(await send(line.trim()));
    rl.prompt();
  }
  return 0;
}
