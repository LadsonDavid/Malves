import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Says in serve.log when the main loop was stuck for a while (busy reading
 * sessions, starting agents, or anything else that doesn't let go). A stuck
 * loop makes the phone wait, so when it happens the log should say so, with
 * when and how long, instead of leaving only a phone that says "reconnecting".
 */
export function startLagMonitor(o: {
  say: (line: string) => void;
  everyMs?: number;
  thresholdMs?: number;
}): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const worstMs = histogram.max / 1e6;
    histogram.reset();
    if (worstMs >= (o.thresholdMs ?? 1500)) {
      o.say(`Busy: malves' main loop was stuck for ${(worstMs / 1000).toFixed(1)} s just now.`);
    }
  }, o.everyMs ?? 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
