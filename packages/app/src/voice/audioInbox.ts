/**
 * Malves' natural-voice replies arrive a sentence at a time, each in pieces,
 * often before the reply's own text. They're kept here by command id; the
 * voice code reads them back in order with `replyAudio`.
 */
type Piece = {
  commandId: string;
  index: number;
  last: boolean;
  mime: string;
  data: string;
  failed?: string | undefined;
  part: number;
  text?: string | undefined;
  lang?: "ta" | "en" | undefined;
  done: boolean;
  note?: string | undefined;
};

/** One sentence: audio to play, or (`failed`) text for the phone's own voice. */
export type Clip = {
  mime: string;
  data: string;
  text: string;
  lang: "ta" | "en";
  failed: boolean;
  note?: string | undefined;
};

type Reply = {
  pieces: Map<number, string[]>;
  clips: Map<number, Clip>;
  notes: Map<number, string>;
  /** How many sentences there are, once known. */
  end?: number;
  wake?: (() => void) | undefined;
};

const replies = new Map<string, Reply>();

function reply(commandId: string): Reply {
  let r = replies.get(commandId);
  if (!r) {
    r = { pieces: new Map(), clips: new Map(), notes: new Map() };
    replies.set(commandId, r);
    // Nobody reads it within two minutes: drop it (a reader keeps its own reference).
    setTimeout(() => replies.delete(commandId), 120_000);
  }
  return r;
}

export function deliver(piece: Piece): void {
  const r = reply(piece.commandId);
  if (piece.done) r.end = piece.part;
  else {
    const parts = r.pieces.get(piece.part) ?? [];
    parts[piece.index] = piece.data;
    r.pieces.set(piece.part, parts);
    if (piece.note) r.notes.set(piece.part, piece.note);
    if (piece.last) {
      r.pieces.delete(piece.part);
      r.clips.set(piece.part, {
        mime: piece.mime,
        data: parts.join(""),
        text: piece.text ?? "",
        lang: piece.lang ?? "en",
        failed: Boolean(piece.failed) || !piece.mime,
        note: r.notes.get(piece.part),
      });
    }
  }
  r.wake?.();
}

/**
 * A reply's sentences in order. `next` resolves with the next one, or
 * undefined at the end, after `cancel`, or when nothing comes for `idleMs`.
 */
export function replyAudio(commandId: string, idleMs = 25_000) {
  const r = reply(commandId);
  let cursor = 0;
  let cancelled = false;
  return {
    async next(): Promise<Clip | undefined> {
      for (;;) {
        if (cancelled) return undefined;
        const clip = r.clips.get(cursor);
        if (clip) {
          r.clips.delete(cursor);
          cursor += 1;
          return clip;
        }
        if (r.end !== undefined && cursor >= r.end) return undefined;
        const woke = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), idleMs);
          r.wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        r.wake = undefined;
        if (!woke) return undefined;
      }
    },
    cancel(): void {
      cancelled = true;
      r.wake?.();
      replies.delete(commandId);
    },
  };
}

export type ReplyAudio = ReturnType<typeof replyAudio>;
