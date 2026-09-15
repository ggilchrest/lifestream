import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type * as M from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import { ConfiguredCapabilitySchemas, encodeCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import { canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import type { Database } from '@lifestream/storage-sqlite';
import { UserProfileAdministration } from '../admin/user-profile.ts';
import type { CanonicalCapabilityComposition } from '../authority/capability-preparation.ts';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const capabilityId = 'synthetic.echo', version = '1.0.0', route = 'fixture:synthetic-echo';
const input = encodeCapabilitySchema('urn:lifestream:fixture:echo:input:1', { type: 'object', required: ['target','text'], additionalProperties: false, properties: { target: { enum: ['synthetic:one','synthetic:two'] }, text: { type: 'string', maxLength: 80 } } });
const output = encodeCapabilitySchema('urn:lifestream:fixture:echo:output:1', { type: 'object', required: ['text','fixture'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 80 }, fixture: { const: true } } });
type OwnedEvidence = { reference: M.ArtifactRef; bytes: Uint8Array; scope: M.CallScope; invocationId: string };
type Result = Extract<M.CapabilityInvocationResult['outcome'], { status: 'succeeded' }>['payload'];
const operationScope = (target: string) => ({ capabilityId, capabilityVersion: version, operation: 'echo', targetRefs: [target], dataScopeRefs: [] });
function argumentsFor(value: unknown): { target: string; text: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'target,text') throw new Error('fixture_input_invalid');
  const record = value as Record<string, unknown>;
  if (!['synthetic:one','synthetic:two'].includes(record.target as string) || typeof record.text !== 'string' || [...record.text].length > 80) throw new Error('fixture_input_invalid');
  return { target: record.target as string, text: record.text };
}

/** Selected fixture only. Echo has no external effect, network, device or model.
 * The canonical host owns durable grants, admission and initial-call claiming.
 * Provider observations are bounded in memory; a restart never invents a result. */
