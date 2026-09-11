import type { Database } from "./database.js";

export type ProfileSource = { sourceId: string; format: "json" | "csv" | "ndjson"; path: string; byteLength: number; sourceFamily: string; observedAt: string };
export type ProfileBuilderJob = { jobId: string; userId: string; revision: number; status: "preparing" | "extracting" | "review" | "cancelled" | "failed"; source: ProfileSource; limitBytes: number; egress: "closed" };
export type ProfileCandidate = { candidateId: string; jobId: string; key: string; value: string; sourceId: string; sourceFamily: string; observedAt: string; status: "inactive"; provenance: "fixture-extraction" };

const safePath = (path: string) => path.length > 0 && path.length <= 300 && !path.startsWith("/") && !path.includes("..") && !path.includes("\\") && !path.includes("\0");
const id = (value: string) => value.length > 0 && value.length <= 300;

export class ProfileBuilderRepository {
  private readonly jobs = new Map<string, ProfileBuilderJob>();
  private readonly candidates = new Map<string, ProfileCandidate[]>();
  private readonly database?: Database;
  constructor(database?: Database) { this.database = database; database?.exec("CREATE TABLE IF NOT EXISTS profile_builder_jobs (job_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS profile_builder_candidates (candidate_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload_json TEXT NOT NULL)"); }
  createJob(job: ProfileBuilderJob): ProfileBuilderJob { if (!id(job.jobId) || !id(job.userId) || job.revision < 1 || job.source.byteLength < 0 || job.source.byteLength > job.limitBytes || !safePath(job.source.path) || job.source.format === undefined || job.egress !== "closed") throw new Error("invalid bounded profile builder job"); if (this.jobs.has(job.jobId)) throw new Error("duplicate profile builder job"); this.jobs.set(job.jobId, structuredClone(job)); return structuredClone(job); }
  extract(jobId: string, records: Array<{ candidateId: string; key: string; value: string }>): ProfileCandidate[] { const job = this.jobs.get(jobId); if (!job || job.status !== "extracting") throw new Error("job is not extracting"); if (records.length > 1000 || records.some((record) => !id(record.candidateId) || !id(record.key) || record.value.length > 4000)) throw new Error("profile extraction exceeds bounded limits"); const result = records.map((record) => ({ ...record, jobId, sourceId: job.source.sourceId, sourceFamily: job.source.sourceFamily, observedAt: job.source.observedAt, status: "inactive" as const, provenance: "fixture-extraction" as const })); this.candidates.set(jobId, structuredClone(result)); this.jobs.set(jobId, { ...job, status: "review" }); return structuredClone(result); }
  cancel(jobId: string): ProfileBuilderJob { const job = this.jobs.get(jobId); if (!job || job.status === "review" || job.status === "cancelled" || job.status === "failed") throw new Error("job is not cancellable"); const next = { ...job, status: "cancelled" as const }; this.jobs.set(jobId, next); return structuredClone(next); }
  getCandidates(jobId: string): ProfileCandidate[] { return structuredClone(this.candidates.get(jobId) ?? []); }
}
