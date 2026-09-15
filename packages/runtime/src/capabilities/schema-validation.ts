import { Worker } from 'node:worker_threads';

// Capability values are data. Reject lossy JSON encodings before hashing,
// validating or transferring them across a provider boundary.
export function boundedJson(value: unknown, maxBytes = 65_536): boolean {
  let nodes = 0, characters = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 32) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') { characters += item.length; return characters <= maxBytes; }
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item) && (item.length > 8192 || Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      characters += key.length;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || characters > maxBytes || !visit(descriptor.value, depth + 1)) return false;
    }
    if (Object.getOwnPropertySymbols(item).length) return false;
    ancestors.delete(item);
    return true;
  };
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes; } catch { return false; }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

type Pending = { finish: (valid: boolean) => void };
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();
let idle: ReturnType<typeof setTimeout> | undefined;
function stopWorker(target: Worker): void {
  if (target !== worker) return;
  worker = undefined;
  clearTimeout(idle);
  void target.terminate();
  for (const item of [...pending.values()]) item.finish(false);
}
function currentWorker(): Worker {
  clearTimeout(idle);
  if (!worker) {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const created = new Worker(new URL(`./schema-worker.${extension}`, import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 } });
    worker = created;
    created.on('message', (message: unknown) => {
      if (created !== worker || !message || typeof message !== 'object') return;
      const result = message as { id?: number; valid?: boolean };
      if (typeof result.id === 'number') pending.get(result.id)?.finish(result.valid === true);
    });
    created.on('error', () => stopWorker(created));
    created.on('exit', () => stopWorker(created));
  }
  worker.ref();
  return worker;
}

// Validation runs off the conversation thread: even a pathological regular
// expression, recursive schema or compiler failure has a finite lifetime.
// No remote schema loading, custom code or format registration is exposed.
export function validateCapabilitySchema(schema: unknown, value: unknown, signal: AbortSignal, compileOnly = false): Promise<boolean> {
  if (signal.aborted || !boundedJson(schema, 16_384) || (!compileOnly && !boundedJson(value)) || pending.size >= 32) return Promise.resolve(false);
  return new Promise(resolve => {
    const active = currentWorker(), id = ++sequence;
    const expiresAt = performance.now() + 2000;
    const timer = setTimeout(() => stopWorker(active), 2000);
    const abort = () => stopWorker(active);
    const finish = (valid: boolean) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(valid && performance.now() < expiresAt);
      if (!pending.size && worker === active) {
        active.unref();
        idle = setTimeout(() => stopWorker(active), 1000);
        idle.unref();
      }
    };
    pending.set(id, { finish });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { stopWorker(active); return; }
    try { active.postMessage({ id, schema, value: compileOnly ? null : value, compileOnly }); }
    catch { stopWorker(active); }
  });
}