export function createFixtureCapabilities(database: Database, selected: () => boolean): CanonicalCapabilityComposition {
  const deployment = new UserProfileAdministration(database).deploymentId();
  const id = digest(['fixture-capability-environment', deployment]);
  const environmentId = `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-8${id.slice(17,20)}-${id.slice(20,32)}`;
  const snapshots = new Map<string, { scope: M.CallScope; value: M.capabilitySnapshot_Root }>();
  const decisions = new Map<string, { request: M.AuthorityRequest; disposition: M.providerMessages_DefsGovernedDisposition; evidence: OwnedEvidence }>();
  const results = new Map<string, { request: M.CapabilityInvocationRequest; result: Result; evidence: OwnedEvidence }>();
  const current = (request: { scope: M.CallScope; deadlineAt: string }, context: ProviderCallContext) => {
    context.signal.throwIfAborted();
    if (!selected() || request.scope.environmentId !== environmentId || !context.isCurrent(request.scope) || Date.parse(request.deadlineAt) <= Date.now()) throw new Error('fixture_scope_changed');
  };
  const evidence = (scope: M.CallScope, invocationId: string, value: unknown): OwnedEvidence => {
    const bytes = new TextEncoder().encode(canonicalJson(value));
    return { scope: structuredClone(scope), invocationId, bytes, reference: { reference: `urn:lifestream:fixture:evidence:${randomUUID()}`, sha256: bytesDigest(bytes), byteLength: bytes.length, mediaType: 'application/json', schemaRef: 'urn:lifestream:fixture:echo-evidence:1' } };
  };
  const assertDecision = (request: M.AuthorityRequest, disposition: M.providerMessages_DefsGovernedDisposition) => {
    const owned = decisions.get(disposition.decisionId), snapshot = snapshots.get(request.payload.snapshotId);
    if (!selected() || !owned || !isDeepStrictEqual(owned.request, request) || !isDeepStrictEqual(owned.disposition, disposition) || Date.parse(disposition.expiresAt) <= Date.now() || !snapshot || snapshot.value.revision !== request.payload.snapshotRevision || Date.parse(snapshot.value.expiresAt) <= Date.now() || !isDeepStrictEqual(snapshot.scope, request.scope)) throw new Error('fixture_decision_changed');
  };
  return {
    environmentId, providerRef: 'fixture',
    schemas: new ConfiguredCapabilitySchemas([input, output], (scope, context) => selected() && scope.environment === environmentId && context.isCurrent()),
    adapters: [{ capabilityId, version, providerRouteRef: route, revision: '1', inputSchema: input.artifact, outputSchema: output.artifact,
      derive(value) { const args = argumentsFor(value); return { scope: operationScope(args.target), effectSummary: `Synthetic test only: echo ${[...args.text].length} characters to ${args.target}. No device or external service is used.`, scopeDerivation: 'validatedArguments' }; } }],
    governance: {
      async evaluate(request, context) {
        current(request, context);
        for (const [key, record] of decisions) if (Date.parse(record.disposition.expiresAt) <= Date.now()) decisions.delete(key);
        if (decisions.size >= 4096) throw new Error('fixture_decision_capacity');
        const scope = request.payload.scope;
        if (scope.targetRefs.length !== 1 || !['synthetic:one','synthetic:two'].includes(scope.targetRefs[0]!) || !isDeepStrictEqual(scope, operationScope(scope.targetRefs[0]!))) throw new Error('fixture_operation_unavailable');
        const snapshot = snapshots.get(request.payload.snapshotId);
        if (!snapshot || !isDeepStrictEqual(snapshot.scope, request.scope) || snapshot.value.revision !== request.payload.snapshotRevision || Date.parse(snapshot.value.expiresAt) <= Date.now()) throw new Error('fixture_snapshot_unavailable');
        const bytes = evidence(request.scope, request.payload.invocationId, { fixture: true, type: 'providerDisposition', invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest, scope, authorityContextRef: request.scope.authorityContextRef });
        const disposition: M.providerMessages_DefsGovernedDisposition = { decisionId: randomUUID(), providerRef: 'fixture', invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest, scopeDigest: digest(scope), authorityContextRef: request.scope.authorityContextRef!, disposition: 'authorized', reason: { code: 'synthetic_echo_only', summary: 'Synthetic echo provider permits this scope; Human grant and final admission are separate.' }, evaluatedAt: new Date().toISOString(), expiresAt: new Date(Math.min(Date.now() + 30000, Date.parse(snapshot.value.expiresAt))).toISOString(), evidenceRef: bytes.reference };
        decisions.set(disposition.decisionId, { request: structuredClone(request), disposition: structuredClone(disposition), evidence: bytes });
        return { disposition, evidence: new Uint8Array(bytes.bytes) };
      },
      assertCurrent: assertDecision,
      async readEvidence(reference, request, context) {
        current(request, context);
        const record = [...results.values()].find(value => value.evidence.reference.reference === reference.reference)?.evidence;
        if (!record || record.invocationId !== request.payload.invocationId || !isDeepStrictEqual(record.scope, request.scope) || !isDeepStrictEqual(record.reference, reference)) throw new Error('fixture_evidence_unavailable');
        return new Uint8Array(record.bytes);
      }
    },
    provider: {
      async getSnapshot(request, context) {
        current(request, context);
        for (const [key, record] of snapshots) if (Date.parse(record.value.expiresAt) <= Date.now()) snapshots.delete(key);
        const capabilities: M.capabilitySnapshot_Root['capabilities'] = request.payload.requestedCapabilityIds.length && !request.payload.requestedCapabilityIds.includes(capabilityId) ? [] : [{ capabilityId, version, inputSchemaRef: input.artifact.reference, outputSchemaRef: output.artifact.reference, sideEffectClass: 'none', authorization: 'approvalRequired', idempotency: 'required', latencyClass: 'interactive', offlineAvailable: true, simulationSupported: true, providerRouteRef: route }];
        const scopeDigest = digest({ scope: request.scope, capabilities, input: input.artifact, output: output.artifact });
        const value = database.transaction(tx => {
          tx.run('DELETE FROM fixture_capability_snapshots WHERE expires_at <= ?', new Date().toISOString());
          const prior = tx.get<{ payload_json: string; sha256: string; snapshot_id: string }>('SELECT * FROM fixture_capability_snapshots WHERE scope_digest=?', scopeDigest);
          if (prior) {
            const parsed = JSON.parse(prior.payload_json) as M.capabilitySnapshot_Root;
            if (digest(parsed) !== prior.sha256 || parsed.snapshotId !== prior.snapshot_id || !isDeepStrictEqual(parsed.capabilities, capabilities)) throw new Error('fixture_snapshot_corrupt');
            return parsed;
          }
          if ((tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM fixture_capability_snapshots')?.count ?? 0) >= 256) throw new Error('fixture_snapshot_capacity');
          const created: M.capabilitySnapshot_Root = { schemaVersion: '2.0.0', snapshotId: randomUUID(), revision: 1, assistantId: request.scope.assistantId, endpointId: request.scope.endpointId!, sessionId: request.scope.sessionId!, environmentId, authorityContextRef: request.scope.authorityContextRef!, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), capabilities };
          tx.run('INSERT INTO fixture_capability_snapshots VALUES (?,?,?,?,?)', scopeDigest, created.snapshotId, created.expiresAt, canonicalJson(created), digest(created));
          return created;
        });
        snapshots.set(value.snapshotId, { scope: structuredClone(request.scope), value: structuredClone(value) });
        return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: value, error: null } };
      },
      async invoke(request, context) {
        current(request, context);
        const prior = results.get(request.payload.invocationId);
        if (prior && !isDeepStrictEqual(prior.request, request)) throw new Error('fixture_invocation_conflict');
        if (!prior && results.size >= 4096) throw new Error('fixture_result_capacity');
        const args = argumentsFor(request.payload.input), snapshot = snapshots.get(request.payload.snapshotId);
        if (!request.payload.dispatchReceipt || !isDeepStrictEqual(request.payload.inputSchema, input.artifact) || request.payload.inputDigest !== digest(args) || request.payload.capabilityId !== capabilityId || request.payload.capabilityVersion !== version || !isDeepStrictEqual(request.payload.operationScope, operationScope(args.target)) || !snapshot || !isDeepStrictEqual(snapshot.scope, request.scope) || snapshot.value.revision !== request.payload.snapshotRevision || Date.parse(snapshot.value.expiresAt) <= Date.now()) throw new Error('fixture_invocation_unavailable');
        const decision = [...decisions.values()].find(value => value.request.payload.invocationId === request.payload.invocationId && value.request.payload.inputDigest === request.payload.inputDigest && isDeepStrictEqual(value.request.scope, request.scope));
        if (!decision) throw new Error('fixture_disposition_missing'); assertDecision(decision.request, decision.disposition);
        let record = prior;
        if (!record) {
          const completedAt = new Date().toISOString(), value = { text: args.text, fixture: true };
          const proof = evidence(request.scope, request.payload.invocationId, { fixture: true, type: 'echoResult', invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest, output: value, completedAt });
          const result: Result = { type: 'succeeded', invocationId: request.payload.invocationId, output: value, outputSchema: output.artifact, confirmedAt: completedAt, evidenceRef: proof.reference };
          record = { request: structuredClone(request), result, evidence: proof }; results.set(request.payload.invocationId, record);
        }
        return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: structuredClone(record.result), error: null } };
      },
      async getInvocation(request, context) {
        current(request, context); const record = results.get(request.payload.invocationId);
        if (!record || record.request.idempotencyKey !== request.idempotencyKey || !isDeepStrictEqual(record.request.scope, request.scope)) throw new Error('fixture_invocation_unavailable');
        return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: structuredClone(record.result), error: null } };
      },
      async *subscribeInvalidations(request, context) {
        current(request, context);
        const streamId = randomUUID(), occurredAt = new Date().toISOString();
        // Static, process-local catalog: no resumable history is implied.
        yield { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', streamId, sequence: 0, occurredAt, kind: 'data', payload: { eventId: randomUUID(), scope: request.scope, snapshotIds: [], capabilityIds: [capabilityId], reason: 'gap', occurredAt } };
        current(request, context);
        yield { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', streamId, sequence: 1, occurredAt: new Date().toISOString(), kind: 'terminal', outcome: { status: 'succeeded', payload: { lastSequence: 0, sourceRevision: null }, error: null } };
      }
    }
  };
}
