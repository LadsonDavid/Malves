import { describe, expect, it, vi } from "vitest";
import { reviewFinishedTask } from "../src/adapters/assistant/review.js";
import { SearchIndex } from "../src/adapters/sqlite/search.js";
import {
  consolidateDailyJournal,
  loadProjectNotes,
  undoConsolidation,
} from "../src/adapters/assistant/consolidation.js";
import {
  executeBargeIn,
  PresenceMonitor,
} from "../src/adapters/assistant/presence.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("learning loop - background reviewer", () => {
  it("proposes a skill when reviewer detects a reusable pattern", async () => {
    const offeredRules: { key: string; text: string }[] = [];
    const mockSuggestions = {
      offer(input: { key: string; text: string }) {
        offeredRules.push(input);
        return "sug_123";
      },
    };

    const result = await reviewFinishedTask({
      task: {
        taskId: "t_101",
        agent: "claude",
        prompt: "Run production build",
        commands: ["pnpm build", "pnpm test"],
      },
      suggestions: mockSuggestions,
    });

    expect(result.offered).toBe(true);
    expect(result.suggestionId).toBe("sug_123");
    expect(offeredRules).toHaveLength(1);
    expect(offeredRules[0]?.text).toContain("Project command: pnpm build");
  });

  it("proposes memory when custom reviewer model recommends it", async () => {
    const offeredRules: { key: string; text: string }[] = [];
    const mockSuggestions = {
      offer(input: { key: string; text: string }) {
        offeredRules.push(input);
        return "sug_456";
      },
    };

    const result = await reviewFinishedTask({
      task: {
        taskId: "t_102",
        agent: "claude",
        prompt: "Fix database pool timeout",
      },
      reviewerModel: async () => ({
        worthSaving: true,
        type: "memory",
        title: "Postgres connection pool max 20",
        content: "Always set pool size to 20 on local staging.",
        explanation: "Prevents connection exhaustion observed during load test.",
      }),
      suggestions: mockSuggestions,
    });

    expect(result.offered).toBe(true);
    expect(offeredRules[0]?.text).toContain("Postgres connection pool max 20");
  });
});

describe("search - SQLite FTS5 search index", () => {
  it("indexes and performs fast full-text search with snippets", () => {
    const db = new Database(":memory:");
    const index = new SearchIndex(db);

    index.indexDocument({
      sourceId: "note_1",
      kind: "vault",
      title: "Authentication Retry Strategy",
      content: "We decided to use exponential backoff with jitter for the OAuth refresh token endpoint.",
    });

    index.indexDocument({
      sourceId: "session_2",
      kind: "session",
      title: "Stripe Webhook Bug",
      content: "The signature verification failed because raw body parsing was disabled in Express.",
    });

    const results = index.search("exponential jitter");
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Authentication Retry Strategy");
    expect(results[0]?.snippet).toContain("jitter");

    index.close();
  });

  it("falls back to deep recall only when fast search returns empty", async () => {
    const db = new Database(":memory:");
    const index = new SearchIndex(db);

    index.indexDocument({
      sourceId: "doc_1",
      kind: "vault",
      title: "Kubernetes Deployments",
      content: "Cluster ingress controller configuration.",
    });

    let deepRecallCalled = false;
    const deepRecall = async (_q: string) => {
      deepRecallCalled = true;
      return {
        sourceId: "deep_recall_source",
        kind: "memory",
        title: "Historic cluster design",
        snippet: "Recalled from archived transcripts.",
        rank: 1,
      };
    };

    // Fast search finds match: deep recall not called
    const foundFast = await index.searchWithRecall("ingress", { deepRecall });
    expect(foundFast).toHaveLength(1);
    expect(deepRecallCalled).toBe(false);

    // Fast search yields 0 matches: deep recall called
    const foundDeep = await index.searchWithRecall("quantum cryptography", { deepRecall });
    expect(foundDeep).toHaveLength(1);
    expect(deepRecallCalled).toBe(true);
    expect(foundDeep[0]?.sourceId).toBe("deep_recall_source");

    index.close();
  });
});

describe("consolidation - project notes and rollback", () => {
  it("merges journal entries into notes and supports undo rollback", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "malves-vault-"));

    const res = consolidateDailyJournal({
      vaultDir: tempDir,
      projectId: "malves-core",
      date: "2026-10-25",
      entries: [
        {
          timestamp: Date.now(),
          command: "pnpm test packages/core",
          outcome: "success",
        },
        {
          timestamp: Date.now(),
          command: "pnpm build",
          outcome: "failure",
          summary: "Missing esbuild dependency in alpine container",
        },
      ],
    });

    expect(res.commandsAdded).toBe(1);
    expect(res.pitfallsAdded).toBe(1);

    const notes = loadProjectNotes(tempDir, "malves-core");
    expect(notes).toContain("`pnpm test packages/core`");
    expect(notes).toContain("Missing esbuild dependency");

    // Test undo rollback
    const undone = undoConsolidation(tempDir, "malves-core");
    expect(undone).toBe(true);

    const reverted = loadProjectNotes(tempDir, "malves-core");
    expect(reverted).not.toContain("Missing esbuild dependency");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("presence - signals and barge-in", () => {
  it("collects presence signals without model calls", async () => {
    const fakeDesktop = {
      activeTitle: async () => "Visual Studio Code - Malves",
    } as any;

    const monitor = new PresenceMonitor({
      desktop: fakeDesktop,
      getBuildState: () => "passed",
      idleThresholdSeconds: 10,
    });

    const state = await monitor.getPresence();
    expect(state.activeWindow).toBe("Visual Studio Code - Malves");
    expect(state.buildState).toBe("passed");
    expect(state.isIdle).toBe(false);
  });

  it("barge-in immediately stops running step and speaks heads-up", async () => {
    let stepStopped = false;
    let spokenMessage = "";

    const res = await executeBargeIn({
      stopActiveStep: async () => {
        stepStopped = true;
      },
      speak: (msg) => {
        spokenMessage = msg;
      },
    });

    expect(res.stopped).toBe(true);
    expect(res.spoken).toBe(true);
    expect(stepStopped).toBe(true);
    expect(spokenMessage).toBe("Stopped running step.");
  });
});
