import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoggedEvent } from "@malves/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Caller } from "../src/adapters/assistant/caller.js";
import { fcmSender } from "../src/adapters/push/fcm.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "malves-calls-"));
  dirs.push(d);
  return d;
};

function caller(o: { now?: Date; quiet?: string; fail?: boolean } = {}) {
  const sent: Array<{ token: string; data: Record<string, string> }> = [];
  let now = o.now ?? new Date(2026, 9, 8, 12, 0);
  const c = new Caller({
    send: async (token, data) => {
      if (o.fail) throw new Error("UNREGISTERED");
      sent.push({ token, data });
    },
    dataDir: temp(),
    paired: () => ["phone-1"],
    quietHours: o.quiet,
    now: () => now,
  });
  return { c, sent, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("Malves calling your phone", () => {
  it("rings paired phones with only a call id, and says why once you answer", async () => {
    const { c, sent } = caller();
    c.register("phone-1", "tok-1");
    c.register("revoked-phone", "tok-2");
    expect(await c.call("Codex finished the footer.")).toBe("Calling your phone.");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe("tok-1");
    // No content in the push: only what's needed to ring.
    expect(Object.keys(sent[0]?.data ?? {}).sort()).toEqual(["call_id", "type"]);
    const id = sent[0]?.data.call_id ?? "";
    expect(c.answer(id)).toBe("Codex finished the footer.");
    expect(c.answer(id)).toBeUndefined();
  });

  it("keeps the rules: quiet hours, three an hour, no calls today; a test call ignores them", async () => {
    const quiet = caller({ now: new Date(2026, 9, 8, 23, 0), quiet: "22-7" });
    quiet.c.register("phone-1", "t");
    expect(await quiet.c.call("x")).toMatch(/quiet hours/);
    expect(await quiet.c.call("test", true)).toBe("Calling your phone.");

    const { c, later } = caller();
    c.register("phone-1", "t");
    for (let i = 0; i < 3; i++) expect(await c.call("x")).toBe("Calling your phone.");
    expect(await c.call("x")).toMatch(/three calls this hour/);
    later(3_600_001);
    expect(await c.call("x")).toBe("Calling your phone.");
    c.pauseToday();
    expect(await c.call("x")).toMatch(/no calls today/);
  });

  it("says why it couldn't ring, and a call answered too late is over", async () => {
    expect(await caller().c.call("x")).toMatch(/No phone is set up/);
    const failing = caller({ fail: true });
    failing.c.register("phone-1", "t");
    expect(await failing.c.call("x")).toMatch(/Couldn't ring the phone: UNREGISTERED/);

    const { c, sent, later } = caller();
    c.register("phone-1", "t");
    await c.call("x");
    later(601_000);
    expect(c.answer(sent[0]?.data.call_id ?? "")).toBeUndefined();
  });

  it("rings when a task he asked about ends, in code-written words", async () => {
    const { c, sent } = caller();
    c.register("phone-1", "t");
    let emit: (e: LoggedEvent) => void = () => {};
    c.follow({
      subscribe: (l) => {
        emit = l;
        return () => {};
      },
      task: () =>
        ({ id: "t1", agent: "codex", prompt: "fix the footer", state: "failed" }) as never,
      label: () => "Codex",
    });
    c.watch("t1");
    const event = (state: string) =>
      ({ type: "task.updated", data: { task_id: "t1", state, reason: "Tests failed." } }) as never;
    emit(event("running"));
    expect(sent).toHaveLength(0);
    emit(event("failed"));
    await new Promise((r) => setTimeout(r, 0));
    expect(c.answer(sent[0]?.data.call_id ?? "")).toBe(
      "Codex couldn't finish: fix the footer. Tests failed.",
    );
    // Once only.
    emit(event("failed"));
    expect(sent).toHaveLength(1);
  });

  it("signs in to Firebase with the service-account key and sends a data-only, high-priority push", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = path.join(temp(), "key.json");
    writeFileSync(
      keyFile,
      JSON.stringify({
        project_id: "malves-test",
        client_email: "bot@malves-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        token_uri: "https://oauth2.example/token",
      }),
    );
    const calls: Array<{ url: string; body: string; auth?: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init.body),
        auth: (init.headers as Record<string, string>).authorization,
      });
      return String(url).includes("oauth2")
        ? Response.json({ access_token: "at-1", expires_in: 3600 })
        : Response.json({ name: "projects/malves-test/messages/1" });
    });
    const send = fcmSender(keyFile);
    await send("tok-1", { type: "call", call_id: "abc" });
    await send("tok-1", { type: "call", call_id: "def" });

    // One sign-in, reused.
    expect(calls.map((x) => x.url)).toEqual([
      "https://oauth2.example/token",
      "https://fcm.googleapis.com/v1/projects/malves-test/messages:send",
      "https://fcm.googleapis.com/v1/projects/malves-test/messages:send",
    ]);
    const assertion = new URLSearchParams(calls[0]?.body).get("assertion") ?? "";
    const [head, claims, signature] = assertion.split(".");
    expect(
      createVerify("RSA-SHA256")
        .update(`${head}.${claims}`)
        .verify(publicKey, signature ?? "", "base64url"),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toMatchObject({
      iss: "bot@malves-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(calls[1]?.auth).toBe("Bearer at-1");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      message: {
        token: "tok-1",
        data: { type: "call", call_id: "abc" },
        android: { priority: "HIGH", ttl: "60s" },
      },
    });
  });
});
