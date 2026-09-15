import {ConfiguredCapabilitySchemas,encodeCapabilitySchema} from "@lifestream/runtime/capabilities/schema-artifacts";
import type {CapabilityProvider, CapabilityDefinition, AdmittedCapabilityInvocation, CapabilityInvocationResult, CapabilitySnapshot, CapabilitySnapshotRequest, CapabilityStatusRequest, CapabilityCallContext} from "@lifestream/runtime/capabilities/ports";
const key=(request:CapabilityStatusRequest)=>JSON.stringify([request.assistantId,request.endpointId,request.sessionId,request.environment,request.authorityContextRef,request.invocationId]);
export class FixtureCapabilityProvider implements CapabilityProvider {
  private readonly results = new Map<string, CapabilityInvocationResult>();
  private readonly calls = new Map<string, number>();
  private readonly definitions: readonly CapabilityDefinition[];

  private readonly schemas:ConfiguredCapabilitySchemas|undefined;
  constructor(definitions: readonly CapabilityDefinition[] = [], schemas?:ConfiguredCapabilitySchemas) { this.definitions = structuredClone(definitions);this.schemas=schemas; }
  static schemaArtifacts(definitions:readonly CapabilityDefinition[],authorize:ConstructorParameters<typeof ConfiguredCapabilitySchemas>[1]):ConfiguredCapabilitySchemas {
    return new ConfiguredCapabilitySchemas(definitions.flatMap(definition=>[encodeCapabilitySchema(schemaRef(definition,'input'),definition.inputSchema),encodeCapabilitySchema(schemaRef(definition,'output'),definition.outputSchema)]),authorize);
  }

  async getSnapshot(request: CapabilitySnapshotRequest, context: CapabilityCallContext): Promise<CapabilitySnapshot> {
    context.signal.throwIfAborted(); if(!context.isCurrent())throw new Error("fixture_scope_changed");
    return Object.freeze({
      ...request,
      snapshotId: "00000000-0000-4000-8000-000000000017",
      revision: request.authorityContextRef.revision,
      expiresAt: new Date(Date.parse(request.now) + 60_000).toISOString(),
      capabilities: this.definitions.map((definition) => {
        const copy=structuredClone(definition);
        if(!this.schemas)return copy;
        const inputSchemaRef=this.schemas.metadata(schemaRef(definition,'input')),outputSchemaRef=this.schemas.metadata(schemaRef(definition,'output'));
        if(!inputSchemaRef||!outputSchemaRef)throw new Error('fixture_schema_missing');
        return {...copy,inputSchemaRef,outputSchemaRef};
      }),
    });
  }

  async invoke(invocation: AdmittedCapabilityInvocation, capability: CapabilityDefinition, context: CapabilityCallContext): Promise<CapabilityInvocationResult> {
    context.signal.throwIfAborted(); if(!context.isCurrent())throw new Error("fixture_scope_changed");
    if((capability.sideEffect!=="none"||capability.authorization==="required")&&(!invocation.dispatchReceipt||invocation.dispatchReceipt.status!=="admitted"||invocation.dispatchReceipt.invocationId!==invocation.invocationId))return {invocationId:invocation.invocationId,lifecycle:"denied",reason:"fixture_admission_required"};
    const calls = (this.calls.get(invocation.invocationId) ?? 0) + 1;
    this.calls.set(invocation.invocationId, calls);
    if (this.results.has(key(invocation))) return structuredClone(this.results.get(key(invocation))!);
    const lifecycle: CapabilityInvocationResult = capability.idempotency === "unsupported"
      ? { invocationId: invocation.invocationId, lifecycle: "outcomeUnknown", reason: "fixture_outcome_unknown" }
      : { invocationId: invocation.invocationId, lifecycle: "succeeded", output: { fixture: true } };
    const outputSchema=this.schemas?.metadata(schemaRef(capability,'output'));
    const result=lifecycle.lifecycle==='succeeded'&&outputSchema?{...lifecycle,outputSchema}:lifecycle;
    this.results.set(key(invocation), result);
    return structuredClone(result);
  }

  async getInvocation(request: CapabilityStatusRequest, context: CapabilityCallContext): Promise<CapabilityInvocationResult | undefined> {
    context.signal.throwIfAborted(); if(!context.isCurrent())throw new Error("fixture_scope_changed");
    const result = this.results.get(key(request));
    return result && structuredClone(result);
  }

  invocationCount(invocationId: string): number { return this.calls.get(invocationId) ?? 0; }
}

const schemaRef=(capability:CapabilityDefinition,kind:'input'|'output')=>`urn:lifestream:fixture-schema:${encodeURIComponent(capability.id)}:${encodeURIComponent(capability.version)}:${kind}`;
