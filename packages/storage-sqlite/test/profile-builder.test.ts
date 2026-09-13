import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/database.ts";
import { ProfileBuilderRepository, inventoryUploads, type ProfileUpload, type ExtractedRecord } from "../src/profile-builder.ts";

const scope = { userId: "synthetic-user", assistantId: "synthetic-assistant", relationshipId: "synthetic-relationship" };
const upload = (override: Partial<ProfileUpload> = {}): ProfileUpload => ({ name: "notes.txt", format: "notes-v1", content: "I prefer short replies.", authoredBy: "user", ownedBySubject: true, observedAt: "2026-09-12T00:00:00Z", ...override });
const record = (override: Partial<ExtractedRecord> = {}): ExtractedRecord => ({ key: "style", value: "short replies", evidenceBasis: "userDeclaration", eventAt: null, sensitivity: "personal", locator: "line:1", ...override });
const prepare = (repo: ProfileBuilderRepository, files = [upload()], records = [record()]) => { const job = repo.createJob(scope, files); const snapshot = repo.snapshot(job.jobId, job.revision, files); const running = repo.beginExtraction(job.jobId, snapshot.revision); return repo.finishExtraction(job.jobId, running.job.revision, records.map(r => ({ source: running.job.sources[0]!, record: r }))); };
const use = { personalization: true, mention: true, training: false as const };

