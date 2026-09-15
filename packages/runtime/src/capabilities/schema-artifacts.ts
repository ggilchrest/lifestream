import { createHash } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import type { CapabilityCallContext, CapabilityScope, CapabilityJsonSchema } from './ports.js';
import type { CapabilityCall } from './call.js';
import { CapabilityCallError } from './call.ts';
import { boundedJson } from './schema-validation.ts';

/** The existing protocol-common ArtifactRef; a reference never grants access. */
export type SchemaArtifactRef = {
  readonly reference: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly schemaRef: string;
  readonly byteLength: number;
};
export type CapabilitySchemaArtifact = { readonly artifact: SchemaArtifactRef; readonly bytes: Uint8Array };
export interface CapabilitySchemaStore {
  read(artifact: SchemaArtifactRef, scope: CapabilityScope, context: CapabilityCallContext): Promise<Uint8Array | undefined>;
}
const schemaDialect = 'https://json-schema.org/draft/2020-12/schema';
let validator: ReturnType<typeof createContractValidator> | undefined;
function validReference(value: unknown): value is SchemaArtifactRef {
  validator ??= createContractValidator();
  if (!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/ArtifactRef', value).valid) return false;
  const ref = value as SchemaArtifactRef;
  return ref.mediaType === 'application/schema+json' && ref.schemaRef === schemaDialect && ref.byteLength > 0 && ref.byteLength <= 16_384;
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function matches(left: SchemaArtifactRef, right: SchemaArtifactRef): boolean {
  return left.reference === right.reference && left.sha256 === right.sha256 && left.byteLength === right.byteLength && left.mediaType === right.mediaType && left.schemaRef === right.schemaRef;
}
function copyScope(scope:CapabilityScope):CapabilityScope {
  return {assistantId:scope.assistantId,endpointId:scope.endpointId,sessionId:scope.sessionId,environment:scope.environment,authorityContextRef:structuredClone(scope.authorityContextRef)};
}
function current(context: CapabilityCallContext): void {
  context.signal.throwIfAborted();
  if (!context.isCurrent() || !Number.isFinite(Date.parse(context.deadlineAt)) || Date.parse(context.deadlineAt) <= Date.now()) throw new CapabilityCallError('scopeChanged');
}
export function encodeCapabilitySchema(reference: string, schema: CapabilityJsonSchema): CapabilitySchemaArtifact {
  if (!boundedJson(schema, 16_384)) throw new CapabilityCallError('invalidResponse');
  const bytes = new TextEncoder().encode(JSON.stringify(schema));
  const artifact = { reference, sha256: digest(bytes), mediaType: 'application/schema+json', schemaRef: schemaDialect, byteLength: bytes.byteLength };
  if (!validReference(artifact)) throw new CapabilityCallError('invalidResponse');
  return { artifact, bytes };
}

/** A configured, immutable registry; no filesystem paths or URL fetching. */
export class ConfiguredCapabilitySchemas implements CapabilitySchemaStore {
  private readonly records = new Map<string, CapabilitySchemaArtifact>();
  private readonly authorize: (scope: CapabilityScope, context: CapabilityCallContext) => boolean | Promise<boolean>;
  constructor(records: readonly CapabilitySchemaArtifact[], authorize: (scope: CapabilityScope, context: CapabilityCallContext) => boolean | Promise<boolean>) {
    if (records.length > 256 || typeof authorize !== 'function') throw new CapabilityCallError('invalidResponse');
    this.authorize = authorize;
    for (const record of records) {
      const artifact = structuredClone(record.artifact);
      if (!validReference(artifact) || !(record.bytes instanceof Uint8Array) || record.bytes.byteLength !== artifact.byteLength) throw new CapabilityCallError('invalidResponse');
      const bytes = new Uint8Array(record.bytes);
      if (digest(bytes) !== artifact.sha256 || this.records.has(artifact.reference)) throw new CapabilityCallError('invalidResponse');
      this.records.set(artifact.reference, { artifact, bytes });
    }
  }
  metadata(reference: string): SchemaArtifactRef | undefined {
    const record = this.records.get(reference);
    return record && structuredClone(record.artifact);
  }
  async read(reference: SchemaArtifactRef, scope: CapabilityScope, context: CapabilityCallContext): Promise<Uint8Array | undefined> {
    const requested = structuredClone(reference), owned = copyScope(scope);
    current(context);
    const allowed = await this.authorize(owned, context);
    current(context);
    if (!allowed) return undefined;
    const record = this.records.get(requested.reference);
    if (!record || !matches(record.artifact, requested)) return undefined;
    return new Uint8Array(record.bytes);
  }
}

export async function resolveCapabilitySchema(reference: SchemaArtifactRef, scope: CapabilityScope, call: CapabilityCall, store?: CapabilitySchemaStore): Promise<CapabilityJsonSchema> {
  const owned = structuredClone(reference), owner = copyScope(scope);
  if (!store || !validReference(owned)) throw new CapabilityCallError('invalidResponse');
  const result = await call.wait(() => store.read(structuredClone(owned), owner, call.context));
  if (!(result instanceof Uint8Array) || result.byteLength !== owned.byteLength) throw new CapabilityCallError('invalidResponse');
  const bytes = new Uint8Array(result);
  if (bytes.byteLength !== owned.byteLength || digest(bytes) !== owned.sha256) throw new CapabilityCallError('invalidResponse');
  try {
    const schema: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if ((typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema))) || !boundedJson(schema, 16_384)) throw new Error('invalid schema data');
    return schema as CapabilityJsonSchema;
  } catch { throw new CapabilityCallError('invalidResponse'); }
}
