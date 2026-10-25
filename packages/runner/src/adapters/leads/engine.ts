import type { Lead } from "@malves/protocol";
import type { LeadSource } from "./signalstack.js";
import { type DbAccount, type DbSignal, LeadsDatabase } from "./db.js";
import { rankLeads } from "./scoring.js";
import type { CollectedJob } from "./collectors/hiring.js";
import type { HnHiringPost } from "./collectors/hackernews.js";

export type LocalLeadEngineOptions = {
  db: LeadsDatabase | string;
};

/**
 * Malves Local Lead Engine (Pillar D stages D1 & D2).
 * Embeds lead accounts, append-only signals, and read-time scoring into Malves
 * with zero required Python dependencies.
 */
export class LocalLeadEngine implements LeadSource {
  private readonly db: LeadsDatabase;

  constructor(options: LocalLeadEngineOptions) {
    this.db = typeof options.db === "string" ? new LeadsDatabase(options.db) : options.db;
  }

  get database(): LeadsDatabase {
    return this.db;
  }

  setIcp(idealCustomer: string, keywords: string[]): void {
    this.db.setIcp(idealCustomer, keywords);
  }

  getIcp() {
    return this.db.getIcp();
  }

  upsertAccount(account: {
    domain: string;
    name: string;
    description?: string | undefined;
    industry?: string | undefined;
    size?: string | undefined;
  }): void {
    this.db.upsertAccount(account);
  }

  addSignal(signal: {
    id: string;
    domain: string;
    type: string;
    weight: number;
    summary: string;
    sourceUrl?: string | undefined;
    timestamp?: number | undefined;
  }): void {
    this.db.addSignal(signal);
  }

  /** Ingests collected hiring jobs into account and signals. */
  ingestJobs(domain: string, companyName: string, jobs: CollectedJob[]): void {
    if (jobs.length === 0) return;
    this.db.upsertAccount({ domain, name: companyName });
    for (const job of jobs) {
      this.db.addSignal({
        id: `job-${job.id}`,
        domain,
        type: "hiring",
        weight: 0.8,
        summary: `Hiring for ${job.title}${job.location ? ` in ${job.location}` : ""}`,
        sourceUrl: job.url,
        timestamp: job.updatedAt ?? Date.now(),
      });
    }
  }

  /** Ingests an HN hiring post into account and signal. */
  ingestHnPost(post: HnHiringPost): void {
    const domain = post.domain ?? `${post.companyName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
    this.db.upsertAccount({
      domain,
      name: post.companyName,
      description: post.text,
    });
    this.db.addSignal({
      id: `hn-${post.id}`,
      domain,
      type: "hiring",
      weight: 0.85,
      summary: `Hiring ${post.role} on Hacker News`,
      sourceUrl: post.url,
      timestamp: post.timestamp,
    });
  }

  /**
   * Fetches top leads scored at read time (§8 D1).
   * Implements LeadSource.fetch() interface.
   */
  async fetch(limit = 25): Promise<Lead[]> {
    const accounts = this.db.listAccounts();
    const signalsMap = new Map<string, DbSignal[]>();
    for (const acc of accounts) {
      signalsMap.set(acc.domain, this.db.getSignalsForDomain(acc.domain));
    }
    const icp = this.db.getIcp();
    const ranked = rankLeads(accounts, signalsMap, icp);
    return ranked.slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
