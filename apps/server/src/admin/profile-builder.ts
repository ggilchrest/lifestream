import { createContractValidator } from "@lifestream/contracts";
import { setImmediate } from "node:timers/promises";
import { PROFILE_BUILDER_LIMITS, ProfileBuilderError, ProfileBuilderRepository, type ExtractedRecord, type ProfileUpload, type ProfileCandidate, type EvidenceBasis } from "@lifestream/storage-sqlite";

const canonicalValidator = createContractValidator();
export const PROFILE_FORMATS = Object.freeze([
  { format: "canonical-user-profile-v1", version: "1.0.0", parser: "canonical-user-profile", description: "Canonical UserProfile v1 scalar declarations for the authenticated subject; scopes and consent are not imported or activated" },
  { format: "notes-v1", version: "1", parser: "utf8-lines", description: "UTF-8 personally authored notes; each nonempty line is an attributed candidate" },
  { format: "profile-v1", version: "1.0.0", parser: "bounded-json-profile", description: "Explicit self-subject profile records: key, value, basis, eventAt and sensitivity" },
  { format: "conversation-v1", version: "1.0.0", parser: "bounded-json-conversation", description: "Explicit self-subject conversation messages: role, content and createdAt" },
  { format: "conversation-ndjson-v1", version: "1", parser: "bounded-ndjson-conversation", description: "One role/content/createdAt conversation message per line" }
]);
const object = (input: unknown): Record<string, unknown> => { if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProfileBuilderError("Expected a supported structured object"); return input as Record<string, unknown>; };
const allowedFields = (input: Record<string, unknown>, fields: string[]): void => { if (Object.keys(input).some((key) => !fields.includes(key))) throw new ProfileBuilderError("Unsupported structured fields; credentials, instructions and authority fields are never configuration inputs"); };
const value = (input: unknown, max: number): string => { if (typeof input !== "string" || !input.trim() || input.length > max || input.includes("\0")) throw new ProfileBuilderError("Missing, malformed or oversized text field"); return input.trim(); };
const date = (input: unknown): string | null => { if (input === undefined || input === null) return null; if (typeof input !== "string" || !/Z$/u.test(input) || !Number.isFinite(Date.parse(input))) throw new ProfileBuilderError("Original event date must be UTC or unknown"); return input; };
const parseJSON = (content: string): unknown => { try { return JSON.parse(content); } catch { throw new ProfileBuilderError("Malformed selected JSON; no content was admitted"); } };
const basisFor = (basis: EvidenceBasis, upload: ProfileUpload): EvidenceBasis => basis === "userDeclaration" && upload.authoredBy !== "user" ? upload.authoredBy === "assistant" ? "assistantGenerated" : "observation" : basis;
export function extractProfileUpload(upload: ProfileUpload, expectedUserId?: string): ExtractedRecord[] {
  const make = (key: unknown, text: unknown, evidenceBasis: EvidenceBasis, eventAt: unknown, locator: string, sensitivity: unknown = "personal"): ExtractedRecord => {
    if (typeof key === "string" && /^(?:password|api[-_]?key|access[-_]?token|private[-_]?key|credential|secret)$/iu.test(key)) throw new ProfileBuilderError("Credential-like records are excluded from intake");
    if (sensitivity !== "personal" && sensitivity !== "sensitive") throw new ProfileBuilderError("Unsupported sensitivity value");
    return { key: value(key, 120), value: value(text, PROFILE_BUILDER_LIMITS.valueCharacters), evidenceBasis: basisFor(evidenceBasis, upload), eventAt: date(eventAt), sensitivity, locator };
  };
  const message = (item: unknown, index: number): ExtractedRecord => {
    const row = object(item); allowedFields(row, ["role", "content", "createdAt"]);
    if (!["user", "assistant", "quoted"].includes(row.role as string)) throw new ProfileBuilderError("Conversation role must explicitly identify user, assistant or quoted text");
    return make(`conversation-${index + 1}`, row.content, row.role === "assistant" ? "assistantGenerated" : row.role === "quoted" ? "quoted" : "userDeclaration", row.createdAt, `message:${index + 1}`);
  };
  let records: ExtractedRecord[];
  if (upload.format === "canonical-user-profile-v1") {
    const root = object(parseJSON(upload.content));
    if (!canonicalValidator.validate("https://lifestream.dev/contracts/user-profile/1.0.0", root).valid) throw new ProfileBuilderError("Canonical UserProfile 1.0.0 schema validation failed");
    if (!expectedUserId || root.userId !== expectedUserId) throw new ProfileBuilderError("Canonical profile subject differs from the authenticated target", 403);
    if (root.status === "revoked" || root.revokedAt !== null) throw new ProfileBuilderError("Revoked canonical profiles cannot seed new context");
    records = (root.declarations as unknown[]).map((item,index) => { const declaration=object(item); if (!["string","number","boolean"].includes(typeof declaration.value)) throw new ProfileBuilderError("Canonical intake supports bounded scalar declarations only"); return make(declaration.key,String(declaration.value),"userDeclaration",root.validFrom,`declaration:${index+1}`,declaration.sensitivity === "sensitive" ? "sensitive" : "personal"); });
  }
  else if (upload.format === "notes-v1") records = upload.content.split(/\r?\n/u).map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line).map(({ line, index }) => make(`note-${index + 1}`, line, line.startsWith(">") ? "quoted" : "userDeclaration", upload.observedAt, `line:${index + 1}`));
  else if (upload.format === "conversation-ndjson-v1") records = upload.content.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => message(parseJSON(line), index));
  else {
    const root = object(parseJSON(upload.content));
    allowedFields(root, upload.format === "profile-v1" ? ["schemaVersion", "kind", "subject", "records"] : ["schemaVersion", "kind", "subject", "messages"]);
    if (root.schemaVersion !== "1.0.0" || root.subject !== "self") throw new ProfileBuilderError("Structured intake requires schemaVersion 1.0.0 and explicit self subject; third-party subjects are excluded");
    if (upload.format === "profile-v1") {
      if (root.kind !== "user-profile" || !Array.isArray(root.records)) throw new ProfileBuilderError("Unsupported structured profile version or records");
      records = root.records.map((item, index) => { const row = object(item); allowedFields(row, ["key", "value", "basis", "eventAt", "sensitivity"]); if (!["userDeclaration", "observation", "quoted", "assistantGenerated", "modelInference"].includes(row.basis as string)) throw new ProfileBuilderError("Every profile record requires an explicit evidence basis"); return make(row.key, row.value, row.basis as EvidenceBasis, row.eventAt, `record:${index + 1}`, row.sensitivity); });
    } else if (upload.format === "conversation-v1" && root.kind === "conversation" && Array.isArray(root.messages)) records = root.messages.map(message);
    else throw new ProfileBuilderError("Unsupported conversation format/version");
  }
  if (!records.length || records.length > PROFILE_BUILDER_LIMITS.records) throw new ProfileBuilderError("Extraction must produce between one and 256 bounded records");
  return records;
}

