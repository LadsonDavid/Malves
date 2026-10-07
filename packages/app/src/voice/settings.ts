import { NATURAL_VOICES } from "@malves/protocol";
import * as SecureStore from "expo-secure-store";
import type { Lang } from "./engine";

/** Voice settings, kept on the phone. */
export type VoiceSettings = {
  lang: Lang;
  /** Dictation is sent to Whisper on the computer for a more accurate text. */
  precise: boolean;
  /** The phone voice chosen for each language; unset means the phone's default. */
  voices: Partial<Record<Lang, string>>;
  /** Malves speaks in a natural voice (Cartesia, ElevenLabs, Piper) instead of the phone's. */
  natural: boolean;
  /** The natural voice for Tamil and for English (and Tanglish). */
  naturalVoices: { ta: string; en: string };
  /** Talking over Malves (or "stop", "wait", "nillu") cuts it short. */
  bargeIn: boolean;
};

const KEY = "malves.voice";
const firstOf = (lang: "ta" | "en") => NATURAL_VOICES.find((v) => v.lang === lang)?.id ?? "";
export const DEFAULT_VOICE: VoiceSettings = {
  lang: "en-IN",
  precise: false,
  voices: {},
  natural: true,
  naturalVoices: { ta: firstOf("ta"), en: firstOf("en") },
  bargeIn: true,
};

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<VoiceSettings>) : {};
    const voices: VoiceSettings["voices"] = {};
    for (const lang of ["en-IN", "en-US", "ta-IN"] as const) {
      const id = saved.voices?.[lang];
      if (typeof id === "string" && id.length <= 200) voices[lang] = id;
    }
    const known = (lang: "ta" | "en") => {
      const id = saved.naturalVoices?.[lang];
      return NATURAL_VOICES.some((v) => v.lang === lang && v.id === id)
        ? (id as string)
        : firstOf(lang);
    };
    return {
      lang: saved.lang === "en-US" || saved.lang === "ta-IN" ? saved.lang : "en-IN",
      precise: saved.precise === true,
      voices,
      // Settings saved before the natural voices existed start on them (the old default was off).
      natural: saved.naturalVoices ? saved.natural !== false : true,
      naturalVoices: { ta: known("ta"), en: known("en") },
      bargeIn: saved.bargeIn !== false,
    };
  } catch {
    return DEFAULT_VOICE;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(settings));
}
