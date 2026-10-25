import type { Lead } from "@malves/protocol";
import type { DbAccount, DbIcp, DbSignal } from "./db.js";

const DEFAULT_HALF_LIFE_MS = 14 * 86_400_000; // 14 days

export type ScoringOptions = {
  halfLifeMs?: number;
  now?: number;
};

/**
 * Computes scores at read time from the append-only signal log (§8 D1).
 * Invariant: Fit gates intent, intent decays exponentially over time.
 */
export function scoreAccount(
  account: DbAccount,
  signals: DbSignal[],
  icp: DbIcp | undefined,
  options: ScoringOptions = {},
): Lead {
  const now = options.now ?? Date.now();
  const halfLife = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;

  // 1. Compute Intent with exponential time decay
  let intentSum = 0;
  for (const s of signals) {
    const age = Math.max(0, now - s.timestamp);
    const decay = Math.pow(0.5, age / halfLife);
    intentSum += s.weight * decay;
  }
  // Clamp intent to [0, 2.0]
  const intent = Math.round(Math.min(2.0, intentSum) * 100) / 100;

  // 2. Compute Fit against ICP keywords
  const textToMatch = [
    account.name,
    account.domain,
    account.industry ?? "",
    account.description ?? "",
  ]
    .join(" ")
    .toLowerCase();

  let fitScore = 0.3; // baseline
  const keywords = icp?.keywords ?? [];
  if (keywords.length > 0) {
    let matchCount = 0;
    for (const kw of keywords) {
      if (textToMatch.includes(kw.toLowerCase().trim())) {
        matchCount++;
      }
    }
    if (matchCount === 1) fitScore = 0.6;
    else if (matchCount === 2) fitScore = 0.8;
    else if (matchCount >= 3) fitScore = 1.0;
  } else {
    fitScore = 0.5; // neutral when no ICP defined
  }
  const fit = Math.round(fitScore * 100) / 100;

  // 3. Fit gates Intent: total score
  // If fit is low, high intent does not produce a hot lead.
  const rawScore = fit * (intent / 2.0);
  const score = Math.round(Math.min(1.0, rawScore) * 100) / 100;

  // 4. Assign Tier
  let tier: "hot" | "warm" | "cold";
  if (score >= 0.5 && intent >= 0.8) {
    tier = "hot";
  } else if (score >= 0.25 || intent >= 0.4) {
    tier = "warm";
  } else {
    tier = "cold";
  }

  // 5. Synthesize trigger and opener
  const sortedSignals = [...signals].sort((a, b) => b.timestamp - a.timestamp);
  const newestSignal = sortedSignals[0];
  const trigger = newestSignal?.summary ?? "ICP profile match";
  const types = Array.from(new Set(signals.map((s) => s.type)));
  if (types.length === 0) types.push("cold");

  const why =
    signals.length > 0
      ? `${signals.length} signal${signals.length > 1 ? "s" : ""}: ${trigger}`
      : `Matches ideal customer profile (${icp?.ideal_customer ?? "target audience"})`;

  const opener = newestSignal
    ? `Saw that ${account.name} recently ${newestSignal.summary.toLowerCase()}. Are you looking to streamline developer workflows with automation?`
    : `Hi team at ${account.name}, noticed your work in ${account.industry ?? "tech"}. Would love to share how Malves assists engineering teams.`;

  return {
    domain: account.domain,
    name: account.name,
    tier,
    score,
    fit,
    intent,
    types,
    why,
    trigger,
    opener,
    contact: null,
    signals: signals.length,
    last_signal: newestSignal ? new Date(newestSignal.timestamp).toISOString() : new Date(account.created_at).toISOString(),
  };
}

/** Scores all accounts in the database at read time and returns them ranked by score DESC. */
export function rankLeads(
  accounts: DbAccount[],
  signalsByDomain: Map<string, DbSignal[]>,
  icp: DbIcp | undefined,
  options: ScoringOptions = {},
): Lead[] {
  const scored = accounts.map((account) =>
    scoreAccount(account, signalsByDomain.get(account.domain) ?? [], icp, options),
  );
  return scored.sort((a, b) => b.score - a.score || b.intent - a.intent);
}
