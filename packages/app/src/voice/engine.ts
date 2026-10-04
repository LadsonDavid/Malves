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

/** Says `text`; resolves when it's finished or stopped. */
export function speak(text: string, language: Lang): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    // Long texts are cut to what the phone can say in one go.
    const max = Number.isFinite(Speech.maxSpeechInputLength) ? Speech.maxSpeechInputLength : 4000;
    Speech.speak(text.slice(0, max), {
      language,
      rate: 1.0,
      onDone: done,
      onStopped: done,
      onError: done,
    });
  });
}

export function stopSpeaking(): void {
  void Speech.stop();
}

export type Heard = {
  text: string;
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

let active: { stop: () => void } | undefined;

/** Listens for one sentence (or, with `long`, until stopped). Rejects only on permission or setup errors. */
export async function listen(o: ListenOptions): Promise<Heard> {
  const module = recognition?.ExpoSpeechRecognitionModule;
  if (!module) throw new Error("Listening needs the malves app (APK), not Expo Go.");
  const permission = await module.requestPermissionsAsync();
  if (!permission.granted)
    throw new Error("malves needs the microphone to listen. Allow it in Android settings.");
  stopSpeaking();
  active?.stop();

  return new Promise<Heard>((resolve, reject) => {
    // Android splits long speech into segments; each final one is kept.
    const segments: string[] = [];
    let partial = "";
    let confidence: number | undefined;
    let audioUri: string | undefined;
    let settled = false;
    const subs = [
      module.addListener("result", (event) => {
        const best = event.results[0];
        if (!best) return;
        if (event.isFinal) {
          segments.push(best.transcript.trim());
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
      active = undefined;
      if (error) return reject(error);
      const text = [...segments, partial].filter(Boolean).join(" ").trim();
      resolve({ text, confidence, audioUri });
    };
    active = { stop: () => module.stop() };
    module.start({
      lang: o.lang,
      interimResults: true,
      continuous: o.long ?? false,
      maxAlternatives: 1,
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
