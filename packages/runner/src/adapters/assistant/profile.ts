import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Llm } from "./llm.js";

/**
 * His profile: "About me.md" in the vault, the work profile only (the private
 * one never leaves the computer). Its core goes to the brain with every
 * message, all of it when he asks for writing. Malves never edits it on its
 * own: an edit is a draft, read back in code-written words, written on yes.
 * Once a week the brain compares the profile with what he actually did and
 * drafts edits where they differ.
 */
export const PROFILE_FILE = "About me.md";

/** Always sent: who he is and how he judges. The rest only for writing. */
const CORE = [
  "priority",
  "identity_context",
  "voice_fingerprint",
  "decision_rules",
  "do_not_infer",
];
const WRITING =
  /\b(write|draft|post|linkedin|tweet|twitter|email|mail|dm|message|caption|copy|outreach|reply to|comment)\b/i;
const MAX_CHARS = 12_000;
/** For writing, the whole profile (examples and the phrase bank sit at the end). */
const MAX_WRITING_CHARS = 30_000;

export type ProfileDraft = { id: string; find: string; replace: string; why: string };

export class Profile {
  private readonly file: string;
  private readonly draftsFile: string;

  constructor(private readonly o: { vault: string; dataDir: string; llm: Llm; now?: () => Date }) {
    this.file = path.join(o.vault, PROFILE_FILE);
    this.draftsFile = path.join(o.dataDir, "profile-drafts.json");
  }

  text(): string {
    try {
      return readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }

  /** What the brain gets for this message. */
  forBrain(message: string): string {
    const all = this.text();
    if (!all) return "";
    // The outer <about_me> wraps everything: look inside it for the sections.
    const inner = all.replace(/<\/?about_me>/g, "");
    const sections = [...inner.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)].filter(
      ([, tag]) => tag !== "usage",
    );
    if (sections.length === 0 || WRITING.test(message)) return all.slice(0, MAX_WRITING_CHARS);
    return sections
      .filter(([, tag]) => CORE.includes(tag ?? ""))
      .map(([whole]) => whole)
      .join("\n")
      .slice(0, MAX_CHARS);
  }

  /** Why an edit can't be made, or undefined if it can. */
  check(find: string, replace: string): string | undefined {
    const all = this.text();
    if (!all) return "There's no profile yet.";
    if (replace.length > 600) return "That change is too long.";
    if (find && all.split(find).length !== 2)
      return "The text to change must appear exactly once in the profile.";
    const tags = (s: string) => (s.match(/<\/?[a-z_]+>/g) ?? []).join();
    if (tags(find) !== tags(replace))
      return "An edit may change the words, not the profile's sections.";
    return undefined;
  }

  /** Applies a checked edit; an empty `find` adds a line at the end. */
  apply(find: string, replace: string): void {
    const problem = this.check(find, replace);
    if (problem) throw new Error(problem);
    const all = this.text();
    writeFileSync(
      this.file,
      find ? all.replace(find, () => replace) : `${all.trimEnd()}\n${replace}\n`,
      "utf8",
    );
  }

  drafts(): ProfileDraft[] {
    try {
      return JSON.parse(readFileSync(this.draftsFile, "utf8")) as ProfileDraft[];
    } catch {
      return [];
    }
  }

  dropDraft(id: string): void {
    writeFileSync(this.draftsFile, JSON.stringify(this.drafts().filter((d) => d.id !== id)));
  }

  /**
   * The weekly check: the profile against the last week's conversations and
   * tasks. Returns how many edits were drafted (at most three, each checked).
   */
  async review(tasks: string[]): Promise<number> {
    const profile = this.text();
    if (!profile) return 0;
    const evidence = this.recentConversations(7).slice(-10_000);
    if (!evidence && tasks.length === 0) return 0;
    const answer = await this.o.llm.chat(
      [
        {
          role: "system",
          content:
            'You keep a person\'s work profile true. Compare the profile with what he did this week. Propose an edit only where the evidence clearly shows the profile is wrong or missing something about his work habits, preferences or way of working; never about his private life, faith or relationships, which you can\'t see. Quote the exact profile text to change. Answer with JSON only: [{"find": "exact text from the profile", "replace": "new text", "why": "the evidence, one short sentence"}], at most 3, or [] if nothing clearly differs.',
        },
        {
          role: "user",
          content: `Profile:\n<data>${profile.slice(0, 14_000)}</data>\n\nHis conversations with Malves this week:\n<data>${evidence || "none"}</data>\n\nTasks he started recently:\n<data>${tasks.slice(-30).join("\n") || "none"}</data>`,
        },
      ],
      [],
    );
    let proposed: unknown;
    try {
      proposed = JSON.parse(answer.content.replace(/^```(json)?|```$/gm, "").trim());
    } catch {
      return 0;
    }
    if (!Array.isArray(proposed)) return 0;
    const kept = proposed
      .filter(
        (p): p is { find: string; replace: string; why: string } =>
          typeof p?.find === "string" &&
          typeof p?.replace === "string" &&
          typeof p?.why === "string" &&
          p.find !== p.replace,
      )
      .filter((p) => this.check(p.find, p.replace) === undefined)
      .slice(0, 3)
      .map((p) => ({
        id: `p-${randomBytes(3).toString("hex")}`,
        find: p.find,
        replace: p.replace,
        why: p.why.slice(0, 200),
      }));
    writeFileSync(this.draftsFile, JSON.stringify([...this.drafts(), ...kept].slice(-6)));
    return kept.length;
  }

  private recentConversations(days: number): string {
    const dir = path.join(this.o.vault, "Conversations");
    if (!existsSync(dir)) return "";
    const since = new Date((this.o.now?.() ?? new Date()).getTime() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) >= since)
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
  }
}

/** Runs the profile check once a week (checked hourly), and tells him when it drafted edits. */
export function startProfileReview(o: {
  dataDir: string;
  review: () => Promise<number>;
  notify: (title: string, message: string, click?: string) => void;
  everyMs?: number;
}): () => void {
  const file = path.join(o.dataDir, "profile-review.json");
  const check = async () => {
    let last = 0;
    try {
      last = (JSON.parse(readFileSync(file, "utf8")) as { last: number }).last;
    } catch {
      // Never run: run now.
    }
    if (Date.now() - last < 7 * 86_400_000) return;
    writeFileSync(file, JSON.stringify({ last: Date.now() }));
    const count = await o.review().catch(() => 0);
    if (count > 0)
      o.notify(
        "Malves has profile changes for you",
        `${count} change${count > 1 ? "s" : ""} to your profile, based on this week. Ask Malves to go through them.`,
        "malves://malves",
      );
  };
  const timer = setInterval(() => void check(), o.everyMs ?? 60 * 60_000);
  void check();
  return () => clearInterval(timer);
}
