/**
 * Yes and no, as people say them to Malves: English, Tamil, Tanglish. Shared so
 * the phone and the computer read a spoken "yes" exactly the same way.
 *
 * Any "no" word wins: a misheard answer can only ever deny.
 */
export const YES_WORDS = [
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

export const NO_WORDS = [
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

/** Lower case, no punctuation (Tamil letters kept), single spaces, padded for whole-word checks. */
export function normalizeSpeech(text: string): string {
  const plain = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${plain} `;
}

export function saysAny(text: string, words: readonly string[]): boolean {
  const said = normalizeSpeech(text);
  return words.some((w) => said.includes(` ${w} `));
}

/** "yes", "no", or undefined when it's neither. Any no word makes it a no. */
export function yesOrNo(text: string): "yes" | "no" | undefined {
  if (saysAny(text, NO_WORDS)) return "no";
  if (saysAny(text, YES_WORDS)) return "yes";
  return undefined;
}
