import { EventBody, type LoggedEvent } from "@malves/protocol";
import type { Clock, Store } from "../ports.js";

export type Listener = (event: LoggedEvent) => void;

const PAGE = 500;

/**
 * The append-only log. Every module derives its state by folding the events it
 * cares about, both at startup (`load`) and as new events are appended.
 */
export class EventLog {
  private readonly listeners = new Set<Listener>();
  private last = 0;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  /** Validates, stores and publishes one event. */
  append(body: EventBody): LoggedEvent {
    const event = this.store.append(EventBody.parse(body), this.clock.now());
    this.last = event.seq;
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Replays every stored event to the current listeners. Call once, at startup. */
  load(): void {
    for (const event of this.all()) {
      this.last = event.seq;
      for (const listener of this.listeners) listener(event);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `seq`, for resuming after a dropout. */
  since(seq: number, limit = PAGE): LoggedEvent[] {
    return this.store.since(seq, limit);
  }

  /** Events before `seq`, newest first, for paging back through history. */
  before(seq: number, limit = PAGE): LoggedEvent[] {
    return this.store.before(seq, limit);
  }

  get lastSeq(): number {
    return this.last;
  }

  private *all(): Generator<LoggedEvent> {
    let after = 0;
    for (;;) {
      const page = this.store.since(after, PAGE);
      yield* page;
      const tail = page.at(-1);
      if (!tail || page.length < PAGE) return;
      after = tail.seq;
    }
  }
}
