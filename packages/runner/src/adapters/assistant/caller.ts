import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import type { FcmSend } from "../push/fcm.js";
import { isQuiet } from "./watcher.js";

/**
 * Malves rings your phone (a real incoming-call screen) when you asked it to:
 * "call me when Codex finishes", or a test call from Settings. Once you
 * answer, the phone asks why over the sealed link and Malves says it, then
 * you talk hands-free. Rules: none in quiet hours, at most three an hour,
 * none after "don't call me today", and a call nobody answers just ends.
 */
export const MAX_CALLS_PER_HOUR = 3;

type Waiting = { reason: string; at: number };

export class Caller {
  private readonly tokensFile: string;
  /** Calls rung but not yet answered, by id: what Malves will say. */
  private readonly ringing = new Map<string, Waiting>();
  /** Tasks he asked to be called about. */
  private readonly watched = new Set<string>();
  private readonly rung: number[] = [];
  private pausedUntil = 0;
  private readonly now: () => Date;

  constructor(
    private readonly o: {
      send: FcmSend;
      dataDir: string;
      /** Phones still paired (a revoked phone's token is never rung). */
      paired: () => string[];
      quietHours?: string | undefined;
      now?: () => Date;
    },
  ) {
    this.tokensFile = path.join(o.dataDir, "call-tokens.json");
    this.now = o.now ?? (() => new Date());
  }

  private tokens(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.tokensFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** A phone's Firebase token, so it can be rung. */
  register(deviceId: string, token: string): void {
    writeFileSync(this.tokensFile, JSON.stringify({ ...this.tokens(), [deviceId]: token }));
  }

  /** Rings every paired phone; the answer says why it couldn't, if it couldn't. */
  async call(reason: string, test = false): Promise<string> {
    const now = this.now();
    if (!test) {
      if (now.getTime() < this.pausedUntil) return "Not calling: he asked for no calls today.";
      if (isQuiet(this.o.quietHours, now)) return "Not calling: it's quiet hours.";
      const hourAgo = now.getTime() - 3_600_000;
      while ((this.rung[0] ?? Infinity) < hourAgo) this.rung.shift();
      if (this.rung.length >= MAX_CALLS_PER_HOUR)
        return "Not calling: three calls this hour already.";
    }
    const paired = new Set(this.o.paired());
    const tokens = Object.entries(this.tokens()).filter(([device]) => paired.has(device));
    if (tokens.length === 0)
      return "No phone is set up for calls yet (open malves on the phone once).";
    const id = randomBytes(8).toString("hex");
    this.ringing.set(id, { reason, at: now.getTime() });
    this.rung.push(now.getTime());
    const sent = await Promise.allSettled(
      tokens.map(([, token]) => this.o.send(token, { type: "call", call_id: id })),
    );
    if (sent.every((s) => s.status === "rejected")) {
      this.ringing.delete(id);
      const why = (sent[0] as PromiseRejectedResult).reason;
      return `Couldn't ring the phone: ${why instanceof Error ? why.message : String(why)}`;
    }
    return "Calling your phone.";
  }

  /** He answered: what Malves says first. Each call is answered once, within ten minutes. */
  answer(callId: string): string | undefined {
    const call = this.ringing.get(callId);
    this.ringing.delete(callId);
    if (!call || this.now().getTime() - call.at > 600_000) return undefined;
    return call.reason;
  }

  decline(callId: string): void {
    this.ringing.delete(callId);
  }

  /** "Call me when it's done." */
  watch(taskId: string): void {
    this.watched.add(taskId);
  }

  /** "Don't call me today": until local midnight. */
  pauseToday(): void {
    const end = new Date(this.now());
    end.setHours(24, 0, 0, 0);
    this.pausedUntil = end.getTime();
  }

  /** Rings when a watched task finishes or fails. */
  follow(o: {
    subscribe: (listener: (event: LoggedEvent) => void) => () => void;
    task: (id: string) => Task | undefined;
    label: (agent: string) => string;
  }): () => void {
    return o.subscribe((event) => {
      if (event.type !== "task.updated") return;
      const { task_id, state, reason } = event.data;
      if (!this.watched.has(task_id) || !["done", "failed", "stopped"].includes(state)) return;
      this.watched.delete(task_id);
      const task = o.task(task_id);
      const who = task ? o.label(task.agent) : "The agent";
      const what = task ? task.prompt.slice(0, 100) : "your task";
      // Code-written: the call says exactly what happened, nothing the brain made up.
      const said =
        state === "done"
          ? `${who} finished: ${what}.${task?.result ? ` It ended with: ${task.result.slice(-300).trim()}` : ""}`
          : `${who} ${state === "failed" ? "couldn't finish" : "was stopped"}: ${what}.${reason ? ` ${reason}` : ""}`;
      void this.call(said).catch(() => {});
    });
  }
}