test("LS-TEST-101 inventory and snapshot are bounded, pinned and durable with no collection capability", t => {
  const root = mkdtempSync(join(tmpdir(), "builder-durable-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let database = new Database({ path: join(root, "state.sqlite") }); database.migrate(); let repo = new ProfileBuilderRepository(database);
  const job = repo.createJob(scope, [upload()]); assert.equal(job.collectionAccess, "closed"); assert.equal(job.egress, "closed");
  assert.equal(database.connection.prepare("SELECT COUNT(*) AS n FROM profile_builder_snapshots").get()?.n, 0);
  assert.throws(() => repo.snapshot(job.jobId, job.revision, [upload({ content: "changed after inventory" })]), /changed after inventory/);
  const snapshot = repo.snapshot(job.jobId, job.revision, [upload()]); database.close();
  database = new Database({ path: join(root, "state.sqlite") }); database.migrate(); repo = new ProfileBuilderRepository(database); t.after(() => database.close());
  assert.equal(repo.getJob(job.jobId)?.status, "snapshotted"); assert.equal(repo.getJob(job.jobId)?.collectionAccess, "closed");
  const running = repo.beginExtraction(job.jobId, snapshot.revision); const reviewed = repo.finishExtraction(job.jobId, running.job.revision, [{ source: running.job.sources[0]!, record: record() }]);
  const candidate = repo.getCandidates(job.jobId)[0]!; assert.equal(candidate.status, "inactive"); assert.equal(candidate.approvedUse, null); assert.equal(candidate.subjectId, scope.userId); assert.equal(candidate.sourceDate, upload().observedAt); assert.equal(candidate.observedAt, null); assert.equal(candidate.untrustedContent, true);
  assert.equal(reviewed.status, "review"); assert.equal(database.connection.prepare("SELECT COUNT(*) AS n FROM profile_builder_snapshots").get()?.n, 0);
});

test("LS-TEST-101 rejects traversal, symlink paths, archives, credential names, unsupported and oversized input", t => {
  const repo = new ProfileBuilderRepository(); t.after(() => repo.database.close());
  for (const name of ["../secrets.txt", "/home/user.txt", "link/notes.txt", "folder\\notes.txt", "notes.zip", "id.key", ".env", "browser-profile.json", "password.txt"]) assert.throws(() => repo.createJob(scope, [upload({ name })]), /excluded|safe names/);
  for (const bad of [upload({ content: "x".repeat(65_537) }), upload({ format: "vendor-unknown" as never }), upload({ authoredBy: "unknown", ownedBySubject: false as never }), upload({ content: "API_KEY=synthetic-test-value" }), upload({ content: "-----BEGIN PRIVATE KEY-----" }), upload({ content: "binary\0bytes" })]) assert.throws(() => repo.createJob(scope, [bad]));
  assert.throws(() => inventoryUploads(scope.userId, Array.from({ length: 9 }, (_, i) => upload({ name: `file${i}.txt` }))), /eight/);
  assert.throws(() => inventoryUploads(scope.userId, Array.from({ length: 5 }, (_, i) => upload({ name: `file${i}.txt`, content: "x".repeat(65_536) }))), /byte limits/);
});

test("LS-TEST-101 restart, cancellation and stale extraction cannot reopen collection or restore candidates", t => {
  const database = new Database({ path: ":memory:" }); database.migrate(); t.after(() => database.close());
  let repo = new ProfileBuilderRepository(database); const job = repo.createJob(scope, [upload()]); const snapshot = repo.snapshot(job.jobId, job.revision, [upload()]); const first = repo.beginExtraction(job.jobId, snapshot.revision);
  repo = new ProfileBuilderRepository(database); const recovered = repo.getJob(job.jobId)!; assert.equal(recovered.status, "failed"); assert.equal(recovered.collectionAccess, "closed"); assert.equal(repo.getCandidates(job.jobId).length, 0);
  assert.throws(() => repo.finishExtraction(job.jobId, first.job.revision, []), /stale/);
  const resumed = repo.beginExtraction(job.jobId, recovered.revision); const cancelled = repo.cancel(job.jobId, resumed.job.revision);
  assert.equal(cancelled.status, "cancelled"); assert.throws(() => repo.finishExtraction(job.jobId, resumed.job.revision, []), /stale/); assert.throws(() => repo.beginExtraction(job.jobId, cancelled.revision), /cancelled/); assert.equal(repo.getCandidates(job.jobId).length, 0);
});

test("LS-MEM-082 granular and grouped review is revision checked, atomic and never grants training", t => {
  const repo = new ProfileBuilderRepository(); t.after(() => repo.database.close()); const job = prepare(repo, [upload()], [record(), record({ key: "goal", value: "learn", locator: "line:2" })]); const [a, b] = repo.getCandidates(job.jobId);
  assert.throws(() => repo.review(job.jobId, job.revision, scope.userId, [{ candidateId: a!.candidateId, expectedRevision: 1, decision: "approved", use }, { candidateId: b!.candidateId, expectedRevision: 999, decision: "rejected" }]), /stale/); assert.equal(repo.getCandidate(a!.candidateId)?.status, "inactive");
  assert.throws(() => repo.review(job.jobId, job.revision, scope.userId, [{ candidateId: a!.candidateId, expectedRevision: 1, decision: "approved", use: { ...use, training: true as never } }]), /training/);
  assert.throws(() => repo.review(job.jobId, job.revision, scope.userId, [{ candidateId: a!.candidateId, expectedRevision: 1, decision: "approved", use: { ...use, mention: false } }]), /Mention-restricted/);
  const reviewed = repo.review(job.jobId, job.revision, scope.userId, [{ candidateId: a!.candidateId, expectedRevision: 1, decision: "approved", value: "precise short replies", use }, { candidateId: b!.candidateId, expectedRevision: 1, decision: "rejected" }]);
  assert.equal(repo.getCandidate(a!.candidateId)?.value, "precise short replies"); assert.equal(repo.getCandidate(a!.candidateId)?.approvedUse?.training, false); assert.throws(() => repo.review(job.jobId, job.revision, scope.userId, []), /stale/); assert.equal(reviewed.revision, job.revision + 1);
});

test("LS-MEM-082 admission reports partial outcomes, survives restart and rejects stale reimports", t => {
  const database = new Database({ path: ":memory:" }); database.migrate(); t.after(() => database.close()); let repo = new ProfileBuilderRepository(database); let job = prepare(repo, [upload()], [record(), record({ key: "goal", value: "learn", locator: "line:2" })]);
  job = repo.review(job.jobId, job.revision, scope.userId, repo.getCandidates(job.jobId).map(c => ({ candidateId: c.candidateId, expectedRevision: c.revision, decision: "approved", use })));
  let accepted = 0; job = repo.admit(job.jobId, job.revision, scope.userId, repo.getCandidates(job.jobId).map(c => ({ candidateId: c.candidateId, expectedRevision: c.revision })), c => { if (c.key === "goal") throw new Error("synthetic owner failure"); accepted++; });
  assert.deepEqual(job.outcomes.map(o => o.status), ["admitted", "failed"]); assert.equal(accepted, 1);
  repo = new ProfileBuilderRepository(database); const remaining = repo.getCandidates(job.jobId).filter(c => c.status === "approved"); job = repo.admit(job.jobId, job.revision, scope.userId, remaining.map(c => ({ candidateId: c.candidateId, expectedRevision: c.revision })), () => accepted++); assert.equal(accepted, 2);
  const renamed = prepare(repo, [upload({ name: "renamed.txt" })], [record(), record({ key: "goal", value: "learn", locator: "line:2" })]); assert.equal(renamed.candidateIds.length, 2); assert.deepEqual(renamed.candidateIds, job.candidateIds); assert.ok(repo.getCandidates(renamed.jobId).every(c => c.status === "admitted"));
  const prior = repo.getCandidates(renamed.jobId)[0]!; const result = repo.admit(renamed.jobId, renamed.revision, scope.userId, [{ candidateId: prior.candidateId, expectedRevision: 1 }], () => { throw new Error("must not run"); }); assert.equal(result.outcomes[0]?.status, "failed");
  assert.equal(new Set(repo.getCandidates(renamed.jobId).flatMap(c => c.independentSourceGroups)).size, 1);
});

test("LS-MEM-081 metadata refresh creates an inactive attributed difference without independent support", t => {
  const repo = new ProfileBuilderRepository(); t.after(() => repo.database.close()); const original = prepare(repo); const first = repo.getCandidates(original.jobId)[0]!;
  const refresh = prepare(repo, [upload({ observedAt: "2026-09-13T00:00:00Z", authoredBy: "assistant" })], [record({ evidenceBasis: "assistantGenerated" })]); const difference = repo.getCandidates(refresh.jobId)[0]!;
  assert.notEqual(difference.candidateId, first.candidateId); assert.equal(difference.status, "inactive"); assert.equal(difference.evidenceBasis, "assistantGenerated"); assert.equal(difference.sourceDate, "2026-09-13T00:00:00Z"); assert.equal(repo.getCandidate(first.candidateId)?.evidenceBasis, "userDeclaration"); assert.deepEqual(difference.independentSourceGroups, first.independentSourceGroups);
});

test("owner-local admission and durable marker roll back together on failure", t => {
  const repo = new ProfileBuilderRepository(); t.after(() => repo.database.close()); repo.database.exec("CREATE TABLE synthetic_owner (candidate_id TEXT PRIMARY KEY)");
  let job = prepare(repo); const candidate = repo.getCandidates(job.jobId)[0]!; job = repo.review(job.jobId, job.revision, scope.userId, [{ candidateId: candidate.candidateId, expectedRevision: candidate.revision, decision: "approved", use }]);
  const selected = repo.getCandidates(job.jobId)[0]!; const failed = repo.admit(job.jobId, job.revision, scope.userId, [{ candidateId: selected.candidateId, expectedRevision: selected.revision }], c => { repo.database.connection.prepare("INSERT INTO synthetic_owner VALUES (?)").run(c.candidateId); throw new Error("synthetic failure before marker"); });
  assert.equal(failed.outcomes[0]?.status, "failed"); assert.equal(repo.database.connection.prepare("SELECT COUNT(*) AS n FROM synthetic_owner").get()?.n, 0); assert.equal(repo.getCandidate(candidate.candidateId)?.status, "approved");
});
