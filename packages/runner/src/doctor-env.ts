import { existsSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import { agentProfiles } from "./agents.js";
import { autostartState } from "./autostart.js";
import { type DoctorEnv, formatChecks, runDoctor } from "./doctor.js";
import { readSecretJson } from "./secure-file.js";
import { runningRunner, tailscaleAddress } from "./system.js";

const NATIVE = { screen: "@nut-tree-fork/nut-js", video: "@roamhq/wrtc" } as const;

/** Files that hold secrets: each must read back as JSON. */
const SECRET_FILES = [
  "runner-key.json",
  "extension-token.json",
  "control-token.json",
  "ide-token.json",
  "push-topic.json",
  "call-tokens.json",
];

/**
 * The real computer. `deep` really loads the native parts (a few seconds, so
 * only for `malves doctor`); otherwise it only checks they're installed, which
 * keeps the running server from stalling while it re-checks itself.
 */
export function realEnv(dataDir: string, deep: boolean): DoctorEnv {
  const require = createRequire(import.meta.url);
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    dataDir,
    env: process.env,
    writable(dir) {
      const probe = path.join(dir, `.write-test-${process.pid}`);
      try {
        writeFileSync(probe, "x");
        rmSync(probe);
        return true;
      } catch {
        return false;
      }
    },
    freeBytes(dir) {
      const info = statfsSync(dir);
      return Number(info.bavail) * Number(info.bsize);
    },
    openDatabase() {
      new Database(":memory:").close();
    },
    async loadNative(what) {
      if (deep) await import(NATIVE[what]);
      else require.resolve(NATIVE[what]);
    },
    damagedSecrets() {
      const present = new Set(readdirSync(dataDir));
      const damaged: string[] = [];
      for (const name of SECRET_FILES) {
        if (!present.has(name)) continue;
        try {
          readSecretJson(path.join(dataDir, name));
        } catch {
          damaged.push(name);
        }
      }
      return damaged;
    },
    tailscale: tailscaleAddress,
    agents() {
      return [...agentProfiles(dataDir)]
        .filter(([name, p]) => name !== "demo" && !p.metered)
        .map(([, p]) => ({
          label: p.label,
          installed: !p.missing,
          hint: p.missing ?? p.signInHint,
        }));
    },
    reach: (url) =>
      fetch(url, { signal: AbortSignal.timeout(3000) }).then(
        () => true,
        () => false,
      ),
    exists: existsSync,
    autostart: autostartState,
    running: () => runningRunner(dataDir),
  };
}

/** `malves doctor`: prints the report; exits 1 if something is broken (not just missing). */
export async function doctorCommand(dataDir: string): Promise<number> {
  console.log("Checking this computer (loading the native parts takes a few seconds)…\n");
  const checks = await runDoctor(realEnv(dataDir, true));
  console.log(formatChecks(checks));
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
