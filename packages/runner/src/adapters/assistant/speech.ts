/**
 * Malves' natural voice: Gemini text-to-speech through freellmapi (the phone's
 * own voices stay the fast default). About five seconds per sentence today.
 *
 *   MALVES_VOICE_MODEL  default gemini-2.5-flash-preview-tts
 *   MALVES_VOICE        a Gemini voice name, default Puck (upbeat)
 */
export type Speech = (text: string) => Promise<{ mime: string; audio: Buffer }>;

export function geminiSpeech(o: {
  url: string;
  key: string;
  model?: string | undefined;
  voice?: string | undefined;
  timeoutMs?: number;
}): Speech {
  return async (text) => {
    let response: Response;
    try {
      response = await fetch(new URL("/v1/audio/speech", o.url), {
        method: "POST",
        headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: o.model ?? "gemini-2.5-flash-preview-tts",
          voice: o.voice ?? "Puck",
          input: text.slice(0, 1500),
        }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch {
      throw new Error("Couldn't reach the voice (freellmapi).");
    }
    if (!response.ok) throw new Error(`The voice answered ${response.status}.`);
    return {
      mime: response.headers.get("content-type")?.split(";")[0] ?? "audio/wav",
      audio: Buffer.from(await response.arrayBuffer()),
    };
  };
}
