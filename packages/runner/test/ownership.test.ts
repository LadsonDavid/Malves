import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Handover } from "../src/adapters/assistant/handover.js";
import { humanHasControl, saveControlOwner } from "../src/adapters/assistant/ownership.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("preserves human ownership after restart and fails closed on damaged state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "malves-ownership-"));
  dirs.push(dir);
  expect(humanHasControl(dir)).toBe(false);
  saveControlOwner(dir, "human");
  const recovered = new Handover({ onChange: () => {}, initialPaused: humanHasControl(dir) });
  expect(recovered.state.paused).toBe(true);
  expect(recovered.start().active).toBe(false);
  saveControlOwner(dir, "malves");
  expect(humanHasControl(dir)).toBe(false);
  writeFileSync(path.join(dir, "desktop-ownership.json"), "{damaged");
  expect(humanHasControl(dir)).toBe(true);
});