type Scope = { userId: string; assistantId: string; relationshipId: string; revision: number };
type Result = { status: number; body: Record<string, unknown> };
export class ProfileBuilderAdmin {
  private readonly active = new Set<string>();
  private closed = false;
  readonly repository: ProfileBuilderRepository;
  private readonly sourceAllowed:(userId:string,relationshipId:string,value:string,digest:string)=>boolean;
  constructor(repository: ProfileBuilderRepository, sourceAllowed:(userId:string,relationshipId:string,value:string,digest:string)=>boolean=()=>true) { this.repository = repository;this.sourceAllowed=sourceAllowed; }
  close(): void { this.closed = true; for (const id of this.active) { const job = this.repository.getJob(id); if (job?.status === "extracting") this.repository.cancel(id, job.revision); } }
  private async extract(jobId: string, revision: number, uploads: ProfileUpload[]): Promise<void> {
    this.active.add(jobId);
    const startedAt = Date.now();
    try {
      await setImmediate(); if (this.closed) return;
      const job = this.repository.getJob(jobId); if (!job || job.revision !== revision) return;
      // beginExtraction already pinned the source; no path, connector, model or
      // account capability is available to the parser or to imported content.
      const records: Array<{ source: typeof job.sources[number]; record: ExtractedRecord }> = [];
      let tokens = 0;
      for (let index = 0; index < uploads.length; index++) {
        const source = job.sources[index]!;
        for (const record of extractProfileUpload(uploads[index]!, job.userId)) {
          if(!this.sourceAllowed(job.userId,job.relationshipId,record.value,source.sha256)){this.repository.cancel(job.jobId,revision);return;}
          tokens += record.value.length;
          if (records.length >= PROFILE_BUILDER_LIMITS.records || tokens > PROFILE_BUILDER_LIMITS.tokens || Date.now() - startedAt > PROFILE_BUILDER_LIMITS.durationMs) throw new ProfileBuilderError("Extraction exceeded declared count, token or time limits");
          records.push({ source, record });
          if (records.length % 8 === 0) { await setImmediate(); if (this.closed || this.repository.getJob(jobId)?.revision !== revision) return; }
        }
        await setImmediate(); if (this.closed || this.repository.getJob(jobId)?.revision !== revision) return;
      }
      this.repository.finishExtraction(jobId, revision, records);
    } catch (error) { if (!this.closed) this.repository.fail(jobId, revision, error instanceof ProfileBuilderError ? error.message : "Bounded local extraction failed; no candidate was admitted"); }
    finally { this.active.delete(jobId); }
  }
  handle(method: string, tail: string[], actor: string, scope: Scope, input: unknown, admit: (candidate: ProfileCandidate) => void | (() => void)): Result {
    try {
      if (!actor || actor !== scope.userId) throw new ProfileBuilderError("Profile Builder requires the authenticated relationship subject", 403);
      const raw = object(input);
      if (!tail.length && method === "GET") return { status: 200, body: { formats: PROFILE_FORMATS, limits: PROFILE_BUILDER_LIMITS, jobs: this.repository.listJobs(actor, scope.relationshipId), egress: "closed", unsupported: ["Archives", "Directory paths and symlinks", "Live connectors", "Third-party subjects", "Cloud extraction", "Training", "Mention-restricted personalization"] } };
      if (!tail.length && method === "POST") { allowedFields(raw, ["files"]); const job = this.repository.createJob(scope, raw.files as ProfileUpload[]); return { status: 201, body: { job, candidates: this.repository.getCandidates(job.jobId) } }; }
      const job = this.repository.getJob(tail[0] ?? ""); if (!job || job.userId !== actor || job.relationshipId !== scope.relationshipId || job.assistantId !== scope.assistantId) throw new ProfileBuilderError("Builder job not found", 404);
      const result = (status = 200): Result => ({ status, body: { job: this.repository.getJob(job.jobId), candidates: this.repository.getCandidates(job.jobId) } });
      if (tail.length === 1 && method === "GET") return result();
      if (method !== "POST" || tail.length !== 2) throw new ProfileBuilderError("Unsupported builder operation", 404);
      if (!Number.isInteger(raw.expectedRevision)) throw new ProfileBuilderError("An expected job revision is required", 409);
      const revision = raw.expectedRevision as number;
      if (tail[1] === "snapshot") { allowedFields(raw, ["expectedRevision", "files"]); this.repository.snapshot(job.jobId, revision, raw.files as ProfileUpload[]); return result(); }
      if (tail[1] === "extract" || tail[1] === "resume") { allowedFields(raw, ["expectedRevision"]); if (this.closed || this.active.size >= PROFILE_BUILDER_LIMITS.concurrentJobs) throw new ProfileBuilderError("Bounded extraction capacity is unavailable", 409); const next = this.repository.beginExtraction(job.jobId, revision); void this.extract(job.jobId, next.job.revision, next.uploads); return result(202); }
      if (tail[1] === "cancel") { allowedFields(raw, ["expectedRevision"]); this.repository.cancel(job.jobId, revision); return result(); }
      if (tail[1] === "review") { allowedFields(raw, ["expectedRevision", "items"]); this.repository.review(job.jobId, revision, actor, raw.items as Parameters<ProfileBuilderRepository["review"]>[3]); return result(); }
      if (tail[1] === "admit") { allowedFields(raw, ["expectedRevision", "expectedRelationshipRevision", "items"]); if (raw.expectedRelationshipRevision !== scope.revision) throw new ProfileBuilderError("Target relationship revision is stale", 409); this.repository.admit(job.jobId, revision, actor, raw.items as Parameters<ProfileBuilderRepository["admit"]>[3], admit); return result(); }
      throw new ProfileBuilderError("Unsupported builder operation", 404);
    } catch (error) { return { status: error instanceof ProfileBuilderError ? error.status : 422, body: { code: "profile_builder_rejected", message: error instanceof ProfileBuilderError ? error.message : "Malformed or unsupported bounded builder request" } }; }
  }
}
