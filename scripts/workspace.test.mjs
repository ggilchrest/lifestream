import test from "node:test";
import assert from "node:assert/strict";
import { validateCheckpoint, preflightErrors, repositoryMatches, safePath } from "./workspace.mjs";

const checkpoint = () => ({
  schemaVersion: "1.0.0", repository: "ggilchrest/lifestream", branch: "codex/s001", baseRevision: "d".repeat(40), currentRevision: "WORKTREE",
  activeSlice: "LS-S001", sliceStatus: "notStarted", completedSlices: [], allowedFiles: ["package.json"], changedFiles: [], validation: [], decisions: [], blockers: [],
  nextAction: "Implement the current slice.", updatedAt: "2026-09-03T00:00:00Z", updatedBy: "Codex", notes: ""
});
const packet = () => ({ slice: "LS-S001", prerequisites: [], allowedFiles: ["package.json"] });
const inspect = (overrides = {}) => preflightErrors({ checkpoint: checkpoint(), slice: "LS-S001", packet: packet(), publicBranch: "codex/s001", publicRevision: "d".repeat(40), publicChanges: [], ...overrides });

test("consistent metadata satisfies the pure preflight check", () => assert.deepEqual(inspect(), []));
test("HTTPS and SSH GitHub origins match only the expected repository", () => {
  assert.equal(repositoryMatches("https://github.com/ggilchrest/lifestream-specs.git", "ggilchrest/lifestream-specs"), true);
  assert.equal(repositoryMatches("git@github.com:ggilchrest/lifestream-specs.git", "ggilchrest/lifestream-specs"), true);
  assert.equal(repositoryMatches("https://github.com/someone/lifestream-specs.git", "ggilchrest/lifestream-specs"), false);
});
test("scope paths are literal, relative, and exclude both Git roots", () => {
  for (const value of ["package.json", "apps/server/src/index.ts"]) assert.equal(safePath(value), true);
  for (const value of ["/tmp/x", "../x", "apps/server/", "apps/**", ".git/config", ".private/README.md"]) assert.equal(safePath(value), false);
});
for (const [name, mutate, pattern] of [
  ["inactive slice", (x) => { x.checkpoint.activeSlice = null; x.checkpoint.sliceStatus = "blocked"; x.checkpoint.blockers = ["dependency unavailable"]; }, /does not select/],
  ["branch mismatch", (x) => { x.publicBranch = "main"; }, /branch/],
  ["packet scope drift", (x) => { x.checkpoint.allowedFiles = ["README.md"]; }, /writable files/],
  ["unverified prerequisite", (x) => { x.packet.prerequisites = ["LS-S000"]; }, /prerequisite/]
]) test("preflight reports " + name, () => {
  const input = { checkpoint: checkpoint(), slice: "LS-S001", packet: packet(), publicBranch: "codex/s001", publicRevision: "d".repeat(40), publicChanges: [] };
  mutate(input); assert.match(preflightErrors(input).join("\n"), pattern);
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
test("preflight reports unrecorded worktree changes and a stale WORKTREE base", () => {
  assert.match(inspect({ publicChanges: ["README.md"] }).join("\n"), /checkpoint.changedFiles/);
  const value = checkpoint(); value.baseRevision = "e".repeat(40);
  assert.match(inspect({ checkpoint: value }).join("\n"), /WORKTREE checkpoint base/);
});
