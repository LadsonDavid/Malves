import {
  generateKeyPair,
  isKey,
  open,
  PairingOffer,
  publicKeyOf,
  randomToken,
  seal,
} from "@malves/protocol";
import { describe, expect, it } from "vitest";

describe("sealed messages", () => {
  const phone = generateKeyPair();
  const runner = generateKeyPair();

  it("round-trips between the two key pairs", () => {
    const message = { type: "hello", text: "naïve ✓ 日本" };
    const sealed = seal(message, runner.publicKey, phone.secretKey);
    expect(open(sealed, phone.publicKey, runner.secretKey)).toEqual(message);
  });

  it("never reveals the plaintext on the wire", () => {
    const sealed = seal({ secret: "rm -rf build" }, runner.publicKey, phone.secretKey);
    expect(JSON.stringify(sealed)).not.toContain("rm -rf");
  });

  it("uses a fresh nonce every time", () => {
    const a = seal({ x: 1 }, runner.publicKey, phone.secretKey);
    const b = seal({ x: 1 }, runner.publicKey, phone.secretKey);
    expect(a.n).not.toBe(b.n);
  });

  it("refuses tampered ciphertext", () => {
    const sealed = seal({ x: 1 }, runner.publicKey, phone.secretKey);
    const flipped = sealed.c.startsWith("A") ? `B${sealed.c.slice(1)}` : `A${sealed.c.slice(1)}`;
    expect(open({ ...sealed, c: flipped }, phone.publicKey, runner.secretKey)).toBeUndefined();
  });

  it("refuses a message from anyone but the expected sender", () => {
    const stranger = generateKeyPair();
    const sealed = seal({ x: 1 }, runner.publicKey, stranger.secretKey);
    expect(open(sealed, phone.publicKey, runner.secretKey)).toBeUndefined();
  });

  it("never throws on garbage", () => {
    expect(open({ n: "%%%", c: "!!" }, phone.publicKey, runner.secretKey)).toBeUndefined();
    expect(open({ n: "", c: "" }, phone.publicKey, runner.secretKey)).toBeUndefined();
  });
});

describe("keys and tokens", () => {
  it("recovers the public key from the secret key", () => {
    const keys = generateKeyPair();
    expect(publicKeyOf(keys.secretKey)).toBe(keys.publicKey);
  });

  it("recognises keys", () => {
    expect(isKey(generateKeyPair().publicKey)).toBe(true);
    expect(isKey(randomToken(16))).toBe(false);
    expect(isKey("not base64 at all")).toBe(false);
  });

  it("makes distinct random tokens", () => {
    expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50);
  });
});

describe("pairing offer (the QR code)", () => {
  const offer = {
    v: 1,
    url: "ws://100.64.0.7:7717",
    runner: generateKeyPair().publicKey,
    code: randomToken(),
    computer: "work-pc",
  };

  it("accepts a well-formed offer", () => {
    expect(PairingOffer.parse(offer)).toEqual(offer);
  });

  it.each([
    ["an http URL", { url: "http://x" }],
    ["a bad key", { runner: "abc" }],
    ["a short code", { code: "123456" }],
    ["another version", { v: 2 }],
  ])("rejects %s", (_name, change) => {
    expect(PairingOffer.safeParse({ ...offer, ...change }).success).toBe(false);
  });
});
