import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const utc = (value) => nonempty(value) && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
// Only the checkpoint itself can advance after its named revision. A receipt is
// committed after tested code, then the checkpoint names that evidence commit;
// qualification.testedRevision still names the separately validated source.
// No evidence-directory file receives an effective-input exemption.
export const metadataOnlyPath = (path) => path === "implementation/checkpoint.json";
export const metadataOnlyDelta = (paths) => paths.length > 0 && paths.every(metadataOnlyPath);
const receiptFile = (id) => "implementation/evidence/" + id + ".json";
const successorFile = (id) => "implementation/evidence/" + id + "-qualification.json";
const selectorFile = (id) => "implementation/evidence/" + id + "-current-qualification.json";
const validReceipt = (receipt, id) => receipt?.slice === id && receipt.status === "verified" && commit(receipt.revision) && Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.every((check) => check?.result === "pass" && nonempty(check.command) && nonempty(check.evidence));
export const validQualification = (qualification, id, legacyBytes) => qualification?.kind === "prospective-qualification" && qualification.supersedes === receiptFile(id) && qualification.supersedesSha256 === sha256(legacyBytes) && qualification.sourceRepository === (id === "LS-S072" ? "ggilchrest/lifestream-specs" : "ggilchrest/lifestream") && commit(qualification.testedRevision);
export function receiptCandidates(root, id) {
  // Explicit pointer first, otherwise the fixed successor seam. Never fall back
  // from an invalid selected successor to a narrower historical receipt.
  const known = (path) => {
    if (existsSync(join(root, path))) return true;
    try { return Boolean(git(root, "log", "-1", "--format=%H", "--", path)); }
    catch { return false; }
  };
  if (known(selectorFile(id))) return [{ path: selectorFile(id), successor: true, selector: true }];
  if (known(successorFile(id))) return [{ path: successorFile(id), successor: true }];
  return [{ path: receiptFile(id), successor: false }];
}
export const safePath = (path) => typeof path === "string" && /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.startsWith("/") && !path.endsWith("/") && !path.split("/").some((part) => ["", ".", "..", ".git", ".private"].includes(part));
const strings = (value) => Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const repositoryMatches = (remote, repository) => ["https://github.com/" + repository, "git@github.com:" + repository, "ssh://git@github.com/" + repository].includes(remote.replace(/\.git$/, ""));

const gitBytes = (root, revision, path) => execFileSync("git", ["-C", root, "show", revision + ":" + path], { stdio: ["ignore", "pipe", "pipe"] });
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const caseIds = (value) => strings(value) && value.length > 0 && value.every((id) => /^LS-(?:TEST-|AUTH-T)[0-9]{3}$/.test(id));
class QualificationError extends Error {}
const assert = (condition, message) => { if (!condition) throw new QualificationError(message); };
function ownerRoot(root, repository) {
  assert(["ggilchrest/lifestream", "ggilchrest/lifestream-specs"].includes(repository), "unsupported owner repository");
  const owner = repository === "ggilchrest/lifestream" ? root : join(root, ".private");
  assert(realpathSync(git(owner, "rev-parse", "--show-toplevel")) === realpathSync(owner), "missing independent owner repository");
  assert(repositoryMatches(git(owner, "remote", "get-url", "origin"), repository), "wrong owner repository");
  return owner;
}
function ancestor(root, revision) {
  assert(commit(revision), "invalid tested revision");
  git(root, "cat-file", "-e", revision + "^{commit}");
  git(root, "merge-base", "--is-ancestor", revision, "HEAD");
}
function committedBytes(root, path) {
  assert(safePath(path), "unsafe evidence path");
  const fullPath = join(root, path);
  assert(realpathSync(fullPath).startsWith(realpathSync(root) + "/"), "evidence escapes owner repository");
  const bytes = readFileSync(fullPath);
  assert(bytes.equals(gitBytes(root, "HEAD", path)) && !git(root, "status", "--porcelain", "--", path), "evidence is uncommitted or modified");
  return bytes;
}
function immutableSuccessor(root, path, bytes) {
  for (const revision of git(root, "log", "--format=%H", "--", path).split("\n").filter(Boolean)) {
    assert(gitBytes(root, revision, path).equals(bytes), "qualification successor was overwritten");
  }
}
function verifyArtifacts(root, revision, artifacts) {
  assert(Array.isArray(artifacts) && artifacts.length > 0 && new Set(artifacts.map((item) => item?.path)).size === artifacts.length, "missing or duplicate effective inputs");
  for (const artifact of artifacts) {
    assert(safePath(artifact?.path) && digest(artifact.sha256), "invalid effective input");
    assert(sha256(gitBytes(root, revision, artifact.path)) === artifact.sha256, "tested input digest mismatch");
    assert(sha256(committedBytes(root, artifact.path)) === artifact.sha256, "effective input changed since qualification");
  }
}

