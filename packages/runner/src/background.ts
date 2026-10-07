import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runningRunner } from "./system.js";

/**
 * `malves serve --background`: runs serve with no window at all (output goes to
 * ~/.malves/serve.log) and starts it again if it crashes. Autostart uses this,
 * so nothing pops up at login; `malves console` talks to it.
 */
export async function supervise(dataDir: string, serveArgs: string[]): Promise<number> {
  // Already running (a serve you started by hand, or this one): leave it alone.
  const running = runningRunner(dataDir);
  if (running !== undefined) {
    console.log(`malves is already running (pid ${running}). Nothing to start.`);
    return 0;
  }
  const log = path.join(dataDir, "serve.log");
  // The last run's log is kept beside the new one.
  if (existsSync(log)) renameSync(log, path.join(dataDir, "serve.previous.log"));
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopping = true;
    });
  }
  for (let crashes = 0; !stopping; ) {
    const out = openSync(log, "a");
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      // windowsHide: no console window, not even Windows Terminal's.
      const child = spawn(process.execPath, [main, "serve", ...serveArgs], {
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: process.env,
      });
      const stop = () => child.kill();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      child.once("error", () => resolve(1));
      child.once("exit", (exitCode) => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve(exitCode);
      });
    });
    closeSync(out);
    if (stopping || code === 0) return 0;
    // Someone else started serve meanwhile: theirs wins.
    if (runningRunner(dataDir) !== undefined) return 0;
    // A crash right after starting, again and again, is a setup problem: stop trying after 5.
    crashes = Date.now() - started < 60_000 ? crashes + 1 : 0;
    if (crashes >= 5) return 1;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return 0;
}
