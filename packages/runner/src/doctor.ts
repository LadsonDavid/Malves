import type { Check } from "@malves/protocol";

/**
 * `malves doctor`: is this computer set up, and if not, what to do about it, in
 * plain words. Every check reads the world through `DoctorEnv`, so each one is
 * tested with a made-up computer; `realEnv` (in doctor-env.ts) is the real one.
 *
 * A check that throws becomes a failure of its own line; it never stops the rest.
 */
export type DoctorEnv = {
  nodeVersion: string;
  platform: NodeJS.Platform;
  dataDir: string;
  env: Record<string, string | undefined>;
  writable(dir: string): boolean;
  freeBytes(dir: string): number | undefined;
  /** Opens a throwaway database; throws if SQLite can't load. */
  openDatabase(): void;
  /** Loads a native part (screen control, live video); throws if it can't. */
  loadNative(what: "screen" | "video"): Promise<void>;
  /** Secret files that exist but can't be read back. */
  damagedSecrets(): string[];
  tailscale(): string | undefined;
  agents(): Array<{ label: string; installed: boolean; hint?: string }>;
  /** Whether a web address answers within a few seconds. */
  reach(url: string): Promise<boolean>;
  exists(path: string): boolean;
  autostart(): "on" | "off" | "unknown";
  running(): number | undefined;
};

export const MIN_NODE = [22, 12] as const;

const GB = 1e9;
const MB = 1e6;
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

type Result = Omit<Check, "id" | "label">;
type Definition = [id: string, label: string, run: (e: DoctorEnv) => Result | Promise<Result>];

const ok = (detail: string): Result => ({ status: "ok", detail });
const off = (detail: string, fix?: string): Result => ({
  status: "off",
  detail,
  ...(fix ? { fix } : {}),
});
const warn = (detail: string, fix: string): Result => ({ status: "warn", detail, fix });
const fail = (detail: string, fix: string): Result => ({ status: "fail", detail, fix });

const set = (value: string | undefined) => (value ?? "").trim() !== "";

