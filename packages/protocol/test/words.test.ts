import { expect, it } from "vitest";
import { explicitlyRequestsRunner, yesOrNo } from "../src/words.js";

it("accepts explicit confirmations in English, Tamil and Tanglish", () => {
  for (const phrase of [
    "yes",
    "yes please",
    "Malves, go ahead and do it now",
    "start it",
    "சரி",
    "ஆம்",
    "aama",
    "seri",
  ])
    expect(yesOrNo(phrase)).toBe("yes");
});
it("never treats a different instruction as permission for an older action", () => {
  for (const phrase of [
    "Actually start the second task",
    "yes but change the other file",
    "go to the other conversation",
    "the right file is index.ts",
    "start a new Codex chat",
  ])
    expect(yesOrNo(phrase)).toBeUndefined();
  expect(yesOrNo("yes, do not send it")).toBe("no");
});
it("requires an explicit runner/CLI request in English or Tamil before desktop fallback", () => {
  for (const text of ["Use the CLI", "Start a command-line task", "சிஎல்ஐ மூலம் செய்"])
    expect(explicitlyRequestsRunner(text)).toBe(true);
  for (const text of ["Work in Codex desktop", "Start a coding task", "Retry this chat"])
    expect(explicitlyRequestsRunner(text)).toBe(false);
});
