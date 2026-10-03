import { z } from "zod";

/**
 * A lead from the lead engine (signalstack's `GET /api/leads`, points 1 and 7):
 * a company worth contacting this week, and why. The runner checks
 * signalstack's answer against this, and sends it to the phone in this shape.
 */
export const Lead = z.object({
  domain: z.string(),
  name: z.string(),
  tier: z.enum(["hot", "warm", "cold"]),
  score: z.number(),
  fit: z.number(),
  intent: z.number(),
  /** e.g. "company" (a recent trigger), "intent" (they said or did something), "cold" (fit only). */
  types: z.array(z.string()),
  /** One line: why this company is on the list. */
  why: z.string(),
  /** The newest event that made them worth contacting now, if any. */
  trigger: z.string(),
  /** A suggested opening line. */
  opener: z.string(),
  /** The best person to contact; never a known-bad address. */
  contact: z
    .object({ name: z.string(), title: z.string(), email: z.string(), status: z.string() })
    .nullable(),
  signals: z.number().int(),
  last_signal: z.string(),
});
export type Lead = z.infer<typeof Lead>;

/** signalstack's `GET /api/leads` response. */
export const LeadsResponse = z.object({ generated_at: z.string(), leads: z.array(Lead) });
