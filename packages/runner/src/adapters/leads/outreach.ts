import type { EventLog } from "@malves/core";
import type { Lead, LeadDossier, OutreachDraft } from "@malves/protocol";
import type { LeadStatus, LeadsDatabase } from "./db.js";

export type OutreachSender = (
  draft: OutreachDraft,
) => Promise<{ ok: boolean; messageId?: string; mailtoUrl?: string }>;

export type SendOutreachOptions = {
  draft: OutreachDraft;
  askUser: (prompt: string) => Promise<boolean>;
  sender?: OutreachSender | undefined;
  db?: LeadsDatabase | undefined;
  log?: EventLog | undefined;
  createFollowUp?: ((leadDomain: string) => Promise<void>) | undefined;
};

export type SendOutreachResult = {
  sent: boolean;
  status: "sent" | "rejected";
  mailtoUrl?: string | undefined;
  messageId?: string | undefined;
  followUpCreated?: boolean | undefined;
};

/**
 * Stage D4: Draft an outreach message using lead trigger, dossier, and opener.
 */
export function draftOutreach(lead: Lead, dossier?: LeadDossier): OutreachDraft {
  const recipientName = lead.contact?.name || "Team";
  const recipientEmail = lead.contact?.email || `contact@${lead.domain}`;
  const opener =
    lead.opener ||
    (dossier?.recent_signals[0]
      ? `Noticed that ${dossier.recent_signals[0]}.`
      : `Noticed ${lead.name}'s recent work with ${lead.trigger || "developer tooling"}.`);

  const sign = process.env.MALVES_USER_NAME?.trim();
  const subject = `Quick question regarding ${lead.name}`;
  const body = `Hi ${recipientName},\n\n${opener}\n\nWould love to connect and share a brief thought on your technical roadmap.\n\nBest${sign ? `,\n${sign}` : ""}`;

  return {
    domain: lead.domain,
    recipient_email: recipientEmail,
    recipient_name: recipientName,
    subject,
    body,
    opener,
    status: "draft",
  };
}

/**
 * Stage D4 & D5: Send outreach loop with mandatory Tier 3 user approval (§8).
 * Invariant: Sending is Tier 3, ALWAYS. Nothing is sent without explicit user confirmation.
 */
export async function sendOutreach(options: SendOutreachOptions): Promise<SendOutreachResult> {
  const { draft, askUser, sender, db, log, createFollowUp } = options;

  // 1. Mandatory Tier 3 Approval Gate (§8 / §11)
  const question = `Send outreach email to ${draft.recipient_name} <${draft.recipient_email}> for ${draft.domain}?\nSubject: ${draft.subject}`;
  const approved = await askUser(question);

  if (!approved) {
    draft.status = "rejected";
    return {
      sent: false,
      status: "rejected",
    };
  }

  // 2. Perform sending via sender adapter or fallback to mailto
  let mailtoUrl: string | undefined;
  let messageId: string | undefined;

  if (sender) {
    const res = await sender(draft);
    if (!res.ok) {
      throw new Error(`Outreach send failed for ${draft.domain}`);
    }
    messageId = res.messageId;
    mailtoUrl = res.mailtoUrl;
  } else {
    // Mailto fallback
    mailtoUrl = `mailto:${encodeURIComponent(draft.recipient_email)}?subject=${encodeURIComponent(
      draft.subject,
    )}&body=${encodeURIComponent(draft.body)}`;
  }

  draft.status = "sent";

  // 3. Stage D5: Update CRM state from 'new' -> 'contacted'
  const prevStatus: LeadStatus = db?.getStatus(draft.domain) ?? "new";
  if (db) {
    db.updateStatus(draft.domain, "contacted");
  }

  // 4. Log event
  if (log) {
    log.append({
      type: "lead.state_updated",
      data: {
        domain: draft.domain,
        from_state: prevStatus,
        to_state: "contacted",
        reason: `Outreach sent to ${draft.recipient_email}`,
        timestamp: Date.now(),
      },
    });
  }

  // 5. Create follow-up rule if configured
  let followUpCreated = false;
  if (createFollowUp) {
    await createFollowUp(draft.domain);
    followUpCreated = true;
  }

  return {
    sent: true,
    status: "sent",
    mailtoUrl,
    messageId,
    followUpCreated,
  };
}

/**
 * Stage D5: CRM Reply Monitor helper.
 * When a reply is detected, advances lead state from 'contacted' to 'replied'.
 */
export async function handleLeadReply(
  domain: string,
  db?: LeadsDatabase,
  log?: EventLog,
): Promise<boolean> {
  const current = db?.getStatus(domain) ?? "contacted";
  if (current !== "contacted") {
    return false;
  }

  if (db) {
    db.updateStatus(domain, "replied");
  }

  if (log) {
    log.append({
      type: "lead.state_updated",
      data: {
        domain,
        from_state: "contacted",
        to_state: "replied",
        reason: `Reply received from ${domain}`,
        timestamp: Date.now(),
      },
    });
  }

  return true;
}
