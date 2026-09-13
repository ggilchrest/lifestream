import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { validateCheckpoint, preflightErrors, preflight, prerequisiteErrors, repositoryMatches, safePath, metadataOnlyDelta, metadataOnlyRevisionAdvance, validQualification, sha256 } from "./workspace.mjs";

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
test("metadata-only checkpoint commits are distinguishable from source changes", () => {
  assert.equal(metadataOnlyDelta(["implementation/checkpoint.json"]), true);
  assert.equal(metadataOnlyDelta(["implementation/checkpoint.json", "implementation/evidence/LS-S052-qualification.json"]), false);
  assert.equal(metadataOnlyDelta(["implementation/checkpoint.json", "packages/runtime/src/inference/prompt.ts"]), false);
  for (const path of ["implementation/evidence/helper.mjs", "implementation/evidence/config.json", "implementation/evidence/fixtures/LS-S052.json", "implementation/evidence/LS-S052.test.mjs"]) assert.equal(metadataOnlyDelta([path]), false);
  assert.equal(metadataOnlyDelta([]), false);
});

// Each integration case owns two independent, disposable Git roots. No user's
// repository, credentials, private specification content or providers are used.
const runGit = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
};
const save = (root, label) => { runGit(root, "add", "--all"); runGit(root, "commit", "-m", label); return runGit(root, "rev-parse", "HEAD"); };
const init = (root, repository) => {
  mkdirSync(root, { recursive: true }); runGit(root, "init", "-b", "main");
  runGit(root, "config", "user.name", "Synthetic qualification test");
  runGit(root, "config", "user.email", "qualification@example.invalid");
  runGit(root, "config", "commit.gpgsign", "false");
  runGit(root, "remote", "add", "origin", "https://github.com/" + repository + ".git");
};
const artifact = (root, path) => ({ path, sha256: sha256(readFileSync(join(root, path))) });
function repositories(t) {
  const root = mkdtempSync(join(tmpdir(), "lifestream-qualification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root, "ggilchrest/lifestream");
  for (const path of ["README.md", "AGENTS.md", "BOOTSTRAP.md", "LICENSE", ".github/workflows/workspace.yml", "scripts/workspace.test.mjs"]) put(root, path, "synthetic\n");
  put(root, ".gitignore", "/.private/\n"); put(root, "source.mjs", "export const value = 1;\n");
  const cp = { ...checkpoint(), branch: "main", currentRevision: "d".repeat(40), allowedFiles: ["implementation/checkpoint.json"] };
  put(root, "implementation/checkpoint.json", cp);
  const publicSource = save(root, "synthetic public source");
  cp.baseRevision = publicSource; cp.currentRevision = publicSource;
  put(root, "implementation/checkpoint.json", cp); save(root, "checkpoint metadata");
  const privateRoot = join(root, ".private"); init(privateRoot, "ggilchrest/lifestream-specs");
  put(privateRoot, "contracts/structural.json", { type: "object" });
  put(privateRoot, "acceptance/core.md", "Synthetic criterion LS-TEST-091 and LS-TEST-052.\n");
  put(privateRoot, "scripts/validate-handoff.mjs", "export const loadSlice = () => []; export const validatePacket = () => [];\n");
  put(privateRoot, "roadmap/packets/LS-S001.json", { ...packet(), allowedFiles: cp.allowedFiles });
  const privateSource = save(privateRoot, "synthetic private specification");
  return { root, privateRoot, publicSource, privateSource, cp };
}
function qualify(fixture, id = "LS-S052", options = {}) {
  const { root, privateRoot, publicSource, privateSource } = fixture;
  const isPrivate = id === "LS-S072";
  const owner = isPrivate ? privateRoot : root;
  const revision = isPrivate ? privateSource : publicSource;
  const claimClass = isPrivate ? "structural-contract" : "development-runtime";
  const caseId = isPrivate ? "LS-TEST-091" : "LS-TEST-052";
  const legacyPath = "implementation/evidence/" + id + ".json";
  const legacy = { slice: id, status: "verified", revision, claimClass: isPrivate ? claimClass : "fixture", checks: [{ command: "synthetic original", result: "pass", evidence: "Synthetic historical check." }] };
  if (options.legacyObserved) legacy.checks.push({ command: "synthetic observation", result: "observed", evidence: "Preserved narrower observation." });
  put(owner, legacyPath, legacy); save(owner, "preserved synthetic original");
  const receipt = {
    slice: id, status: "verified", revision, claimClass, caseIds: [caseId],
    checks: [{ command: "synthetic qualification", result: "pass", evidence: "Synthetic bounded claim." }],
    qualification: {
      kind: "prospective-qualification", sourceRepository: isPrivate ? "ggilchrest/lifestream-specs" : "ggilchrest/lifestream", testedRevision: revision,
      supersedes: legacyPath, supersedesSha256: sha256(readFileSync(join(owner, legacyPath))),
      sourceArtifacts: [artifact(owner, isPrivate ? "contracts/structural.json" : "source.mjs")],
      effectiveSpecification: { sourceRepository: "ggilchrest/lifestream-specs", revision: privateSource, artifacts: [artifact(privateRoot, "acceptance/core.md")] },
      ...(isPrivate ? { openObligations: [{ caseId, claimClass: "runtime-security", owningSlices: ["LS-S075", "LS-S081"] }] } : {})
    }
  };
  if (options.change) options.change(receipt);
  const path = "implementation/evidence/" + id + "-qualification-run1.json";
  put(root, path, receipt);
  const selector = { kind: "current-qualification", slice: id, path, sha256: sha256(readFileSync(join(root, path))) };
  put(root, "implementation/evidence/" + id + "-current-qualification.json", selector);
  if (!options.uncommitted) save(root, "select synthetic qualification");
  return { receipt, path, selector, legacyPath, requirement: { sourceRepository: receipt.qualification.sourceRepository, claimClass, caseIds: [caseId], qualificationRequired: true, specificationArtifacts: ["acceptance/core.md"] } };
}
function requirePrerequisite(fixture, id, requirement) {
  const { root, privateRoot, cp } = fixture;
  cp.completedSlices = [id]; cp.currentRevision = runGit(root, "rev-parse", "HEAD");
  put(root, "implementation/checkpoint.json", cp); save(root, "checkpoint prerequisite index");
  put(privateRoot, "roadmap/packets/LS-S001.json", { ...packet(), prerequisites: [id], prerequisiteQualifications: { [id]: requirement }, allowedFiles: cp.allowedFiles });
  save(privateRoot, "consuming packet scope");
}

test("temporary repositories: full preflight admits a legitimate checkpoint-only advance", async (t) => {
  const fixture = repositories(t);
  assert.equal(metadataOnlyRevisionAdvance(fixture.root, fixture.publicSource), true);
  assert.deepEqual(await preflight(fixture.root, "LS-S001"), []);
});
test("temporary repositories: a non-ancestor with identical source cannot use metadata semantics", async (t) => {
  const fixture = repositories(t);
  const sibling = runGit(fixture.root, "commit-tree", runGit(fixture.root, "rev-parse", "HEAD^{tree}"), "-m", "unrelated identical source");
  fixture.cp.currentRevision = sibling;
  put(fixture.root, "implementation/checkpoint.json", fixture.cp); save(fixture.root, "name unrelated revision");
  assert.equal(metadataOnlyRevisionAdvance(fixture.root, sibling), false);
  assert.match((await preflight(fixture.root, "LS-S001")).join("\n"), /revision does not match/);
});
test("temporary repositories: source-changing advances require a new tested checkpoint", async (t) => {
  const fixture = repositories(t);
  put(fixture.root, "source.mjs", "export const value = 2;\n"); save(fixture.root, "source change");
  assert.equal(metadataOnlyRevisionAdvance(fixture.root, fixture.publicSource), false);
  assert.match((await preflight(fixture.root, "LS-S001")).join("\n"), /revision does not match/);
});
test("temporary repositories: selected current proof supersedes an insufficient fixture receipt", async (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S052", { legacyObserved: true });
  requirePrerequisite(fixture, "LS-S052", result.requirement);
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
  assert.deepEqual(await preflight(fixture.root, "LS-S001"), []);
  assert.equal(JSON.parse(readFileSync(join(fixture.root, result.legacyPath))).checks[1].result, "observed");
});
test("temporary repositories: private S072 structural qualification cannot close runtime/security", async (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S072");
  requirePrerequisite(fixture, "LS-S072", result.requirement);
  assert.deepEqual(await preflight(fixture.root, "LS-S001"), []);
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", { ...result.requirement, claimClass: "runtime-security" }), []);
  assert.throws(() => runGit(fixture.root, "cat-file", "-e", fixture.privateSource + "^{commit}"));
});
for (const [name, change] of [
  ["mismatched tested revision", (receipt) => { receipt.qualification.testedRevision = "a".repeat(40); }],
  ["missing tested commit", (receipt) => { receipt.revision = "a".repeat(40); receipt.qualification.testedRevision = receipt.revision; }],
  ["wrong owner identity", (receipt) => { receipt.qualification.sourceRepository = "elsewhere/lifestream"; }],
  ["insufficient claim", (receipt) => { receipt.claimClass = "fixture"; }],
  ["missing effective specification", (receipt) => { delete receipt.qualification.effectiveSpecification; }],
  ["failed current check", (receipt) => { receipt.checks[0].result = "fail"; }]
]) test("temporary repositories: " + name + " fails without legacy fallback", (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S052", { change });
  const requirement = { ...result.requirement, claimClass: "development-runtime" };
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", requirement), []);
});
for (const [name, change] of [
  ["wrong private origin", (f) => runGit(f.privateRoot, "remote", "set-url", "origin", "https://github.com/other/specs.git")],
  ["missing private Git root", (f) => rmSync(join(f.privateRoot, ".git"), { recursive: true, force: true })],
  ["changed effective specification", (f) => { put(f.privateRoot, "acceptance/core.md", "changed criterion\n"); save(f.privateRoot, "new effective requirement"); }],
  ["dirty effective specification", (f) => put(f.privateRoot, "acceptance/core.md", "dirty criterion\n")],
  ["changed legacy bytes", (f, r) => { put(f.privateRoot, r.legacyPath, JSON.stringify({ ...JSON.parse(readFileSync(join(f.privateRoot, r.legacyPath))), note: "altered" })); save(f.privateRoot, "altered legacy receipt"); }],
  ["uncommitted legacy receipt", (f, r) => put(f.privateRoot, r.legacyPath, readFileSync(join(f.privateRoot, r.legacyPath), "utf8") + "\n")],
  ["changed source input", (f) => { put(f.privateRoot, "contracts/structural.json", { type: "string" }); save(f.privateRoot, "changed contract input"); }]
]) test("temporary repositories: S072 rejects " + name, (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S072");
  change(fixture, result);
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
});
test("temporary repositories: S072 cannot omit its open consuming-owner obligations", (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S072", { change: (r) => { delete r.qualification.openObligations; } });
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
});
test("temporary repositories: S072 reruns append a private source receipt and preserve the original", (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S072");
  const originalBytes = readFileSync(join(fixture.privateRoot, result.legacyPath));
  put(fixture.privateRoot, "contracts/structural.json", { type: "object", additionalProperties: false });
  const nextSource = save(fixture.privateRoot, "later structural source");
  const sourceReceiptPath = "implementation/evidence/LS-S072-structural-run2.json";
  put(fixture.privateRoot, sourceReceiptPath, { ...JSON.parse(originalBytes), revision: nextSource }); save(fixture.privateRoot, "append private structural rerun receipt");
  const receipt = structuredClone(result.receipt);
  receipt.revision = nextSource; receipt.qualification.testedRevision = nextSource;
  receipt.qualification.sourceArtifacts = [artifact(fixture.privateRoot, "contracts/structural.json")];
  receipt.qualification.sourceReceipt = artifact(fixture.privateRoot, sourceReceiptPath);
  const nextPath = "implementation/evidence/LS-S072-qualification-run2.json";
  put(fixture.root, nextPath, receipt);
  put(fixture.root, "implementation/evidence/LS-S072-current-qualification.json", { kind: "current-qualification", slice: "LS-S072", path: nextPath, sha256: sha256(readFileSync(join(fixture.root, nextPath))) }); save(fixture.root, "select later private structural qualification");
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
  assert.equal(readFileSync(join(fixture.privateRoot, result.legacyPath)).equals(originalBytes), true);
  put(fixture.privateRoot, sourceReceiptPath, readFileSync(join(fixture.privateRoot, sourceReceiptPath), "utf8") + "\n");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
  save(fixture.privateRoot, "altered per-run receipt");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
});
test("temporary repositories: S072 rejects a missing private per-run source receipt", (t) => {
  const fixture = repositories(t);
  const result = qualify(fixture, "LS-S072", { change: (r) => { r.qualification.sourceReceipt = { path: "implementation/evidence/LS-S072-structural-missing.json", sha256: "0".repeat(64) }; } });
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S072", result.requirement), []);
});
test("temporary repositories: selected proof must cover the consuming packet's effective specification", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
  assert.match(prerequisiteErrors(fixture.root, "LS-S052", { ...result.requirement, specificationArtifacts: ["contracts/structural.json", "acceptance/core.md"] }).join("\n"), /does not cover required specification artifacts/);
});
test("temporary repositories: only the explicit S080 paired-review technical cases may precede Human review", (t) => {
  const fixture = repositories(t);
  const result = qualify(fixture, "LS-S080", { change: (r) => { r.status = "implementationCompleteVerificationPending"; r.claimClass = "technical-core"; r.caseIds = ["LS-TEST-102", "LS-TEST-104"]; } });
  const required = { ...result.requirement, claimClass: "technical-core", caseIds: ["LS-TEST-102", "LS-TEST-104"] };
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S080", required), []);
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S080"), []);
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S080", { ...required, caseIds: ["LS-TEST-102"] }), []);
  const other = qualify(fixture, "LS-S079", { change: (r) => { r.status = "implementationCompleteVerificationPending"; } });
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S079", other.requirement), []);
});
test("temporary repositories: modified committed successor and mismatched selector digest fail closed", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  put(fixture.root, result.path, readFileSync(join(fixture.root, result.path), "utf8") + "\n");
  assert.match(prerequisiteErrors(fixture.root, "LS-S052", result.requirement).join("\n"), /uncommitted or modified/);
  runGit(fixture.root, "restore", "--", result.path);
  put(fixture.root, "implementation/evidence/LS-S052-current-qualification.json", { ...result.selector, sha256: "0".repeat(64) }); save(fixture.root, "invalid selection digest");
  assert.match(prerequisiteErrors(fixture.root, "LS-S052", result.requirement).join("\n"), /selected qualification digest mismatch/);
});
test("temporary repositories: uncommitted successor and selection fail closed", (t) => {
  const fixture = repositories(t); const result = qualify(fixture, "LS-S052", { uncommitted: true });
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
});
test("temporary repositories: a revoked selector cannot fall back to historical proof", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  put(fixture.root, "implementation/evidence/LS-S052-current-qualification.json", { kind: "revoked", slice: "LS-S052" }); save(fixture.root, "revoke selection");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
});
test("temporary repositories: required current proof cannot be replaced by an old fixture", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  rmSync(join(fixture.root, result.path)); rmSync(join(fixture.root, "implementation/evidence/LS-S052-current-qualification.json")); save(fixture.root, "remove current proof");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
});
test("temporary repositories: deleting a selected pointer cannot resurrect an older qualification", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  put(fixture.root, "implementation/evidence/LS-S052-qualification.json", result.receipt); save(fixture.root, "preserve compatible older qualification");
  rmSync(join(fixture.root, "implementation/evidence/LS-S052-current-qualification.json")); save(fixture.root, "remove selected pointer");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
});
test("temporary repositories: successor mutation requires a new append-only filename", (t) => {
  const fixture = repositories(t); const result = qualify(fixture);
  result.receipt.checks[0].evidence = "A different rerun.";
  put(fixture.root, result.path, result.receipt);
  result.selector.sha256 = sha256(readFileSync(join(fixture.root, result.path)));
  put(fixture.root, "implementation/evidence/LS-S052-current-qualification.json", result.selector); save(fixture.root, "overwrite old successor");
  assert.notDeepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
  const nextPath = "implementation/evidence/LS-S052-qualification-run2.json";
  put(fixture.root, nextPath, result.receipt);
  put(fixture.root, "implementation/evidence/LS-S052-current-qualification.json", { ...result.selector, path: nextPath }); save(fixture.root, "append new qualification");
  assert.deepEqual(prerequisiteErrors(fixture.root, "LS-S052", result.requirement), []);
});
test("prospective receipt qualification binds to the preserved legacy bytes", () => {
  const legacy = Buffer.from('{"slice":"LS-S052"}');
  const good = { kind: "prospective-qualification", supersedes: "implementation/evidence/LS-S052.json", supersedesSha256: sha256(legacy), sourceRepository: "ggilchrest/lifestream", testedRevision: "a".repeat(40) };
  assert.equal(validQualification(good, "LS-S052", legacy), true);
  assert.equal(validQualification({ ...good, supersedesSha256: "0".repeat(64) }, "LS-S052", legacy), false);
  assert.equal(validQualification({ ...good, sourceRepository: "ggilchrest/lifestream-specs" }, "LS-S052", legacy), false);
});
