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
/** The standby copy on the server: answers when the computer is off. */
const STANDBY_KEY = "malves.standby";

export const loadPairing = (): Promise<Pairing | null> => read(KEY);
export const loadStandby = (): Promise<Pairing | null> => read(STANDBY_KEY);

async function read(key: string): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(key);
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
  await SecureStore.deleteItemAsync(key);
  if (key === KEY) await SecureStore.deleteItemAsync(PUSH_KEY);
  return null;
}

export function savePairing(pairing: Pairing): Promise<void> {
  return SecureStore.setItemAsync(KEY, JSON.stringify(pairing));
}

export function saveStandby(pairing: Pairing): Promise<void> {
  return SecureStore.setItemAsync(STANDBY_KEY, JSON.stringify(pairing));
}

export function forgetStandby(): Promise<void> {
  return SecureStore.deleteItemAsync(STANDBY_KEY);
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
