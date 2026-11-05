import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { loadMigrations } from "./migrations/index.ts";

export type OwnerChange = {owner: string; principalId?: string; assistantId?: string; relationshipId?: string; ownerId: string; beforeRevision: number; afterRevision: number};
export interface Transaction {
  readonly ownerChanges: readonly OwnerChange[];
  recordOwnerChange(change: OwnerChange): void;
  readonly database: DatabaseSync;
  run(sql: string, ...parameters: unknown[]): void;
  get<T extends object = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T | undefined;
  all<T extends object = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T[];
}
class TransactionImpl implements Transaction {
  readonly ownerChanges: OwnerChange[]=[];
  recordOwnerChange(change:OwnerChange):void {if(Object.keys(change).some(k=>!['owner','principalId','assistantId','relationshipId','ownerId','beforeRevision','afterRevision'].includes(k))||![change.beforeRevision,change.afterRevision].every(v=>Number.isSafeInteger(v)&&v>=0)||change.afterRevision<change.beforeRevision||typeof change.owner!=='string'||!/^[a-zA-Z0-9._:-]{1,64}$/.test(change.owner)||![change.ownerId,change.principalId,change.assistantId,change.relationshipId].filter(v=>v!==undefined).every(v=>typeof v==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(v))||this.ownerChanges.length>=64)throw Error('owner_receipt_metadata_invalid');this.ownerChanges.push({...change});}

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

export interface MigrationRecord { id: number; name: string; digest: string; appliedAt: string; }

export interface DatabaseOptions { path: string; busyTimeoutMs?: number; migrations?: ReturnType<typeof loadMigrations>; }

export class Database {
  // Default read statements belong exclusively to this executor. Never expose
  // them through connection.prepare: its options, iteration and mutation stay
  // local to each public StatementSync. Only compilation is reused, never rows.
  readonly #reads = new Map<string, {statement: StatementSync; busy: boolean}>();
  readonly path: string;
  readonly connection: DatabaseSync;
  private readonly native:DatabaseSync;private depth=0;private observer:((transaction:Transaction,result:unknown,changes:number,owners:readonly OwnerChange[])=>void)|undefined;
  private readonly migrations: ReturnType<typeof loadMigrations>;
  constructor(options: DatabaseOptions) {
    this.path = options.path; this.migrations = options.migrations ?? loadMigrations();
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.native=new DatabaseSync(options.path);const database=this;
    this.connection=new Proxy(this.native,{get(target,key){if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)||/\b(?:administration_audit|administration_outbox|administration_owner_commits)\b/i.test(sql))return statement;return new Proxy(statement,{get(original,method){const value=Reflect.get(original,method,original);if(['run','get','all'].includes(String(method))&&typeof value==='function')return (...args:unknown[])=>database.observer&&database.depth===0?database.transaction(()=>value.apply(original,args)):value.apply(original,args);return typeof value==='function'?value.bind(original):value;}});};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});

    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = NORMAL");
  }
  migrate(): MigrationRecord[] {
    this.connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, applied_at TEXT NOT NULL)");
    return withTransaction(this.native, (tx) => {
      for (const migration of this.migrations) {
        const existing = tx.get<{ id: number; name: string; digest: string }>("SELECT id, name, digest FROM schema_migrations WHERE id = ?", migration.id);
        if (existing && (existing.name !== migration.name || existing.digest !== migration.digest)) throw new Error(`Migration ${migration.id} digest mismatch`);
        if (!existing) { tx.database.exec(migration.sql); tx.run("INSERT INTO schema_migrations (id, name, digest, applied_at) VALUES (?, ?, ?, ?)", migration.id, migration.name, migration.digest, new Date().toISOString()); }
      }
      return tx.all<MigrationRecord>("SELECT id, name, digest, applied_at AS appliedAt FROM schema_migrations ORDER BY id");
    });
  }
  transaction<T>(operation: (transaction: Transaction) => T): T {return withTransaction(this.native,tx=>{const before=Number(tx.get<{n:number}>('SELECT total_changes() AS n')!.n);this.depth++;try{const result=operation(tx);if(this.observer&&result instanceof Promise)throw Error('transaction_requires_synchronous_operation');const changes=Number(tx.get<{n:number}>('SELECT total_changes() AS n')!.n)-before;if(changes>0)this.observer?.(tx,result,changes,tx.ownerChanges);return result;}finally{this.depth--;}});}
  /** Host-only observer admitted inside the owner transaction before COMMIT.
   * Statement-only writes use the same path while an observer is installed. */
  observeTransactions(observer:(transaction:Transaction,result:unknown,changes:number,owners:readonly OwnerChange[])=>void):()=>void {if(this.observer)throw Error('transaction_observer_already_bound');this.observer=observer;return ()=>{if(this.observer===observer)this.observer=undefined;};}
  /** Commit a synchronous native dispatch CAS with WAL fsync before I/O.
   * Scoped to this transaction; legacy connection defaults are restored. */
  durableTransaction<T>(operation: (transaction: Transaction) => T): T {
    const previous = this.connection.prepare("PRAGMA synchronous").get()!.synchronous as number;
    this.connection.exec("PRAGMA synchronous = FULL");
    try {
      if ((this.connection.prepare("PRAGMA synchronous").get()!.synchronous as number) < 2) throw new Error("durable_transaction_unavailable");
      return this.transaction(tx => {
        const value = operation(tx);
        if (value instanceof Promise) throw new Error("durable_transaction_requires_synchronous_operation");
        return value;
      });
    } finally { this.connection.exec(`PRAGMA synchronous = ${previous}`); }
  }
  exec(sql: string): void { this.connection.exec(sql); }
  private read(sql: string, method: "get" | "all", parameters: unknown[]): unknown {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error("read_statement_requires_select");
    let entry = this.#reads.get(sql);
    // An SQLite function can synchronously reenter this executor. Its active
    // cursor must not be reset or rebound by the nested call.
    if (!entry || entry.busy) {
      const created = {statement: this.connection.prepare(sql), busy: false};
      if (!entry && sql.length <= 16_384) {
        if (this.#reads.size >= 64) this.#reads.delete(this.#reads.keys().next().value!);
        this.#reads.set(sql, created);
      }
      entry = created;
    }
    entry.busy = true;
    try { return entry.statement[method](...parameters as never[]); }
    catch (error) {
      if (this.#reads.get(sql) === entry) this.#reads.delete(sql);
      throw error; // Preserve the original failure; never retry an execution.
    } finally { entry.busy = false; }
  }
  /** Execute a fresh default SELECT; the private prepared statement never escapes. */
  readGet<T extends object = Record<string, SQLOutputValue>>(sql: string, ...parameters: unknown[]): T | undefined {
    return this.read(sql, "get", parameters) as T | undefined;
  }
  readAll<T extends object = Record<string, SQLOutputValue>>(sql: string, ...parameters: unknown[]): T[] {
    return this.read(sql, "all", parameters) as T[];
  }
  close(): void { this.#reads.clear(); this.connection.close(); }
  async backup(destination: string): Promise<number> { return backup(this.native, destination); }
}
