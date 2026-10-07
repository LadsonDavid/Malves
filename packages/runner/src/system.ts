import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, networkInterfaces, uptime } from "node:os";
import path from "node:path";
import type { Clock, Ids } from "@malves/core";
import { generateKeyPair, type KeyPair, publicKeyOf } from "@malves/protocol";

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export const randomIds: Ids = {
  next: (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`,
};

export function dataDir(): string {
  const dir = process.env.MALVES_HOME ?? path.join(homedir(), ".malves");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * One runner per data directory. A second one would see the first one's
 * active tasks as abandoned and mark them failed.
 */
export function acquireLock(dir: string): () => void {
  const file = path.join(dir, "runner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${process.pid} ${bootTime()}`);
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = runningRunner(dir);
      if (pid !== undefined) {
        throw new Error(
          `malves is already running (pid ${pid}), maybe in the background. Type its commands with: pnpm malves console`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not lock ${dir}`);
}

/**
 * The pid of the runner holding the lock, if one really is: same boot, still
 * alive, and still Node. Windows reuses pids, and Fast Startup keeps the boot
 * time across "shut down", so the pid alone can point at another program.
 */
export function runningRunner(dir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, "runner.lock"), "utf8");
  } catch {
    return undefined;
  }
  const [pidText, bootText] = text.split(" ");
  const pid = Number.parseInt(pidText ?? "", 10);
  const sameBoot = Math.abs(Number(bootText) - bootTime()) < 120_000;
  return sameBoot && isAlive(pid) && isNode(pid) ? pid : undefined;
}

/** Whether a process is Node (so a reused pid isn't mistaken for malves). */
function isNode(pid: number): boolean {
  const out =
    process.platform === "win32"
      ? spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          windowsHide: true,
        }).stdout
      : spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout;
  // If the check itself can't run, err on the side of "still running".
  return out === undefined || /node/i.test(out);
}

/** When the computer started, to the minute. */
function bootTime(): number {
  return Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The real, absolute path of a folder. `.native` because plain `realpathSync`
 * keeps Windows short names (`C:\PROGRA~1`) while the ACP adapter's `realpath`
 * expands them, and the two would then not match.
 */
export function resolveFolder(folder: string): string {
  return realpathSync.native(path.resolve(folder));
}

/**
 * The runner's own key pair, made on first use.
 *
 * ponytail: kept in the data directory (owner-only on Linux/macOS), not the OS
 * keychain §15 names. Anything running as this user can read it — but such a
 * process can already run the agents directly. Move to the keychain when a
 * stronger local threat model matters.
 */
export function runnerKeys(dir: string): KeyPair {
  const file = path.join(dir, "runner-key.json");
  try {
    const { secretKey } = JSON.parse(readFileSync(file, "utf8")) as { secretKey: string };
    return { secretKey, publicKey: publicKeyOf(secretKey) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keys = generateKeyPair();
    writeFileSync(file, JSON.stringify({ secretKey: keys.secretKey }), { mode: 0o600, flag: "wx" });
    return keys;
  }
}

/**
 * The secret the Chrome extension proves itself with. Made on first use; `renew`
 * replaces it, so an extension set up with the old one is shut out.
 */
export function extensionToken(dir: string, renew = false): string {
  return secret(dir, "extension-token.json", renew);
}

/** The secret `malves console` proves itself with, to a serve running in the background. */
export function controlToken(dir: string): string {
  return secret(dir, "control-token.json", false);
}

/** The secret malves' IDE extension proves itself with; it reads it from this folder. */
export function ideToken(dir: string): string {
  return secret(dir, "ide-token.json", false);
}

/**
 * The secret ntfy topic phones subscribe to for notifications. `renew` replaces
 * it, so a phone subscribed with the old one gets nothing more.
 */
export function pushTopic(dir: string, renew = false): string {
  return secret(dir, "push-topic.json", renew);
}

function secret(dir: string, name: string, renew: boolean): string {
  const file = path.join(dir, name);
  if (!renew) {
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { token: string }).token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  return token;
}

/** This computer's Tailscale address, if it's on a tailnet (they're always in 100.64.0.0/10). */
export function tailscaleAddress(): string | undefined {
  return ipv4Addresses().find(isTailscale);
}

/** Other network addresses a phone on the same Wi-Fi could use. */
export function lanAddresses(): string[] {
  return ipv4Addresses().filter((ip) => !isTailscale(ip));
}

function ipv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** "90s", "10m", "1h", or plain milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`Not a duration: ${text}`);
  const n = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "ms"] ?? 1;
  const ms = n * unit;
  if (ms <= 0) throw new Error("Duration must be positive");
  return ms;
}
