import { generateKeyPair, LINK_VERSION, pairingLink, readPairing } from "@malves/protocol";
import { describe, expect, it } from "vitest";

const offer = () => ({
  v: LINK_VERSION as 1,
  url: "ws://100.64.0.1:7717",
  runner: generateKeyPair().publicKey,
  code: "abcdefghijklmnopqrstuvwx",
  computer: "Ladson's PC / ½ ₹ தமிழ்",
});

describe("pairing links", () => {
  it("a link carries the whole offer, whatever the computer is called", () => {
    const o = offer();
    const link = pairingLink(o);
    expect(link.startsWith("malves://pair?o=")).toBe(true);
    expect(link).not.toMatch(/\s/);
    expect(readPairing(link)).toEqual(o);
  });

  it("readPairing still reads the plain JSON that the QR code has always carried", () => {
    const o = offer();
    expect(readPairing(JSON.stringify(o))).toEqual(o);
  });

  it("refuses anything else", () => {
    expect(readPairing("hello")).toBeUndefined();
    expect(readPairing("malves://pair?o=%7Bnope")).toBeUndefined();
    expect(readPairing("malves://pair")).toBeUndefined();
    expect(readPairing("malves://task/abc")).toBeUndefined();
    // A real shape with a bad key is refused, not half-accepted.
    const bad = { ...offer(), runner: "AAAA" };
    expect(readPairing(pairingLink(bad as never))).toBeUndefined();
    // An address that isn't a websocket.
    expect(readPairing(pairingLink({ ...offer(), url: "http://evil.example" }))).toBeUndefined();
  });
});
