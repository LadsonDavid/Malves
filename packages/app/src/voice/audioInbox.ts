/**
 * Malves' natural-voice replies arrive in pieces after the reply itself;
 * they're collected here by command id until the voice code asks for them.
 */
type Clip = { mime: string; data: string; failed?: string | undefined };
type Piece = {
  commandId: string;
  index: number;
  last: boolean;
  mime: string;
  data: string;
  failed?: string | undefined;
};

const partial = new Map<string, string[]>();
const done = new Map<string, Clip>();
const waiting = new Map<string, (clip: Clip) => void>();

export function deliver(piece: Piece): void {
  const parts = partial.get(piece.commandId) ?? [];
  parts[piece.index] = piece.data;
  partial.set(piece.commandId, parts);
  if (!piece.last) return;
  partial.delete(piece.commandId);
  const clip: Clip = { mime: piece.mime, data: parts.join(""), failed: piece.failed };
  const resolve = waiting.get(piece.commandId);
  if (resolve) {
    waiting.delete(piece.commandId);
    resolve(clip);
  } else {
    done.set(piece.commandId, clip);
    // Nobody asked within a minute: drop it.
    setTimeout(() => done.delete(piece.commandId), 60_000);
  }
}

/** The spoken reply for a command, or undefined if it fails or takes longer than `ms`. */
export function waitAudio(commandId: string, ms: number): Promise<Clip | undefined> {
  const ready = done.get(commandId);
  if (ready) {
    done.delete(commandId);
    return Promise.resolve(ready.failed ? undefined : ready);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(commandId);
      resolve(undefined);
    }, ms);
    waiting.set(commandId, (clip) => {
      clearTimeout(timer);
      resolve(clip.failed ? undefined : clip);
    });
  });
}
