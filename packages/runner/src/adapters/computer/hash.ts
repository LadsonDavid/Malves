import { createHash } from "node:crypto";
import type { Rect } from "./types.js";

/**
 * Computes a perceptual hash of an image or region.
 * If raw RGBA bytes are provided: computes average hash (aHash).
 * If a string (e.g. base64 JPEG or UI element state): hashes normalized tokens.
 */
export function perceptualHash(
  data: Uint8Array | string,
  rect?: Rect,
  gridSize = 8,
): string {
  if (typeof data === "string") {
    // For string/base64 representations, compute sample block hash
    const block = rect
      ? `${rect.x},${rect.y},${rect.width},${rect.height}:${data.slice(0, 1000)}`
      : data.slice(0, 2000);
    return createHash("sha256").update(block).digest("hex").slice(0, 16);
  }

  // 8x8 average hash over byte buffer
  const totalPixels = gridSize * gridSize;
  const samples = new Uint8Array(totalPixels);
  const step = Math.max(1, Math.floor(data.length / totalPixels));

  let sum = 0;
  for (let i = 0; i < totalPixels; i++) {
    const val = data[i * step] ?? 0;
    samples[i] = val;
    sum += val;
  }

  const avg = sum / totalPixels;
  let hashHex = "";
  for (let byteIdx = 0; byteIdx < totalPixels / 8; byteIdx++) {
    let byteVal = 0;
    for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
      const idx = byteIdx * 8 + bitIdx;
      if ((samples[idx] ?? 0) >= avg) {
        byteVal |= 1 << (7 - bitIdx);
      }
    }
    hashHex += byteVal.toString(16).padStart(2, "0");
  }

  return hashHex;
}

/**
 * Computes the Hamming distance (number of differing bits) between two hex hashes.
 */
export function hashDistance(h1: string, h2: string): number {
  if (h1 === h2) return 0;
  const len = Math.min(h1.length, h2.length);
  let distance = 0;

  for (let i = 0; i < len; i += 2) {
    const b1 = parseInt(h1.slice(i, i + 2), 16) || 0;
    const b2 = parseInt(h2.slice(i, i + 2), 16) || 0;
    let xor = b1 ^ b2;
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }

  // Penalty for length discrepancy
  distance += Math.abs(h1.length - h2.length) * 4;
  return distance;
}

/**
 * Default perceptual hash difference threshold:
 * 10 bit differences out of 64 bits (~15% change).
 */
export const DEFAULT_HASH_THRESHOLD = 10;
