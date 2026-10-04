import * as SecureStore from "expo-secure-store";
import type { Lang } from "./engine";

/** Voice settings, kept on the phone. */
export type VoiceSettings = {
  lang: Lang;
  /** Dictation is sent to Whisper on the computer for a more accurate text. */
  precise: boolean;
};

const KEY = "malves.voice";
export const DEFAULT_VOICE: VoiceSettings = { lang: "en-IN", precise: false };

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<VoiceSettings>) : {};
    return {
      lang: saved.lang === "en-US" || saved.lang === "ta-IN" ? saved.lang : "en-IN",
      precise: saved.precise === true,
    };
  } catch {
    return DEFAULT_VOICE;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(settings));
}
