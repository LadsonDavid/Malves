import * as SecureStore from "expo-secure-store";
import type { Lang } from "./engine";

/** Voice settings, kept on the phone. */
export type VoiceSettings = {
  lang: Lang;
  /** Dictation is sent to Whisper on the computer for a more accurate text. */
  precise: boolean;
  /** The phone voice chosen for each language; unset means the phone's default. */
  voices: Partial<Record<Lang, string>>;
};

const KEY = "malves.voice";
export const DEFAULT_VOICE: VoiceSettings = { lang: "en-IN", precise: false, voices: {} };

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<VoiceSettings>) : {};
    const voices: VoiceSettings["voices"] = {};
    for (const lang of ["en-IN", "en-US", "ta-IN"] as const) {
      const id = saved.voices?.[lang];
      if (typeof id === "string" && id.length <= 200) voices[lang] = id;
    }
    return {
      lang: saved.lang === "en-US" || saved.lang === "ta-IN" ? saved.lang : "en-IN",
      precise: saved.precise === true,
      voices,
    };
  } catch {
    return DEFAULT_VOICE;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(settings));
}
