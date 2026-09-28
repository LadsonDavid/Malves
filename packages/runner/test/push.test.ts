import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { commandId } from "@malves/protocol";
// @ts-expect-error http_ece ships no types
import ece from "http_ece";
import { afterEach, describe, expect, it } from "vitest";
import { allowedEndpoint, type PushPayload } from "../src/adapters/push/webpush.js";
import type { Served } from "../src/serve.js";
import { connect, pairPhone, sleep, startServed } from "./helpers.js";

/** A stand-in for ntfy: records what it receives, which should be ciphertext only. */
function fakePushService() {
  const received: Array<{ body: Buffer; headers: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks), headers: req.headers });
      res.writeHead(201).end();
    });
  });
  return new Promise<{ url: string; received: typeof received; close(): void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/upTEST?up=1`,
        received,
        close: () => server.close(),
      });
    });
  });
}

/** The phone's Web Push keys, as the UnifiedPush connector would generate them. */
function phonePushKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    subscription: (endpoint: string) => ({
      endpoint,
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    }),
    decrypt: (body: Buffer) =>
      JSON.parse(
        ece
          .decrypt(body, {
            version: "aes128gcm",
            privateKey: ecdh,
            authSecret: auth.toString("base64url"),
          })
          .toString(),
      ) as PushPayload,
  };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("push through a UnifiedPush endpoint", () => {
  it("sends the question encrypted to the phone, and clears it when answered", async () => {
    const push = await fakePushService();
    cleanups.push(() => push.close());
    const { served, ws }: { served: Served; ws: { id: string } } = await startServed();
    cleanups.push(() => served.stop());

    const phone = await pairPhone(served);
    const keys = phonePushKeys();
    const link = connect(served, phone);
    cleanups.push(() => link.client.stop());
    const welcome = await link.welcomed();
    expect(welcome.vapid_public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/);

    await link.client.send({
      t: "push.register",
      id: commandId(),
      subscription: keys.subscription(push.url),
    });
    await link.client.send({
      t: "task.create",
      id: commandId(),
      workspace_id: ws.id,
      agent: "demo",
      prompt: "push test",
    });

    const opened = await link.next((e) => e.type === "question.opened");
    for (let i = 0; i < 100 && push.received.length === 0; i++) await sleep(20);
    expect(push.received).toHaveLength(1);
    const first = push.received[0]!;

    // The push service sees only ciphertext…
    expect(first.body.toString("latin1")).not.toContain("malves-demo");
    expect(first.headers["content-encoding"]).toBe("aes128gcm");
    expect(String(first.headers.authorization)).toMatch(/^vapid t=/);
    expect(first.headers.urgency).toBe("high");

    // …and the phone can read it.
    const payload = keys.decrypt(first.body);
    if (payload.kind !== "question" || opened.type !== "question.opened") throw new Error();
    expect(payload).toMatchObject({
      runner: served.runner.identity.runnerId,
      q: opened.data.question_id,
      choices: [
        { id: "allow", label: "Allow" },
        { id: "reject", label: "Skip" },
      ],
    });
    expect(payload.text).toContain("malves-demo.txt");

    await link.client.send({
      t: "answer",
      id: commandId(),
      question_id: opened.data.question_id,
      choice_id: "allow",
    });
    for (let i = 0; i < 100 && push.received.length < 2; i++) await sleep(20);
    expect(keys.decrypt(push.received[1]!.body)).toEqual({
      kind: "closed",
      runner: served.runner.identity.runnerId,
      q: opened.data.question_id,
    });
  }, 20_000);

  it("a dead push service changes nothing: the question is still answerable", async () => {
    const { served, ws } = await startServed();
    cleanups.push(() => served.stop());
    const phone = await pairPhone(served);
    served.runner.devices.registerPush(phone.deviceId, {
      endpoint: "http://127.0.0.1:9/nothing-listens-here",
      p256dh: phonePushKeys().subscription("x").p256dh,
      auth: randomBytes(16).toString("base64url"),
    });
    const id = served.runner.tasks.create({ workspaceId: ws.id, agent: "demo", prompt: "x" });
    for (let i = 0; i < 200 && served.runner.questions.pending().length === 0; i++) await sleep(20);
    const q = served.runner.questions.pending()[0]!;
    for (let i = 0; i < 200; i++) {
      if (
        served.runner.log.since(0).some((e) => e.type === "error" && e.data.code === "push_failed")
      )
        break;
      await sleep(20);
    }
    expect(
      served.runner.log.since(0).some((e) => e.type === "error" && e.data.code === "push_failed"),
    ).toBe(true);
    served.runner.questions.answer({
      questionId: q.question_id,
      choiceId: "reject",
      commandId: "c",
    });
    expect((await served.runner.tasks.whenFinished(id)).state).toBe("done");
  }, 20_000);
});

describe("allowedEndpoint", () => {
  it.each([
    ["https://ntfy.sh/upABC?up=1", true],
    ["http://127.0.0.1:8080/up", true],
    ["http://100.101.1.2/up", true],
    ["http://192.168.1.10/up", false],
    ["http://ntfy.sh/up", false],
    ["file:///etc/passwd", false],
    ["not a url", false],
  ])("%s → %s", (endpoint, ok) => {
    expect(allowedEndpoint(endpoint)).toBe(ok);
  });
});