function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const CHECKS: Definition[] = [
  [
    "node",
    "Node.js",
    (e) =>
      nodeOk(e.nodeVersion)
        ? ok(`Node.js ${e.nodeVersion}`)
        : fail(
            `Node.js ${e.nodeVersion} is too old. malves needs ${MIN_NODE.join(".")} or newer.`,
            "Install the current LTS from nodejs.org, then start malves again.",
          ),
  ],
  [
    "folder",
    "malves folder",
    (e) => {
      if (!e.writable(e.dataDir)) {
        return fail(
          `malves can't write to ${e.dataDir}.`,
          "Check that folder's permissions, or set MALVES_HOME to another folder.",
        );
      }
      const free = e.freeBytes(e.dataDir);
      if (free !== undefined && free < 100 * MB) {
        return fail(
          `Only ${mb(free)} free on the disk.`,
          "Free some space: malves can't save anything when the disk is full.",
        );
      }
      if (free !== undefined && free < GB) {
        return warn(`Only ${mb(free)} free on the disk.`, "Free some space soon.");
      }
      return ok(free === undefined ? "Writable." : `Writable, ${gb(free)} free.`);
    },
  ],
  [
    "database",
    "Memory database",
    (e) => {
      try {
        e.openDatabase();
        return ok("SQLite works.");
      } catch (error) {
        return fail(
          `malves can't open its database (${error instanceof Error ? error.message : String(error)}).`,
          "Run `pnpm install` again; the SQLite part didn't install for this computer.",
        );
      }
    },
  ],
  [
    "secrets",
    "Keys and tokens",
    (e) => {
      const damaged = e.damagedSecrets();
      return damaged.length === 0
        ? ok("All readable.")
        : fail(
            `Damaged: ${damaged.join(", ")}.`,
            "Delete the damaged file from the malves folder; malves makes a new one (phones may need to pair again).",
          );
    },
  ],
  [
    "phone-link",
    "Phone connection",
    (e) => {
      const address = e.tailscale();
      if (address) return ok(`Phones connect through Tailscale (${address}).`);
      if (set(e.env.MALVES_RELAY_URL)) return ok("Phones connect through your relay.");
      return warn(
        "Only phones on the same Wi-Fi can connect.",
        "Install Tailscale on this computer and the phone (same account), or set up a relay.",
      );
    },
  ],
  [
    "agents",
    "Coding agents",
    (e) => {
      const agents = e.agents();
      const installed = agents.filter((a) => a.installed).map((a) => a.label);
      const missing = agents.filter((a) => !a.installed);
      if (installed.length === 0) {
        return fail(
          "No coding agent is installed.",
          missing[0]?.hint ?? "Install Claude Code or Codex, then sign in.",
        );
      }
      if (missing.length > 0) {
        return warn(
          `Installed: ${installed.join(", ")}. Not installed: ${missing.map((a) => a.label).join(", ")}.`,
          missing[0]?.hint ?? "Install it if you want to use it.",
        );
      }
      return ok(`Installed: ${installed.join(", ")}.`);
    },
  ],
  [
    "notifications",
    "Notifications",
    (e) =>
      e.tailscale()
        ? ok("Questions and results can notify the phone (ntfy over Tailscale).")
        : warn(
            "No notifications: they need Tailscale.",
            "Install Tailscale on this computer and the phone.",
          ),
  ],
  [
    "brain",
    "Malves (assistant)",
    async (e) => {
      const url = e.env.MALVES_MODELS_URL;
      if (!set(url)) {
        return off(
          "Off: voice uses basic commands only.",
          "Set MALVES_MODELS_URL and MALVES_MODELS_KEY to turn it on.",
        );
      }
      return (await e.reach(url as string))
        ? ok("The brain answers.")
        : warn(
            "The brain doesn't answer, so Malves falls back to basic commands.",
            "Check that the server is running and that Tailscale is on.",
          );
    },
  ],
  [
    "vault",
    "Memory folder",
    (e) => {
      const vault = e.env.MALVES_VAULT;
      if (!set(vault)) return off("Not set: Malves keeps no memory.", "Set MALVES_VAULT.");
      return e.exists(vault as string)
        ? ok("Found.")
        : warn(`${vault} doesn't exist.`, "Create the folder, or fix MALVES_VAULT.");
    },
  ],
  [
    "name",
    "Your name",
    (e) =>
      set(e.env.MALVES_USER_NAME)
        ? ok(`Malves calls you ${e.env.MALVES_USER_NAME}.`)
        : set(e.env.MALVES_MODELS_URL)
          ? warn(
              "Malves doesn't know your name and says “the owner”.",
              "Set MALVES_USER_NAME in .env.",
            )
          : off("Not set (only matters once Malves is on)."),
  ],
  [
    "voice",
    "Natural voice",
    (e) => {
      const found = [
        set(e.env.CARTESIA_API_KEY) ? "Cartesia" : "",
        set(e.env.ELEVENLABS_API_KEY) ? "ElevenLabs" : "",
        set(e.env.MALVES_PIPER_URL) ? "Piper" : "",
      ].filter(Boolean);
      if (found.length > 0) return ok(`Available: ${found.join(", ")}.`);
      return set(e.env.MALVES_MODELS_URL)
        ? warn(
            "No natural voice: Malves speaks with the phone's robotic voice.",
            "Add CARTESIA_API_KEY or ELEVENLABS_API_KEY (both have a free tier), or MALVES_PIPER_URL.",
          )
        : off("Not set.");
    },
  ],
  [
    "calls",
    "Calls",
    (e) => {
      const key = e.env.MALVES_FCM_KEY;
      if (!set(key))
        return off("Not set up: Malves can't ring the phone.", "See the README: Calls.");
      return e.exists(key as string)
        ? ok("Firebase key found.")
        : warn(`${key} doesn't exist.`, "Fix MALVES_FCM_KEY, or remove it.");
    },
  ],
  [
    "screen",
    "Screen control",
    async (e) => {
      try {
        await e.loadNative("screen");
        return ok("Loaded.");
      } catch {
        return warn(
          "Screen control didn't load: handover mode and the phone's screen control won't work.",
          "Run `pnpm install` again on this computer.",
        );
      }
    },
  ],
  [
    "video",
    "Live screen video",
    async (e) => {
      try {
        await e.loadNative("video");
        return ok("Loaded.");
      } catch {
        return warn(
          "Live video didn't load: the phone shows pictures of the screen instead.",
          "Run `pnpm install` again on this computer.",
        );
      }
    },
  ],
  [
    "autostart",
    "Start at login",
    (e) => {
      if (e.platform !== "win32") return off("Only offered on Windows for now.");
      const state = e.autostart();
      if (state === "on") return ok("malves starts by itself when you log in.");
      return off("malves doesn't start by itself.", "Run `pnpm malves autostart on` once.");
    },
  ],
  [
    "running",
    "malves is running",
    (e) => {
      const pid = e.running();
      return pid === undefined ? off("Not running right now.") : ok(`Running (process ${pid}).`);
    },
  ],
];

export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  return Promise.all(
    CHECKS.map(async ([id, label, run]): Promise<Check> => {
      try {
        return { id, label, ...(await run(env)) };
      } catch (error) {
        return {
          id,
          label,
          status: "fail",
          detail: `The check itself failed: ${error instanceof Error ? error.message : String(error)}`,
          fix: "Run `malves doctor` again; if it repeats, report it.",
        };
      }
    }),
  );
}

const MARK: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗", off: "–" };

/** The report `malves doctor` prints. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = checks.flatMap((c) => [
    `${MARK[c.status]} ${c.label.padEnd(width)}  ${c.detail}`,
    ...(c.fix && c.status !== "ok" ? [`  ${" ".repeat(width)}  Fix: ${c.fix}`] : []),
  ]);
  const problems = checks.filter((c) => c.status === "warn" || c.status === "fail").length;
  lines.push(
    "",
    problems === 0 ? "All set." : `${problems} thing${problems === 1 ? "" : "s"} to look at.`,
  );
  return lines.join("\n");
}

/** What isn't working, one short sentence each (for the phone's Home screen). */
export function degradedLines(checks: Check[]): string[] {
  return checks
    .filter((c) => c.status === "warn" || c.status === "fail")
    .map((c) => `${c.label}: ${c.detail}`);
}
