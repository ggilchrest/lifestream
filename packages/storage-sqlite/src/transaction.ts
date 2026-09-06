import type { DatabaseSync, StatementSync } from "node:sqlite";

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

export function withTransaction<T>(database: DatabaseSync, operation: (transaction: Transaction) => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = operation(new TransactionImpl(database)); database.exec("COMMIT"); return result; }
  catch (error) { try { database.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
}