export function metadataOnlyRevisionAdvance(root, revision) {
  try {
    ancestor(root, revision);
    const paths = git(root, "diff", "--name-only", revision, "HEAD").split("\n").filter(Boolean);
    return metadataOnlyDelta(paths);
  } catch { return false; }
}

// Requirements come from the current consuming packet, not completedSlices or
// receipt discovery. Public diagnostics deliberately contain no private payload.
export function prerequisiteErrors(root, id, requirement) {
  try {
    const publicRoot = ownerRoot(root, "ggilchrest/lifestream");
    const candidate = receiptCandidates(root, id)[0];
    let bytes = committedBytes(publicRoot, candidate.path);
    let selectedPath = candidate.path;
    if (candidate.selector) {
      const selector = JSON.parse(bytes);
      assert(selector.kind === "current-qualification" && selector.slice === id && safePath(selector.path) && selector.path.startsWith("implementation/evidence/" + id + "-qualification-") && selector.path.endsWith(".json") && digest(selector.sha256), "invalid current qualification selection");
      bytes = committedBytes(publicRoot, selector.path);
      selectedPath = selector.path;
      assert(sha256(bytes) === selector.sha256, "selected qualification digest mismatch");
    }
    if (candidate.successor) immutableSuccessor(publicRoot, selectedPath, bytes);
    const receipt = JSON.parse(bytes);
    if (!candidate.successor) {
      assert(!requirement?.qualificationRequired && !requirement?.claimClass && !requirement?.caseIds && id !== "LS-S072", "current scope requires a qualification");
      assert(validReceipt(receipt, id), "invalid historical receipt");
      ancestor(publicRoot, receipt.revision);
      return [];
    }
    const pairedCases = ["LS-TEST-102", "LS-TEST-104"];
    const pairedTechnicalClaim = id === "LS-S080" && receipt?.status === "implementationCompleteVerificationPending" && receipt.claimClass === "technical-core" && requirement?.qualificationRequired === true && requirement.claimClass === "technical-core" && Array.isArray(receipt.caseIds) && Array.isArray(requirement.caseIds) && same(receipt.caseIds, pairedCases) && same(requirement.caseIds, pairedCases);
    assert(receipt?.slice === id && (receipt.status === "verified" || pairedTechnicalClaim) && commit(receipt.revision) && Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.every((check) => check?.result === "pass" && nonempty(check.command) && nonempty(check.evidence)), "invalid current qualification receipt");
    assert(nonempty(receipt.claimClass) && caseIds(receipt.caseIds), "qualification lacks claim/case scope");
    const qualification = receipt.qualification;
    const owner = ownerRoot(root, qualification?.sourceRepository);
    const legacyBytes = committedBytes(owner, receiptFile(id));
    assert(validQualification(qualification, id, legacyBytes), "invalid qualification or changed legacy bytes");
    assert(qualification.testedRevision === receipt.revision, "mismatched tested revision");
    ancestor(owner, receipt.revision);
    verifyArtifacts(owner, receipt.revision, qualification.sourceArtifacts);
    const specification = qualification.effectiveSpecification;
    assert(specification?.sourceRepository === "ggilchrest/lifestream-specs", "missing effective specification owner");
    const specificationRoot = ownerRoot(root, specification.sourceRepository);
    ancestor(specificationRoot, specification.revision);
    verifyArtifacts(specificationRoot, specification.revision, specification.artifacts);
    if (id === "LS-S072") {
      let structuralBytes = legacyBytes;
      if (qualification.sourceReceipt) {
        const reference = qualification.sourceReceipt;
        assert(safePath(reference.path) && /^implementation\/evidence\/LS-S072-[A-Za-z0-9-]+\.json$/.test(reference.path) && digest(reference.sha256), "invalid private structural receipt reference");
        structuralBytes = committedBytes(owner, reference.path);
        assert(sha256(structuralBytes) === reference.sha256, "private structural receipt digest mismatch");
        immutableSuccessor(owner, reference.path, structuralBytes);
      }
      const structuralReceipt = JSON.parse(structuralBytes);
      assert(validReceipt(structuralReceipt, id) && structuralReceipt.revision === receipt.revision && structuralReceipt.claimClass === "structural-contract", "invalid private structural receipt");
      assert(receipt.claimClass === "structural-contract" && receipt.caseIds.includes("LS-TEST-091"), "S072 qualification must remain structural");
      assert(Array.isArray(qualification.openObligations) && qualification.openObligations.some((item) => item.caseId === "LS-TEST-091" && item.claimClass === "runtime-security" && strings(item.owningSlices) && item.owningSlices.includes("LS-S081") && item.owningSlices.some((slice) => slice !== "LS-S081" && /^LS-S[0-9]{3}$/.test(slice))), "S072 runtime/security obligations must remain assigned and open");
    }
    if (requirement) {
      assert(!requirement.sourceRepository || requirement.sourceRepository === qualification.sourceRepository, "qualification owner does not match dependency");
      assert(!requirement.claimClass || requirement.claimClass === receipt.claimClass, "qualification claim does not meet dependency");
      assert(!requirement.caseIds || caseIds(requirement.caseIds) && requirement.caseIds.every((id) => receipt.caseIds.includes(id)), "qualification cases do not meet dependency");
      assert(!requirement.specificationArtifacts || strings(requirement.specificationArtifacts) && requirement.specificationArtifacts.length > 0 && requirement.specificationArtifacts.every((path) => safePath(path) && specification.artifacts.some((artifact) => artifact.path === path)), "qualification does not cover required specification artifacts");
    }
    return [];
  } catch (error) {
    // Git/parser errors can contain private paths or prose. Report only the
    // public slice identity; inspect the declared owner locally for diagnosis.
    const reason = error instanceof QualificationError ? " (" + error.message + ")" : " (owner repository, commit or evidence unavailable)";
    return ["Missing/invalid current prerequisite qualification: " + id + reason];
  }
}

