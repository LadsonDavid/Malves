import type { Lead } from "@malves/protocol";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { LeadsDatabase } from "../src/adapters/leads/db.js";
import { buildDossier } from "../src/adapters/leads/dossier.js";
import { draftOutreach, handleLeadReply, sendOutreach } from "../src/adapters/leads/outreach.js";

describe("leads - stage D3: dossier", () => {
  it("builds a company dossier from website and signals", async () => {
    const fakeHtml = `
      <html>
        <head><title>Acme Corp | High Performance Cloud</title></head>
        <body>
          <header>Navigation</header>
          <h1>Next Generation Cloud Infrastructure</h1>
          <p>Acme Corp provides automated cloud scaling and developer tooling for Kubernetes clusters.</p>
          <footer>Footer links</footer>
        </body>
      </html>
    `;

    const dossier = await buildDossier({
      domain: "acme.com",
      companyName: "Acme Corp",
      reader: async (url) => (url.includes("acme.com") ? fakeHtml : undefined),
      signals: [
        {
          id: "sig_1",
          domain: "acme.com",
          type: "hiring",
          weight: 1.5,
          summary: "Hiring Staff Infrastructure Engineer",
          source_url: "https://boards.greenhouse.io/acme",
          timestamp: Date.now() - 3600_000,
        },
      ],
    });

    expect(dossier.domain).toBe("acme.com");
    expect(dossier.company_name).toBe("Acme Corp");
    expect(dossier.summary).toContain("Acme Corp provides automated cloud scaling");
    expect(dossier.recent_signals).toContain("[hiring] Hiring Staff Infrastructure Engineer");
    expect(dossier.sources).toContain("https://acme.com");
    expect(dossier.sources).toContain("https://boards.greenhouse.io/acme");
  });
});

describe("leads - stage D4 & D5: outreach loop and CRM", () => {
  const sampleLead: Lead = {
    domain: "stripe.com",
    name: "Stripe",
    tier: "hot",
    score: 8.5,
    fit: 0.9,
    intent: 1.8,
    types: ["hiring", "tech"],
    why: "Rapidly expanding developer platform team",
    trigger: "posted 5 Senior Node.js roles",
    opener: "Loved seeing your recent updates to the Payments API SDK.",
    contact: {
      name: "Alex Smith",
      title: "VP Engineering",
      email: "alex@stripe.com",
      status: "verified",
    },
    signals: 4,
    last_signal: "hiring",
  };

  it("drafts outreach from lead and dossier", () => {
    const draft = draftOutreach(sampleLead);
    expect(draft.domain).toBe("stripe.com");
    expect(draft.recipient_name).toBe("Alex Smith");
    expect(draft.recipient_email).toBe("alex@stripe.com");
    expect(draft.body).toContain(sampleLead.opener);
    expect(draft.status).toBe("draft");
  });

  it("enforces Tier 3 safety rule: sending is ALWAYS Tier 3 and refused if user rejects", async () => {
    const db = new LeadsDatabase(new Database(":memory:"));
    db.upsertAccount({ domain: "stripe.com", name: "Stripe" });

    const draft = draftOutreach(sampleLead);
    const askUser = vi.fn().mockResolvedValue(false); // User clicks NO
    const sender = vi.fn();

    const result = await sendOutreach({
      draft,
      askUser,
      sender,
      db,
    });

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(sender).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    expect(result.status).toBe("rejected");
    expect(draft.status).toBe("rejected");
    // CRM state remains 'new'
    expect(db.getStatus("stripe.com")).toBe("new");

    db.close();
  });

  it("sends outreach, updates CRM state to 'contacted', and schedules follow-up on user YES", async () => {
    const db = new LeadsDatabase(new Database(":memory:"));
    db.upsertAccount({ domain: "stripe.com", name: "Stripe" });

    const draft = draftOutreach(sampleLead);
    const askUser = vi.fn().mockResolvedValue(true); // User clicks YES
    const sender = vi.fn().mockResolvedValue({ ok: true, messageId: "msg_999" });
    const createFollowUp = vi.fn().mockResolvedValue(undefined);

    const result = await sendOutreach({
      draft,
      askUser,
      sender,
      db,
      createFollowUp,
    });

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(true);
    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_999");
    expect(result.followUpCreated).toBe(true);
    expect(createFollowUp).toHaveBeenCalledWith("stripe.com");

    // CRM state updated to 'contacted'
    expect(db.getStatus("stripe.com")).toBe("contacted");

    // Stage D5: CRM reply advances state to 'replied'
    const replyHandled = await handleLeadReply("stripe.com", db);
    expect(replyHandled).toBe(true);
    expect(db.getStatus("stripe.com")).toBe("replied");

    db.close();
  });
});
