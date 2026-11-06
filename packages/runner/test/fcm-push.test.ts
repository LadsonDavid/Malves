import type { OpenQuestion } from "@malves/core";
import { describe, expect, it } from "vitest";
import { FcmPush } from "../src/adapters/push/fcm-push.js";

const question = {
  question_id: "q1",
  kind: "permission",
  text: "May I delete the secret file C:/private/plan.txt?",
} as unknown as OpenQuestion;

function setup(extra: { text?: boolean; phones?: string[]; fail?: boolean } = {}) {
  const sent: Array<{ token: string; data: Record<string, string>; ttl?: string }> = [];
  const errors: string[] = [];
  const push = new FcmPush({
    send: async (token, data, options) => {
      if (extra.fail) throw new Error("Firebase answered 404");
      sent.push({ token, data, ...(options?.ttl ? { ttl: options.ttl } : {}) });
    },
    phones: () => extra.phones ?? ["tok-a", "tok-b"],
    text: extra.text,
    onError: (m) => errors.push(m),
  });
  return { push, sent, errors };
}

describe("malves' own notifications (Firebase)", () => {
  it("sends a question to every paired phone with its kind as the title and no text", async () => {
    const s = setup();
    await s.push.questionOpened(question);
    expect(s.sent.map((m) => m.token)).toEqual(["tok-a", "tok-b"]);
    expect(s.sent[0]?.data).toEqual({
      type: "note",
      title: "An agent asks permission",
      link: "malves://home",
    });
    // What the question says never goes to Google by default.
    expect(JSON.stringify(s.sent)).not.toContain("secret file");
    expect(s.sent[0]?.ttl).toBe("3600s");
  });

  it("marks a reminder, and sends a short text only when opted in", async () => {
    const s = setup({ text: true });
    await s.push.questionReminder(question, 2);
    expect(s.sent[0]?.data.title).toBe("Still waiting · An agent asks permission");
    expect(s.sent[0]?.data.body).toContain("secret file");
    s.push.notify("Claude finished", `${"long ".repeat(100)}`, "malves://task/t1");
    await new Promise((r) => setTimeout(r, 5));
    const note = s.sent.find((m) => m.data.link === "malves://task/t1");
    expect(note?.data.title).toBe("Claude finished");
    expect((note?.data.body ?? "").length).toBeLessThanOrEqual(140);
  });

  it("does nothing without a registered phone, and reports a failure without throwing", async () => {
    const none = setup({ phones: [] });
    await none.push.questionOpened(question);
    expect(none.sent).toEqual([]);

    const broken = setup({ fail: true });
    await expect(broken.push.questionOpened(question)).resolves.toBeUndefined();
    expect(broken.errors).toEqual(["Firebase answered 404", "Firebase answered 404"]);
  });
});