// Public/offline shape checks; local preflight also applies the canonical private JSON Schema.
export function validateCheckpoint(checkpoint) {
  const errors = [];
  const required = ["schemaVersion", "repository", "branch", "baseRevision", "currentRevision", "activeSlice", "sliceStatus", "completedSlices", "allowedFiles", "changedFiles", "validation", "decisions", "blockers", "nextAction", "updatedAt", "updatedBy"];
  if (!checkpoint || required.some((key) => !Object.hasOwn(checkpoint, key)) || Object.keys(checkpoint).some((key) => ![...required, "notes"].includes(key))) return ["checkpoint: invalid fields"];
  if (checkpoint.schemaVersion !== "1.0.0" || checkpoint.repository !== "ggilchrest/lifestream" || !commit(checkpoint.baseRevision) || !(checkpoint.currentRevision === "WORKTREE" || commit(checkpoint.currentRevision))) errors.push("checkpoint: invalid repository/revision");
  if (!nonempty(checkpoint.branch) || !nonempty(checkpoint.nextAction) || !nonempty(checkpoint.updatedBy) || !utc(checkpoint.updatedAt)) errors.push("checkpoint: branch, next action, identity and UTC time required");
  if (!["notStarted", "inProgress", "blocked", "implemented", "verified"].includes(checkpoint.sliceStatus)) errors.push("checkpoint: unknown slice status");
  if (checkpoint.activeSlice !== null && !/^LS-S[0-9]{3}$/.test(checkpoint.activeSlice)) errors.push("checkpoint: invalid active slice");
  for (const name of ["completedSlices", "allowedFiles", "changedFiles", "decisions", "blockers"]) if (!strings(checkpoint[name])) errors.push("checkpoint: invalid " + name);
  for (const name of ["allowedFiles", "changedFiles"]) if (Array.isArray(checkpoint[name]) && checkpoint[name].some((path) => !safePath(path))) errors.push("checkpoint: unsafe " + name);
  if (Array.isArray(checkpoint.allowedFiles) && Array.isArray(checkpoint.changedFiles) && checkpoint.changedFiles.some((path) => !checkpoint.allowedFiles.includes(path))) errors.push("checkpoint: changed file outside exact writable scope");
  if (Array.isArray(checkpoint.completedSlices) && checkpoint.completedSlices.some((id) => !/^LS-S[0-9]{3}$/.test(id))) errors.push("checkpoint: invalid completed slice");
  if (!Array.isArray(checkpoint.validation) || checkpoint.validation.some((check) => !check || !nonempty(check.command) || !["pass", "fail", "notRun", "blocked"].includes(check.result) || (["pass", "fail"].includes(check.result) && !nonempty(check.evidence)))) errors.push("checkpoint: validation results need commands and executed evidence");
  if (checkpoint.activeSlice === null && ["inProgress", "implemented", "verified"].includes(checkpoint.sliceStatus)) errors.push("checkpoint: progress claim without active slice");
  if (checkpoint.sliceStatus === "blocked" && !checkpoint.blockers?.length) errors.push("checkpoint: blocked without a reason");
  if (checkpoint.sliceStatus === "verified" && (checkpoint.blockers?.length || !checkpoint.validation?.length || checkpoint.validation.some((check) => check.result !== "pass"))) errors.push("checkpoint: verified with missing/failed evidence or blockers");
  return errors;
}

