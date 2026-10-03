#!/usr/bin/env node
/**
 * A tiny ACP agent for demos and tests, with no model and no API key. It asks
 * permission to write one file, then writes it through the client's (confined)
 * file access. Set MALVES_DEMO_FILE to choose the path it asks to write, and
 * MALVES_DEMO_AUTH=required to make it act like an agent that isn't signed in,
 * or MALVES_DEMO_AUTH=key to require an `authenticate` with method "demo-key".
 * Set MALVES_DEMO_SESSIONS to a JSON file to keep conversations between runs,
 * so they can be listed and continued (`session/list`, `session/resume`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const target = process.env.MALVES_DEMO_FILE ?? "malves-demo.txt";
let signedIn = false;

type Saved = { sessionId: string; cwd: string; title: string; updatedAt: string; turns: number };
const store = process.env.MALVES_DEMO_SESSIONS;
const saved = (): Saved[] =>
  store && existsSync(store) ? (JSON.parse(readFileSync(store, "utf8")) as Saved[]) : [];
const live = new Map<string, Saved>();
function save(session: Saved): void {
  live.set(session.sessionId, session);
  if (store) {
    const others = saved().filter((s) => s.sessionId !== session.sessionId);
    writeFileSync(store, JSON.stringify([...others, session]));
  }
}
function find(sessionId: string): Saved {
  const session = live.get(sessionId) ?? saved().find((s) => s.sessionId === sessionId);
  if (!session) throw acp.RequestError.invalidParams({ sessionId }, "Unknown session");
  live.set(sessionId, session);
  return session;
}

acp
  .agent({ name: "malves-demo-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities:
        process.env.MALVES_DEMO_RESUME === "load-only" ? { list: {} } : { list: {}, resume: {} },
    },
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
    const sessionId = crypto.randomUUID();
    live.set(sessionId, { sessionId, cwd: process.cwd(), title: "", updatedAt: "", turns: 0 });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.list, ({ params }) => ({
    sessions: saved()
      .filter((s) => !params.cwd || s.cwd === params.cwd)
      .map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt })),
  }))
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    find(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    const session = find(params.sessionId);
    // Like a real agent: replay the conversation before answering.
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `(replayed: ${session.title})` },
      },
    });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId, cwd } = { sessionId: params.sessionId, cwd: process.cwd() };
    const say = (text: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const prompt = params.prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    const session = find(sessionId);
    session.turns += 1;
    session.title ||= prompt.slice(0, 60);
    session.updatedAt = new Date().toISOString();
    save(session);
    if (session.turns > 1) await say(`Turn ${session.turns} of this conversation. `);
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
