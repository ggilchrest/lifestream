import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncTraceExporter, mapTraceEvent, type ExportEvent, type TracePublishReceipt, type TraceSink } from "../src/observability/exporter.ts";

const event = (id: string, sequence = 1): ExportEvent => ({ id, traceId: "trace-1", sequence, environmentId: "env-dev", replayId: null, sourceCorrelationId: `source-${id}`, payload: { answer: "safe", apiKey: "do-not-export", nested: { password: "also-secret" } } });
const receipt = (ids: string[]): TracePublishReceipt => ({ receiptId: `receipt-${ids.join("-") || "empty"}`, acceptedEventIds: ids, rejectedEvents: [], receivedAt: "2026-09-07T00:00:00.000Z" });

test("mapping redacts secrets while preserving source and replay correlation", () => {
  const mapped = mapTraceEvent({ id: "e1", traceId: "t", sequence: 4, payload: { token: "secret", value: 2 } }, { environmentId: "env", replayId: "replay-1", sourceCorrelationId: "source-1" });
  assert.deepEqual(mapped.payload, { token: "[REDACTED]", value: 2 });
  assert.equal(mapped.replayId, "replay-1");
  assert.equal(mapped.sourceCorrelationId, "source-1");
});

test("sink outage defers export and never loses the outbox", async () => {
  const sink: TraceSink = { publish: async () => { throw new Error("offline"); } };
  const exporter = new AsyncTraceExporter(sink); exporter.enqueue(event("e1"));
  assert.equal((await exporter.flush()).status, "deferred"); assert.equal(exporter.pending().length, 1);
});

test("duplicate flush is single-flight and partial rejection retains only rejected events", async () => {
  let calls = 0;
  const sink: TraceSink = { publish: async ({ events }) => { calls++; return { ...receipt([events[0].id]), rejectedEvents: events.slice(1).map((item) => ({ eventId: item.id, reason: "invalid" })) }; } };
  const exporter = new AsyncTraceExporter(sink, 2); exporter.enqueue(event("e1", 1)); exporter.enqueue(event("e2", 2));
  const first = exporter.flush(); const second = exporter.flush(); assert.strictEqual(second, first); await first; assert.equal(calls, 1); assert.deepEqual(exporter.pending().map((item) => item.id), ["e2"]);
  assert.equal(exporter.highWater(), 1);
});

test("enqueue is synchronous so speech callers do not wait for the remote sink", () => {
  let resolve!: (value: TracePublishReceipt) => void;
  const sink: TraceSink = { publish: async () => new Promise((done) => { resolve = done; }) };
  const exporter = new AsyncTraceExporter(sink); exporter.enqueue(event("e1")); const pending = exporter.flush();
  assert.equal(exporter.pending().length, 1); resolve(receipt(["e1"])); return pending;
});
