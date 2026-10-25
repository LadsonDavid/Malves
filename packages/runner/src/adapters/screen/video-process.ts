import { fork } from "node:child_process";
import { constants, setPriority } from "node:os";
import type { FromVideo, ToVideo } from "./video-ipc.js";

/**
 * The live screen video runs in its own process (`video-worker`), not in the
 * main one. Capturing, encoding and the steady 15 pictures a second all need a
 * free event loop, and the main process is often busy (starting agents, reading
 * every session, answering the phone): when it was, the phone waited minutes for
 * an answer and then gave up. Here the main process only passes the offer in and
 * the answer back.
 */
export type ChildLike = {
  send(message: ToVideo): void;
  onMessage(listener: (message: FromVideo) => void): void;
  /** Called once when the process ends, however it ends. */
  onExit(listener: (why: string) => void): void;
  kill(): void;
};

type Answer = { sdp: string; width: number; height: number };
type Waiting = {
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class VideoProcess {
  private child: ChildLike | undefined;
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();
  private idle: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: {
      spawn: () => ChildLike;
      log: (line: string) => void;
      /** How long the video process may take to answer an offer. */
      answerTimeoutMs?: number;
      /** How long it stays loaded after the last viewer left (it holds some memory). */
      idleMs?: number;
    },
  ) {}

  /** Starts the process now, so the first viewer doesn't wait for it to load. */
  warm(): void {
    this.process();
  }

  start(sdp: string): Promise<Answer> {
    clearTimeout(this.idle);
    const child = this.process();
    this.nextId += 1;
    const id = this.nextId;
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        // Something is badly stuck in there: start fresh next time.
        this.child?.kill();
        this.child = undefined;
        reject(new Error("The video part of malves didn't answer in time."));
      }, this.o.answerTimeoutMs ?? 30_000);
      timer.unref();
      this.waiting.set(id, { resolve, reject, timer });
      child.send({ t: "start", id, sdp });
    });
  }

  /** The viewer left. The process stays for a while, in case they come back. */
  stop(): void {
    this.child?.send({ t: "stop" });
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.o.idleMs ?? 600_000);
    this.idle.unref();
  }

  close(): void {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = undefined;
  }

  private process(): ChildLike {
    if (this.child) return this.child;
    const child = this.o.spawn();
    this.child = child;
    child.onMessage((message) => {
      if (message.t === "log") return this.o.log(message.line);
      if (message.t === "ready") return;
      const waiting = this.waiting.get(message.id);
      if (!waiting) return;
      this.waiting.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.t === "answer") {
        waiting.resolve({ sdp: message.sdp, width: message.width, height: message.height });
      } else waiting.reject(new Error(message.message));
    });
    child.onExit((why) => {
      if (this.child === child) this.child = undefined;
      for (const [id, waiting] of this.waiting) {
        this.waiting.delete(id);
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`The video part of malves stopped (${why}). Try again.`));
      }
      this.o.log(`Video process ended (${why}).`);
    });
    return child;
  }
}

/** The real thing: `worker` is the compiled video-worker.js, started with the same Node as malves. */
export function forkVideoWorker(worker: string): ChildLike {
  const child = fork(worker, [], {
    // Output through pipes so a crash message reaches serve.log; messages through IPC.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    execArgv: [],
  });
  // serve may have been started at low priority (the login task used to be); filming must not be.
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, constants.priority.PRIORITY_NORMAL);
    } catch {
      // Not allowed to change it: it just runs at the priority it started with.
    }
  }
  let tail = "";
  const remember = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-400);
  };
  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);
  return {
    send: (message) => void child.send(message),
    onMessage: (listener) => void child.on("message", (m) => listener(m as FromVideo)),
    onExit: (listener) => {
      let told = false;
      const once = (why: string) => {
        if (told) return;
        told = true;
        listener(tail.trim() ? `${why}: ${tail.trim().split("\n").at(-1)}` : why);
      };
      child.once("exit", (code, signal) => once(signal ? `signal ${signal}` : `code ${code}`));
      child.once("error", (error) => once(error.message));
    },
    kill: () => void child.kill(),
  };
}
