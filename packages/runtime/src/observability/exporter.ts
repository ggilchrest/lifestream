import { createHash } from 'node:crypto';
import { traceDataSnapshot, traceIdentifier, traceQueueBounds, validTraceEvent, type TraceAdmission, type TraceEvent, type TraceQueueBounds } from './outbox.ts';

export type ExportEvent = TraceEvent & {
  environmentId: string;
  replayId: string | null;
  sourceCorrelationId: string;
};

export type TracePublishReceipt = {
  receiptId: string;
  acceptedEventIds: string[];
  rejectedEvents: Array<{ eventId: string; reason: string }>;
  receivedAt: string;
};

export interface TraceSink {
  publish(batch: { idempotencyKey: string; events: ExportEvent[] }, signal?: AbortSignal): Promise<TracePublishReceipt>;
}

export type ExportResult =
  | { status: "accepted"; receipt: TracePublishReceipt; highWaterSequence: number }
  | { status: "deferred"; reason: "sink-unavailable" | "redaction-failed" | "invalid-receipt" | "timed-out" | "quarantined" | "closed"; pending: number }
  | { status: "partial"; receipt: TracePublishReceipt; pending: number };

const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|cookie|private[_-]?key|chain[_-]?of[_-]?thought|reasoning)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(child)]));
  }
  return value;
}

export function mapTraceEvent(event: TraceEvent, context: Pick<ExportEvent, "environmentId" | "replayId" | "sourceCorrelationId">): ExportEvent {
  const source = traceDataSnapshot<TraceEvent>(event, 32768), scope = traceDataSnapshot<typeof context>(context, 1024);
  if (!source || !scope || Object.keys(source).sort().join(',') !== 'id,payload,sequence,traceId' || Object.keys(scope).sort().join(',') !== 'environmentId,replayId,sourceCorrelationId' || !validTraceEvent(source) || !traceIdentifier(scope.environmentId) || !traceIdentifier(scope.sourceCorrelationId) || scope.replayId !== null && !traceIdentifier(scope.replayId)) throw Error('Invalid trace data.');
  const mapped = { ...source, ...scope, payload: redact(source.payload) as Record<string, unknown> };
  if (Buffer.byteLength(JSON.stringify(mapped)) > 32768) throw Error('Invalid trace data.');
  return mapped;
}

export type TraceExporterOptions = Partial<TraceQueueBounds> & Readonly<{ maxCompletedIds?: number; deadlineMs?: number }>;

export class AsyncTraceExporter {
  private readonly pendingEvents: ExportEvent[] = [];
  private readonly completed = new Set<string>();
  private highWaterSequence = -1;
  private inFlight: Promise<ExportResult> | null = null;
  private readonly sink: TraceSink;
  private readonly maxBatchSize: number;
  readonly bounds: TraceQueueBounds;
  private readonly maxCompletedIds: number;
  private readonly deadlineMs: number;
  private bytes = 0; private refused = 0; private closed = false; private quarantined = false;
  private controller: AbortController | null = null;

