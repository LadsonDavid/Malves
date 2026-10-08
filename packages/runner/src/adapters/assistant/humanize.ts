import { splitSentences } from "./voice.js";

/**
 * The last check on how Malves sounds, after the brain's own instructions
 * (persona). Models slip into chatbot habits; this takes out the ones code
 * can catch safely (from the humanizer skill, after Wikipedia's "Signs of AI
 * writing"): chatbot openers and closers, flattery, em dashes, curly quotes,
 * emojis and markdown, which are noise when spoken. `words` also swaps filler
 * phrases; it's only for the brain's words, never a code-written read-back,
 * which must say exactly what will happen.
 */

/** A whole sentence that's only a chatbot habit: dropped. */
const EMPTY_SENTENCE = [
  /^(great|good|excellent|interesting|fantastic) (question|point|idea)\b/i,
  /^(you'?re|you are) (absolutely|completely|totally) right\b/i,
  /^(i )?hope (this|that|it) helps\b/i,
  /^(let me know|feel free|don'?t hesitate)\b/i,
  /^(is there )?anything else( i can (help|do))?\b.*\?$/i,
  /^happy to help\b/i,
  /^i'?m here (to help|if you need)\b/i,
  /^(certainly|of course|absolutely|sure|sure thing|great|perfect|awesome|got it)[!.]?$/i,
];

/** A chatbot opener at the start of a sentence: cut, the rest kept. */
const OPENER =
  /^(certainly|of course|absolutely|sure|sure thing|great question|good question|great|perfect|awesome)[!,.]\s+/i;

const FILLER: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bit is (important|worth) (to note|noting) that\s*/gi, ""],
  [/\b(additionally|furthermore|moreover),\s*/gi, "also, "],
  [/\butili[sz]e\b/gi, "use"],
  [/\bserves as\b/gi, "is"],
  [/\bcould potentially\b/gi, "could"],
  [/\bmight possibly\b/gi, "might"],
];

function cleanSentence(sentence: string, words: boolean): string {
  if (EMPTY_SENTENCE.some((p) => p.test(sentence.trim()))) return "";
  let s = sentence
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s*[—–]\s*|\s+--\s+/g, ", ")
    .replace(OPENER, "");
  if (words) for (const [from, to] of FILLER) s = s.replace(from, to);
  s = s
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  // An opener removed from the front leaves a lower-case start: fix it.
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function humanize(text: string, o: { words?: boolean } = {}): string {
  const words = o.words !== false;
  return splitSentences(text)
    .map((s) => cleanSentence(s, words))
    .filter(Boolean)
    .join(" ");
}

/** One sentence, the same way (for speaking sentences as they stream). */
export function humanizeSentence(sentence: string, o: { words?: boolean } = {}): string {
  return cleanSentence(sentence, o.words !== false);
}
