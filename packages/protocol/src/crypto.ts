import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } = naclUtil;

/**
 * End-to-end encryption between the phone and the runner (§4, §8).
 *
 * Every message is a NaCl `box`: encrypted to the receiver's public key and
 * authenticated with the sender's secret key. The relay and the push service
 * only ever see ciphertext. Keys are base64 strings so they fit in JSON and QR
 * codes. The design follows Happy's (phone-held keys, sealed payloads); the
 * code is our own.
 */

/** Both halves base64. The secret half never leaves the device that made it. */
export type KeyPair = { publicKey: string; secretKey: string };

/** A sealed message: a random nonce and the ciphertext, both base64. */
export type Sealed = { n: string; c: string };

const KEY_BYTES = nacl.box.publicKeyLength;

export function generateKeyPair(): KeyPair {
  const keys = nacl.box.keyPair();
  return { publicKey: encodeBase64(keys.publicKey), secretKey: encodeBase64(keys.secretKey) };
}

/** Recomputes the public half of a secret key, e.g. after loading it from disk. */
export function publicKeyOf(secretKey: string): string {
  return encodeBase64(nacl.box.keyPair.fromSecretKey(key(secretKey)).publicKey);
}

/**
 * React Native has no secure random source that tweetnacl can find on its own;
 * the app passes one (expo-crypto) before using anything here. Node and
 * browsers don't need this.
 */
export function setRandomSource(fill: (bytes: Uint8Array) => void): void {
  nacl.setPRNG((target, length) => {
    const bytes = new Uint8Array(length);
    fill(bytes);
    target.set(bytes);
  });
}

/** Random bytes, base64. For pairing codes, challenges and command ids. */
export function randomToken(bytes = 32): string {
  return encodeBase64(nacl.randomBytes(bytes));
}

/** Whether `text` is a base64 32-byte key. */
export function isKey(text: string): boolean {
  try {
    return decodeBase64(text).length === KEY_BYTES;
  } catch {
    return false;
  }
}

/** Encrypts `message` (as JSON) to `to`, signed by `fromSecret`. */
export function seal(message: unknown, to: string, fromSecret: string): Sealed {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(decodeUTF8(JSON.stringify(message)), nonce, key(to), key(fromSecret));
  return { n: encodeBase64(nonce), c: encodeBase64(box) };
}

/**
 * Decrypts a message from `from`. Returns `undefined` for anything forged,
 * tampered with, sent by someone else, or malformed — never throws.
 */
export function open(sealed: Sealed, from: string, toSecret: string): unknown {
  try {
    const plain = nacl.box.open(
      decodeBase64(sealed.c),
      decodeBase64(sealed.n),
      key(from),
      key(toSecret),
    );
    return plain ? JSON.parse(encodeUTF8(plain)) : undefined;
  } catch {
    return undefined;
  }
}

function key(text: string): Uint8Array {
  const bytes = decodeBase64(text);
  if (bytes.length !== KEY_BYTES) throw new Error("not a 32-byte key");
  return bytes;
}
