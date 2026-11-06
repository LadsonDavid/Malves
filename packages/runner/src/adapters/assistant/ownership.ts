import path from "node:path";
import { z } from "zod";
import { readSecretJson, writeSecretJson } from "../../secure-file.js";

const State = z.object({ version: z.literal(1), owner: z.enum(["human", "malves"]) });
const file = (dir: string) => path.join(dir, "desktop-ownership.json");
export function humanHasControl(dir: string): boolean {
  try {
    const saved = readSecretJson<unknown>(file(dir));
    return saved !== undefined && State.parse(saved).owner === "human";
  } catch {
    return true;
  } // Damaged/unreadable state must never release a human lock.
}
export function saveControlOwner(dir: string, owner: "human" | "malves"): void {
  writeSecretJson(file(dir), { version: 1, owner });
}
