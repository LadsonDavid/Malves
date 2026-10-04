/**
 * "Precise" dictation (voice mode): the phone records what you say and sends
 * it here in pieces over the encrypted link; this sends it to Whisper through
 * your freellmapi (/v1/audio/transcriptions) and returns the text. Audio is
 * kept in memory only until it is transcribed, or for two minutes.
 */
export type TranscriberOptions = {
  /** freellmapi's origin (MALVES_MODELS_URL). */
  upstream: string;
  key: string;
  /** e.g. "whisper-large-v3"; freellmapi picks one with "auto". */
  model?: string;
  timeoutMs?: number;
};

/** About a minute of 16 kHz mono speech. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_UPLOADS = 4;
const UPLOAD_TTL_MS = 2 * 60_000;

type Upload = { chunks: Buffer[]; bytes: number; started: number };

export class Transcriber {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly o: TranscriberOptions) {}

  /** Adds the next piece of a recording. Pieces must arrive in order. */
  add(uploadId: string, index: number, base64: string): void {
    this.expire();
    let upload = this.uploads.get(uploadId);
    if (!upload) {
      if (index !== 0) throw new Error("That recording isn't on the computer any more. Try again.");
      if (this.uploads.size >= MAX_UPLOADS) throw new Error("Too many recordings at once.");
      upload = { chunks: [], bytes: 0, started: Date.now() };
      this.uploads.set(uploadId, upload);
    }
    if (index !== upload.chunks.length) throw new Error("A piece of the recording went missing.");
    const piece = Buffer.from(base64, "base64");
    upload.bytes += piece.length;
    if (upload.bytes > MAX_UPLOAD_BYTES) {
      this.uploads.delete(uploadId);
      throw new Error("That recording is too long for precise mode (about a minute at most).");
    }
    upload.chunks.push(piece);
  }

  /** Transcribes a finished recording. `language` is e.g. "en" or "ta". */
  async transcribe(uploadId: string, language: string): Promise<string> {
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (!upload) throw new Error("That recording isn't on the computer any more. Try again.");
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.concat(upload.chunks)], { type: "audio/wav" }),
      "speech.wav",
    );
    form.append("model", this.o.model ?? "auto");
    form.append("language", language);
    form.append("response_format", "json");
    let response: Response;
    try {
      response = await fetch(new URL("/v1/audio/transcriptions", this.o.upstream), {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.key}` },
        body: form,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      });
    } catch {
      throw new Error("Couldn't reach freellmapi for precise mode.");
    }
    if (!response.ok) {
      throw new Error(`Precise mode failed: freellmapi answered ${response.status}.`);
    }
    const body = (await response.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("Precise mode returned no text.");
    return body.text.trim();
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.started > UPLOAD_TTL_MS) this.uploads.delete(id);
    }
  }
}

/** The transcriber, if freellmapi is set up (the same settings as free models). */
export function transcriberFromEnv(): Transcriber | undefined {
  const upstream = process.env.MALVES_MODELS_URL;
  const key = process.env.MALVES_MODELS_KEY;
  if (!upstream || !key) return undefined;
  return new Transcriber({
    upstream,
    key,
    ...(process.env.MALVES_WHISPER_MODEL ? { model: process.env.MALVES_WHISPER_MODEL } : {}),
  });
}
