#!/usr/bin/env node
/**
 * A tiny ACP agent for demos and tests, with no model and no API key. It asks
 * permission to write one file, then writes it through the client's (confined)
 * file access. Set MALVES_DEMO_FILE to choose the path it asks to write, and
 * MALVES_DEMO_AUTH=required to make it act like an agent that isn't signed in,
 * or MALVES_DEMO_AUTH=key to require an `authenticate` with method "demo-key".
 */
import { isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const target = process.env.MALVES_DEMO_FILE ?? "malves-demo.txt";
let signedIn = false;

acp
  .agent({ name: "malves-demo-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.authenticate, ({ params }) => {
    // For tests: accept only the "demo-key" method, like Antigravity's API-key sign-in.
    if (params.methodId !== "demo-key") throw acp.RequestError.authRequired();
    signedIn = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, () => {
    // For tests: behave like an agent that isn't signed in (e.g. Claude before /login),
    // or one that needs an explicit `authenticate` first (e.g. Antigravity).
    const auth = process.env.MALVES_DEMO_AUTH;
    if (auth === "required" || (auth === "key" && !signedIn)) throw acp.RequestError.authRequired();
    return { sessionId: crypto.randomUUID() };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId, cwd } = { sessionId: params.sessionId, cwd: process.cwd() };
    const say = (text: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const prompt = params.prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    const path = isAbsolute(target) ? target : join(cwd, target);

    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "write-1",
        title: `Write ${target}`,
        kind: "edit",
        status: "pending",
        locations: [{ path }],
      },
    });

    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: "write-1",
        title: `Write ${target}`,
        kind: "edit",
        locations: [{ path }],
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Skip", kind: "reject_once" },
      ],
    });

    if (permission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
    if (permission.outcome.optionId !== "allow") {
      await say("Skipped writing the file.");
      return { stopReason: "end_turn" };
    }

    await client.request(acp.methods.client.fs.writeTextFile, {
      sessionId,
      path,
      content: `Written by the malves demo agent.\nTask: ${prompt}\n`,
    });
    await say(`Wrote ${target}.`);
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
