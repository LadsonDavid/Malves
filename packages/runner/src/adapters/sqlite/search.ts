import Database from "better-sqlite3";

export type SearchDoc = {
  sourceId: string;
  kind: "session" | "vault" | "project_notes" | "journal";
  title: string;
  content: string;
};

export type SearchResult = {
  sourceId: string;
  kind: string;
  title: string;
  snippet: string;
  rank: number;
};

export class SearchIndex {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;

  constructor(fileOrDb: string | Database.Database) {
    this.db = typeof fileOrDb === "string" ? new Database(fileOrDb) : fileOrDb;
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        source_id,
        kind,
        title,
        content,
        tokenize='porter unicode61'
      );
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO search_fts (source_id, kind, title, content)
      VALUES (?, ?, ?, ?)
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM search_fts WHERE source_id = ?
    `);

    this.searchStmt = this.db.prepare(`
      SELECT
        source_id,
        kind,
        title,
        snippet(search_fts, 3, '<b>', '</b>', '...', 20) AS snippet,
        rank
      FROM search_fts
      WHERE search_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
  }

  indexDocument(doc: SearchDoc): void {
    // Replace existing if any
    this.deleteStmt.run(doc.sourceId);
    this.insertStmt.run(doc.sourceId, doc.kind, doc.title, doc.content);
  }

  removeDocument(sourceId: string): void {
    this.deleteStmt.run(sourceId);
  }

  /**
   * Sanitizes user queries for SQLite FTS5 syntax.
   */
  private sanitizeQuery(query: string): string {
    const tokens = query
      .replace(/[^\w\s-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (tokens.length === 0) return '""';
    // Match tokens as prefix search
    return tokens.map((t) => `"${t}"*`).join(" ");
  }

  search(query: string, limit = 10): SearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized || sanitized === '""') return [];

    try {
      const rows = this.searchStmt.all(sanitized, limit) as {
        source_id: string;
        kind: string;
        title: string;
        snippet: string;
        rank: number;
      }[];

      return rows.map((r) => ({
        sourceId: r.source_id,
        kind: r.kind,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fast search with fallback to deep recall model if empty (§9).
   */
  async searchWithRecall(
    query: string,
    options?: {
      limit?: number | undefined;
      deepRecall?: ((q: string) => Promise<SearchResult | undefined>) | undefined;
    },
  ): Promise<SearchResult[]> {
    const fastResults = this.search(query, options?.limit ?? 10);
    if (fastResults.length > 0 || !options?.deepRecall) {
      return fastResults;
    }

    // Fast search found nothing: trigger deep recall
    const recallResult = await options.deepRecall(query);
    return recallResult ? [recallResult] : [];
  }

  close(): void {
    this.db.close();
  }
}
