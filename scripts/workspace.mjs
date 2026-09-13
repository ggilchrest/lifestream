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
export const metadataOnlyPath = (path) => path === "implementation/checkpoint.json" || path.startsWith("implementation/evidence/");
export const metadataOnlyDelta = (paths) => paths.length > 0 && paths.every(metadataOnlyPath);
const receiptFile = (id) => "implementation/evidence/" + id + ".json";
const successorFile = (id) => "implementation/evidence/" + id + "-qualification.json";
const validReceipt = (receipt, id) => receipt?.slice === id && receipt.status === "verified" && commit(receipt.revision) && Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.every((check) => check?.result === "pass" && nonempty(check.command) && nonempty(check.evidence));
export const validQualification = (qualification, id, legacyBytes) => qualification?.kind === "prospective-qualification" && qualification.supersedes === receiptFile(id) && qualification.supersedesSha256 === sha256(legacyBytes) && qualification.sourceRepository === "ggilchrest/lifestream" && commit(qualification.testedRevision);
export function receiptCandidates(root, id) {
  const candidates = [{ path: receiptFile(id), successor: false }];
  const successor = join(root, successorFile(id));
  if (existsSync(successor)) candidates.push({ path: successorFile(id), successor: true });
  return candidates;
}
export const safePath = (path) => typeof path === "string" && /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.startsWith("/") && !path.endsWith("/") && !path.split("/").some((part) => ["", ".", "..", ".git", ".private"].includes(part));
const strings = (value) => Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const repositoryMatches = (remote, repository) => ["https://github.com/" + repository, "git@github.com:" + repository, "ssh://git@github.com/" + repository].includes(remote.replace(/\.git$/, ""));

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
  let metadataOnlyRevisionAdvance = false;
  if (checkpoint.currentRevision !== "WORKTREE" && checkpoint.currentRevision !== git(root, "rev-parse", "HEAD")) {
    try {
      const delta = git(root, "diff", "--name-only", checkpoint.currentRevision, "HEAD").split("\n").filter(Boolean);
      metadataOnlyRevisionAdvance = metadataOnlyDelta(delta);
    } catch { metadataOnlyRevisionAdvance = false; }
  }
  errors.push(...preflightErrors({ checkpoint, slice, packet, publicBranch: git(root, "rev-parse", "--abbrev-ref", "HEAD"), publicRevision: git(root, "rev-parse", "HEAD"), publicChanges: [...publicChanges], metadataOnlyRevisionAdvance }));
  if (errors.length) return errors;
  try { git(root, "cat-file", "-e", checkpoint.baseRevision + "^{commit}"); }
  catch { errors.push("Checkpoint base revision is not available in the public repository."); }
  // Verified receipts demonstrate dependency checks at a revision; their shape is not correctness proof.
  for (const id of packet.prerequisites) {
    let accepted = false;
    for (const candidate of receiptCandidates(root, id)) {
      try {
        const fullPath = join(root, candidate.path);
        const receipt = readJSON(fullPath);
        if (!validReceipt(receipt, id)) throw new Error("invalid receipt");
        if (candidate.successor) {
          const qualification = receipt.qualification;
          const legacyPath = join(root, receiptFile(id));
          const legacyBytes = readFileSync(legacyPath);
          if (!validQualification(qualification, id, legacyBytes)) throw new Error("invalid qualification");
        }
        git(root, "cat-file", "-e", receipt.revision + "^{commit}");
        git(root, "merge-base", "--is-ancestor", receipt.revision, "HEAD");
        if (git(root, "show", "HEAD:" + candidate.path) !== readFileSync(fullPath, "utf8").trim()) throw new Error("receipt is not committed at HEAD");
        if (git(root, "status", "--porcelain", "--", candidate.path)) throw new Error("uncommitted receipt");
        accepted = true; break;
      } catch { /* try the next deterministic candidate */ }
    }
    if (!accepted) errors.push("Missing/invalid immutable prerequisite receipt: " + id);
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
    else console.log(command === "check" ? "Workspace checks passed. This validates structure, not runtime behavior or production acceptance." : "Preflight passed for " + slice + "; packet and checkpoint are scope/resume aids, not authorization.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
