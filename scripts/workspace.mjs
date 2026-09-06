import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const utc = (value) => nonempty(value) && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const exactKeys = (object, names) => object && typeof object === "object" && !Array.isArray(object) && same(Object.keys(object), names);
export const safePath = (path) => typeof path === "string" && /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.startsWith("/") && !path.endsWith("/") && !path.split("/").some((part) => ["", ".", "..", ".git", ".private"].includes(part));
const strings = (value) => Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const repositoryMatches = (remote, repository) => ["https://github.com/" + repository, "git@github.com:" + repository, "ssh://git@github.com/" + repository].includes(remote.replace(/\.git$/, ""));

export function validateLock(lock) {
  const errors = [];
  if (!exactKeys(lock, ["schemaVersion", "repository", "checkoutPath", "status", "baseRevision", "revision", "contractManifestSha256", "review"])) return ["spec-lock: invalid fields"];
  if (lock.schemaVersion !== "1.0.0" || lock.repository !== "ggilchrest/lifestream-specs" || lock.checkoutPath !== ".private" || !commit(lock.baseRevision)) errors.push("spec-lock: invalid identity/base revision");
  if (lock.status === "awaitingPublication") {
    if (lock.revision !== null || lock.contractManifestSha256 !== null || lock.review !== null) errors.push("spec-lock: pending baseline must not masquerade as a pin");
  } else if (lock.status === "pinned") {
    if (!commit(lock.revision) || !/^[a-f0-9]{64}$/.test(lock.contractManifestSha256 ?? "")) errors.push("spec-lock: full immutable revision and manifest digest required");
    if (!exactKeys(lock.review, ["reviewer", "reviewedAt", "evidence"]) || !nonempty(lock.review.reviewer) || !utc(lock.review.reviewedAt) || !nonempty(lock.review.evidence)) errors.push("spec-lock: reviewed baseline evidence required");
  } else errors.push("spec-lock: unknown status");
  return errors;
}

// Public/offline shape checks; local admission also applies the canonical private JSON Schema.
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

export function admissionErrors({ checkpoint, slice, packet, publicBranch, publicRevision, publicChanges = [] }) {
  const errors = [...validateCheckpoint(checkpoint)];
  if (errors.length) return errors;
  if (checkpoint.activeSlice !== slice || !["notStarted", "inProgress"].includes(checkpoint.sliceStatus) || checkpoint.blockers.length) errors.push("Requested slice is not active and unblocked in the implementation checkpoint.");
  if (checkpoint.branch !== publicBranch) errors.push("Public branch does not match the checkpoint.");
  if (checkpoint.currentRevision !== "WORKTREE" && checkpoint.currentRevision !== publicRevision) errors.push("Public revision does not match the checkpoint.");
  if (checkpoint.currentRevision === "WORKTREE" && checkpoint.baseRevision !== publicRevision) errors.push("WORKTREE checkpoint base is not the current public HEAD.");
  if (!same(checkpoint.changedFiles, publicChanges)) errors.push("Actual public changes differ from checkpoint.changedFiles.");
  if (!packet || packet.slice !== slice) errors.push("Missing exact prepared packet for the requested slice.");
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
  errors.push(...admissionErrors({ checkpoint, slice, packet, publicBranch: git(root, "rev-parse", "--abbrev-ref", "HEAD"), publicRevision: git(root, "rev-parse", "HEAD"), publicChanges: [...publicChanges] }));
  if (errors.length) return errors;
  try { git(root, "cat-file", "-e", checkpoint.baseRevision + "^{commit}"); }
  catch { errors.push("Checkpoint base revision is not available in the public repository."); }
  // Verified receipts are a prerequisite gate, not a substitute for inspecting their evidence.
  for (const id of packet.prerequisites) {
    try {
      const receipt = readJSON(join(root, "implementation/evidence", id + ".json"));
      if (receipt.slice !== id || receipt.status !== "verified" || !commit(receipt.revision) || !Array.isArray(receipt.checks) || !receipt.checks.length || receipt.checks.some((check) => check.result !== "pass" || !nonempty(check.command) || !nonempty(check.evidence))) throw new Error("invalid receipt");
      git(root, "cat-file", "-e", receipt.revision + "^{commit}");
      git(root, "merge-base", "--is-ancestor", receipt.revision, "HEAD");
      const receiptPath = "implementation/evidence/" + id + ".json";
      if (git(root, "show", "HEAD:" + receiptPath) !== readFileSync(join(root, receiptPath), "utf8").trim()) throw new Error("receipt is not committed at HEAD");
      if (git(root, "status", "--porcelain", "--", "implementation/evidence/" + id + ".json")) throw new Error("uncommitted receipt");
    } catch { errors.push("Missing/invalid immutable prerequisite receipt: " + id); }
  }
  if (errors.length) return errors;
  const { loadSlice, validatePacket } = await import(new URL("../.private/scripts/validate-handoff.mjs", import.meta.url));
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
    else console.log(command === "check" ? "Workspace handoff checks passed. This does not authorize implementation or validate runtime behavior." : "Preflight passed for " + slice + "; proceed only within the explicitly authorized packet/checkpoint scope.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
