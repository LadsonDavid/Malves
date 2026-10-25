import Database from "better-sqlite3";

export type DbAccount = {
  domain: string;
  name: string;
  description?: string | null;
  industry?: string | null;
  size?: string | null;
  created_at: number;
};

export type DbSignal = {
  id: string;
  domain: string;
  type: string;
  weight: number;
  summary: string;
  source_url?: string | null;
  timestamp: number;
};

export type DbIcp = {
  id: string;
  ideal_customer: string;
  keywords: string[]; // parsed from JSON
  updated_at: number;
};

export class LeadsDatabase {
  private readonly db: Database.Database;
  private readonly insertAccountStmt: Database.Statement;
  private readonly insertSignalStmt: Database.Statement;
  private readonly getAccountStmt: Database.Statement;
  private readonly listAccountsStmt: Database.Statement;
  private readonly getSignalsForDomainStmt: Database.Statement;
  private readonly getIcpStmt: Database.Statement;
  private readonly setIcpStmt: Database.Statement;

  constructor(fileOrDb: string | Database.Database) {
    this.db = typeof fileOrDb === "string" ? new Database(fileOrDb) : fileOrDb;
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lead_accounts (
        domain TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        industry TEXT,
        size TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lead_signals (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        summary TEXT NOT NULL,
        source_url TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (domain) REFERENCES lead_accounts(domain)
      );

      CREATE INDEX IF NOT EXISTS idx_lead_signals_domain ON lead_signals(domain, timestamp);

      CREATE TABLE IF NOT EXISTS lead_icp (
        id TEXT PRIMARY KEY,
        ideal_customer TEXT NOT NULL,
        keywords TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.insertAccountStmt = this.db.prepare(`
      INSERT INTO lead_accounts (domain, name, description, industry, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        name = excluded.name,
        description = coalesce(excluded.description, lead_accounts.description),
        industry = coalesce(excluded.industry, lead_accounts.industry),
        size = coalesce(excluded.size, lead_accounts.size)
    `);

    this.insertSignalStmt = this.db.prepare(`
      INSERT OR REPLACE INTO lead_signals (id, domain, type, weight, summary, source_url, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.getAccountStmt = this.db.prepare(`SELECT * FROM lead_accounts WHERE domain = ?`);
    this.listAccountsStmt = this.db.prepare(`SELECT * FROM lead_accounts ORDER BY created_at DESC`);
    this.getSignalsForDomainStmt = this.db.prepare(`
      SELECT * FROM lead_signals WHERE domain = ? ORDER BY timestamp DESC
    `);

    this.getIcpStmt = this.db.prepare(`SELECT * FROM lead_icp WHERE id = 'default'`);
    this.setIcpStmt = this.db.prepare(`
      INSERT INTO lead_icp (id, ideal_customer, keywords, updated_at)
      VALUES ('default', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ideal_customer = excluded.ideal_customer,
        keywords = excluded.keywords,
        updated_at = excluded.updated_at
    `);
  }

  upsertAccount(account: {
    domain: string;
    name: string;
    description?: string | undefined;
    industry?: string | undefined;
    size?: string | undefined;
    createdAt?: number | undefined;
  }): void {
    this.insertAccountStmt.run(
      account.domain.toLowerCase().trim(),
      account.name.trim(),
      account.description ?? null,
      account.industry ?? null,
      account.size ?? null,
      account.createdAt ?? Date.now(),
    );
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
    this.insertSignalStmt.run(
      signal.id,
      signal.domain.toLowerCase().trim(),
      signal.type,
      signal.weight,
      signal.summary,
      signal.sourceUrl ?? null,
      signal.timestamp ?? Date.now(),
    );
  }

  getAccount(domain: string): DbAccount | undefined {
    return this.getAccountStmt.get(domain.toLowerCase().trim()) as DbAccount | undefined;
  }

  listAccounts(): DbAccount[] {
    return this.listAccountsStmt.all() as DbAccount[];
  }

  getSignalsForDomain(domain: string): DbSignal[] {
    return this.getSignalsForDomainStmt.all(domain.toLowerCase().trim()) as DbSignal[];
  }

  getIcp(): DbIcp | undefined {
    const row = this.getIcpStmt.get() as { id: string; ideal_customer: string; keywords: string; updated_at: number } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      ideal_customer: row.ideal_customer,
      keywords: JSON.parse(row.keywords) as string[],
      updated_at: row.updated_at,
    };
  }

  setIcp(idealCustomer: string, keywords: string[]): void {
    this.setIcpStmt.run(idealCustomer, JSON.stringify(keywords), Date.now());
  }

  close(): void {
    this.db.close();
  }
}
