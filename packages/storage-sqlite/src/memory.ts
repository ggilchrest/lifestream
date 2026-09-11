import type { Database } from "./database.js";

export type MemoryRecord = { id: string; assistantId: string; content: string; provenance: Record<string, unknown>; lifecycle: Record<string, unknown>; createdAt: string };
type MemoryRow = { id: string; assistantId: string; content: string; provenance: string; lifecycle: string; createdAt: string };
const fromRow = (row: MemoryRow): MemoryRecord => ({ ...row, provenance: JSON.parse(row.provenance), lifecycle: JSON.parse(row.lifecycle) });

export class MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly database: Database | undefined;
  constructor(database?: Database) { this.database = database; }
  save(record: MemoryRecord): MemoryRecord {
    const copy = structuredClone(record);
    if (this.database) {
      try { this.database.transaction((tx) => { tx.run("INSERT INTO memories (id, assistant_id, content, provenance_json, lifecycle_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, copy.content, JSON.stringify(copy.provenance), JSON.stringify(copy.lifecycle), copy.createdAt); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, 1, "created", JSON.stringify(copy.lifecycle), copy.createdAt); }); }
      catch { throw new Error("memory is immutable"); }
    } else { if (this.records.has(copy.id)) throw new Error("memory is immutable"); this.records.set(copy.id, copy); }
    return structuredClone(copy);
  }
  get(assistantId: string, id: string): MemoryRecord | undefined {
    if (this.database) { const row = this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? AND id = ?").get(assistantId, id) as MemoryRow | undefined; return row ? fromRow(row) : undefined; }
    const record = this.records.get(id); return record?.assistantId === assistantId ? structuredClone(record) : undefined;
  }
  list(assistantId: string): MemoryRecord[] {
    if (this.database) return (this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? ORDER BY id").all(assistantId) as MemoryRow[]).map(fromRow);
    return [...this.records.values()].filter((record) => record.assistantId === assistantId).map((record) => structuredClone(record));
  }
  transition(assistantId: string, id: string, status: string, actor: string, reason?: string): MemoryRecord | undefined {
    const allowed = new Set(["candidate", "active", "superseded", "invalidated", "retracted"]);
    if (!allowed.has(status)) throw new Error("unsupported memory lifecycle status");
    const existing = this.get(assistantId, id); if (!existing) return undefined;
    const previousRevision = typeof existing.lifecycle.revision === "number" ? existing.lifecycle.revision : 1;
    const lifecycle = { ...existing.lifecycle, status, revision: previousRevision + 1, changedBy: actor, ...(reason ? { reason } : {}) };
    if (this.database) {
      this.database.transaction((tx) => { tx.run("UPDATE memories SET lifecycle_json = ? WHERE assistant_id = ? AND id = ?", JSON.stringify(lifecycle), assistantId, id); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, previousRevision + 1, "lifecycleChanged", JSON.stringify(lifecycle), new Date().toISOString()); });
      return this.get(assistantId, id);
    }
    const updated = { ...existing, lifecycle }; this.records.set(id, updated); return structuredClone(updated);
  }
}
