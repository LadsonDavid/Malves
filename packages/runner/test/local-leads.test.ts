import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LeadsDatabase } from "../src/adapters/leads/db.js";
import { LocalLeadEngine } from "../src/adapters/leads/engine.js";
import { rankLeads, scoreAccount } from "../src/adapters/leads/scoring.js";
import {
  collectAshbyJobs,
  collectGreenhouseJobs,
  collectLeverJobs,
} from "../src/adapters/leads/collectors/hiring.js";
import { parseHnComment } from "../src/adapters/leads/collectors/hackernews.js";

describe("Pillar D: Local Leads Engine (D1 & D2)", () => {
  it("stores accounts and append-only signals in SQLite", () => {
    const db = new LeadsDatabase(new Database(":memory:"));
    db.upsertAccount({
      domain: "acme.corp",
      name: "Acme Corp",
      industry: "Software",
      description: "Developer tools and cloud infrastructure",
    });

    const now = Date.now();
    db.addSignal({
      id: "sig-1",
      domain: "acme.corp",
      type: "hiring",
      weight: 0.8,
      summary: "Hiring Senior Backend Engineer",
      timestamp: now,
    });
    db.addSignal({
      id: "sig-2",
      domain: "acme.corp",
      type: "tech_stack",
      weight: 0.5,
      summary: "Using TypeScript and React",
      timestamp: now - 3600_000,
    });

    const account = db.getAccount("acme.corp");
    expect(account).toBeDefined();
    expect(account?.name).toBe("Acme Corp");

    const signals = db.getSignalsForDomain("acme.corp");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.id).toBe("sig-1");
  });

  it("scores accounts at read time where fit gates intent and intent decays", () => {
    const now = 1700000000000;
    const accountHot = {
      domain: "goodfit.com",
      name: "Good Fit AI",
      industry: "AI",
      description: "Building developer agents and workflow automation in TypeScript",
      created_at: now - 86400_000,
    };
    const accountUnfit = {
      domain: "badfit.com",
      name: "Local Bakery",
      industry: "Food",
      description: "Artisan sourdough and pastries in London",
      created_at: now - 86400_000,
    };

    const icp = {
      id: "default",
      ideal_customer: "B2B AI and developer tooling startups",
      keywords: ["developer", "agents", "automation", "typescript"],
      updated_at: now,
    };

    // Both companies have the exact same hiring signals
    const signalsFresh = [
      {
        id: "s1",
        domain: "goodfit.com",
        type: "hiring",
        weight: 1.0,
        summary: "Hiring 3 TypeScript engineers",
        timestamp: now - 1000, // fresh
      },
    ];

    // Compute for Good Fit: high fit + high intent -> HOT lead
    const hotLead = scoreAccount(accountHot, signalsFresh, icp, { now });
    expect(hotLead.fit).toBeGreaterThanOrEqual(0.8);
    expect(hotLead.intent).toBeGreaterThanOrEqual(0.8);
    expect(hotLead.tier).toBe("hot");

    // Compute for Bad Fit: low fit + high intent -> FIT GATES INTENT! Cannot be HOT
    const unfitLead = scoreAccount(accountUnfit, signalsFresh, icp, { now });
    expect(unfitLead.fit).toBeLessThan(0.5);
    expect(unfitLead.tier).not.toBe("hot");
    expect(unfitLead.score).toBeLessThan(hotLead.score);

    // Intent decays with time: compare fresh signal vs 60 days old signal
    const signalsOld = [
      {
        id: "s2",
        domain: "goodfit.com",
        type: "hiring",
        weight: 1.0,
        summary: "Hiring 3 TypeScript engineers",
        timestamp: now - 60 * 86_400_000, // 60 days old
      },
    ];
    const decayedLead = scoreAccount(accountHot, signalsOld, icp, { now });
    expect(decayedLead.intent).toBeLessThan(hotLead.intent * 0.3); // more than 4 half-lives
  });

  it("ranks accounts by score descending", () => {
    const now = Date.now();
    const accounts = [
      { domain: "a.com", name: "A", created_at: now },
      { domain: "b.com", name: "B", created_at: now },
    ];
    const signalsMap = new Map();
    signalsMap.set("a.com", [{ id: "1", domain: "a.com", type: "hiring", weight: 0.2, summary: "hire", timestamp: now }]);
    signalsMap.set("b.com", [{ id: "2", domain: "b.com", type: "hiring", weight: 1.5, summary: "hire", timestamp: now }]);

    const ranked = rankLeads(accounts, signalsMap, undefined, { now });
    expect(ranked[0]!.domain).toBe("b.com");
    expect(ranked[1]!.domain).toBe("a.com");
  });

  describe("zero-login collectors", () => {
    it("collects and parses Greenhouse jobs", async () => {
      const fakeFetch = async () => ({
        status: 200,
        text: async () => "",
        json: async () => ({
          jobs: [
            {
              id: 12345,
              title: "Senior Full Stack Engineer",
              location: { name: "Remote, US" },
              absolute_url: "https://boards.greenhouse.io/demo/jobs/12345",
              updated_at: "2026-10-20T10:00:00Z",
            },
          ],
        }),
      });

      const jobs = await collectGreenhouseJobs("demo", fakeFetch as any);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe("gh-12345");
      expect(jobs[0]!.title).toBe("Senior Full Stack Engineer");
      expect(jobs[0]!.location).toBe("Remote, US");
    });

    it("collects and parses Lever jobs", async () => {
      const fakeFetch = async () => ({
        status: 200,
        text: async () => "",
        json: async () => [
          {
            id: "post-987",
            text: "Product Designer",
            categories: { location: "San Francisco" },
            hostedUrl: "https://jobs.lever.co/demo/post-987",
            createdAt: 1700000000000,
          },
        ],
      });

      const jobs = await collectLeverJobs("demo", fakeFetch as any);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toBe("lever-post-987");
      expect(jobs[0]!.title).toBe("Product Designer");
    });

    it("collects and parses Ashby jobs", async () => {
      const fakeFetch = async () => ({
        status: 200,
        text: async () => "",
        json: async () => ({
          jobs: [
            {
              id: "ashby-111",
              title: "DevOps Architect",
              location: "New York",
              jobUrl: "https://jobs.ashbyhq.com/demo/ashby-111",
            },
          ],
        }),
      });

      const jobs = await collectAshbyJobs("demo", fakeFetch as any);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.title).toBe("DevOps Architect");
    });

    it("parses Hacker News hiring comment", () => {
      const hnText = "Vercel | Frontend Infrastructure Lead | Remote | https://vercel.com/careers<p>We are looking for...";
      const parsed = parseHnComment(42001, hnText);
      expect(parsed).toBeDefined();
      expect(parsed?.companyName).toBe("Vercel");
      expect(parsed?.domain).toBe("vercel.com");
      expect(parsed?.role).toBe("Frontend Infrastructure Lead");
    });
  });

  describe("LocalLeadEngine end-to-end", () => {
    it("ingests jobs and serves scored leads satisfying protocol schema", async () => {
      const engine = new LocalLeadEngine({ db: new LeadsDatabase(new Database(":memory:")) });
      engine.setIcp("Automated testing and developer tools", ["developer", "tools", "testing"]);

      engine.ingestJobs("cypress.io", "Cypress", [
        {
          id: "j1",
          title: "Principal Engineer, Developer Experience",
          location: "Remote",
          url: "https://cypress.io/jobs/j1",
          updatedAt: Date.now(),
        },
      ]);

      const leads = await engine.fetch(10);
      expect(leads).toHaveLength(1);
      const lead = leads[0]!;
      expect(lead.domain).toBe("cypress.io");
      expect(lead.name).toBe("Cypress");
      expect(lead.signals).toBe(1);
      expect(lead.opener).toContain("Cypress");
      expect(lead.why).toContain("Principal Engineer");
    });
  });
});
