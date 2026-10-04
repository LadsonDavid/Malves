import type { Choice } from "@malves/protocol";

/**
 * What a spoken sentence means to malves. Plain rules, no model: the same words
 * always do the same thing, so voice is predictable. Understands English, Tamil
 * and Tanglish ("sari", "vendaam").
 *
 * Safety: anything with a "no" word in it counts as no. A misheard answer can
 * only ever deny, never approve.
 */
export type Intent =
  | { kind: "answer"; choiceId: string; label: string }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "newTask"; prompt: string; agent?: string; workspaceId?: string }
  | { kind: "needs" }
  | { kind: "running" }
  | { kind: "result" }
  | { kind: "more" }
  | { kind: "stopTask" }
  | { kind: "reply"; text: string }
  | { kind: "runAgain" }
  | { kind: "leads" }
  | { kind: "repeat" }
  | { kind: "stopListening" }
  | { kind: "help" }
  | { kind: "unknown"; heard: string };

export type Context = {
  /** What malves just asked for. */
  awaiting: "command" | "answer" | "confirm" | "prompt";
  /** The current question's choices, when awaiting an answer. */
  choices?: Choice[];
  agents: Array<{ name: string; label: string }>;
  workspaces: Array<{ id: string; name: string }>;
};

const YES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "confirm",
  "confirmed",
  "sure",
  "ok",
  "okay",
  "go ahead",
  "do it",
  "correct",
  "right",
  "start",
  "go",
  "ஆம்",
  "ஆமா",
  "சரி",
  "உறுதி",
  "தொடங்கு",
  "ஓகே",
  "aam",
  "aama",
  "aamaa",
  "sari",
  "seri",
  "uruthi",
];
const NO = [
  "no",
  "nope",
  "cancel",
  "stop",
  "dont",
  "do not",
  "never mind",
  "wait",
  "deny",
  "skip",
  "reject",
  "refuse",
  "block",
  "leave",
  "வேண்டாம்",
  "இல்லை",
  "ரத்து",
  "நிறுத்து",
  "தவிர்",
  "vendaam",
  "venda",
  "vendam",
  "illa",
  "illai",
  "rathu",
  "thavir",
  "niruthu",
];
const ALLOW = [
  ...YES,
  "allow",
  "approve",
  "accept",
  "permit",
  "commit",
  "use it",
  "continue",
  "அனுமதி",
  "anumathi",
];
/** A choice label that means no, e.g. "Skip", "Don't allow", "Leave uncommitted". */
const NO_LABEL = /reject|skip|deny|\bno\b|don.?t|leave|stop|cancel|refuse/i;

const ORDINALS: Array<[number, string[]]> = [
  [1, ["1", "one", "first", "ஒன்று", "முதல்", "ondru", "muthal"]],
  [2, ["2", "two", "second", "இரண்டு", "இரண்டாவது", "irandu"]],
  [3, ["3", "three", "third", "மூன்று", "moondru"]],
];

