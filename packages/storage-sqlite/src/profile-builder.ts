import { createHash, randomUUID } from "node:crypto";
import { Database } from "./database.ts";

export const PROFILE_BUILDER_LIMITS = Object.freeze({ files: 8, fileBytes: 65_536, totalBytes: 262_144, records: 256, valueCharacters: 4_000, tokens: 16_384, durationMs: 2_000, providerCalls: 0, concurrentJobs: 2 });
export type ProfileFormat = "canonical-user-profile-v1" | "notes-v1" | "profile-v1" | "conversation-v1" | "conversation-ndjson-v1";
export type EvidenceBasis = "userDeclaration" | "observation" | "quoted" | "assistantGenerated" | "modelInference";
export type ProfileSource = { sourceId: string; format: ProfileFormat; path: string; byteLength: number; sha256: string; sourceFamily: string; observedAt: string | null; authoredBy: "user" | "assistant" | "unknown" };
export type ProfileUpload = { name: string; format: ProfileFormat; content: string; observedAt?: string | null; authoredBy: "user" | "assistant" | "unknown"; ownedBySubject: true };
export type ApprovedUse = { personalization: boolean; mention: boolean; training: false; assistantId: string; relationshipId: string };
export type ProfileCandidate = {
  candidateId: string; jobId: string; userId: string; relationshipId: string; key: string; value: string; subjectId: string;
  sourceId: string; sourceDigest: string; sourceFamily: string; sourceDate: string | null; observedAt: string | null; locator: string;
  revision: number; status: "inactive" | "approved" | "rejected" | "admitted"; provenance: "local-selected-file";
  extractionVersion: "bounded-local-v1"; evidenceBasis: EvidenceBasis; sensitivity: "personal" | "sensitive";
  independentSourceGroups: string[]; conflicts: string[]; uncertainty: "medium" | "high"; untrustedContent: true;
  approvedUse: ApprovedUse | null; reviewedBy?: string; reviewedAt?: string; conflictDisposition?: "retain";
};
export type ProfileBuilderJob = {
  jobId: string; userId: string; assistantId: string; relationshipId: string; revision: number;
  status: "inventoried" | "snapshotted" | "extracting" | "review" | "cancelled" | "failed";
  sources: ProfileSource[]; snapshotDigest: string; candidateIds: string[]; createdAt: string; updatedAt: string;
  egress: "closed"; collectionAccess: "closed"; extractionVersion: "bounded-local-v1"; limits: typeof PROFILE_BUILDER_LIMITS;
  failure?: string; outcomes: Array<{ candidateId: string; status: "admitted" | "alreadyAdmitted" | "failed"; reason?: string }>;
  /** Set only when a worker interruption left the pinned snapshot safe to resume. */
  retryable?: boolean;
};
export type ExtractedRecord = { key: string; value: string; evidenceBasis: EvidenceBasis; eventAt: string | null; sensitivity: "personal" | "sensitive"; locator: string };
export class ProfileBuilderError extends Error { readonly status: number; constructor(message: string, status = 422) { super(message); this.status = status; } }
export const profileDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const ensure = (condition: unknown, message: string, status = 422): void => { if (!condition) throw new ProfileBuilderError(message, status); };
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
export const safeProfileName = (value: unknown): value is string => boundedText(value, 180) && !value.startsWith(".") && !/[\\/:]/u.test(value) && !value.includes("..") && !/(?:^|[._ -])(?:env|secret|credential|password|token|key|keychain|cookies|login|wallet|history|browser)(?:$|[._ -])/iu.test(value) && !/\.(?:zip|tar|gz|bz2|7z|rar|exe|sh|pem|key|p12|sqlite|db)$/iu.test(value);
export function inventoryUploads(userId: string, uploads: ProfileUpload[]): ProfileSource[] {
  ensure(boundedText(userId, 200), "An authenticated subject is required", 401);
  ensure(Array.isArray(uploads) && uploads.length > 0 && uploads.length <= PROFILE_BUILDER_LIMITS.files, "Select between one and eight supported files");
  let bytes = 0;
  const sources = uploads.map((upload) => {
    ensure(upload && !Object.keys(upload).some(key => !["name", "format", "content", "observedAt", "authoredBy", "ownedBySubject"].includes(key)), "Unknown upload controls are not accepted");
    ensure(upload?.ownedBySubject === true, "Explicit subject-owned input confirmation is required; third-party material is excluded");
    ensure(upload && safeProfileName(upload.name), "Selected filenames must be plain safe names; directories, paths, archives and credential-like files are excluded");
    ensure(["notes-v1", "profile-v1", "conversation-v1", "conversation-ndjson-v1", "canonical-user-profile-v1"].includes(upload.format), "Unsupported input format/version; only declared UTF-8 notes and structured profile/conversation v1 are accepted");
    ensure(typeof upload.content === "string" && !upload.content.includes("\0") && !upload.content.includes("\ufffd"), "Input must be valid UTF-8 text without binary data");
    ensure(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|\n)\s*(?:AWS_SECRET_ACCESS_KEY|API_KEY|PASSWORD|ACCESS_TOKEN|SECRET_KEY)\s*[:=]\s*\S+/miu.test(upload.content), "Credential-like payloads and private keys are excluded from intake");
    const byteLength = Buffer.byteLength(upload.content); bytes += byteLength;
    ensure(byteLength > 0 && byteLength <= PROFILE_BUILDER_LIMITS.fileBytes && bytes <= PROFILE_BUILDER_LIMITS.totalBytes, "Selected input exceeds file or total byte limits");
    ensure(["user", "assistant", "unknown"].includes(upload.authoredBy), "Source authorship must be explicitly selected");
    ensure(upload.observedAt === undefined || upload.observedAt === null || typeof upload.observedAt === "string" && /Z$/u.test(upload.observedAt) && Number.isFinite(Date.parse(upload.observedAt)), "Original source date must be UTC or explicitly unknown");
    const sha256 = profileDigest(upload.content);
    // All imports by one subject are conservatively correlated. Renaming a file,
    // reimporting it or uploading a derivative never creates independent support.
    return { sourceId: `source-${sha256}`, format: upload.format, path: upload.name, byteLength, sha256, sourceFamily: `selected-import:${userId}`, observedAt: upload.observedAt ?? null, authoredBy: upload.authoredBy };
  });
  ensure(new Set(sources.map((s) => s.path)).size === sources.length, "Selected filenames must be unique");
  return sources;
}

