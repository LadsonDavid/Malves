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

export function forgetPairing(): Promise<void> {
  return SecureStore.deleteItemAsync(KEY);
}
