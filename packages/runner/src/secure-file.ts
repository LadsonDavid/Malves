import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Files that hold a secret (tokens, keys). Two promises:
 * - a write is all-or-nothing: the new content goes to a temp file in the same
 *   folder and is renamed over the old one, so a crash can't leave half a key;
 * - the file is owner-only. Windows ignores mode bits (the profile folder's
 *   ACL protects it there), so this matters on Linux and macOS.
 */
export function writeSecretJson(file: string, value: unknown): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Reads a secret file. Undefined if it doesn't exist. If another user could
 * read it (a copy, a restore from backup), it is tightened first.
 */
export function readSecretJson<T>(file: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path.basename(file)} is damaged. Delete it to start again.`);
  }
}
