import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export { unifiedDesktopConsumerPins } from './unified-desktop.consumer-pins.ts';
import { createContractValidator, type ValidationResult } from './validator.ts';

export type UnifiedDesktopBoundary = 'conversation-history' | 'shell-preferences' | 'effective-subject' | 'desktop-session';
export type ContractPin = Readonly<{schemaId: string; schemaVersion: string; digest: string}>;
const names: UnifiedDesktopBoundary[] = ['conversation-history', 'shell-preferences', 'effective-subject', 'desktop-session'];
const lock = JSON.parse(readFileSync(new URL('./unified-desktop.lock.json', import.meta.url), 'utf8')) as {schemaVersion: string; contracts: Record<UnifiedDesktopBoundary, ContractPin>};
const pins = Object.fromEntries(names.map(name => {
  const pin = lock.contracts[name];
  const bytes = readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url));
  const schema = JSON.parse(bytes.toString('utf8')) as {$id: string; $defs: Record<string, {properties?: {schemaVersion?: {const?: unknown}}}>};
  const records = Object.values(schema.$defs).filter(def => def.properties?.schemaVersion);
  if (lock.schemaVersion !== '1.0.0' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pin.schemaVersion)
      || schema.$id !== `https://lifestream.dev/contracts/${name}/${pin.schemaVersion}` || schema.$id !== pin.schemaId
      || !records.length || records.some(def => def.properties!.schemaVersion!.const !== pin.schemaVersion)
      || createHash('sha256').update(bytes).digest('hex') !== pin.digest) throw new Error('unified desktop producer lock mismatch');
  return [name, Object.freeze({...pin})];
})) as Record<UnifiedDesktopBoundary, ContractPin>;
Object.freeze(pins);
const validator = createContractValidator();
export const contractFailure = (keyword: string, message: string): ValidationResult => ({valid: false, errors: [{instancePath: '', keyword, message}]});
export const contractSuccess = (): ValidationResult => ({valid: true, errors: []});
export const unifiedDesktopContractPin = (boundary: UnifiedDesktopBoundary): ContractPin => pins[boundary];

/** Caller supplies its generated lock. No schema-presence or compatible-name fallback. */
export function admitUnifiedDesktopConsumer(boundary: UnifiedDesktopBoundary, pin: unknown): ValidationResult {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return contractFailure('contractPin', 'consumer contract pin required');
  const fields = Object.getOwnPropertyDescriptors(pin);
  if (Object.keys(fields).length !== 3 || ['schemaId','schemaVersion','digest'].some(key => !fields[key] || !('value' in fields[key]!))) return contractFailure('contractPin', 'invalid consumer contract pin');
  const expected = pins[boundary];
  return expected && fields.schemaId!.value === expected.schemaId && fields.schemaVersion!.value === expected.schemaVersion && fields.digest!.value === expected.digest
    ? contractSuccess() : contractFailure('contractPin', 'unsupported consumer contract version or digest');
}

/** Reject non-JSON values/accessors/prototypes before serialization, without invoking getters. */
export function unifiedDesktopSnapshot(input: unknown, maxBytes = 4 * 1024 * 1024): unknown | undefined {
  const visited = new Set<object>();
  let budget = maxBytes;
  const copy = (v: unknown, depth: number): unknown => {
    if (depth > 32 || --budget < 0) throw new Error('bounded JSON required');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { budget -= Buffer.byteLength(v); if (budget < 0) throw new Error('bounded JSON required'); return v; }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object' || visited.has(v)) throw new Error('JSON required');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('plain JSON required');
    visited.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw new Error('JSON keys required');
    const out: Record<string, unknown> | unknown[] = Array.isArray(v) ? [] : {};
    for (const [key, d] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!d.enumerable || !('value' in d) || key === '__proto__') throw new Error('JSON values required');
      budget -= Buffer.byteLength(key);
      if (Array.isArray(out)) { if (key !== String(out.length)) throw new Error('dense JSON array required'); out.push(copy(d.value, depth + 1)); }
      else Object.defineProperty(out, key, {value: copy(d.value, depth + 1), enumerable: true});
    }
    visited.delete(v);
    return out;
  };
  try {
    const value = copy(input, 0);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) return undefined;
    return value;
  } catch { return undefined; }
}

export function validateUnifiedDesktopRecord(boundary: UnifiedDesktopBoundary, kind: string, value: unknown, consumerPin: ContractPin = pins[boundary]): ValidationResult {
  const admitted = admitUnifiedDesktopConsumer(boundary, consumerPin);
  if (!admitted.valid) return admitted;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(kind)) return contractFailure('schema', 'unknown boundary record');
  const snapshot = unifiedDesktopSnapshot(value, boundary === 'desktop-session' ? 16384 : 4 * 1024 * 1024);
  if (snapshot === undefined) return contractFailure('bounds', 'invalid or oversized JSON record');
  return validator.validate(`${pins[boundary].schemaId}#/$defs/${kind}`, snapshot);
}

/** Digest encoding for owner-ledger idempotency. This never dispatches or persists an effect. */
export function unifiedDesktopRequestDigest(request: unknown): string {
  const snapshot = unifiedDesktopSnapshot(request);
  if (snapshot === undefined) throw new Error('invalid bounded contract JSON');
  const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',') + '}' : JSON.stringify(v);
  return createHash('sha256').update(canonical(snapshot),'utf8').digest('hex');
}
