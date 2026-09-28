import type { Core } from "@malves/core";
import {
  type AgentInfo,
  Channel,
  Command,
  type Command as CommandMsg,
  type ErrorCode,
  fromBase64,
  LINK_VERSIONS,
  type LoggedEvent,
  Opening,
  parseFrame,
  type Reply,
  randomBytes,
  toBase64,
  type Wish,
  wishOf,
} from "@malves/protocol";

/** Anything that can carry text frames: a WebSocket, or a stream through the relay. */
export type Transport = {
  send(text: string): void;
  close(): void;
};

export type SessionContext = {
  core: Core;
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  runnerId: string;
  name: string;
  agents: () => AgentInfo[];
  vapidPublicKey?: string;
  heartbeatMs?: number;
};

const HISTORY_PAGE = 200;

/**
 * One phone connection (§4). The runner speaks first with a plaintext
 * challenge; everything after that is encrypted. A connection either pairs a
 * new phone (with the one-time QR secret) or says hello as a paired one.
 * Anything malformed closes the connection.
 */
export class PhoneSession {
  private readonly challenge = toBase64(randomBytes(32));
  private channel: Channel | undefined;
  private deviceId: string | undefined;
  private wish = new Set<Wish>();
  private readonly cleanups: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly ctx: SessionContext,
    private readonly transport: Transport,
  ) {
    this.transport.send(JSON.stringify({ t: "challenge", r: this.challenge, v: LINK_VERSIONS }));
  }

  receive(text: string): void {
    if (this.closed) return;
    try {
      if (!this.channel) this.opening(text);
      else void this.command(this.channel.open(parseFrame(text)));
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.transport.close();
  }

  private opening(text: string): void {
    const frame = parseFrame(text);
    if (!frame.k) throw new Error("first frame must carry the phone's key");
    const phoneKey = fromBase64(frame.k);
    if (phoneKey.length !== 32) throw new Error("bad key");
    this.channel = new Channel(this.ctx.keyPair.secretKey, phoneKey);
    const opening = Opening.parse(this.channel.open(frame));
    if (opening.r !== this.challenge) throw new Error("stale challenge");

    if (!(LINK_VERSIONS as readonly number[]).includes(opening.v)) {
      this.fail(
        "unsupported_version",
        `This computer speaks link version ${LINK_VERSIONS.join(", ")}.`,
      );
      return;
    }

    if (opening.t === "pair") {
      try {
        const device = this.ctx.core.devices.completePairing({
          secret: opening.secret,
          publicKey: frame.k,
          name: opening.name,
        });
        this.send({
          t: "paired",
          runner_id: this.ctx.runnerId,
          device_id: device.id,
          name: this.ctx.name,
        });
      } catch (error) {
        this.send({ t: "error", code: "pairing_failed", message: messageOf(error) });
      }
      this.close();
      return;
    }

    const device = this.ctx.core.devices.byPublicKey(frame.k);
    if (!device) {
      this.fail("not_paired", "This phone is not paired with this computer, or was removed.");
      return;
    }
    this.deviceId = device.id;
    this.wish = new Set(opening.wish);
    this.welcome(opening.since_seq);
  }

  private welcome(sinceSeq: number): void {
    const { core } = this.ctx;
    this.send({
      t: "welcome",
      v: 1,
      runner_id: this.ctx.runnerId,
      name: this.ctx.name,
      last_seq: core.log.lastSeq,
      workspaces: core.workspaces.list().map((w) => ({ id: w.id, name: w.name })),
      agents: this.ctx.agents(),
      ...(this.ctx.vapidPublicKey ? { vapid_public_key: this.ctx.vapidPublicKey } : {}),
    });

    // Catch up, then follow live. Both happen in this same tick, so nothing
    // appended in between can be missed.
    let after = sinceSeq;
    for (;;) {
      const page = core.log.since(after, 500);
      for (const event of page) this.forward(event);
      const tail = page.at(-1);
      if (!tail || page.length < 500) break;
      after = tail.seq;
    }
    this.cleanups.push(
      core.log.subscribe((event) => {
        if (event.type === "device.revoked" && event.data.device_id === this.deviceId) {
          this.close();
          return;
        }
        this.forward(event);
      }),
    );

    const beat = setInterval(
      () => this.send({ t: "heartbeat", at: Date.now(), last_seq: core.log.lastSeq }),
      this.ctx.heartbeatMs ?? 30_000,
    );
    beat.unref?.();
    this.cleanups.push(() => clearInterval(beat));
  }

  private forward(event: LoggedEvent): void {
    const wish = wishOf(event.type);
    if (wish && this.wish.has(wish)) this.send({ t: "event", event });
  }

  private async command(raw: unknown): Promise<void> {
    const parsed = Command.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown })?.id;
      this.send({
        t: "error",
        ...(typeof id === "string" ? { id } : {}),
        code: "bad_message",
        message: "The computer did not understand this request.",
      });
      return;
    }
    const cmd = parsed.data;
    try {
      const reply = await this.dispatch(cmd);
      this.send({ t: "ack", id: cmd.id, ...reply });
    } catch (error) {
      this.send({ t: "error", id: cmd.id, code: "rejected", message: messageOf(error) });
    }
  }

  private async dispatch(cmd: CommandMsg): Promise<{ result: string; data?: unknown }> {
    const { core } = this.ctx;
    switch (cmd.t) {
      case "task.create": {
        const taskId = core.tasks.create({
          workspaceId: cmd.workspace_id,
          agent: cmd.agent,
          prompt: cmd.prompt,
          browser: cmd.browser ?? false,
          commandId: cmd.id,
        });
        return { result: "created", data: { task_id: taskId } };
      }
      case "answer":
        return {
          result: core.questions.answer({
            questionId: cmd.question_id,
            choiceId: cmd.choice_id,
            commandId: cmd.id,
          }),
        };
      case "task.stop":
        if (!core.tasks.get(cmd.task_id)) throw new Error("No such task");
        await core.tasks.stop(cmd.task_id);
        return { result: "stopped" };
      case "computer.status": {
        const active = core.tasks
          .list()
          .filter((t) => !["done", "failed", "stopped"].includes(t.state));
        return {
          result: "ok",
          data: {
            active_tasks: active.length,
            open_questions: core.questions.pending().length,
            last_seq: core.log.lastSeq,
          },
        };
      }
      case "push.register":
        core.devices.registerPush(this.deviceId as string, cmd.subscription);
        return { result: "registered" };
      case "history": {
        const before = cmd.before_seq ?? core.log.lastSeq + 1;
        const events: LoggedEvent[] = [];
        let cursor = before;
        // Filter by wish while paging, so a page is never mostly empty.
        while (events.length < cmd.limit) {
          const page = core.log.before(cursor, HISTORY_PAGE);
          for (const event of page) {
            const wish = wishOf(event.type);
            if (wish && this.wish.has(wish) && events.length < cmd.limit) events.push(event);
          }
          const tail = page.at(-1);
          if (!tail || page.length < HISTORY_PAGE) break;
          cursor = tail.seq;
        }
        const oldest = events.at(-1)?.seq;
        return {
          result: "ok",
          data: { events, next_before_seq: oldest && oldest > 1 ? oldest : null },
        };
      }
    }
  }

  private fail(code: ErrorCode, message: string): void {
    this.send({ t: "error", code, message });
    this.close();
  }

  private send(reply: Reply): void {
    if (this.closed || !this.channel) return;
    try {
      this.transport.send(this.channel.seal(reply));
    } catch {
      this.close();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
