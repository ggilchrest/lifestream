import { randomUUID } from "node:crypto";
import type { ProfileCandidate } from "@lifestream/storage-sqlite";
export const recordCategories = ["declaration", "episode", "semantic", "convention", "hypothesis", "procedure", "thread", "commitment"] as const;
export type RecordCategory = typeof recordCategories[number];
export type RelationshipRecord = {
  candidateId: string; content: string; source: string; sourceFamily: string; uncertainty: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "superseded" | "forgotten"; revision: number;
  contextUse?: "baseline" | "correction" | "relevant"; builder?: ProfileCandidate; approvedUse?: ProfileCandidate["approvedUse"]; evidenceBasis?: ProfileCandidate["evidenceBasis"];
  category?: RecordCategory; assertedBy?: string; createdAt?: string; eventAt?: string | null; sensitivity?: "personal" | "sensitive";
  sourceFamilies?: string[]; derivedFrom?: string[]; supersededBy?: string[]; annotations?: { text: string; actor: string; at: string }[];
  conflicts?: { recordId: string; status: "retained" | "resolved" }[]; salience?: "normal" | "operatorPinned";
  audience?: "authenticatedSession" | "ownerOnly"; suppressed?: boolean; trainingExcluded?: true;
  history?: { operation: string; actor: string; at: string; revision: number; relatedIds: string[] }[];
};
export class RecordOperationError extends Error { status: number; constructor(message: string, status = 422) { super(message); this.status = status; } }
const text = (value: unknown, maximum = 4000): string => { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new RecordOperationError("Bounded nonempty text is required"); return value.trim(); };
export function applyRecordOperation(records: RelationshipRecord[], id: string, raw: Record<string, unknown>, actor: string): { records: RelationshipRecord[]; affectedIds: string[] } {
  const next = structuredClone(records), target = next.find(item => item.candidateId === id);
  if (!target || target.status === "forgotten") throw new RecordOperationError("Record unavailable", 404);
  if (raw.expectedRecordRevision !== target.revision) throw new RecordOperationError("Record changed; refresh before applying", 409);
  if (target.status === "superseded" && raw.operation !== "forget") throw new RecordOperationError("Superseded history is read-only", 409);
  const now = new Date().toISOString(), operation = String(raw.operation), affected = [target];
  const history = (record: RelationshipRecord, relatedIds: string[] = []) => {
    if ((record.history?.length ?? 0) >= 256) throw new RecordOperationError("Record history capacity reached", 409);
    record.revision++; record.history = [...(record.history ?? []), { operation, actor, at: now, revision: record.revision, relatedIds }];
  };
  const derivative = (content: string, sources: RelationshipRecord[]): RelationshipRecord => ({
    candidateId: randomUUID(), content, source: "reviewed-record-derivation", sourceFamily: sources[0]!.sourceFamily,
    sourceFamilies: [...new Set(sources.flatMap(item => item.sourceFamilies ?? [item.sourceFamily]))], uncertainty: sources.some(item => item.uncertainty === "high") ? "high" : target.uncertainty,
    status: target.status === "approved" ? "approved" : "pending", revision: 1, contextUse: operation === "correct" ? "correction" : target.contextUse ?? "relevant",
    category: target.category ?? "declaration", assertedBy: actor, createdAt: now, eventAt: target.eventAt ?? null, evidenceBasis: operation === "correct" ? "userDeclaration" : target.evidenceBasis ?? "userDeclaration", sensitivity: sources.some(item => item.sensitivity === "sensitive") ? "sensitive" : "personal",
    derivedFrom: sources.map(item => item.candidateId), approvedUse: target.approvedUse ? structuredClone(target.approvedUse) : null,
    suppressed: target.suppressed ?? false, audience: target.audience ?? "authenticatedSession", trainingExcluded: true,
    history: [{ operation, actor, at: now, revision: 1, relatedIds: sources.map(item => item.candidateId) }]
  });
  if (["correct", "supersede", "split", "merge"].includes(operation)) {
    if (target.status !== "approved" && target.status !== "pending") throw new RecordOperationError("Only active review records can derive replacements", 409);
    const sources = [target];
    if (operation === "merge") {
      const other = next.find(item => item.candidateId === raw.otherRecordId);
      if (!other || other === target || other.revision !== raw.otherRecordRevision || other.status !== target.status || (other.category ?? "declaration") !== (target.category ?? "declaration") || other.contextUse !== target.contextUse || JSON.stringify(other.approvedUse ?? null) !== JSON.stringify(target.approvedUse ?? null) || !!other.suppressed !== !!target.suppressed || (other.audience ?? "authenticatedSession") !== (target.audience ?? "authenticatedSession") || other.conflicts?.some(item => item.status === "retained") || target.conflicts?.some(item => item.status === "retained")) throw new RecordOperationError("Merge supports only current compatible records in this relationship, with equal use scope and no unresolved conflict", 409);
      sources.push(other); affected.push(other);
    }
    const contents = operation === "split" ? raw.contents : [raw.content];
    if (!Array.isArray(contents) || contents.length < (operation === "split" ? 2 : 1) || contents.length > 4 || next.length + contents.length > 256) throw new RecordOperationError("Split accepts two to four bounded parts within relationship capacity");
    const replacements = contents.map(content => derivative(text(content), sources));
    for (const source of sources) { source.status = "superseded"; source.supersededBy = replacements.map(item => item.candidateId); history(source, source.supersededBy); }
    next.push(...replacements); affected.push(...replacements);
  } else if (operation === "annotate") {
    if ((target.annotations?.length ?? 0) >= 32) throw new RecordOperationError("Annotation capacity reached");
    target.annotations = [...(target.annotations ?? []), { text: text(raw.text, 1000), actor, at: now }]; history(target);
  } else if (operation === "conflict") {
    const other = next.find(item => item.candidateId === raw.otherRecordId);
    if (!other || other === target || other.revision !== raw.otherRecordRevision || !["approved", "pending"].includes(other.status) || !["retain", "resolve"].includes(String(raw.disposition))) throw new RecordOperationError("Conflict requires another current scoped record and explicit retain or resolve", 409);
    const status = raw.disposition === "retain" ? "retained" as const : "resolved" as const;
    target.conflicts = [...(target.conflicts ?? []).filter(item => item.recordId !== other.candidateId), { recordId: other.candidateId, status }];
    other.conflicts = [...(other.conflicts ?? []).filter(item => item.recordId !== target.candidateId), { recordId: target.candidateId, status }];
    if (status === "resolved") other.status = "rejected";
    history(target, [other.candidateId]); history(other, [target.candidateId]); affected.push(other);
  } else if (operation === "reject-inference") { if (target.category !== "hypothesis" && target.evidenceBasis !== "modelInference") throw new RecordOperationError("Record is not an inference"); target.status = "rejected"; history(target);
  } else if (operation === "pin") { target.salience = raw.pinned === true ? "operatorPinned" : "normal"; history(target);
  } else if (operation === "suppress") { target.suppressed = true; history(target);
  } else if (operation === "restrict-mention") { target.approvedUse = { personalization: false, mention: false, training: false, assistantId: text(raw.assistantId, 100), relationshipId: text(raw.relationshipId, 100) }; history(target);
  } else if (operation === "narrow-audience") { target.audience = "ownerOnly"; history(target);
  } else if (operation === "exclude-training") { target.trainingExcluded = true; history(target);
  } else if (operation === "forget") {
    target.status = "forgotten"; target.content = ""; target.source = "forgotten"; target.sourceFamily = "forgotten"; target.sourceFamilies = []; target.annotations = []; delete target.builder; target.approvedUse = null; target.suppressed = true; target.trainingExcluded = true; history(target);
  } else throw new RecordOperationError("Unsupported record operation");
  return { records: next, affectedIds: affected.map(item => item.candidateId) };
}
export function recordOverview(records: RelationshipRecord[]) {
  const visible = records.filter(item => item.status !== "forgotten"), active = visible.filter(item => item.status === "approved");
  return { total: records.length, categories: Object.fromEntries(recordCategories.map(category => [category, visible.filter(item => (item.category ?? "declaration") === category).length])), verifiedSharedEvents: 0, verifiedEventsLimitation: "This view contains authored/imported records; no verified event producer is connected.", activeRecords: active.length, pendingReview: visible.filter(item => item.status === "pending").length, retainedConflicts: visible.filter(item => hasRetainedRecordConflict(item)).length, sourceFamilies: new Set(visible.flatMap(item => item.sourceFamilies ?? [item.sourceFamily])).size, sourceDiversityLimitation: "Attributed source families are not independent verification.", highUncertainty: visible.filter(item => item.uncertainty === "high").length, latestRecordAt: visible.map(item => item.createdAt ?? item.builder?.reviewedAt ?? "").sort().at(-1) || null, coverage: "Available authored and imported context only; no claim of complete personal understanding." };
}

export function hasRetainedRecordConflict(record: RelationshipRecord): boolean {
  return !!record.conflicts?.some(conflict => conflict.status === "retained") || !!record.builder?.conflicts.length;
}
export function recordContextContent(record: RelationshipRecord): string {
  // Qualify the evidence before the shared compiler; no new source or support is created.
  if (record.contextUse === "correction" && record.evidenceBasis === "userDeclaration") return record.content;
  const qualifiers: string[] = [];
  if (record.category === "episode") qualifiers.push("Authored/imported account; not a verified shared event");
  if (record.evidenceBasis === "modelInference") qualifiers.push("Unverified hypothesis");
  if (record.builder) qualifiers.push(record.evidenceBasis === "userDeclaration" ? "User-reviewed imported declaration; eligible for its approved preference use, not independent factual verification" : `Imported ${record.evidenceBasis ?? "observation"}; attributed source, not independent verification`);
  return qualifiers.length ? `[${qualifiers.join("; ")}] ${record.content}` : record.content;
}
