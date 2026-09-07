import type { TraceEvent } from "./outbox.ts";

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
  publish(batch: { idempotencyKey: string; events: ExportEvent[] }): Promise<TracePublishReceipt>;
}

export type ExportResult =
  | { status: "accepted"; receipt: TracePublishReceipt; highWaterSequence: number }
  | { status: "deferred"; reason: "sink-unavailable" | "redaction-failed"; pending: number }
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
  return { ...structuredClone(event), ...context, payload: redact(event.payload) as Record<string, unknown> };
}

export class AsyncTraceExporter {
  private readonly pendingEvents: ExportEvent[] = [];
  private readonly completed = new Set<string>();
  private highWaterSequence = -1;
  private inFlight: Promise<ExportResult> | null = null;
  private readonly sink: TraceSink;
  private readonly maxBatchSize: number;

  constructor(sink: TraceSink, maxBatchSize = 500) { this.sink = sink; this.maxBatchSize = maxBatchSize; }

  enqueue(event: ExportEvent): void {
    if (this.completed.has(event.id) || this.pendingEvents.some((candidate) => candidate.id === event.id)) return;
    this.pendingEvents.push(structuredClone(event));
    this.pendingEvents.sort((a, b) => a.sequence - b.sequence);
  }

  pending(): ExportEvent[] { return this.pendingEvents.map((event) => structuredClone(event)); }
  highWater(): number { return this.highWaterSequence; }

  flush(): Promise<ExportResult> {
    if (this.inFlight) return this.inFlight;
    const batch = this.pendingEvents.slice(0, this.maxBatchSize);
    if (batch.length === 0) return Promise.resolve({ status: "accepted", receipt: { receiptId: "none", acceptedEventIds: [], rejectedEvents: [], receivedAt: new Date(0).toISOString() }, highWaterSequence: this.highWaterSequence });
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (!first || !last) return Promise.resolve({ status: "deferred", reason: "redaction-failed", pending: this.pendingEvents.length });
    const idempotencyKey = `trace-batch:${first.traceId}:${first.sequence}-${last.sequence}`;
    this.inFlight = this.sink.publish({ idempotencyKey, events: structuredClone(batch) }).then((receipt) => {
      const accepted = new Set(receipt.acceptedEventIds);
      for (const event of batch) if (accepted.has(event.id)) { this.completed.add(event.id); this.remove(event.id); this.highWaterSequence = Math.max(this.highWaterSequence, event.sequence); }
      const rejected = receipt.rejectedEvents.length > 0;
      return rejected ? { status: "partial", receipt, pending: this.pendingEvents.length } : { status: "accepted", receipt, highWaterSequence: this.highWaterSequence };
    }).catch(() => ({ status: "deferred", reason: "sink-unavailable", pending: this.pendingEvents.length }))
      .finally(() => { this.inFlight = null; }) as Promise<ExportResult>;
    return this.inFlight;
  }

  private remove(id: string): void { const index = this.pendingEvents.findIndex((event) => event.id === id); if (index >= 0) this.pendingEvents.splice(index, 1); }
}
