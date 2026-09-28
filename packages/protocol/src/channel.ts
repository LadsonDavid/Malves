import nacl from "tweetnacl";
import { z } from "zod";

/**
 * End-to-end encryption between the phone and the runner (§8), with libsodium's
 * `box` construction (X25519 + XSalsa20-Poly1305) via tweetnacl. The idea of
 * pairing by QR and then boxing every message is adapted from Happy; the code
 * here is original.
 *
 * The channel runs *inside* WireGuard (Tailscale) or TLS (relay), so a relay
 * or anyone on the network sees only ciphertext. Each message carries a
 * counter, and the first one carries the runner's per-connection challenge,
 * so frames can't be replayed into this or another connection.
 */

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

export const generateKeyPair = (): KeyPair => nacl.box.keyPair();
export const keyPairFromSecretKey = (secretKey: Uint8Array): KeyPair =>
  nacl.box.keyPair.fromSecretKey(secretKey);
export const randomBytes = (n: number): Uint8Array => nacl.randomBytes(n);

/**
 * React Native has no crypto.getRandomValues by default. The app must call
 * this once at startup with a secure source (expo-crypto).
 */
export function setRandomSource(fill: (bytes: Uint8Array) => void): void {
  nacl.setPRNG((out, n) => {
    const bytes = new Uint8Array(n);
    fill(bytes);
    out.set(bytes);
  });
}

/** Short, stable id for a runner, derived from its public key. */
export function runnerIdOf(publicKey: Uint8Array): string {
  return toBase64Url(nacl.hash(publicKey).slice(0, 9));
}

/** Constant-time comparison for secrets. */
export function equalSecrets(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  return nacl.verify(x, y);
}

// ---- frames -------------------------------------------------------------------

/** The runner's first message on every connection, in plaintext. */
export const Challenge = z.object({
  t: z.literal("challenge"),
  r: z.string().min(16),
  v: z.array(z.number().int()).min(1),
});
export type Challenge = z.infer<typeof Challenge>;

/** An encrypted frame. `k` (the sender's public key) is only on the phone's first frame. */
export const Frame = z.object({
  k: z.string().optional(),
  n: z.string(),
  c: z.string(),
});
export type Frame = z.infer<typeof Frame>;

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

/** One direction-aware encrypted conversation between two keys. */
export class Channel {
  private readonly shared: Uint8Array;
  private sent = 0;
  private received = 0;

  constructor(mySecretKey: Uint8Array, theirPublicKey: Uint8Array) {
    this.shared = nacl.box.before(theirPublicKey, mySecretKey);
  }

  /** Encrypts a message into a frame's JSON text. Pass `withKey` on the phone's first frame. */
  seal(message: object, withKey?: Uint8Array): string {
    this.sent += 1;
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const plain = new TextEncoder().encode(JSON.stringify({ ...message, i: this.sent }));
    const frame: Frame = {
      n: toBase64(nonce),
      c: toBase64(nacl.box.after(plain, nonce, this.shared)),
      ...(withKey ? { k: toBase64(withKey) } : {}),
    };
    return JSON.stringify(frame);
  }

  /** Decrypts a frame. Throws if it was tampered with, or is a replay. */
  open(frame: Frame): unknown {
    const plain = nacl.box.open.after(fromBase64(frame.c), fromBase64(frame.n), this.shared);
    if (!plain) throw new ChannelError("could not decrypt");
    const message = JSON.parse(new TextDecoder().decode(plain)) as { i?: unknown };
    if (typeof message.i !== "number" || message.i <= this.received) {
      throw new ChannelError("out-of-order or replayed message");
    }
    this.received = message.i;
    const { i: _counter, ...rest } = message;
    return rest;
  }
}

/** Parses a text frame from the wire. */
export function parseFrame(text: string): Frame {
  const result = Frame.safeParse(safeJson(text));
  if (!result.success) throw new ChannelError("not a frame");
  return result.data;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- pairing QR ----------------------------------------------------------------

/** What the QR code on the desktop carries (§8 "Pairing"). */
export type PairingInvite = {
  /** The runner's public key. */
  publicKey: Uint8Array;
  /** One-time secret, valid for 120 seconds. */
  secret: string;
  /** How to reach the runner: ws:// over Tailscale, or wss:// through a relay. */
  url: string;
  /** The computer's display name. */
  name: string;
};

export function encodeInvite(invite: PairingInvite): string {
  const parts: Array<[string, string]> = [
    ["v", "1"],
    ["k", toBase64Url(invite.publicKey)],
    ["s", invite.secret],
    ["u", invite.url],
    ["n", invite.name],
  ];
  return `malves://pair?${parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

export function decodeInvite(text: string): PairingInvite {
  const prefix = "malves://pair?";
  if (!text.startsWith(prefix)) throw new Error("Not a malves pairing code");
  const fields = new Map(
    text
      .slice(prefix.length)
      .split("&")
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const;
      }),
  );
  const get = (key: string) => {
    const value = fields.get(key);
    if (!value) throw new Error(`Pairing code is missing "${key}"`);
    return value;
  };
  if (get("v") !== "1") throw new Error("Unsupported pairing code version");
  const url = get("u");
  if (!/^wss?:\/\//.test(url)) throw new Error("Pairing code has an invalid address");
  const publicKey = fromBase64Url(get("k"));
  if (publicKey.length !== nacl.box.publicKeyLength) throw new Error("Invalid key in pairing code");
  return { publicKey, secret: get("s"), url, name: get("n") };
}

// ---- base64 (no Buffer, so it runs on React Native too) -----------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((ch, i) => [ch, i]));

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) {
    throw new ChannelError("invalid base64");
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of clean) {
    value = (value << 6) | (LOOKUP.get(ch) ?? 0);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fromBase64Url = (text: string): Uint8Array =>
  fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
