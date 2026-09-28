import {
  fromBase64,
  generateKeyPair,
  type KeyPair,
  keyPairFromSecretKey,
  runnerIdOf,
  toBase64,
} from "@malves/protocol";
import type { Secrets } from "./adapters/secrets/secrets.js";

export type Identity = { keyPair: KeyPair; runnerId: string };

const KEY = "runner-secret-key";

/** The runner's long-term key pair, created on first run and kept in the keychain. */
export function loadIdentity(secrets: Secrets): Identity {
  const stored = secrets.get(KEY);
  let keyPair: KeyPair;
  if (stored) {
    keyPair = keyPairFromSecretKey(fromBase64(stored));
  } else {
    keyPair = generateKeyPair();
    secrets.set(KEY, toBase64(keyPair.secretKey));
  }
  return { keyPair, runnerId: runnerIdOf(keyPair.publicKey) };
}
