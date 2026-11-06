import type { Notifier, OpenQuestion } from "@malves/core";
import type { FcmSend } from "./fcm.js";

/**
 * Malves' own notifications through Firebase (replacing the ntfy app). Every
 * notification is a data push to the phones paired with this computer; the
 * malves app turns it into a notification, and tapping it opens the right
 * screen. What Google sees is only the kind of thing that happened and the
 * title ("A question is waiting", "Claude finished"). The text of the question,
 * the task or the reminder stays on this computer and on the sealed link,
 * unless MALVES_PUSH_TEXT=1 opts in to sending a short text too.
 *
 * Not here yet: answer buttons on the notification itself (ntfy has them). A
 * question opens the app, where Confirm / Allow / Skip are one tap away.
 */
const KIND_TITLE: Record<OpenQuestion["kind"], string> = {
  agent_question: "An agent has a question",
  permission: "An agent asks permission",
  browser_action: "Allow this in Chrome?",
  budget_floor: "Budget limit reached",
  commit_approval: "Approve this commit?",
};

/** A notification that has waited this long is stale; Android drops it. */
const TTL = "3600s";
const MAX_TEXT = 140;

export class FcmPush implements Notifier {
  constructor(
    private readonly o: {
      send: FcmSend;
      /** Firebase tokens of the phones still paired. */
      phones: () => string[];
      /** Send a short text too (it then passes through Google). */
      text?: boolean | undefined;
      onError?: (message: string) => void;
    },
  ) {}

  async questionOpened(question: OpenQuestion): Promise<void> {
    await this.push(KIND_TITLE[question.kind], this.text(question.text), "malves://home");
  }

  async questionReminder(question: OpenQuestion, n: number): Promise<void> {
    const lead = n > 1 ? "Still waiting" : "Waiting for you";
    await this.push(
      `${lead} · ${KIND_TITLE[question.kind]}`,
      this.text(question.text),
      "malves://home",
    );
  }

  /** A plain notification (a task finished, a reminder); tapping opens `click`. */
  notify(title: string, message: string, click = "malves://home"): void {
    void this.push(title, this.text(message), click);
  }

  private text(text: string): string {
    return this.o.text ? text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
  }

  private async push(title: string, body: string, link: string): Promise<void> {
    const phones = this.o.phones();
    if (phones.length === 0) return;
    const data: Record<string, string> = { type: "note", title: title.slice(0, 80), link };
    if (body) data.body = body;
    const results = await Promise.allSettled(
      phones.map((token) => this.o.send(token, data, { ttl: TTL })),
    );
    for (const r of results) {
      if (r.status === "rejected")
        this.o.onError?.(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }
}