/** Lower case, no punctuation (Tamil letters kept), single spaces, padded for whole-word checks. */
export function normalize(text: string): string {
  const plain = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${plain} `;
}

const has = (said: string, words: string[]) => words.some((w) => said.includes(` ${w} `));

export function interpret(text: string, ctx: Context): Intent {
  const said = normalize(text);
  if (said.trim() === "") return { kind: "unknown", heard: text };

  // These always mean what they say, even in the middle of a question.
  if (ctx.awaiting === "answer" || ctx.awaiting === "confirm") {
    for (const [kind, words] of COMMANDS) {
      if (ALWAYS.includes(kind) && has(said, words)) return { kind } as Intent;
    }
  }
  if (ctx.awaiting === "confirm") {
    if (has(said, NO)) return { kind: "cancel" };
    if (has(said, YES)) return { kind: "confirm" };
    return command(said, text, ctx);
  }
  if (ctx.awaiting === "answer" && ctx.choices?.length) {
    const answer = answerFrom(said, ctx.choices);
    if (answer) return answer;
    return command(said, text, ctx);
  }
  if (ctx.awaiting === "prompt") {
    if (has(said, NO) && said.trim().split(" ").length <= 2) return { kind: "cancel" };
    return { kind: "newTask", prompt: text.trim() };
  }
  return command(said, text, ctx);
}

/** Which choice an answer means: its own label, its position, or a plain yes or no. */
function answerFrom(said: string, choices: Choice[]): Intent | undefined {
  const pick = (c: Choice | undefined): Intent | undefined =>
    c ? { kind: "answer", choiceId: c.id, label: c.label } : undefined;
  // A choice's own words, longest first ("leave uncommitted" before "leave").
  // With any "no" word in the sentence, only a "no" choice can be picked.
  const no = has(said, NO);
  const byLabel = [...choices]
    .filter((c) => !no || NO_LABEL.test(c.label))
    .sort((a, b) => b.label.length - a.label.length)
    .find((c) => normalize(c.label).trim() !== "" && said.includes(normalize(c.label)));
  if (byLabel) return pick(byLabel);
  if (no) return pick(choices.find((c) => NO_LABEL.test(c.label)));
  // "option two", "number 2", "the second one", or just "two" — never inside a longer sentence.
  const short = said.trim().split(" ").length <= 3;
  const ordinal = said.replace(/ (first|second|third) one /, " $1 ");
  if (short || /option|number|choice|எண்/.test(said)) {
    for (const [n, words] of ORDINALS) {
      if (n <= choices.length && has(ordinal, words)) return pick(choices[n - 1]);
    }
  }
  if (has(said, NO)) return pick(choices.find((c) => NO_LABEL.test(c.label)));
  if (has(said, ALLOW)) return pick(choices.find((c) => !NO_LABEL.test(c.label)));
  return undefined;
}

const COMMANDS: Array<[Intent["kind"], string[]]> = [
  [
    "stopListening",
    [
      "stop listening",
      "voice off",
      "goodbye",
      "bye",
      "thats all",
      "that is all",
      "போதும்",
      "pothum",
    ],
  ],
  [
    "runAgain",
    ["run again", "run it again", "retry", "try again", "மீண்டும் இயக்கு", "meendum iyakku"],
  ],
  [
    "stopTask",
    [
      "stop the task",
      "stop task",
      "stop it",
      "cancel the task",
      "பணியை நிறுத்து",
      "paniyai niruthu",
    ],
  ],
  [
    "needs",
    [
      "what needs me",
      "needs me",
      "anything for me",
      "questions",
      "whats waiting",
      "என்ன தேவை",
      "enna thevai",
    ],
  ],
  [
    "running",
    [
      "whats running",
      "what is running",
      "running",
      "status",
      "progress",
      "என்ன நடக்கிறது",
      "enna nadakkirathu",
    ],
  ],
  [
    "result",
    ["read the result", "the result", "result", "what did it do", "read it", "முடிவு", "mudivu"],
  ],
  ["more", ["more", "go on", "keep reading", "மேலும்", "melum"]],
  ["repeat", ["repeat", "say again", "say that again", "மீண்டும் சொல்", "meendum sol"]],
  ["leads", ["leads", "read leads", "who to contact", "லீட்ஸ்"]],
  ["help", ["help", "what can i say", "உதவி", "udhavi"]],
];

/** Commands that win over an answer or a confirmation. */
const ALWAYS: Array<Intent["kind"]> = ["stopListening", "repeat", "help"];

function command(said: string, text: string, ctx: Context): Intent {
  const task = newTask(said, ctx);
  if (task) return task;
  const reply = said.match(/^ (?:reply|tell it|பதில்|bathil) (.+) $/);
  if (reply?.[1]) return { kind: "reply", text: reply[1].trim() };
  for (const [kind, words] of COMMANDS) {
    if (has(said, words)) return { kind } as Intent;
  }
  return { kind: "unknown", heard: text };
}

/** "ask Claude to fix the footer in malves", "new task fix the footer", "புதிய பணி …". */
function newTask(said: string, ctx: Context): Intent | undefined {
  const agents = ctx.agents
    .flatMap((a) => [
      { name: a.name, alias: normalize(a.label).trim() },
      { name: a.name, alias: a.name.replace(/-/g, " ") },
    ])
    .sort((x, y) => y.alias.length - x.alias.length);

  let rest: string | undefined;
  let agent: string | undefined;
  const lead = said.match(
    /^ (?:new task|create a task|start a task|புதிய பணி|puthiya pani) (.+) $/,
  );
  if (lead?.[1]) rest = ` ${lead[1]} `;
  const asked = said.match(/^ (?:ask|tell|have|get) (.+?) to (.+) $/);
  if (!rest && asked?.[1] && asked[2]) {
    const who = agents.find((a) => a.alias === asked[1]);
    if (who) {
      agent = who.name;
      rest = ` ${asked[2]} `;
    }
  }
  if (!rest) return undefined;

  // "… in malves" / "… on the website project": the project, taken out of the prompt.
  let workspaceId: string | undefined;
  for (const w of [...ctx.workspaces].sort((a, b) => b.name.length - a.name.length)) {
    const name = normalize(w.name).trim();
    const where = new RegExp(
      ` (?:in|on|for|inside) (?:the )?${escapeRegExp(name)}(?: project| folder)? `,
    );
    if (where.test(rest)) {
      workspaceId = w.id;
      rest = rest.replace(where, " ");
      break;
    }
  }
  const prompt = rest.trim();
  if (!prompt) return undefined;
  return {
    kind: "newTask",
    prompt: prompt.charAt(0).toUpperCase() + prompt.slice(1),
    ...(agent ? { agent } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
