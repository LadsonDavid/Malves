import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupKey,
  packVault,
  restoreVault,
  unpackVault,
} from "../src/adapters/assistant/backup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "malves-backup-"));
  dirs.push(d);
  return d;
};

describe("vault backup", () => {
  it("encrypts the vault, restores it only with the right key, and never over files", () => {
    const vault = temp();
    mkdirSync(path.join(vault, "Facts"));
    writeFileSync(path.join(vault, "Facts", "server.md"), "The server is malves-brain-a1.");
    mkdirSync(path.join(vault, ".trash"));
    writeFileSync(path.join(vault, ".trash", "old.md"), "deleted");

    const data = temp();
    const key = backupKey(data);
    expect(backupKey(data).equals(key)).toBe(true);
    const blob = packVault(vault, key);
    expect(blob.includes(Buffer.from("malves-brain-a1"))).toBe(false);

    expect(unpackVault(blob, key).map((f) => f.path)).toEqual(["Facts/server.md"]);
    expect(() => unpackVault(blob, Buffer.alloc(32, 1))).toThrow(/Wrong backup key/);
    const tampered = Buffer.from(blob);
    tampered.writeUInt8((tampered.at(-1) ?? 0) ^ 1, tampered.length - 1);
    expect(() => unpackVault(tampered, key)).toThrow(/damaged/);

    const into = path.join(temp(), "restored");
    expect(restoreVault(blob, key, into)).toBe(1);
    expect(readFileSync(path.join(into, "Facts", "server.md"), "utf8")).toContain("brain-a1");
    expect(() => restoreVault(blob, key, into)).toThrow(/isn't empty/);
  });
});