export function preflightErrors({ checkpoint, slice, packet, publicBranch, publicRevision, publicChanges = [], metadataOnlyRevisionAdvance = false }) {
  const errors = [...validateCheckpoint(checkpoint)];
  if (errors.length) return errors;
  if (checkpoint.activeSlice !== slice || !["notStarted", "inProgress"].includes(checkpoint.sliceStatus) || checkpoint.blockers.length) errors.push("Checkpoint does not select this slice as current unblocked work.");
  if (checkpoint.branch !== publicBranch) errors.push("Public branch does not match the checkpoint.");
  if (checkpoint.currentRevision !== "WORKTREE" && checkpoint.currentRevision !== publicRevision && !metadataOnlyRevisionAdvance) errors.push("Public revision does not match the checkpoint.");
  if (checkpoint.currentRevision === "WORKTREE" && checkpoint.baseRevision !== publicRevision) errors.push("WORKTREE checkpoint base is not the current public HEAD.");
  if (!same(checkpoint.changedFiles, publicChanges)) errors.push("Actual public changes differ from checkpoint.changedFiles.");
  if (!packet || packet.slice !== slice) errors.push("Missing packet scope aid for the requested slice.");
  else {
    if (!same(checkpoint.allowedFiles, packet.allowedFiles ?? [])) errors.push("Checkpoint writable files differ from the prepared packet.");
    if ((packet.prerequisites ?? []).some((id) => !checkpoint.completedSlices.includes(id))) errors.push("A prerequisite is not recorded as verified.");
  }
  return errors;
}

export function checkWorkspace(root) {
  const errors = [];
  for (const path of ["README.md", "AGENTS.md", "BOOTSTRAP.md", "LICENSE", ".gitignore", "implementation/checkpoint.json", ".github/workflows/workspace.yml", "scripts/workspace.test.mjs"]) if (!existsSync(join(root, path))) errors.push("Missing " + path);
  if (errors.length) return errors;
  errors.push(...validateCheckpoint(readJSON(join(root, "implementation/checkpoint.json"))));
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  if (!ignore.split(/\r?\n/).includes("/.private/")) errors.push("Missing durable root private-repository ignore.");
  if (git(root, "ls-files", "--", ".private")) errors.push("Private repository content/gitlink is tracked by the public index.");
  return errors;
}

export async function preflight(root, slice) {
  if (!/^LS-S[0-9]{3}$/.test(slice ?? "")) return ["An exact LS-SNNN slice ID is required."];
  const errors = checkWorkspace(root);
  if (errors.length) return errors;
  if (!repositoryMatches(git(root, "remote", "get-url", "origin"), "ggilchrest/lifestream")) return ["Unexpected public repository origin."];
  const checkpoint = readJSON(join(root, "implementation/checkpoint.json"));
  const privateRoot = join(root, ".private");
  let packet = null;
  const packetPath = join(privateRoot, "roadmap/packets", slice + ".json");
  if (existsSync(packetPath)) packet = readJSON(packetPath);
  const publicChanges = new Set([
    ...git(root, "diff", "--name-only", "HEAD").split("\n"),
    ...git(root, "ls-files", "--others", "--exclude-standard").split("\n")
  ].filter(Boolean));
  const isMetadataAdvance = checkpoint.currentRevision !== "WORKTREE" && metadataOnlyRevisionAdvance(root, checkpoint.currentRevision);
  errors.push(...preflightErrors({ checkpoint, slice, packet, publicBranch: git(root, "rev-parse", "--abbrev-ref", "HEAD"), publicRevision: git(root, "rev-parse", "HEAD"), publicChanges: [...publicChanges], metadataOnlyRevisionAdvance: isMetadataAdvance }));
  if (errors.length) return errors;
  try { ancestor(root, checkpoint.baseRevision); }
  catch { errors.push("Checkpoint base revision is not an available public ancestor."); }
  // The packet qualifies the scope needed now; historical completed membership
  // remains an index and cannot override selected current proof.
  for (const id of packet.prerequisites) {
    errors.push(...prerequisiteErrors(root, id, packet.prerequisiteQualifications?.[id]));
  }
  if (errors.length) return errors;
  const { loadSlice, validatePacket } = await import(pathToFileURL(join(privateRoot, "scripts/validate-handoff.mjs")));
  errors.push(...validatePacket(packet, loadSlice(privateRoot, slice)));
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const [command, slice, ...extra] = process.argv.slice(2);
    if (extra.length || !["check", "preflight"].includes(command) || command === "check" && slice) throw new Error("Usage: node scripts/workspace.mjs check | preflight LS-SNNN");
    const errors = command === "check" ? checkWorkspace(root) : await preflight(root, slice);
    if (errors.length) { console.error(errors.map((error) => "- " + error).join("\n")); process.exitCode = 1; }
    else console.log(command === "check" ? "Workspace checks passed. This validates structure, not runtime behavior or production acceptance." : "Preflight passed for " + slice + "; packet and checkpoint are scope/resume aids, not authorization.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
