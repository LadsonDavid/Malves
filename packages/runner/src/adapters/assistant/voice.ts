import { readFileSync, writeFileSync } from "node:fs";
import { NATURAL_VOICES, type NaturalVoice, type Speak } from "@malves/protocol";

/**
 * Malves' natural voice, one sentence at a time: Cartesia, then ElevenLabs,
 * then Piper on your own server. When all three fail the phone reads the
 * sentence in its own voice. A provider that answers "out of credit" is
 * skipped until next month, and that's said once.
 *
 *   CARTESIA_API_KEY, ELEVENLABS_API_KEY   (either may be missing)
 *   MALVES_PIPER_URL                       e.g. http://100.69.0.115:5005
 */
export type Lang = "ta" | "en";
export type Spoken = { mime: string; audio: Buffer; note?: string };
export type Voice = (text: string, lang: Lang, choice: Speak) => Promise<Spoken>;

type Provider = {
  name: "Cartesia" | "ElevenLabs" | "Piper";
  /** Out-of-credit marks last the month; Piper is ours and never runs out. */
  metered: boolean;
  run: (text: string, lang: Lang, voice: NaturalVoice) => Promise<Response>;
};

export type VoiceOptions = {
  cartesiaKey?: string | undefined;
  elevenlabsKey?: string | undefined;
  piperUrl?: string | undefined;
  /** Where the out-of-credit marks are kept (survives restarts). */
  stateFile: string;
  now?: () => Date;
  timeoutMs?: number;
};

/** Tamil script is read by the Tamil voice; English and Tanglish by the English one. */
export const langOf = (text: string): Lang => (/[\u0B80-\u0BFF]/.test(text) ? "ta" : "en");

/** The voice chosen for a language, or the default (the first one listed). */
export function voiceFor(lang: Lang, choice: Speak): NaturalVoice {
  const wanted = typeof choice === "object" ? choice[lang] : undefined;
  const all = NATURAL_VOICES.filter((v) => v.lang === lang);
  return all.find((v) => v.id === wanted) ?? (all[0] as NaturalVoice);
}

export function naturalVoice(o: VoiceOptions): Voice | undefined {
  const timeout = () => AbortSignal.timeout(o.timeoutMs ?? 10_000);
  const json = { "content-type": "application/json" };
  const providers: Provider[] = [];
  if (o.cartesiaKey) {
    const key = o.cartesiaKey;
    providers.push({
      name: "Cartesia",
      metered: true,
      run: (text, lang, voice) =>
        fetch("https://api.cartesia.ai/tts/bytes", {
          method: "POST",
          headers: { ...json, authorization: `Bearer ${key}`, "Cartesia-Version": "2026-08-14" },
          body: JSON.stringify({
            model_id: "sonic-3.6",
            transcript: text,
            voice: { mode: "id", id: voice.cartesia },
            language: lang,
            output_format: { container: "mp3", sample_rate: 44100, bit_rate: 64000 },
          }),
          signal: timeout(),
        }),
    });
  }
  if (o.elevenlabsKey) {
    const key = o.elevenlabsKey;
    providers.push({
      name: "ElevenLabs",
      metered: true,
      run: (text, lang, voice) =>
        fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice.elevenlabs}?output_format=mp3_44100_64`,
          {
            method: "POST",
            headers: { ...json, "xi-api-key": key },
            body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", language_code: lang }),
            signal: timeout(),
          },
        ),
    });
  }
  if (o.piperUrl) {
    const url = new URL("/synthesize", o.piperUrl);
    providers.push({
      name: "Piper",
      metered: false,
      run: (text, _lang, voice) =>
        fetch(url, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ text, voice: voice.piper }),
          signal: timeout(),
        }),
    });
  }
  if (providers.length === 0) return undefined;

  const month = () => (o.now?.() ?? new Date()).toISOString().slice(0, 7);
  const spent = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(o.stateFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };

  return async (raw, lang, choice) => {
    const text = raw
      .replace(/[*_#`>]/g, "")
      .trim()
      .slice(0, 600);
    const voice = voiceFor(lang, choice);
    let note: string | undefined;
    for (const p of providers) {
      if (p.metered && spent()[p.name] === month()) continue;
      let response: Response;
      try {
        response = await p.run(text, lang, voice);
      } catch {
        continue; // unreachable or too slow: the next one
      }
      if (response.ok) {
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.length === 0) continue;
        // Piper's server labels its WAV as text/html.
        const mime = p.name === "Piper" ? "audio/wav" : "audio/mpeg";
        return note ? { mime, audio, note } : { mime, audio };
      }
      const body = await response.text().catch(() => "");
      if (
        p.metered &&
        (response.status === 402 || /quota|credit|limit_exceeded/i.test(body.slice(0, 500)))
      ) {
        writeFileSync(o.stateFile, JSON.stringify({ ...spent(), [p.name]: month() }));
        const next = providers.slice(providers.indexOf(p) + 1)[0]?.name ?? "the phone's voice";
        note = `${p.name}'s free voice is used up this month; using ${next}.`;
      }
    }
    throw new Error(note ?? "No natural voice answered.");
  };
}

/** Piper loads each voice on first use (about 3 s): do it at start instead. */
export function warmPiper(piperUrl: string | undefined): void {
  if (!piperUrl) return;
  const url = new URL("/synthesize", piperUrl);
  void (async () => {
    for (const piper of new Set(NATURAL_VOICES.map((v) => v.piper))) {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: piper.startsWith("ta") ? "வணக்கம்" : "Hello", voice: piper }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
    }
  })();
}

/**
 * Cuts text into whole sentences as it streams in. `push` returns the
 * sentences completed so far; `flush` returns what's left at the end.
 */
export function sentences() {
  let buffer = "";
  const END = /[.!?।…]+["')\]]*\s+|\n+/g;
  return {
    push(delta: string): string[] {
      buffer += delta;
      const out: string[] = [];
      let cut = 0;
      for (const m of buffer.matchAll(END)) {
        const s = buffer.slice(cut, m.index + m[0].length).trim();
        if (s) out.push(s);
        cut = m.index + m[0].length;
      }
      buffer = buffer.slice(cut);
      return out;
    },
    flush(): string[] {
      const s = buffer.trim();
      buffer = "";
      return s ? [s] : [];
    },
  };
}

/** All the sentences of a finished text, cut the same way as when streamed. */
export function splitSentences(text: string): string[] {
  const cut = sentences();
  return [...cut.push(text), ...cut.flush()];
}
