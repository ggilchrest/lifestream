import { types } from 'node:util';
export type TraceEvent = { id: string; traceId: string; sequence: number; payload: Record<string, unknown> };
export type TraceAdmission = 'queued' | 'duplicate' | 'overflow' | 'invalid' | 'closed';
export type TraceQueueBounds = Readonly<{ maxEvents: number; maxBytes: number; maxEventBytes: number }>;
export const referenceTraceQueueBounds: TraceQueueBounds = Object.freeze({ maxEvents: 128, maxBytes: 1_048_576, maxEventBytes: 32768 });
export function traceQueueBounds(options: Partial<TraceQueueBounds> = {}): TraceQueueBounds {
  const bounds = { ...referenceTraceQueueBounds, ...options };
  if (!Number.isSafeInteger(bounds.maxEvents) || bounds.maxEvents < 1 || bounds.maxEvents > 4096 || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 256 || bounds.maxBytes > 4_194_304 || !Number.isSafeInteger(bounds.maxEventBytes) || bounds.maxEventBytes < 128 || bounds.maxEventBytes > 32768 || bounds.maxEventBytes > bounds.maxBytes) throw Error('Invalid trace queue bounds.');
  return Object.freeze(bounds);
}
/** Finite plain data only, without invoking getters/proxies or serialization
 * hooks. Binary media, cycles, sparse arrays and nonfinite numbers are refused. */
export function traceDataSnapshot<T>(value: unknown, maxBytes: number): T | null {
  let nodes = 0, bytes = 0; const seen = new Set<object>();
  const charge = (text: string) => { bytes += Buffer.byteLength(text); if (bytes > maxBytes) throw Error('bound'); };
  const copy = (input: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 16) throw Error('bound');
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) { charge(JSON.stringify(input)); return input; }
    if (typeof input === 'string' && Buffer.byteLength(input) <= 8192) { charge(JSON.stringify(input)); return input; }
    if (!input || typeof input !== 'object' || types.isProxy(input) || seen.has(input)) throw Error('data');
    const array = Array.isArray(input), keys = Reflect.ownKeys(input);
    if (keys.length > 4096 || Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype) || array && keys.length !== (input as unknown[]).length + 1) throw Error('data');
    charge('{}'); seen.add(input); const result: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || Buffer.byteLength(key) > 256 || array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= (input as unknown[]).length)) throw Error('data');
      charge(array ? ',' : JSON.stringify(key) + ':,');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(input); return result;
  };
  try { const result = copy(value); return Buffer.byteLength(JSON.stringify(result)) <= maxBytes ? result as T : null; } catch { return null; }
}
export const traceIdentifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 256;
export function validTraceEvent(event: TraceEvent): boolean {
  return traceIdentifier(event.id) && traceIdentifier(event.traceId) && Number.isSafeInteger(event.sequence) && event.sequence >= 0 && !!event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
}
/** Bounded diagnostic queue. Overflow refuses new work, preserves retained
 * evidence and reports loss. No durable custody, source provenance or authority. */
export class TraceOutbox {
  private readonly events: TraceEvent[] = []; private bytes = 0; private refused = 0; private closed = false;
  readonly bounds: TraceQueueBounds;
  constructor(options: Partial<TraceQueueBounds> = {}) { this.bounds = traceQueueBounds(options); }
  append(input: TraceEvent): TraceAdmission {
    if (this.closed) return 'closed';
    const event = traceDataSnapshot<TraceEvent>(input, this.bounds.maxEventBytes);
    if (!event || Object.keys(event).sort().join(',') !== 'id,payload,sequence,traceId' || !validTraceEvent(event)) return 'invalid';
    if (this.events.some(e => e.id === event.id)) return 'duplicate';
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.events.length >= this.bounds.maxEvents || this.bytes + bytes > this.bounds.maxBytes) { this.refused = Math.min(Number.MAX_SAFE_INTEGER, this.refused + 1); return 'overflow'; }
    this.events.push(event); this.events.sort((a, b) => a.sequence - b.sequence); this.bytes += bytes; return 'queued';
  }
  pending(): TraceEvent[] { return this.events.map(event => structuredClone(event)); }
  usage() { return Object.freeze({ events: this.events.length, bytes: this.bytes, refusedEvents: this.refused, closed: this.closed, durable: false as const, complete: false as const }); }
  close(): void { this.closed = true; this.events.length = 0; this.bytes = 0; }
}