export class ProfileBuilderRepository {
  readonly database: Database;
  constructor(database?: Database) {
    this.database = database ?? new Database({ path: ":memory:" });
    if (!database) this.database.migrate();
    // Recovery never recreates file/collection capabilities in place. It records
    // that an interrupted extraction still has a pinned, local snapshot which
    // may be resumed by the owning idle worker after current checks pass.
    for (const job of this.allJobs()) if (job.status === "extracting") this.saveJob({ ...job, revision: job.revision + 1, status: "failed", collectionAccess: "closed", failure: "Extraction interrupted by restart; waiting for an idle worker to reprocess the pinned snapshot", retryable: true, updatedAt: new Date().toISOString() });
  }
  private allJobs(): ProfileBuilderJob[] { return (this.database.connection.prepare("SELECT payload_json FROM profile_builder_jobs").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json) as ProfileBuilderJob); }
  private saveJob(job: ProfileBuilderJob): void { this.database.connection.prepare("INSERT OR REPLACE INTO profile_builder_jobs (job_id,payload_json) VALUES (?,?)").run(job.jobId, JSON.stringify(job)); }
  private saveCandidate(candidate: ProfileCandidate): void { this.database.connection.prepare("INSERT OR REPLACE INTO profile_builder_candidates (candidate_id,job_id,payload_json) VALUES (?,?,?)").run(candidate.candidateId, candidate.jobId, JSON.stringify(candidate)); }
  getJob(jobId: string): ProfileBuilderJob | undefined { const row = this.database.connection.prepare("SELECT payload_json FROM profile_builder_jobs WHERE job_id=?").get(jobId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as ProfileBuilderJob : undefined; }
  listJobs(userId: string, relationshipId: string): ProfileBuilderJob[] { return this.allJobs().filter((j) => j.userId === userId && j.relationshipId === relationshipId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  listRecoverableJobs(): ProfileBuilderJob[] {
    return this.allJobs().filter(job => job.status === "failed" && job.retryable === true && !!this.database.connection.prepare("SELECT 1 FROM profile_builder_snapshots WHERE job_id=?").get(job.jobId));
  }
  getCandidate(candidateId: string): ProfileCandidate | undefined { const row = this.database.connection.prepare("SELECT payload_json FROM profile_builder_candidates WHERE candidate_id=?").get(candidateId) as { payload_json: string } | undefined; return row ? JSON.parse(row.payload_json) as ProfileCandidate : undefined; }
  getCandidates(jobId: string): ProfileCandidate[] { return (this.getJob(jobId)?.candidateIds ?? []).map((id) => this.getCandidate(id)).filter((c): c is ProfileCandidate => !!c); }
  private current(jobId: string, revision: number): ProfileBuilderJob { const job = this.getJob(jobId); ensure(job && job.revision === revision, "Builder job revision is stale", 409); return job!; }
  createJob(scope: { userId: string; assistantId: string; relationshipId: string }, uploads: ProfileUpload[]): ProfileBuilderJob {
    const sources = inventoryUploads(scope.userId, uploads); ensure(boundedText(scope.assistantId, 200) && boundedText(scope.relationshipId, 200), "An owned Assistant relationship is required");
    const digest = profileDigest(JSON.stringify(sources));
    const jobs = this.listJobs(scope.userId, scope.relationshipId);
    const prior = jobs.find((j) => j.snapshotDigest === digest && !["cancelled", "failed"].includes(j.status)); if (prior) return prior;
    ensure(jobs.length < 32, "Relationship import history has reached its bounded job limit");
    const now = new Date().toISOString();
    const job: ProfileBuilderJob = { ...scope, jobId: randomUUID(), revision: 1, status: "inventoried", sources, snapshotDigest: digest, candidateIds: [], createdAt: now, updatedAt: now, egress: "closed", collectionAccess: "closed", extractionVersion: "bounded-local-v1", limits: PROFILE_BUILDER_LIMITS, outcomes: [] };
    this.saveJob(job); return job;
  }
  snapshot(jobId: string, revision: number, uploads: ProfileUpload[]): ProfileBuilderJob {
    const job = this.current(jobId, revision); ensure(job.status === "inventoried", "Only the inventoried selection can be collected", 409);
    ensure(profileDigest(JSON.stringify(inventoryUploads(job.userId, uploads))) === job.snapshotDigest, "Selected files changed after inventory; start a fresh reviewable inventory", 409);
    const next = { ...job, revision: job.revision + 1, status: "snapshotted" as const, updatedAt: new Date().toISOString() };
    this.database.transaction(() => { this.database.connection.prepare("INSERT INTO profile_builder_snapshots (job_id,payload_json) VALUES (?,?)").run(jobId, JSON.stringify(uploads)); this.saveJob(next); }); return next;
  }
  beginExtraction(jobId: string, revision: number): { job: ProfileBuilderJob; uploads: ProfileUpload[] } {
    const job = this.current(jobId, revision); ensure(["snapshotted", "failed"].includes(job.status), "Job must have a pinned snapshot; cancelled and reviewed jobs cannot resume", 409);
    const snapshot = this.database.connection.prepare("SELECT payload_json FROM profile_builder_snapshots WHERE job_id=?").get(jobId) as { payload_json: string } | undefined;
    ensure(snapshot, "Pinned snapshot is unavailable; explicitly collect a new selection", 409);
    const uploads = JSON.parse(snapshot!.payload_json) as ProfileUpload[];
    ensure(profileDigest(JSON.stringify(inventoryUploads(job.userId, uploads))) === job.snapshotDigest, "Pinned snapshot integrity failed", 409);
    const next = { ...job, revision: job.revision + 1, status: "extracting" as const, updatedAt: new Date().toISOString() }; delete next.failure; delete next.retryable; this.saveJob(next); return { job: next, uploads };
  }
  finishExtraction(jobId: string, revision: number, records: Array<{ source: ProfileSource; record: ExtractedRecord }>): ProfileBuilderJob {
    const job = this.current(jobId, revision); ensure(job.status === "extracting", "Job is no longer extracting", 409); ensure(records.length <= PROFILE_BUILDER_LIMITS.records, "Candidate count exceeds the bounded limit");
    const candidates = records.map(({ source, record }) => {
      ensure(boundedText(record.key, 120) && boundedText(record.value, PROFILE_BUILDER_LIMITS.valueCharacters), "Extracted record exceeds bounded limits");
      const candidateId = `candidate-${profileDigest(`${job.relationshipId}:${source.sha256}:${source.format}:${source.authoredBy}:${source.observedAt ?? "unknown"}:bounded-local-v1:${record.locator}`)}`;
      const prior = this.getCandidate(candidateId); if (prior) return prior;
      return { candidateId, jobId, userId: job.userId, relationshipId: job.relationshipId, key: record.key, value: record.value, subjectId: job.userId, sourceId: source.sourceId, sourceDigest: source.sha256, sourceFamily: source.sourceFamily, sourceDate: source.observedAt, observedAt: record.eventAt, locator: record.locator, revision: 1, status: "inactive" as const, provenance: "local-selected-file" as const, extractionVersion: "bounded-local-v1" as const, evidenceBasis: record.evidenceBasis, sensitivity: record.sensitivity, independentSourceGroups: [source.sourceFamily], conflicts: [], uncertainty: "high" as const, untrustedContent: true as const, approvedUse: null };
    });
    for (const candidate of candidates) if (!this.getCandidate(candidate.candidateId)) candidate.conflicts = candidates.filter((other) => other.candidateId !== candidate.candidateId && other.key === candidate.key && other.value !== candidate.value).map((other) => other.candidateId);
    const next = { ...job, revision: job.revision + 1, status: "review" as const, candidateIds: [...new Set(candidates.map((c) => c.candidateId))], updatedAt: new Date().toISOString() };
    this.database.transaction(() => { for (const candidate of candidates) this.saveCandidate(candidate); this.saveJob(next); this.database.connection.prepare("DELETE FROM profile_builder_snapshots WHERE job_id=?").run(jobId); }); return next;
  }
  fail(jobId: string, revision: number, reason: string): void { const job = this.getJob(jobId); if (job?.revision === revision && job.status === "extracting") this.saveJob({ ...job, revision: job.revision + 1, status: "failed", collectionAccess: "closed", failure: reason, retryable: false, updatedAt: new Date().toISOString() }); }
  interrupt(jobId: string, revision: number, reason = "Extraction interrupted; waiting for an idle worker to reprocess the pinned snapshot"): void { const job = this.getJob(jobId); if (job?.revision === revision && job.status === "extracting") this.saveJob({ ...job, revision: job.revision + 1, status: "failed", collectionAccess: "closed", failure: reason, retryable: true, updatedAt: new Date().toISOString() }); }
  cancel(jobId: string, revision: number): ProfileBuilderJob {
    const job = this.current(jobId, revision); ensure(job.status !== "review", "Reviewed jobs retain their per-candidate review history", 409);
    const next = { ...job, revision: job.revision + 1, status: "cancelled" as const, collectionAccess: "closed" as const, retryable: false, updatedAt: new Date().toISOString() };
    this.database.transaction(() => { this.database.connection.prepare("DELETE FROM profile_builder_snapshots WHERE job_id=?").run(jobId); this.saveJob(next); }); return next;
  }
  review(jobId: string, revision: number, actor: string, items: Array<{ candidateId: string; expectedRevision: number; decision: "approved" | "rejected"; value?: string; use?: { personalization: boolean; mention: boolean; training: false }; retainConflicts?: boolean }>): ProfileBuilderJob {
    const job = this.current(jobId, revision); ensure(job.status === "review" && actor === job.userId, "Only the owned review job can be changed", 409); ensure(Array.isArray(items) && items.length > 0 && items.length <= PROFILE_BUILDER_LIMITS.records && new Set(items.map((i) => i.candidateId)).size === items.length, "Review requires unique bounded candidate selections");
    this.database.transaction(() => {
      for (const item of items) {
        const candidate = this.getCandidate(item.candidateId); ensure(candidate && job.candidateIds.includes(item.candidateId) && candidate.revision === item.expectedRevision && candidate.status !== "admitted", "Candidate review is stale or already admitted; use normal relationship operations", 409);
        ensure(["approved", "rejected"].includes(item.decision), "Review requires an explicit approve or reject decision");
        if (item.decision === "approved") { ensure(item.use && typeof item.use.personalization === "boolean" && typeof item.use.mention === "boolean" && item.use.training === false, "Explicit use scope is required; import never grants training consent"); ensure(!item.use!.personalization || item.use!.mention, "Mention-restricted personalization is not supported by this intake; retain for review only"); ensure(!candidate!.conflicts.length || item.retainConflicts === true, "Conflicting candidates require explicit retain-conflict review"); }
        ensure(item.value === undefined || boundedText(item.value, PROFILE_BUILDER_LIMITS.valueCharacters), "Corrected value exceeds bounded limits");
        this.saveCandidate({ ...candidate!, revision: candidate!.revision + 1, status: item.decision, value: item.value ?? candidate!.value, approvedUse: item.decision === "approved" ? { ...item.use!, assistantId: job.assistantId, relationshipId: job.relationshipId } : null, reviewedBy: actor, reviewedAt: new Date().toISOString(), ...(item.retainConflicts ? { conflictDisposition: "retain" as const } : {}) });
      }
      this.saveJob({ ...job, revision: job.revision + 1, updatedAt: new Date().toISOString() });
    }); return this.getJob(jobId)!;
  }
  admit(jobId: string, revision: number, actor: string, selections: Array<{ candidateId: string; expectedRevision: number }>, apply: (candidate: ProfileCandidate) => void | (() => void)): ProfileBuilderJob {
    const job = this.current(jobId, revision); ensure(job.status === "review" && job.userId === actor, "Only the owned review job can admit context", 409); ensure(Array.isArray(selections) && selections.length > 0 && selections.length <= PROFILE_BUILDER_LIMITS.records && new Set(selections.map((i) => i.candidateId)).size === selections.length, "Admission requires unique bounded selections");
    const outcomes: ProfileBuilderJob["outcomes"] = [];
    for (const selection of selections) {
      const candidate = this.getCandidate(selection.candidateId);
      if (!candidate || !job.candidateIds.includes(selection.candidateId) || candidate.revision !== selection.expectedRevision || !["approved", "admitted"].includes(candidate.status) || !candidate.approvedUse) { outcomes.push({ candidateId: selection.candidateId, status: "failed", reason: "Candidate is stale, rejected or not approved" }); continue; }
      try {
        let afterCommit: void | (() => void);
        this.database.transaction(() => { afterCommit = apply(candidate); if (candidate.status !== "admitted") this.saveCandidate({ ...candidate, revision: candidate.revision + 1, status: "admitted" }); });
        if (typeof afterCommit! === "function") afterCommit();
        outcomes.push({ candidateId: candidate.candidateId, status: candidate.status === "admitted" ? "alreadyAdmitted" : "admitted" });
      }
      catch { outcomes.push({ candidateId: candidate.candidateId, status: "failed", reason: "Owner-local admission failed or target record changed; review current state before retry" }); }
    }
    const next = { ...job, revision: job.revision + 1, outcomes, updatedAt: new Date().toISOString() }; this.saveJob(next); return next;
  }
}
