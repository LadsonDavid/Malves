import { describe, expect, it } from "vitest";
import { type Context, interpret, normalize } from "../src/voice/intent";

/** What spoken sentences mean. Every rule here is a promise the voice mode keeps. */
const agents = [
  { name: "claude", label: "Claude" },
  { name: "codex", label: "Codex" },
  { name: "claude-free", label: "Claude (free models)" },
];
const workspaces = [
  { id: "w1", name: "malves" },
  { id: "w2", name: "website" },
];
const ctx = (awaiting: Context["awaiting"], choices?: Context["choices"]): Context => ({
  awaiting,
  agents,
  workspaces,
  ...(choices ? { choices } : {}),
});
const permission = [
  { id: "allow", label: "Allow" },
  { id: "reject", label: "Skip" },
];
const browser = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Don't allow" },
];
const commit = [
  { id: "commit", label: "Commit" },
  { id: "leave", label: "Leave uncommitted" },
];
const answer = (text: string, choices = permission) => {
  const intent = interpret(text, ctx("answer", choices));
  return intent.kind === "answer" ? intent.choiceId : intent.kind;
};

describe("answering a question by voice", () => {
  it("understands yes and no, in English, Tamil and Tanglish", () => {
    for (const yes of ["allow", "Yes, go ahead", "ok", "approve it", "சரி", "ஆம்", "sari", "aama"]) {
      expect(answer(yes), yes).toBe("allow");
    }
    for (const no of ["skip", "No.", "reject", "வேண்டாம்", "இல்லை", "vendaam", "illa"]) {
      expect(answer(no), no).toBe("reject");
    }
  });

  it("any 'no' word wins, so a mishearing can only deny", () => {
    expect(answer("don't allow", browser)).toBe("deny");
    expect(answer("no don't allow that", browser)).toBe("deny");
    expect(answer("yes no", browser)).toBe("deny");
    expect(answer("allow — no wait")).toBe("reject");
  });

  it("matches a choice by its own words, longest first", () => {
    expect(answer("leave uncommitted", commit)).toBe("leave");
    expect(answer("commit it", commit)).toBe("commit");
    expect(answer("Don't allow", browser)).toBe("deny");
  });

  it("understands 'option two' and 'the second one', never a number inside a sentence", () => {
    expect(answer("option two")).toBe("reject");
    expect(answer("the second one")).toBe("reject");
    expect(answer("number 1")).toBe("allow");
    expect(answer("இரண்டு")).toBe("reject");
    expect(answer("I have one question about this file")).toBe("unknown");
  });

  it("anything else is unknown — never a guess", () => {
    expect(answer("hmm what")).toBe("unknown");
    expect(answer("")).toBe("unknown");
  });

  it("still hears commands while a question is open", () => {
    expect(answer("repeat")).toBe("repeat");
    expect(answer("stop listening")).toBe("stopListening");
  });
});

describe("confirming", () => {
  it("yes confirms, any no cancels", () => {
    expect(interpret("confirm", ctx("confirm")).kind).toBe("confirm");
    expect(interpret("உறுதி", ctx("confirm")).kind).toBe("confirm");
    expect(interpret("yes start", ctx("confirm")).kind).toBe("confirm");
    expect(interpret("no cancel", ctx("confirm")).kind).toBe("cancel");
    expect(interpret("yes no", ctx("confirm")).kind).toBe("cancel");
    expect(interpret("ரத்து", ctx("confirm")).kind).toBe("cancel");
  });
});

describe("starting a task by voice", () => {
  it("'ask <agent> to …' picks the agent and the project, and keeps the rest as the request", () => {
    expect(interpret("Ask Claude to fix the footer in malves", ctx("command"))).toEqual({
      kind: "newTask",
      agent: "claude",
      workspaceId: "w1",
      prompt: "Fix the footer",
    });
    expect(interpret("tell codex to add tests on the website project", ctx("command"))).toEqual({
      kind: "newTask",
      agent: "codex",
      workspaceId: "w2",
      prompt: "Add tests",
    });
    expect(
      interpret("ask claude free models to summarize the readme", ctx("command")),
    ).toMatchObject({
      agent: "claude-free",
    });
  });

  it("'new task …' and Tamil 'புதிய பணி …' leave the agent to the default", () => {
    expect(interpret("new task update the changelog", ctx("command"))).toEqual({
      kind: "newTask",
      prompt: "Update the changelog",
    });
    expect(interpret("புதிய பணி readme சரி செய்", ctx("command"))).toMatchObject({
      kind: "newTask",
    });
  });

  it("an unknown agent name isn't guessed", () => {
    expect(interpret("ask bob to fix it", ctx("command")).kind).toBe("unknown");
  });

  it("dictating a request keeps every word; a lone 'cancel' cancels", () => {
    expect(interpret("Refactor the login page and keep the tests green", ctx("prompt"))).toEqual({
      kind: "newTask",
      prompt: "Refactor the login page and keep the tests green",
    });
    expect(interpret("cancel", ctx("prompt")).kind).toBe("cancel");
    // Command words inside a dictated request stay part of it.
    expect(
      interpret("repeat the failing test and stop listening for events", ctx("prompt")).kind,
    ).toBe("newTask");
  });
});

describe("commands", () => {
  it.each([
    ["what needs me", "needs"],
    ["what's running", "running"],
    ["read the result", "result"],
    ["more", "more"],
    ["stop the task", "stopTask"],
    ["run it again", "runAgain"],
    ["read leads", "leads"],
    ["say that again", "repeat"],
    ["that's all", "stopListening"],
    ["போதும்", "stopListening"],
    ["என்ன நடக்கிறது", "running"],
    ["what can I say", "help"],
  ])("%s → %s", (text, kind) => {
    expect(interpret(text, ctx("command")).kind).toBe(kind);
  });

  it("reply keeps what to say", () => {
    expect(interpret("reply now add a test", ctx("command"))).toEqual({
      kind: "reply",
      text: "now add a test",
    });
  });

  it("normalizes punctuation and case, and keeps Tamil letters", () => {
    expect(normalize("  Don't — STOP!  ")).toBe(" dont stop ");
    expect(normalize("சரி.")).toBe(" சரி ");
  });
});
