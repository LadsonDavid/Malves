import {
  fromBase64,
  generateKeyPair,
  type KeyPair,
  keyPairFromSecretKey,
  toBase64,
} from "@malves/protocol";
import * as SecureStore from "expo-secure-store";

/** A computer this phone is paired with. */
export type Computer = {
  runnerId: string;
  name: string;
  url: string;
  /** The runner's public key, base64. */
  publicKey: string;
  deviceId: string;
};

const KEY = "phone-secret-key";
const COMPUTERS = "computers";

/**
 * The phone's own key pair, created once and kept in SecureStore (Android
 * Keystore). The private key never leaves the phone.
 */
export async function phoneKeys(): Promise<KeyPair> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (stored) return keyPairFromSecretKey(fromBase64(stored));
  const keys = generateKeyPair();
  await SecureStore.setItemAsync(KEY, toBase64(keys.secretKey));
  return keys;
}

export async function loadComputers(): Promise<Computer[]> {
  const stored = await SecureStore.getItemAsync(COMPUTERS);
  if (!stored) return [];
  try {
    return JSON.parse(stored) as Computer[];
  } catch {
    return [];
  }
}

export async function saveComputers(computers: Computer[]): Promise<void> {
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(computers));
}
