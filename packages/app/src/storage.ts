import { isKey, type KeyPair } from "@malves/protocol";
import * as SecureStore from "expo-secure-store";

/**
 * The pairing, kept in Android's encrypted storage (Keystore-backed). Saved only
 * after the runner has accepted this phone, so a half-finished pairing is never
 * remembered.
 */
export type Pairing = {
  url: string;
  runnerKey: string;
  computer: string;
  keys: KeyPair;
};

const KEY = "malves.pairing";

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pairing>;
    if (
      typeof p.url === "string" &&
      typeof p.computer === "string" &&
      typeof p.runnerKey === "string" &&
      isKey(p.runnerKey) &&
      p.keys &&
      isKey(p.keys.publicKey)
    ) {
      return p as Pairing;
    }
  } catch {
    // Unreadable: fall through and pair again.
  }
  await forgetPairing();
  return null;
}

export function savePairing(pairing: Pairing): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(pairing));
}

export async function forgetPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
  await SecureStore.deleteItemAsync(PUSH_KEY);
}

/** The notification link last opened in the ntfy app. It holds a secret topic. */
const PUSH_KEY = "malves.push";

export function loadPushLink(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_KEY);
}

export function savePushLink(link: string): Promise<void> {
  return SecureStore.setItemAsync(PUSH_KEY, link);
}
