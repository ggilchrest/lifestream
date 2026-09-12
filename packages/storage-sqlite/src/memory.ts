import type { Database } from "./database.js";

export type MemoryRecord = { id: string; assistantId: string; content: string; provenance: Record<string, unknown>; lifecycle: Record<string, unknown>; createdAt: string };
type MemoryRow = { id: string; assistantId: string; content: string; provenance: string; lifecycle: string; createdAt: string };
export type MemoryLifecycleEvent = { memoryId: string; assistantId: string; revision: number; eventType: string; payload: Record<string, unknown>; occurredAt: string };
export type ForgetResult = { memoryId: string; assistantId: string; status: "forgotten"; contentRemoved: true; lifecycleRetained: true; externalCopies: "not-controlled"; revision: number };
const fromRow = (row: MemoryRow): MemoryRecord => ({ ...row, provenance: JSON.parse(row.provenance), lifecycle: JSON.parse(row.lifecycle) });

export class MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly events = new Map<string, MemoryLifecycleEvent[]>();
  private readonly database: Database | undefined;
  constructor(database?: Database) { this.database = database; }
  save(record: MemoryRecord): MemoryRecord {
    const copy = structuredClone(record);
    if (this.database) {
      try { this.database.transaction((tx) => { tx.run("INSERT INTO memories (id, assistant_id, content, provenance_json, lifecycle_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, copy.content, JSON.stringify(copy.provenance), JSON.stringify(copy.lifecycle), copy.createdAt); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, 1, "created", JSON.stringify(copy.lifecycle), copy.createdAt); }); }
      catch { throw new Error("memory is immutable"); }
    } else { if (this.records.has(copy.id)) throw new Error("memory is immutable"); this.records.set(copy.id, copy); this.events.set(copy.id, [{ memoryId: copy.id, assistantId: copy.assistantId, revision: 1, eventType: "created", payload: structuredClone(copy.lifecycle), occurredAt: copy.createdAt }]); }
    return structuredClone(copy);
  }
  saveMany(records: MemoryRecord[]): void {
    if (this.database) {
      this.database.transaction((tx) => { for (const record of records) { const copy = structuredClone(record); tx.run("INSERT INTO memories (id, assistant_id, content, provenance_json, lifecycle_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, copy.content, JSON.stringify(copy.provenance), JSON.stringify(copy.lifecycle), copy.createdAt); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, 1, "created", JSON.stringify(copy.lifecycle), copy.createdAt); } });
      return;
    }
    const seen = new Set<string>(); for (const record of records) { if (seen.has(record.id) || this.records.has(record.id)) throw new Error("memory is immutable"); seen.add(record.id); }
    for (const record of records) this.save(record);
  }
  get(assistantId: string, id: string): MemoryRecord | undefined {
    if (this.database) { const row = this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? AND id = ?").get(assistantId, id) as MemoryRow | undefined; return row ? fromRow(row) : undefined; }
    const record = this.records.get(id); return record?.assistantId === assistantId ? structuredClone(record) : undefined;
  }
  list(assistantId: string): MemoryRecord[] {
    if (this.database) return (this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? ORDER BY id").all(assistantId) as MemoryRow[]).map(fromRow);
    return [...this.records.values()].filter((record) => record.assistantId === assistantId).map((record) => structuredClone(record));
  }
  search(assistantId: string, query: string, limit = 20): MemoryRecord[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return this.list(assistantId).filter((record) => record.content.toLocaleLowerCase().includes(normalized)).slice(0, Math.max(1, Math.min(100, limit)));
  }
  history(assistantId: string, id: string): MemoryLifecycleEvent[] {
    if (this.database) {
      return (this.database.connection.prepare("SELECT memory_id AS memoryId, assistant_id AS assistantId, revision, event_type AS eventType, payload_json AS payload, occurred_at AS occurredAt FROM memory_lifecycle_events WHERE assistant_id = ? AND memory_id = ? ORDER BY revision").all(assistantId, id) as { memoryId: string; assistantId: string; revision: number; eventType: string; payload: string; occurredAt: string }[]).map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
    }
    const record = this.records.get(id); return record?.assistantId === assistantId ? structuredClone(this.events.get(id) ?? []) : [];
  }
  proposeCorrection(assistantId: string, id: string, proposedContent: string, actor: string): MemoryLifecycleEvent | undefined {
    const existing = this.get(assistantId, id); if (!existing) return undefined;
    const occurredAt = new Date().toISOString(); const payload = { proposedContent, status: "needsReview", actor };
    const revision = this.database ? this.database.transaction((tx) => { const nextRevision = tx.get<{ revision: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_lifecycle_events WHERE memory_id = ? AND assistant_id = ?", id, assistantId)?.revision ?? 1; tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, nextRevision, "correctionProposed", JSON.stringify(payload), occurredAt); return nextRevision; }) : (this.events.get(id)?.at(-1)?.revision ?? 0) + 1;
    if (!this.database) { const events = this.events.get(id) ?? []; events.push({ memoryId: id, assistantId, revision, eventType: "correctionProposed", payload, occurredAt }); this.events.set(id, events); }
    return { memoryId: id, assistantId, revision, eventType: "correctionProposed", payload, occurredAt };
  }
  transition(assistantId: string, id: string, status: string, actor: string, reason?: string, expectedRevision?: number): MemoryRecord | undefined {
    const allowed = new Set(["candidate", "active", "superseded", "invalidated", "contradicted"]);
    if (!allowed.has(status)) throw new Error("unsupported memory lifecycle status");
    const existing = this.get(assistantId, id); if (!existing) return undefined;
    const previousRevision = typeof existing.lifecycle.revision === "number" ? existing.lifecycle.revision : 1;
    if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw new Error("memory revision conflict");
    const currentStatus = typeof existing.lifecycle.status === "string" ? existing.lifecycle.status : "candidate";
    const validTransition = currentStatus === "candidate" ? ["active", "invalidated", "contradicted", "superseded"].includes(status) : currentStatus === "active" ? ["invalidated", "contradicted", "superseded"].includes(status) : false;
    if (!validTransition) throw new Error("invalid memory lifecycle transition");
    const lifecycle = { ...existing.lifecycle, status, revision: previousRevision + 1, changedBy: actor, ...(reason ? { reason } : {}) };
    if (this.database) {
      this.database.transaction((tx) => { const eventRevision = tx.get<{ revision: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_lifecycle_events WHERE memory_id = ? AND assistant_id = ?", id, assistantId)?.revision ?? 1; tx.run("UPDATE memories SET lifecycle_json = ? WHERE assistant_id = ? AND id = ? AND json_extract(lifecycle_json, '$.revision') = ? AND json_extract(lifecycle_json, '$.status') = ?", JSON.stringify(lifecycle), assistantId, id, previousRevision, currentStatus); if ((tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) !== 1) throw new Error("memory revision conflict"); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, eventRevision, "lifecycleChanged", JSON.stringify(lifecycle), new Date().toISOString()); });
      return this.get(assistantId, id);
    }
    const updated = { ...existing, lifecycle }; this.records.set(id, updated); const events = this.events.get(id) ?? []; events.push({ memoryId: id, assistantId, revision: (events.at(-1)?.revision ?? 0) + 1, eventType: "lifecycleChanged", payload: structuredClone(lifecycle), occurredAt: new Date().toISOString() }); this.events.set(id, events); return structuredClone(updated);
  }
  forget(assistantId: string, id: string, actor: string, reason = "source forgotten", expectedRevision?: number): ForgetResult | undefined {
    const existing = this.get(assistantId, id); if (!existing) return undefined;
    const previousRevision = typeof existing.lifecycle.revision === "number" ? existing.lifecycle.revision : 1;
    if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw new Error("memory revision conflict");
    const revision = previousRevision + 1; const occurredAt = new Date().toISOString(); const lifecycle = { ...existing.lifecycle, status: "invalidated", revision, changedBy: actor, reason, forgottenAt: occurredAt, contentRemoved: true };
    if (this.database) {
      this.database.transaction((tx) => { tx.run("UPDATE memories SET content = ?, lifecycle_json = ? WHERE assistant_id = ? AND id = ? AND json_extract(lifecycle_json, '$.revision') = ?", "", JSON.stringify(lifecycle), assistantId, id, previousRevision); if ((tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) !== 1) throw new Error("memory revision conflict"); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, revision, "forgotten", JSON.stringify({ status: "invalidated", reason, contentRemoved: true }), occurredAt); });
    } else {
      this.records.set(id, { ...existing, content: "", lifecycle }); const events = this.events.get(id) ?? []; events.push({ memoryId: id, assistantId, revision, eventType: "forgotten", payload: { status: "invalidated", reason, contentRemoved: true }, occurredAt }); this.events.set(id, events);
    }
    return { memoryId: id, assistantId, status: "forgotten", contentRemoved: true, lifecycleRetained: true, externalCopies: "not-controlled", revision };
  }
}