  constructor(sink: TraceSink, maxBatchSize = 500, options: TraceExporterOptions = {}) {
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 500) throw Error('Invalid trace batch bound.');
    this.sink = sink; this.maxBatchSize = maxBatchSize;
    this.bounds = traceQueueBounds({ maxEvents: options.maxEvents ?? 1024, maxBytes: options.maxBytes ?? 1_048_576, maxEventBytes: options.maxEventBytes ?? 32768 });
    this.maxCompletedIds = options.maxCompletedIds ?? 1024; this.deadlineMs = options.deadlineMs ?? 3000;
    if (!Number.isSafeInteger(this.maxCompletedIds) || this.maxCompletedIds < 1 || this.maxCompletedIds > 4096 || !Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 3000) throw Error('Invalid trace delivery bounds.');
  }

  enqueue(input: ExportEvent): TraceAdmission {
    if (this.closed) return 'closed';
    const snapshot = traceDataSnapshot<ExportEvent>(input, this.bounds.maxEventBytes);
    if (!snapshot || Object.keys(snapshot).sort().join(',') !== 'environmentId,id,payload,replayId,sequence,sourceCorrelationId,traceId') return 'invalid';
    let event: ExportEvent;
    try { event = mapTraceEvent({ id: snapshot.id, traceId: snapshot.traceId, sequence: snapshot.sequence, payload: snapshot.payload }, { environmentId: snapshot.environmentId, replayId: snapshot.replayId, sourceCorrelationId: snapshot.sourceCorrelationId }); } catch { return 'invalid'; }
    if (this.completed.has(event.id) || this.pendingEvents.some(candidate => candidate.id === event.id)) return 'duplicate';
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.bounds.maxEventBytes) return 'invalid';
    if (this.pendingEvents.length >= this.bounds.maxEvents || this.bytes + bytes > this.bounds.maxBytes) { this.refused = Math.min(Number.MAX_SAFE_INTEGER, this.refused + 1); return 'overflow'; }
    this.pendingEvents.push(event); this.bytes += bytes;
    this.pendingEvents.sort((a, b) => a.sequence - b.sequence);
    return 'queued';
  }

  pending(): ExportEvent[] { return this.pendingEvents.map((event) => structuredClone(event)); }
  highWater(): number { return this.highWaterSequence; }
  usage() { return Object.freeze({ events: this.pendingEvents.length, bytes: this.bytes, completedIds: this.completed.size, dedupCoverage: 'bounded_recent' as const, refusedEvents: this.refused, closed: this.closed, quarantined: this.quarantined, durable: false as const, complete: false as const }); }

  flush(): Promise<ExportResult> {
    if (this.inFlight) return this.inFlight;
    if (this.closed || this.quarantined) return Promise.resolve({ status: 'deferred', reason: this.closed ? 'closed' : 'quarantined', pending: this.pendingEvents.length });
    const batch = this.pendingEvents.slice(0, this.maxBatchSize);
    if (batch.length === 0) return Promise.resolve({ status: "accepted", receipt: { receiptId: "none", acceptedEventIds: [], rejectedEvents: [], receivedAt: new Date(0).toISOString() }, highWaterSequence: this.highWaterSequence });
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (!first || !last) return Promise.resolve({ status: "deferred", reason: "redaction-failed", pending: this.pendingEvents.length });
    const idempotencyKey = 'trace-batch:sha256:' + createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const controller = new AbortController(); this.controller = controller;
    let expired = false, settled = false, timer: ReturnType<typeof setTimeout>;
    const started = performance.now();
    const current = () => !this.closed && !expired && performance.now() - started < this.deadlineMs;
    // Quarantine an uncooperative timed-out sink until the actual call settles.
    // No retry or replacement call can accumulate abandoned requests.
    let resolvePublish!: (receipt: TracePublishReceipt) => void, rejectPublish!: (error: unknown) => void;
    const source = new Promise<TracePublishReceipt>((resolve, reject) => { resolvePublish = resolve; rejectPublish = reject; });
    const published = source.finally(() => { settled = true; this.quarantined = false; });
    const unavailable = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(Error('retired')), { once: true });
      timer = setTimeout(() => { expired = true; this.quarantined = !settled; controller.abort(); }, this.deadlineMs);
    });
    this.inFlight = Promise.race([published, unavailable]).then((raw) => {
      if (!current()) return { status: 'deferred', reason: this.closed ? 'closed' : 'timed-out', pending: this.pendingEvents.length } as ExportResult;
      const receipt = this.receipt(raw, batch);
      if (!receipt) return { status: 'deferred', reason: 'invalid-receipt', pending: this.pendingEvents.length } as ExportResult;
      if (!current()) return { status: 'deferred', reason: this.closed ? 'closed' : 'timed-out', pending: this.pendingEvents.length } as ExportResult;
      const accepted = new Set(receipt.acceptedEventIds);
      for (const event of batch) if (accepted.has(event.id)) { this.completed.add(event.id); this.remove(event.id); this.highWaterSequence = Math.max(this.highWaterSequence, event.sequence); }
      while (this.completed.size > this.maxCompletedIds) this.completed.delete(this.completed.values().next().value!);
      return accepted.size !== batch.length ? { status: "partial", receipt, pending: this.pendingEvents.length } : { status: "accepted", receipt, highWaterSequence: this.highWaterSequence };
    }).catch(() => ({ status: "deferred", reason: this.closed ? 'closed' : expired ? 'timed-out' : "sink-unavailable", pending: this.pendingEvents.length }))
      .finally(() => { clearTimeout(timer); this.controller = null; this.inFlight = null; }) as Promise<ExportResult>;
    // Install the one-flight fence before entering a synchronous/reentrant sink.
    // Existing sinks still begin during flush; queue admission never calls one.
    const inFlight = this.inFlight;
    try { Promise.resolve(this.sink.publish({ idempotencyKey, events: structuredClone(batch) }, controller.signal)).then(resolvePublish, rejectPublish); } catch (error) { rejectPublish(error); }
    return inFlight;
  }

  private receipt(input: unknown, batch: readonly ExportEvent[]): TracePublishReceipt | null {
    const receipt = traceDataSnapshot<TracePublishReceipt>(input, 262144);
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'acceptedEventIds,receiptId,receivedAt,rejectedEvents' || !traceIdentifier(receipt.receiptId) || typeof receipt.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.receivedAt) || !Number.isFinite(Date.parse(receipt.receivedAt)) || !Array.isArray(receipt.acceptedEventIds) || !Array.isArray(receipt.rejectedEvents) || receipt.acceptedEventIds.length + receipt.rejectedEvents.length > batch.length) return null;
    if (new Date(receipt.receivedAt).toISOString() !== receipt.receivedAt) return null;
    const ids = new Set(batch.map(event => event.id)), seen = new Set<string>();
    for (const id of receipt.acceptedEventIds) { if (!traceIdentifier(id) || !ids.has(id) || seen.has(id)) return null; seen.add(id); }
    for (const item of receipt.rejectedEvents) { if (!item || Object.keys(item).sort().join(',') !== 'eventId,reason' || !traceIdentifier(item.eventId) || !ids.has(item.eventId) || seen.has(item.eventId) || typeof item.reason !== 'string' || Buffer.byteLength(item.reason) > 256) return null; seen.add(item.eventId); }
    return receipt;
  }
  private remove(id: string): void { const index = this.pendingEvents.findIndex(event => event.id === id); if (index >= 0) { this.bytes -= Buffer.byteLength(JSON.stringify(this.pendingEvents[index])); this.pendingEvents.splice(index, 1); } }
  close(): void { this.closed = true; this.controller?.abort(); this.pendingEvents.length = 0; this.completed.clear(); this.bytes = 0; }
}
