import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPreparedEnrichment } from "../src/understanding/selection.ts";

const input = { enabled: true, boundaryCurrent: () => true, now: () => 100, candidates: Array.from({ length: 12 }, (_, rank) => ({ id: `source-${rank.toString().padStart(2, "0")}`, content: `Attributed detail ${rank}`, rank })) };

test("LS-TEST-134: prepared enrichment enforces default and absolute budgets including formatting", () => {
  const selected = selectPreparedEnrichment(input);
  assert.equal(selected.items.length, 4); assert.ok(selected.tokenUpperBound <= 512);
  assert.equal(selected.tokenUpperBound, Buffer.byteLength(selected.content));
  assert.equal(selected.estimator, "utf8-bytes-upper-bound");
  assert.equal(selectPreparedEnrichment({ ...input, budget: { tokens: 1024, items: 8, deadlineMs: 10 } }).items.length, 8);
  assert.throws(() => selectPreparedEnrichment({ ...input, budget: { tokens: 1025, items: 8, deadlineMs: 10 } }), /budget/);
  assert.throws(() => selectPreparedEnrichment({ ...input, budget: { tokens: 512, items: 9, deadlineMs: 10 } }), /budget/);
  assert.throws(() => selectPreparedEnrichment({ ...input, candidates: Array(100000).fill(input.candidates[0]) }), /bounded prepared/);
  const multibyte = selectPreparedEnrichment({ ...input, candidates: [{ id: "wide", rank: 0, content: "界".repeat(180) }, input.candidates[0]!] });
  assert.deepEqual(multibyte.items.map(item => item.id), ["source-00"]);
});

test("LS-TEST-129/132/134: disabled, expired selection and changed privacy return no optional payload", () => {
  assert.equal(selectPreparedEnrichment({ ...input, enabled: false }).content, "");
  assert.equal(selectPreparedEnrichment({ ...input, boundaryCurrent: () => false }).disposition, "boundaryChanged");
  let checks = 0;
  assert.equal(selectPreparedEnrichment({ ...input, boundaryCurrent: () => ++checks === 1 }).content, "");
  let clock = 100;
  const expired = selectPreparedEnrichment({ ...input, now: () => (clock += 5) });
  assert.equal(expired.disposition, "deadline"); assert.deepEqual(expired.items, []);
  const clocks = [100, 99, 99];
  assert.equal(selectPreparedEnrichment({ ...input, now: () => clocks.shift() ?? 99 }).disposition, "deadline");
});

test("LS-TEST-134: stable selection deduplicates sources and never mutates its input", () => {
  const before = structuredClone(input.candidates);
  const result = selectPreparedEnrichment({ ...input, candidates: [input.candidates[0]!, ...input.candidates].reverse() });
  assert.deepEqual(result.items.map(item => item.id), ["source-00", "source-01", "source-02", "source-03"]);
  assert.deepEqual(input.candidates, before);
  result.items[0]!.content = "changed local copy";
  assert.deepEqual(input.candidates, before);
});

import { UnderstandingWorkCoordinator, type BackgroundWork } from "../src/understanding/coordinator.ts";

test("LS-TEST-135: shared analysis without bounded preemption is denied even when idle", async () => {
  const coordinator = new UnderstandingWorkCoordinator({ now: () => 100, pressureAllowsWork: () => true });
  let admissions = 0;
  const work: BackgroundWork<string> = { key: "job", deadlineAt: 1000, current: () => true, admitOnce: () => { admissions++; return true; }, steps: [async () => "result"], publish: () => true, sharedInference: true };
  assert.equal((await coordinator.run(work)).reason, "providerPriorityUnverified");
  assert.equal((await coordinator.run({ ...work, providerPreemptionBoundMs: 11 })).reason, "providerPriorityUnverified");
  assert.equal(admissions, 0);
  assert.equal((await coordinator.run({ ...work, sharedInference: false })).state, "published");
});

test("LS-TEST-129/133/135: a new foreground turn cancels admitted work and fences late results", async () => {
  const coordinator = new UnderstandingWorkCoordinator({ now: () => 100, pressureAllowsWork: () => true });
  let release: (value: string) => void = () => { throw new Error("step not started"); };
  let signal: AbortSignal | undefined, publishes = 0;
  const work: BackgroundWork<string> = { key: "job", deadlineAt: 1000, current: () => true, admitOnce: () => true, steps: [(value) => { signal = value; return new Promise(resolve => { release = resolve; }); }], publish: () => { publishes++; return true; }, sharedInference: true, providerPreemptionBoundMs: 5 };
  const pending = coordinator.run(work);
  assert.ok(signal);
  const done = coordinator.foregroundStarted(); assert.equal(signal.aborted, true);
  assert.equal((await coordinator.run({ ...work, key: "other" })).reason, "foregroundOrCapacity");
  done(); done(); // release is idempotent and cannot make foreground count negative
  release("late private result");
  assert.equal((await pending).state, "cancelled"); assert.equal(publishes, 0);
});

test("LS-TEST-136: unique admission, revoked dependencies and failed publication never retry", async () => {
  const coordinator = new UnderstandingWorkCoordinator({ now: () => 100, pressureAllowsWork: () => true });
  let admitted = false, steps = 0, current = true, publishes = 0;
  const work: BackgroundWork<string> = { key: "job", deadlineAt: 1000, current: () => current, admitOnce: () => { if (admitted) return false; admitted = true; return true; }, steps: [async () => { steps++; current = false; return "stale"; }], publish: () => { publishes++; return true; }, sharedInference: false };
  assert.equal((await coordinator.run(work)).state, "cancelled"); current = true;
  assert.equal((await coordinator.run(work)).reason, "duplicateOrBudget");
  assert.equal(steps, 1); assert.equal(publishes, 0);
  const conflict = { ...work, key: "fresh", admitOnce: () => true, steps: [async () => "safe"], publish: () => false };
  assert.equal((await coordinator.run(conflict)).reason, "publicationConflict");
});
