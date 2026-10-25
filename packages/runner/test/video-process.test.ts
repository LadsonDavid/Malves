import { afterEach, describe, expect, it, vi } from "vitest";
import type { FromVideo, ToVideo } from "../src/adapters/screen/video-ipc.js";
import { type ChildLike, VideoProcess } from "../src/adapters/screen/video-process.js";

afterEach(() => vi.useRealTimers());

/** A video process we control: records what it is told and says what the test wants. */
function fakeChild() {
  const sent: ToVideo[] = [];
  let hear: (m: FromVideo) => void = () => {};
  let gone: (why: string) => void = () => {};
  let killed = false;
  const child: ChildLike = {
    send: (m) => void sent.push(m),
    onMessage: (l) => {
      hear = l;
    },
    onExit: (l) => {
      gone = l;
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    child,
    sent,
    say: (m: FromVideo) => hear(m),
    exit: (why = "crashed") => gone(why),
    get killed() {
      return killed;
    },
  };
}

function setup(options: { answerTimeoutMs?: number; idleMs?: number } = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const log: string[] = [];
  const video = new VideoProcess({
    spawn: () => {
      const c = fakeChild();
      children.push(c);
      return c.child;
    },
    log: (line) => log.push(line),
    ...options,
  });
  return { video, children, log };
}

const answer = (id: number) => ({
  t: "answer" as const,
  id,
  sdp: "answer-sdp",
  width: 1920,
  height: 1080,
});

describe("the video process, from the main process's side", () => {
  it("starts the process once, passes the offer in and the answer back, and reuses it", async () => {
    const s = setup();
    const first = s.video.start("offer-1");
    expect(s.children).toHaveLength(1);
    expect(s.children[0]?.sent).toEqual([{ t: "start", id: 1, sdp: "offer-1" }]);
    s.children[0]?.say(answer(1));
    await expect(first).resolves.toEqual({ sdp: "answer-sdp", width: 1920, height: 1080 });

    const second = s.video.start("offer-2");
    expect(s.children).toHaveLength(1);
    s.children[0]?.say(answer(2));
    await second;
  });

  it("can be warmed up before anyone asks", async () => {
    const s = setup();
    s.video.warm();
    expect(s.children).toHaveLength(1);
    const started = s.video.start("offer");
    expect(s.children).toHaveLength(1);
    s.children[0]?.say(answer(1));
    await started;
  });

  it("an error from the process becomes the error", async () => {
    const s = setup();
    const started = s.video.start("offer");
    s.children[0]?.say({ t: "error", id: 1, message: "no screen" });
    await expect(started).rejects.toThrow("no screen");
  });

  it("an answer that never comes ends the wait, and the next try uses a fresh process", async () => {
    vi.useFakeTimers();
    const s = setup({ answerTimeoutMs: 20_000 });
    const started = s.video.start("offer");
    const failed = expect(started).rejects.toThrow(/didn't answer/);
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(s.children[0]?.killed).toBe(true);

    void s.video.start("offer again").catch(() => {});
    expect(s.children).toHaveLength(2);
  });

  it("a process that dies mid-wait fails the wait, and the next try starts a new one", async () => {
    const s = setup();
    const started = s.video.start("offer");
    const failed = expect(started).rejects.toThrow(/stopped/);
    s.children[0]?.exit("exit code 1");
    await failed;
    void s.video.start("again").catch(() => {});
    expect(s.children).toHaveLength(2);
  });

  it("stop tells the process, and an idle process is closed after a while", async () => {
    vi.useFakeTimers();
    const s = setup({ idleMs: 600_000 });
    const started = s.video.start("offer");
    s.children[0]?.say(answer(1));
    await started;

    s.video.stop();
    expect(s.children[0]?.sent.at(-1)).toEqual({ t: "stop" });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(s.children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.children[0]?.killed).toBe(true);

    // Watching again later starts a new one.
    void s.video.start("later").catch(() => {});
    expect(s.children).toHaveLength(2);
  });

  it("starting again cancels the idle close", async () => {
    vi.useFakeTimers();
    const s = setup({ idleMs: 1_000 });
    const first = s.video.start("a");
    s.children[0]?.say(answer(1));
    await first;
    s.video.stop();
    const second = s.video.start("b");
    s.children[0]?.say(answer(2));
    await second;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.children[0]?.killed).toBe(false);
  });

  it("passes the process's log lines on", () => {
    const s = setup();
    s.video.warm();
    s.children[0]?.say({ t: "log", line: "Video: connected." });
    expect(s.log).toContain("Video: connected.");
  });

  it("closing kills the process", () => {
    const s = setup();
    s.video.warm();
    s.video.close();
    expect(s.children[0]?.killed).toBe(true);
  });
});
