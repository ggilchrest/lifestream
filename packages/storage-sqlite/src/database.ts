import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StatementSync } from "node:sqlite";

export interface Transaction {
  readonly database: DatabaseSync;
  run(sql: string, ...parameters: unknown[]): void;
  get<T extends object = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T | undefined;
  all<T extends object = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T[];
}
class TransactionImpl implements Transaction {
  readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  private statement(sql: string): StatementSync { return this.database.prepare(sql); }
  run(sql: string, ...parameters: unknown[]): void { this.statement(sql).run(...parameters as never[]); }
  get<T extends object>(sql: string, ...parameters: unknown[]): T | undefined { return this.statement(sql).get(...parameters as never[]) as T | undefined; }
  all<T extends object>(sql: string, ...parameters: unknown[]): T[] { return this.statement(sql).all(...parameters as never[]) as T[]; }
}
function withTransaction<T>(database: DatabaseSync, operation: (transaction: Transaction) => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = operation(new TransactionImpl(database)); database.exec("COMMIT"); return result; }
  catch (error) { try { database.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
}

interface Migration { id: number; name: string; sql: string; digest: string; }
export interface MigrationRecord { id: number; name: string; digest: string; appliedAt: string; }
function loadMigrations(): Migration[] {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return [
    [1, "initial", "0001_initial.sql"],
    [11, "capability_cache", "0011_capability_cache.sql"],
  ].map(([id, name, file]) => {
    const sql = readFileSync(join(directory, file as string), "utf8");
    return { id: id as number, name: name as string, sql, digest: createHash("sha256").update(sql).digest("hex") };
  });
}

export interface DatabaseOptions { path: string; busyTimeoutMs?: number; migrations?: ReturnType<typeof loadMigrations>; }

export class Database {
  readonly path: string;
  readonly connection: DatabaseSync;
  private readonly migrations: ReturnType<typeof loadMigrations>;
  constructor(options: DatabaseOptions) {
    this.path = options.path; this.migrations = options.migrations ?? loadMigrations();
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.connection = new DatabaseSync(options.path);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = NORMAL");
  }
  migrate(): MigrationRecord[] {
    this.connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, applied_at TEXT NOT NULL)");
    return withTransaction(this.connection, (tx) => {
      for (const migration of this.migrations) {
        const existing = tx.get<{ id: number; name: string; digest: string }>("SELECT id, name, digest FROM schema_migrations WHERE id = ?", migration.id);
        if (existing && (existing.name !== migration.name || existing.digest !== migration.digest)) throw new Error(`Migration ${migration.id} digest mismatch`);
        if (!existing) { tx.database.exec(migration.sql); tx.run("INSERT INTO schema_migrations (id, name, digest, applied_at) VALUES (?, ?, ?, ?)", migration.id, migration.name, migration.digest, new Date().toISOString()); }
      }
      return tx.all<MigrationRecord>("SELECT id, name, digest, applied_at AS appliedAt FROM schema_migrations ORDER BY id");
    });
  }
  transaction<T>(operation: (transaction: Transaction) => T): T { return withTransaction(this.connection, operation); }
  exec(sql: string): void { this.connection.exec(sql); }
  close(): void { this.connection.close(); }
  async backup(destination: string): Promise<number> { return backup(this.connection, destination); }
}
