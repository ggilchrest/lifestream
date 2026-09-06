import test from "node:test";
import assert from "node:assert/strict";
import { validateLock, validateCheckpoint, admissionErrors, repositoryMatches, safePath } from "./workspace.mjs";

const revision = "a".repeat(40);
const manifest = "b".repeat(64);
const readyLock = () => ({
  schemaVersion: "1.0.0", repository: "ggilchrest/lifestream-specs", checkoutPath: ".private", status: "pinned",
  baseRevision: "c".repeat(40), revision, contractManifestSha256: manifest,
  review: { reviewer: "human-admin", reviewedAt: "2026-09-03T00:00:00Z", evidence: "private-review:baseline-1" }
});
const checkpoint = () => ({
  schemaVersion: "1.0.0", repository: "ggilchrest/lifestream", branch: "codex/s001", baseRevision: "d".repeat(40), currentRevision: "WORKTREE",
  activeSlice: "LS-S001", sliceStatus: "notStarted", completedSlices: [], allowedFiles: ["package.json"], changedFiles: [], validation: [], decisions: [], blockers: [],
  nextAction: "Implement the reviewed slice.", updatedAt: "2026-09-03T00:00:00Z", updatedBy: "Codex", notes: ""
});
const spec = () => ({ present: true, independent: true, remote: "https://github.com/ggilchrest/lifestream-specs.git", revision, dirty: false, manifestSha256: manifest });
const packet = () => ({ slice: "LS-S001", prerequisites: [], allowedFiles: ["package.json"] });
const admit = (overrides = {}) => admissionErrors({ lock: readyLock(), checkpoint: checkpoint(), slice: "LS-S001", spec: spec(), packet: packet(), publicBranch: "codex/s001", publicRevision: "d".repeat(40), publicChanges: [], ...overrides });

test("ready metadata satisfies the pure admission gate", () => assert.deepEqual(admit(), []));
test("HTTPS and SSH GitHub origins match only the expected repository", () => {
  assert.equal(repositoryMatches("https://github.com/ggilchrest/lifestream-specs.git", "ggilchrest/lifestream-specs"), true);
  assert.equal(repositoryMatches("git@github.com:ggilchrest/lifestream-specs.git", "ggilchrest/lifestream-specs"), true);
  assert.equal(repositoryMatches("https://github.com/someone/lifestream-specs.git", "ggilchrest/lifestream-specs"), false);
});
test("scope paths are literal, relative, and exclude both Git roots", () => {
  for (const value of ["package.json", "apps/server/src/index.ts"]) assert.equal(safePath(value), true);
  for (const value of ["/tmp/x", "../x", "apps/server/", "apps/**", ".git/config", ".private/README.md"]) assert.equal(safePath(value), false);
});
test("pending lock carries no fake immutable target", () => assert.deepEqual(validateLock({ ...readyLock(), status: "awaitingPublication", revision: null, contractManifestSha256: null, review: null }), []));

for (const [name, mutate, pattern] of [
  ["unpublished pin", (x) => { x.lock.status = "awaitingPublication"; x.lock.revision = null; x.lock.contractManifestSha256 = null; x.lock.review = null; }, /awaits reviewed publication/],
  ["wrong private origin", (x) => { x.spec.remote = "https://github.com/someone/lifestream-specs"; }, /origin/],
  ["nested private tree", (x) => { x.spec.independent = false; }, /independent Git root/],
  ["stale revision", (x) => { x.spec.revision = "f".repeat(40); }, /immutable specification pin/],
  ["dirty specification", (x) => { x.spec.dirty = true; }, /uncommitted/],
  ["manifest drift", (x) => { x.spec.manifestSha256 = "0".repeat(64); }, /manifest digest/],
  ["inactive slice", (x) => { x.checkpoint.activeSlice = null; x.checkpoint.sliceStatus = "blocked"; x.checkpoint.blockers = ["not authorized"]; }, /not active and unblocked/],
  ["branch mismatch", (x) => { x.publicBranch = "main"; }, /branch/],
  ["packet scope drift", (x) => { x.checkpoint.allowedFiles = ["README.md"]; }, /writable files/],
  ["unverified prerequisite", (x) => { x.packet.prerequisites = ["LS-S000"]; }, /prerequisite/]
]) test("admission rejects " + name, () => {
  const input = { lock: readyLock(), checkpoint: checkpoint(), slice: "LS-S001", spec: spec(), packet: packet(), publicBranch: "codex/s001", publicRevision: "d".repeat(40), publicChanges: [] };
  mutate(input); assert.match(admissionErrors(input).join("\n"), pattern);
});

test("lock rejects branches, fabricated review, partial hashes and unknown fields", () => {
  for (const lock of [
    { ...readyLock(), revision: "main" },
    { ...readyLock(), review: { reviewer: "", reviewedAt: "today", evidence: "" } },
    { ...readyLock(), contractManifestSha256: "abc" },
    { ...readyLock(), extra: true }
  ]) assert.ok(validateLock(lock).length);
});
test("checkpoint cannot claim work with no active slice", () => {
  const value = checkpoint(); value.activeSlice = null; value.sliceStatus = "inProgress";
  assert.match(validateCheckpoint(value).join("\n"), /without active slice/);
});
test("checkpoint cannot claim verification with blockers or nonpassing checks", () => {
  const value = checkpoint(); value.sliceStatus = "verified"; value.blockers = ["still blocked"];
  value.validation = [{ command: "pnpm test", result: "notRun", evidence: "" }];
  assert.match(validateCheckpoint(value).join("\n"), /verified with/);
});
test("checkpoint rejects unsafe scope and evidence-free executed results", () => {
  const value = checkpoint(); value.allowedFiles = [".private/README.md"];
  value.validation = [{ command: "pnpm test", result: "pass", evidence: "" }];
  const result = validateCheckpoint(value).join("\n");
  assert.match(result, /unsafe/); assert.match(result, /executed evidence/);
});
test("checkpoint rejects changed files outside the packet scope", () => {
  const value = checkpoint(); value.changedFiles = ["README.md"];
  assert.match(validateCheckpoint(value).join("\n"), /outside exact writable scope/);
});
test("admission rejects unrecorded worktree changes and a stale WORKTREE base", () => {
  assert.match(admit({ publicChanges: ["README.md"] }).join("\n"), /checkpoint.changedFiles/);
  const value = checkpoint(); value.baseRevision = "e".repeat(40);
  assert.match(admit({ checkpoint: value }).join("\n"), /WORKTREE checkpoint base/);
});
