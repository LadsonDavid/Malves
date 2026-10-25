import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerRedaction } from "../../redact.js";

export type VaultSecret = {
  handle: string;
  origin: string; // e.g. "https://dashboard.stripe.com"
  username?: string | undefined;
  secret: string; // password, token or TOTP base32 key
  kind?: "password" | "totp" | "card" | undefined;
};

export type VaultHandle = {
  handle: string;
  origin: string;
  username?: string | undefined;
  kind?: "password" | "totp" | "card" | undefined;
};

export type VaultOptions = {
  file?: string | undefined;
  key?: Buffer | undefined;
};

/** Decodes a base32 string into a Buffer. */
function base32Decode(base32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const char of cleaned) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Computes standard 6-digit RFC 6238 TOTP code from a base32 secret. */
export function generateTotp(
  secret: string,
  stepSeconds = 30,
  digits = 6,
  timeMs = Date.now(),
): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);
  const key = base32Decode(secret);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits);
  return code.toString().padStart(digits, "0");
}

export function normalizeOrigin(urlOrOrigin: string): string {
  try {
    const u = new URL(urlOrOrigin);
    return u.origin.toLowerCase();
  } catch {
    return urlOrOrigin.toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * An encrypted vault holding login credentials and TOTP secrets (§6).
 * Secrets are bound to web origins; the agent sees only a handle and site.
 * The model never sees the secret bytes.
 * Uses AES-256-GCM authenticated encryption.
 */
export class BrowserVault {
  private readonly secrets = new Map<string, VaultSecret>();
  private readonly key: Buffer;
  private readonly file: string | undefined;

  constructor(options: VaultOptions = {}) {
    this.file = options.file;
    this.key = options.key ?? randomBytes(32);

    if (this.file && existsSync(this.file)) {
      this.load();
    }
  }

  /** Adds or updates a secret in the vault. */
  async add(entry: VaultSecret): Promise<void> {
    const normalized: VaultSecret = {
      handle: entry.handle.trim(),
      origin: normalizeOrigin(entry.origin),
      secret: entry.secret,
      kind: entry.kind ?? "password",
      username: entry.username,
    };
    this.secrets.set(normalized.handle, normalized);
    this.save();
  }

  /** Removes a secret by handle. */
  async remove(handle: string): Promise<boolean> {
    const removed = this.secrets.delete(handle);
    if (removed) this.save();
    return removed;
  }

  /** Returns all handles without any secret data (safe for models/agents). */
  list(): VaultHandle[] {
    return Array.from(this.secrets.values()).map(({ handle, origin, username, kind }) => ({
      handle,
      origin,
      username,
      kind,
    }));
  }

  /** Retrieves full entry by handle (internal use only). */
  get(handle: string): VaultSecret | undefined {
    return this.secrets.get(handle);
  }

  /**
   * Retrieves secret for autofill on currentOrigin.
   * Throws if handle is not found or if the current origin does not match the vault entry's origin.
   * Registers secret bytes for redaction across logs and memory.
   */
  async fill(handle: string, currentOrigin: string): Promise<{ value: string; kind: string }> {
    const entry = this.secrets.get(handle);
    if (!entry) {
      throw new Error(`No secret found in vault with handle "${handle}".`);
    }

    const normCurrent = normalizeOrigin(currentOrigin);
    const normBound = normalizeOrigin(entry.origin);

    if (normCurrent !== normBound) {
      throw new Error(
        `Refused: secret "${handle}" is bound to "${entry.origin}", but current page is "${currentOrigin}".`,
      );
    }

    let value = entry.secret;
    if (entry.kind === "totp") {
      value = generateTotp(entry.secret);
    }

    // Register secret bytes for redaction in logs/events
    registerRedaction(value);
    if (entry.secret !== value) {
      registerRedaction(entry.secret);
    }

    return { value, kind: entry.kind ?? "password" };
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; tag: string };
      const iv = Buffer.from(parsed.iv, "base64");
      const ciphertext = Buffer.from(parsed.ciphertext, "base64");
      const tag = Buffer.from(parsed.tag, "base64");

      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const data = JSON.parse(decrypted.toString("utf8")) as VaultSecret[];
      this.secrets.clear();
      for (const entry of data) {
        this.secrets.set(entry.handle, entry);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Unsupported state")) {
        throw new Error("Failed to decrypt vault: wrong key or corrupted file.");
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    const data = Buffer.from(JSON.stringify(Array.from(this.secrets.values())), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload = JSON.stringify({
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    });
    writeFileSync(this.file, payload, "utf8");
  }
}
