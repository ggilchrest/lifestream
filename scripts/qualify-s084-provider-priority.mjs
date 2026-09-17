#!/usr/bin/env node
// Read-only selected-provider cancellation/slot-release qualification.
// This harness sends synthetic inference requests, aborts them, and measures
// provider terminal/cleanup time. It never logs or persists the API key.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { loadProfile } from "../apps/server/dist/config/loader.js";
import { SglangInferenceProvider } from "../packages/providers-sglang/dist/provider.js";
import { buildCanonicalPrompt } from "../packages/runtime/dist/inference/prompt.js";
import { loadWindowsKey } from "../../orchestration/scripts/start-conversation.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listening = port => new Promise(resolve => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(500);
  for (const event of ["connect", "error", "timeout"]) socket.once(event, () => { socket.destroy(); resolve(event === "connect"); });
});
const sampleCount = Number(process.env.LIFESTREAM_PRIORITY_SAMPLES ?? 20);
const abortDelayMs = Number(process.env.LIFESTREAM_PRIORITY_ABORT_DELAY_MS ?? 20);
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0 && sampleCount <= 100, "sample count must be 1..100");
assert.ok(Number.isInteger(abortDelayMs) && abortDelayMs >= 0 && abortDelayMs <= 1000, "abort delay must be 0..1000 ms");

const profile = loadProfile("ai5090");
const endpoint = profile.inferenceProfile.endpoint;
assert.equal(profile.providers.inference, "ai5090-development", "selected profile must use ai5090 inference");
assert.equal(new URL(endpoint).hostname, "127.0.0.1", "qualification only accepts the local SSH forward");
assert.ok(await listening(Number(new URL(endpoint).port)), "ai5090 inference forward is not listening");
const key = await loadWindowsKey();
const provider = new SglangInferenceProvider({ endpoint, model: profile.inferenceProfile.servedModelName, apiKey: key });
const profileBytes = await readFile(new URL("../apps/server/src/config/profiles/ai5090.json", import.meta.url));
const rows = [];

for (let trial = 0; trial < sampleCount; trial += 1) {
  const controller = new AbortController();
  const request = buildCanonicalPrompt({
    assistantId: "s084-provider-priority",
    sessionId: "s084-provider-priority",
    interactionId: randomUUID(),
    endpointId: null,
    userInput: "Write a long explanation of a synthetic cache test using many sentences.",
    memory: "[]",
    conversation: "[]",
    capabilities: "No capability use.",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    maximumOutputTokens: 256
  });
  const iterator = provider.generate(request, { signal: controller.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await sleep(abortDelayMs);
  const abortedAt = performance.now();
  controller.abort("priority-qualification");
  let next = await Promise.race([pending, sleep(1_000).then(() => ({ timeout: true }))]);
  if (next.timeout) {
    await iterator.return?.();
    rows.push({ trial, timeout: true });
    continue;
  }
  let terminal = next.value?.error?.code ?? next.value?.kind ?? "none";
  let done = Boolean(next.done);
  while (!done) {
    next = await Promise.race([iterator.next(), sleep(1_000).then(() => ({ timeout: true }))]);
    if (next.timeout) {
      await iterator.return?.();
      rows.push({ trial, timeout: true, terminal });
      done = true;
      break;
    }
    done = Boolean(next.done);
    if (next.value) terminal = next.value.error?.code ?? next.value.kind ?? terminal;
  }
  if (rows.at(-1)?.trial === trial && rows.at(-1)?.timeout) continue;
  rows.push({ trial, elapsedMs: Number((performance.now() - abortedAt).toFixed(3)), terminal });
  await sleep(50);
}

const measured = rows.filter(row => row.elapsedMs !== undefined);
const maxMs = measured.length ? Math.max(...measured.map(row => row.elapsedMs)) : null;
const result = {
  schemaVersion: "1.0.0",
  slice: "LS-S084",
  caseIds: ["LS-TEST-107"],
  status: measured.length === sampleCount && rows.every(row => row.terminal === "cancelled" && row.elapsedMs <= 250) ? "verified" : "failed",
  result: measured.length === sampleCount && rows.every(row => row.terminal === "cancelled" && row.elapsedMs <= 250) ? "pass" : "fail",
  claimClass: "selected-provider-priority-transport",
  collectedAt: new Date().toISOString(),
  sourceRevision: process.env.LIFESTREAM_SOURCE_REVISION ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  selectedProfile: { path: "apps/server/src/config/profiles/ai5090.json", sha256: createHash("sha256").update(profileBytes).digest("hex"), provider: "ai5090" },
  selectedProvider: true,
  limits: { preemptionBoundMs: 10, slotReleaseBoundMs: 250 },
  measurement: { samples: sampleCount, abortDelayMs, maxAbortToTerminalAndCleanupMs: maxMs, allTerminalCancelled: rows.every(row => row.terminal === "cancelled"), withinPreemptionBound: measured.length === sampleCount && measured.every(row => row.elapsedMs <= 10), withinSlotReleaseBound: measured.length === sampleCount && measured.every(row => row.elapsedMs <= 250) },
  checks: [{ command: "node scripts/qualify-s084-provider-priority.mjs", result: measured.length === sampleCount && rows.every(row => row.terminal === "cancelled" && row.elapsedMs <= 250) ? "pass" : "fail", evidence: "Synthetic cancellation against the selected ai5090 inference forward; terminal and iterator cleanup are measured after AbortController cancellation. No credentials or generated text are retained." }],
  rows,
  exclusions: ["No personal data", "No provider configuration or service changes", "No speech, physical output, production or Human acceptance claim"]
};
console.log(JSON.stringify(result, null, 2));
if (result.result !== "pass") process.exitCode = 1;
