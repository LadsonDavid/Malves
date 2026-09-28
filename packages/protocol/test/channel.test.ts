import {
  Channel,
  decodeInvite,
  encodeInvite,
  equalSecrets,
  fromBase64,
  fromBase64Url,
  generateKeyPair,
  parseFrame,
  runnerIdOf,
  toBase64,
  toBase64Url,
} from "@malves/protocol";
import { describe, expect, it } from "vitest";

describe("Channel", () => {
  const runner = generateKeyPair();
  const phone = generateKeyPair();

  it("round-trips messages both ways", () => {
    const phoneSide = new Channel(phone.secretKey, runner.publicKey);
    const runnerSide = new Channel(runner.secretKey, phone.publicKey);
    const frame = parseFrame(phoneSide.seal({ t: "answer", id: "c1" }, phone.publicKey));
    expect(frame.k).toBe(toBase64(phone.publicKey));
    expect(runnerSide.open(frame)).toEqual({ t: "answer", id: "c1" });
    expect(phoneSide.open(parseFrame(runnerSide.seal({ t: "ack", id: "c1" })))).toEqual({
      t: "ack",
      id: "c1",
    });
  });

  it("the ciphertext does not contain the message", () => {
    const text = new Channel(phone.secretKey, runner.publicKey).seal({ secret: "hunter2" });
    expect(text).not.toContain("hunter2");
  });

  it("rejects a replayed frame", () => {
    const phoneSide = new Channel(phone.secretKey, runner.publicKey);
    const runnerSide = new Channel(runner.secretKey, phone.publicKey);
    const frame = parseFrame(phoneSide.seal({ t: "x" }));
    runnerSide.open(frame);
    expect(() => runnerSide.open(frame)).toThrow(/replayed/);
  });

  it("rejects a tampered frame", () => {
    const phoneSide = new Channel(phone.secretKey, runner.publicKey);
    const runnerSide = new Channel(runner.secretKey, phone.publicKey);
    const frame = parseFrame(phoneSide.seal({ t: "x" }));
    const bytes = fromBase64(frame.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => runnerSide.open({ ...frame, c: toBase64(bytes) })).toThrow(/decrypt/);
  });

  it("rejects a frame from a different key", () => {
    const stranger = generateKeyPair();
    const frame = parseFrame(new Channel(stranger.secretKey, runner.publicKey).seal({ t: "x" }));
    expect(() => new Channel(runner.secretKey, phone.publicKey).open(frame)).toThrow();
  });
});

describe("pairing invite", () => {
  it("round-trips through the QR text", () => {
    const { publicKey } = generateKeyPair();
    const invite = {
      publicKey,
      secret: "abc_-123",
      url: "ws://100.64.0.1:7420",
      name: "Desk & Co",
    };
    const text = encodeInvite(invite);
    expect(text.startsWith("malves://pair?")).toBe(true);
    expect(decodeInvite(text)).toEqual(invite);
  });

  it("rejects other QR codes and bad addresses", () => {
    expect(() => decodeInvite("https://example.com")).toThrow();
    const { publicKey } = generateKeyPair();
    const bad = encodeInvite({ publicKey, secret: "s", url: "http://x", name: "n" });
    expect(() => decodeInvite(bad)).toThrow(/address/);
  });
});

describe("helpers", () => {
  it("base64 matches Node's", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("runner ids are short and stable", () => {
    const { publicKey } = generateKeyPair();
    expect(runnerIdOf(publicKey)).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(runnerIdOf(publicKey)).toBe(runnerIdOf(publicKey));
  });

  it("compares secrets", () => {
    expect(equalSecrets("abc", "abc")).toBe(true);
    expect(equalSecrets("abc", "abd")).toBe(false);
    expect(equalSecrets("abc", "abcd")).toBe(false);
  });
});
