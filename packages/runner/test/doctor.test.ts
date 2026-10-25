import { describe, expect, it } from "vitest";
import { type DoctorEnv, degradedLines, formatChecks, runDoctor } from "../src/doctor.js";

/** A computer where everything is set up. Each test breaks one thing. */
const healthy = (over: Partial<DoctorEnv> = {}): DoctorEnv => ({
  nodeVersion: "24.11.0",
  platform: "win32",
  dataDir: "C:\\Users\\me\\.malves",
  env: {
    MALVES_MODELS_URL: "http://brain:3001",
    MALVES_VAULT: "C:\\Notes",
    MALVES_USER_NAME: "Ladson",
    CARTESIA_API_KEY: "x",
    MALVES_FCM_KEY: "C:\\fcm.json",
  },
  writable: () => true,
  freeBytes: () => 50e9,
  openDatabase: () => {},
  loadNative: async () => {},
  damagedSecrets: () => [],
  tailscale: () => "100.1.2.3",
  agents: () => [
    { label: "Claude", installed: true },
    { label: "Codex", installed: true },
  ],
  reach: async () => true,
  exists: () => true,
  autostart: () => "on",
  running: () => 4242,
  ...over,
});

const find = (checks: Awaited<ReturnType<typeof runDoctor>>, id: string) => {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
};

describe("doctor", () => {
  it("a fully set up computer has nothing to fix", async () => {
    const checks = await runDoctor(healthy());
    expect(checks.filter((c) => c.status === "warn" || c.status === "fail")).toEqual([]);
    expect(degradedLines(checks)).toEqual([]);
  });

  it("every check has a plain label, a detail, and a fix when it isn't ok", async () => {
    const checks = await runDoctor(
      healthy({
        nodeVersion: "20.1.0",
        tailscale: () => undefined,
        agents: () => [{ label: "Claude", installed: false, hint: "Install Claude Code." }],
      }),
    );
    for (const c of checks) {
      expect(c.label.length).toBeGreaterThan(2);
      expect(c.detail.length).toBeGreaterThan(2);
      if (c.status === "warn" || c.status === "fail") expect(c.fix?.length).toBeGreaterThan(2);
    }
  });

  it("an old Node is a failure that names the version needed", async () => {
    const node = find(await runDoctor(healthy({ nodeVersion: "22.11.0" })), "node");
    expect(node.status).toBe("fail");
    expect(node.detail).toContain("22.12");
    expect(find(await runDoctor(healthy({ nodeVersion: "22.12.0" })), "node").status).toBe("ok");
  });

  it("an unwritable data folder fails; little free space warns", async () => {
    expect(find(await runDoctor(healthy({ writable: () => false })), "folder").status).toBe("fail");
    const low = find(await runDoctor(healthy({ freeBytes: () => 500e6 })), "folder");
    expect(low.status).toBe("warn");
    expect(low.detail).toContain("500 MB");
  });

  it("a database that won't open fails", async () => {
    const env = healthy({
      openDatabase: () => {
        throw new Error("bindings not found");
      },
    });
    const db = find(await runDoctor(env), "database");
    expect(db.status).toBe("fail");
    expect(db.detail).toContain("bindings not found");
  });

  it("a damaged secret file fails and names it", async () => {
    const secrets = find(
      await runDoctor(healthy({ damagedSecrets: () => ["push-topic.json"] })),
      "secrets",
    );
    expect(secrets.status).toBe("fail");
    expect(secrets.detail).toContain("push-topic.json");
  });

  it("the phone link: Tailscale or a relay is fine, neither warns", async () => {
    expect(find(await runDoctor(healthy()), "phone-link").status).toBe("ok");
    const relay = healthy({
      tailscale: () => undefined,
      env: { MALVES_RELAY_URL: "wss://relay.example" },
    });
    expect(find(await runDoctor(relay), "phone-link").status).toBe("ok");
    const none = find(
      await runDoctor(healthy({ tailscale: () => undefined, env: {} })),
      "phone-link",
    );
    expect(none.status).toBe("warn");
    expect(none.detail).toContain("same Wi-Fi");
  });

  it("agents: none installed fails, some missing warns, all fine is ok", async () => {
    const none = healthy({
      agents: () => [{ label: "Claude", installed: false, hint: "Install it." }],
    });
    expect(find(await runDoctor(none), "agents").status).toBe("fail");
    const some = healthy({
      agents: () => [
        { label: "Claude", installed: true },
        { label: "Cursor", installed: false, hint: "Cursor's CLI isn't installed." },
      ],
    });
    const mixed = find(await runDoctor(some), "agents");
    expect(mixed.status).toBe("warn");
    expect(mixed.detail).toContain("Cursor");
    expect(find(await runDoctor(healthy()), "agents").detail).toContain("Claude, Codex");
  });

  it("the brain: off when not set, warns when unreachable, ok when reachable", async () => {
    expect(find(await runDoctor(healthy({ env: {} })), "brain").status).toBe("off");
    expect(find(await runDoctor(healthy({ reach: async () => false })), "brain").status).toBe(
      "warn",
    );
    expect(find(await runDoctor(healthy()), "brain").status).toBe("ok");
  });

  it("voice: warns about the robotic voice only when Malves is on without a natural voice", async () => {
    const on = { MALVES_MODELS_URL: "http://brain:3001" };
    expect(find(await runDoctor(healthy({ env: on })), "voice").status).toBe("warn");
    expect(find(await runDoctor(healthy({ env: {} })), "voice").status).toBe("off");
    expect(find(await runDoctor(healthy()), "voice").status).toBe("ok");
  });

  it("calls: off when not set, warns when the key file is missing", async () => {
    expect(find(await runDoctor(healthy({ env: {} })), "calls").status).toBe("off");
    expect(find(await runDoctor(healthy({ exists: () => false })), "calls").status).toBe("warn");
  });

  it("optional parts that fail to load warn but name what still works", async () => {
    const env = healthy({
      loadNative: async (what) => {
        if (what === "video") throw new Error("no wrtc");
      },
    });
    const video = find(await runDoctor(env), "video");
    expect(video.status).toBe("warn");
    expect(video.detail).toContain("pictures");
  });

  it("autostart is only offered on Windows", async () => {
    expect(find(await runDoctor(healthy({ autostart: () => "off" })), "autostart").status).toBe(
      "off",
    );
    const linux = find(await runDoctor(healthy({ platform: "linux" })), "autostart");
    expect(linux.status).toBe("off");
    expect(linux.detail).toContain("Windows");
  });

  it("a check that throws becomes a failure instead of stopping the rest", async () => {
    const env = healthy({
      freeBytes: () => {
        throw new Error("disk gone");
      },
    });
    const checks = await runDoctor(env);
    expect(find(checks, "folder").status).toBe("fail");
    expect(find(checks, "node").status).toBe("ok");
  });

  it("formats a readable report and lists only real problems as degraded", async () => {
    const checks = await runDoctor(healthy({ tailscale: () => undefined, env: {} }));
    const text = formatChecks(checks);
    expect(text).toContain("Phone connection");
    expect(text).toContain("Fix:");
    const lines = degradedLines(checks);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.length < 200)).toBe(true);
  });
});
