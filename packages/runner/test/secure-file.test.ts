import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSecretJson, writeSecretJson } from "../src/secure-file.js";

const posix = process.platform !== "win32";

describe("secret files", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "malves-secret-"));

  it("writes and reads back", () => {
    const file = path.join(dir(), "token.json");
    writeSecretJson(file, { token: "abc" });
    expect(readSecretJson<{ token: string }>(file)).toEqual({ token: "abc" });
  });

  it("replaces an existing file whole, leaving no temp file behind", () => {
    const d = dir();
    const file = path.join(d, "token.json");
    writeSecretJson(file, { token: "one" });
    writeSecretJson(file, { token: "two" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "two" });
    expect(readdirSync(d)).toEqual(["token.json"]);
  });

  it("returns undefined for a missing file and throws for broken JSON", () => {
    const d = dir();
    expect(readSecretJson(path.join(d, "none.json"))).toBeUndefined();
    writeFileSync(path.join(d, "bad.json"), "{nope");
    expect(() => readSecretJson(path.join(d, "bad.json"))).toThrow(/bad\.json/);
  });

  it.runIf(posix)("is owner-only, and tightens a file someone else could read", () => {
    const file = path.join(dir(), "token.json");
    writeSecretJson(file, { token: "abc" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    chmodSync(file, 0o644);
    readSecretJson(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
