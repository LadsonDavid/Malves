import { type AudioPlayer, createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";

/**
 * Speaking (Expo Speech, works everywhere) and listening (Android's speech
 * recognizer through expo-speech-recognition — native code, so the APK only).
 * In Expo Go the recognizer isn't there: listening is off, reading aloud works.
 */
type Recognition = typeof import("expo-speech-recognition");
let recognition: Recognition | undefined;
try {
  // Loaded lazily: importing it in Expo Go would crash the whole app.
  recognition = require("expo-speech-recognition") as Recognition;
} catch {
  recognition = undefined;
}

export type Lang = "en-IN" | "en-US" | "ta-IN";

export function canListen(): boolean {
  try {
    return recognition?.ExpoSpeechRecognitionModule.isRecognitionAvailable() ?? false;
  } catch {
    return false;
  }
}

/** Saving the audio (for precise mode) needs Android 13+. */
export function canRecord(): boolean {
  try {
    return recognition?.ExpoSpeechRecognitionModule.supportsRecording() ?? false;
  } catch {
    return false;
  }
}

/** The phone's voices for a language (e.g. Indian English, Tamil), for the voice picker. */
export async function voicesFor(language: Lang): Promise<Array<{ id: string; name: string }>> {
  const prefix = language.toLowerCase();
  const all = await Speech.getAvailableVoicesAsync().catch(() => []);
  return all
    .filter((v) => v.language.toLowerCase().replace("_", "-").startsWith(prefix))
    .map((v) => ({ id: v.identifier, name: v.name }));
}

/** Says `text` (in `voice` when given); resolves when it's finished or stopped. */
export function speak(text: string, language: Lang, voice?: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    // Long texts are cut to what the phone can say in one go.
    const max = Number.isFinite(Speech.maxSpeechInputLength) ? Speech.maxSpeechInputLength : 4000;
    Speech.speak(text.slice(0, max), {
      language,
      ...(voice ? { voice } : {}),
      rate: 1.0,
      onDone: done,
      onStopped: done,
      onError: done,
    });
  });
}

export function stopSpeaking(): void {
  void Speech.stop();
  stopClip?.();
}

let stopClip: (() => void) | undefined;

/** Plays one of Malves' natural-voice replies; resolves when it ends or is stopped. */
export function playClip(base64: string, mime: string): Promise<void> {
  stopClip?.();
  const file = new File(
    Paths.cache,
    `malves-voice-${Date.now()}.${mime.includes("mpeg") ? "mp3" : "wav"}`,
  );
  file.create();
  file.write(base64, { encoding: "base64" });
  const player: AudioPlayer = createAudioPlayer({ uri: file.uri });
  return new Promise((resolve) => {
    const finish = () => {
      if (stopClip !== finish) return;
      stopClip = undefined;
      subscription.remove();
      player.remove();
      try {
        file.delete();
      } catch {
        // A leftover cache file is harmless.
      }
      resolve();
    };
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) finish();
    });
    stopClip = finish;
    player.play();
  });
}

export type Heard = {
  text: string;
  /** The recognizer's other guesses, best first (they help Malves' brain). */
  alternatives: string[];
  /** 0–1 when the recognizer gives one; undefined when it doesn't. */
  confidence: number | undefined;
  /** The recording (WAV), when `record` was asked for and the phone can do it. */
  audioUri: string | undefined;
};

export type ListenOptions = {
  lang: Lang;
  /** Words to listen for: agent and project names, choices, commands. */
  hints: string[];
  /** Keep listening through pauses until `stopListening()` (dictation). */
  long?: boolean;
  record?: boolean;
  onPartial?: (text: string) => void;
};

/** The listening session in progress; `ended` settles once its "end" event has come. */
let active: { stop: () => void; ended: Promise<void> } | undefined;

/** Listens for one sentence (or, with `long`, until stopped). Rejects only on permission or setup errors. */
export async function listen(o: ListenOptions): Promise<Heard> {
  const module = recognition?.ExpoSpeechRecognitionModule;
  if (!module) throw new Error("Listening needs the malves app (APK), not Expo Go.");
  const permission = await module.requestPermissionsAsync();
  if (!permission.granted)
    throw new Error("malves needs the microphone to listen. Allow it in Android settings.");
  stopSpeaking();
  // Let the previous session finish first: its late "end" event would otherwise
  // end this one at once, with nothing heard. At most a second.
  const previous = active;
  if (previous) {
    previous.stop();
    await Promise.race([previous.ended, new Promise((r) => setTimeout(r, 1000))]);
  }

  let markEnded = () => {};
  const ended = new Promise<void>((r) => {
    markEnded = r;
  });
  return new Promise<Heard>((resolve, reject) => {
    // Android splits long speech into segments; each final one is kept.
    const segments: string[] = [];
    let partial = "";
    let confidence: number | undefined;
    let audioUri: string | undefined;
    let alternatives: string[] = [];
    let settled = false;
    const subs = [
      module.addListener("result", (event) => {
        const best = event.results[0];
        if (!best) return;
        if (event.isFinal) {
          segments.push(best.transcript.trim());
          alternatives = event.results
            .slice(1, 4)
            .map((r) => r.transcript.trim())
            .filter(Boolean);
          partial = "";
          if (best.confidence > 0) confidence = best.confidence;
        } else partial = best.transcript;
        o.onPartial?.([...segments, partial].filter(Boolean).join(" "));
      }),
      module.addListener("audioend", (event) => {
        if (event.uri) audioUri = event.uri;
      }),
      module.addListener("error", (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          finish(new Error("Speech recognition isn't allowed on this phone."));
        } else if (event.error === "language-not-supported") {
          finish(
            new Error(
              "This phone can't recognize that language. Install it in Android's speech settings.",
            ),
          );
        }
        // no-speech, speech-timeout, aborted…: "end" follows with whatever was heard.
      }),
      module.addListener("end", () => finish()),
    ];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const sub of subs) sub.remove();
      if (active?.ended === ended) active = undefined;
      markEnded();
      if (error) return reject(error);
      const text = [...segments, partial].filter(Boolean).join(" ").trim();
      resolve({ text, alternatives, confidence, audioUri });
    };
    active = { stop: () => module.stop(), ended };
    module.start({
      lang: o.lang,
      interimResults: true,
      continuous: o.long ?? false,
      maxAlternatives: 4,
      contextualStrings: o.hints.slice(0, 100),
      ...(o.record && canRecord() ? { recordingOptions: { persist: true } } : {}),
      androidIntentOptions: {
        // Dictation allows thinking pauses; a quick command doesn't wait long.
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: o.long ? 4000 : 1500,
      },
    });
  });
}

/** Stops listening; the words heard so far are kept. */
export function stopListening(): void {
  active?.stop();
}

/** Deletes a recording once it's been used (or wasn't needed): they'd pile up in the cache. */
export function discardRecording(uri: string | undefined): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or not ours to delete: nothing to do.
  }
}

/** Reads a recording as base64, for precise mode. */
export async function readAudio(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("Couldn't read the recording."));
    reader.readAsDataURL(blob);
  });
}
