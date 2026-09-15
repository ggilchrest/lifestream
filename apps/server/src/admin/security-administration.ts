import type {CapabilitySchemaStore} from "@lifestream/runtime/capabilities/schema-artifacts";
import { randomUUID, createHash } from "node:crypto";
import type { Database, ToolRequestIdentity } from "@lifestream/storage-sqlite";
import { GrantRepository, AdmissionRepository, ToolInvocationRepository, ToolInvocationError } from "@lifestream/storage-sqlite";
import { createContractValidator } from "@lifestream/contracts";
import { SkillExecutor, validateSkill, type Skill } from "@lifestream/runtime/skills";
import { CapabilityResolver, capabilityInputDigest, validateRecordedCapabilityResult } from "@lifestream/runtime/capabilities/resolver";
import type { CapabilityProvider, CapabilityScope, CapabilityCallContext, CapabilityInvocationResult } from "@lifestream/runtime/capabilities/ports";
import { AuthenticationError, type LocalAuthentication, type LocalContext } from "../auth/local-auth.ts";
export type SecurityResult = { status: number; body: Record<string, unknown>; replayed?: boolean };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthenticationError(422, "invalid_request"); return value as Record<string, unknown>; };
export class SecurityAdministration {
  private readonly schemas:CapabilitySchemaStore|undefined;
  private readonly toolRequests: ToolInvocationRepository;
  private readonly database: Database; private readonly auth: LocalAuthentication; private readonly grants: GrantRepository; private readonly admissions: AdmissionRepository; private readonly provider: CapabilityProvider | undefined; private readonly now: () => number; private readonly validator = createContractValidator();
  constructor(database: Database, auth: LocalAuthentication, provider?: CapabilityProvider, now: () => number = Date.now, schemas?:CapabilitySchemaStore) { this.toolRequests = new ToolInvocationRepository(database); this.schemas=schemas; this.database = database; this.auth = auth; this.grants = new GrantRepository(database); this.admissions = new AdmissionRepository(database); this.provider = provider; this.now = now; }
  handleLocal(method: string, path: string, context: LocalContext, input: unknown): SecurityResult {
    this.auth.assertCurrent(context); const parts = path.split("/").filter(Boolean), assistantId = parts[4], body = object(input);
    if (parts[3] !== "assistants" || !assistantId || !this.auth.canAdminister(context, assistantId)) throw new AuthenticationError(403, "assistant_scope_denied");
    const base = { assistantId, principalId: context.principalId, grantsAuthority: false };
    if (parts[5] === "grants" && parts.length === 6) {
      if (method === "GET") return { status: 200, body: { ...base, grants: this.grants.list(context.principalId, assistantId) } };
      if (method === "POST") { if (!Array.isArray(body.scope) || body.scope.length < 1 || body.scope.length > 16 || body.scope.some(value => typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) || typeof body.durationSeconds !== "number" || !Number.isInteger(body.durationSeconds) || body.durationSeconds < 1 || body.durationSeconds > 86400 || !["allowOnce","allowSession","allowPersistent"].includes(String(body.durationMode)) || Object.keys(body).some(key => !["scope", "durationSeconds", "durationMode"].includes(key))) throw new AuthenticationError(422, "invalid_grant_request"); const grant = this.grants.create({ id: randomUUID(), principalId: context.principalId, assistantId, status: "pending", scope: [...new Set(body.scope as string[])], revision: 1, terms: { durationMode: body.durationMode, sessionId: context.sessionId, expiresAt: new Date(this.now() + body.durationSeconds * 1000).toISOString() }, createdAt: new Date(this.now()).toISOString() }); return { status: 201, body: { ...base, grant } }; }
    }
    if (parts[5] === "grants" && parts[6] && parts[7] === "decision" && parts.length === 8 && method === "POST") { const grant = this.grants.get(parts[6], context.principalId); if (!grant || grant.assistantId !== assistantId || !["active", "denied", "revoked"].includes(String(body.decision)) || !Number.isInteger(body.expectedRevision)) throw new AuthenticationError(409, "grant_decision_conflict"); try { return { status: 200, body: { ...base, grant: this.grants.decide(grant.id, context.principalId, body.expectedRevision as number, body.decision as "active" | "denied" | "revoked") } }; } catch { throw new AuthenticationError(409, "grant_decision_conflict"); } }
    if (parts[5] === "audit" && parts.length === 6 && method === "GET") return { status: 200, body: { ...base, events: this.database.connection.prepare("SELECT e.event,e.occurred_at AS occurredAt,e.grant_id AS grantId,e.actor FROM authority_events e JOIN authority_grants g ON e.grant_id=g.id WHERE g.assistant_id=? AND g.principal_id=? ORDER BY e.id").all(assistantId, context.principalId) } };
    if (parts[5] === "skills") return this.skills(method, parts, context, body, assistantId);
    return { status: 404, body: { code: "not_found", message: "administration operation not found" } };
  }
  async handle(method: string, path: string, context: LocalContext, input: unknown, call: CapabilityCallContext): Promise<SecurityResult> {
    const parts = path.split('/').filter(Boolean);
    if (!(method === 'POST' && parts.length === 8 && parts[3] === 'assistants' && parts[5] === 'tools' && parts[7] === 'invoke')) {
      return this.perform(method, path, context, input, call);
    }
    const assistantId = parts[4]!, capabilityId = parts[6]!;
    const assertCurrent = () => {
      this.auth.assertCurrent(context);
      if (!this.auth.canAdminister(context, assistantId)) throw new AuthenticationError(403, 'assistant_scope_denied');
      if (call.signal.aborted || !call.isCurrent() || !Number.isFinite(Date.parse(call.deadlineAt)) || Date.parse(call.deadlineAt) <= Date.now()) throw new AuthenticationError(503, 'capability_unavailable');
    };
    assertCurrent();
    const body = object(input);
    if (!this.validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/UUID', body.idempotencyKey).valid ||
      Object.keys(body).some(key => !['idempotencyKey', 'grantId', 'input'].includes(key)) ||
      (body.grantId !== undefined && body.grantId !== null && (typeof body.grantId !== 'string' || body.grantId.length > 128))) throw new AuthenticationError(422, 'invalid_tool_request');
    let requestDigest: string;
    try { requestDigest = capabilityInputDigest({ principalId: context.principalId, assistantId, sessionId: context.sessionId, capabilityId,
      endpointId: 'administration', environment: 'local-administration', grantId: body.grantId ?? null, input: body.input, executionMode: call.executionMode }); }
    catch { throw new AuthenticationError(422, 'invalid_tool_request'); }
    const owned = structuredClone(body);
    let identity: ToolRequestIdentity;
    try {
      identity = this.toolRequests.begin({ idempotencyKey: owned.idempotencyKey as string, principalId: context.principalId,
        assistantId, sessionId: context.sessionId, requestDigest, requestId: call.requestId, correlationId: call.correlationId,
        now: new Date(this.now()).toISOString() }, assertCurrent);
    } catch (error) {
      if (error instanceof ToolInvocationError) {
        const status = error.code === 'notFound' ? 404 : error.code === 'conflict' ? 409 : error.code === 'capacity' ? 429 : 503;
        throw new AuthenticationError(status, error.code === 'conflict' ? 'authority_idempotency_conflict' : 'tool_request_unavailable');
      }
      throw error;
    }
    if (!identity.fresh) {
      assertCurrent();
      if (identity.response && identity.response.body.result) {
        try {
          await validateRecordedCapabilityResult(identity.response.body.result as CapabilityInvocationResult,
            { assistantId, endpointId: 'administration', sessionId: context.sessionId, environment: 'local-administration',
              authorityContextRef: { providerRef: 'local-human', contextId: context.principalId, revision: 1 }, invocationId: identity.invocationId }, call, this.schemas);
          assertCurrent();
        } catch { return { status: 503, replayed: true, body: { code: 'recorded_tool_result_unavailable', invocationId: identity.invocationId,
          message: 'The original result cannot be released under the current scope and schema access. No action was repeated.' } }; }
      }
      return identity.response ? { ...identity.response, replayed: true } : { status: 202, replayed: true, body: { assistantId, principalId: context.principalId, grantsAuthority: false,
        requestId: identity.requestId, correlationId: identity.correlationId, invocationId: identity.invocationId,
        result: { invocationId: identity.invocationId, lifecycle: 'outcomeUnknown', reason: 'original_request_pending_or_requires_reconciliation' } } };
    }
    let result: SecurityResult;
    try {
      result = this.provider ? await this.perform(method, path, context, owned, call, identity) :
        { status: 503, body: { code: 'capability_unavailable', message: 'No capability provider is attached.' } };
      assertCurrent();
    } catch (error) {
      result = { status: error instanceof AuthenticationError ? error.status : 503,
        body: { code: error instanceof AuthenticationError ? error.code : 'capability_unavailable', message: 'The original tool request could not finish under the current scope.' } };
    }
    result = { status: result.status, body: { ...result.body, requestId: identity.requestId, correlationId: identity.correlationId, invocationId: identity.invocationId } };
    try { this.toolRequests.complete(identity, result); }
    catch { return { status: 503, body: { code: 'tool_result_unavailable', invocationId: identity.invocationId,
      message: 'The original request may require reconciliation. Retry only with the same idempotency key.' } }; }
    return result;
  }
  private async perform(method: string, path: string, context: LocalContext, input: unknown, call: CapabilityCallContext, identity?: ToolRequestIdentity): Promise<SecurityResult> {
    this.auth.assertCurrent(context);const parts=path.split("/").filter(Boolean),assistantId=parts[4],body=object(input);
    if(parts[3]!=="assistants"||!assistantId||!this.auth.canAdminister(context,assistantId))throw new AuthenticationError(403,"assistant_scope_denied");
    const base={assistantId,principalId:context.principalId,grantsAuthority:false};
    try {
    if (parts[5] === "tools") {
      if (!this.provider) return { status: 200, body: { ...base, tools: [], status: "unavailable", reason: "No capability provider is attached to this local administration instance; no live dispatch is inferred." } };
      const scope: CapabilityScope = { assistantId, endpointId: "administration", sessionId: context.sessionId, environment: "local-administration", authorityContextRef: { providerRef: "local-human", contextId: context.principalId, revision: 1 } };
      const resolver = new CapabilityResolver(this.provider, undefined, async (invocation, capability, dispatchCall) => {
        if (typeof body.grantId !== "string") return undefined;
        let admittedRevision: number | undefined;
        try {
          const admissionInput = {
            grantId: body.grantId, principalId: context.principalId, assistantId, sessionId: context.sessionId,
            capabilityId: invocation.capabilityId, invocationId: invocation.invocationId, inputDigest: capabilityInputDigest(invocation.input),
            now: new Date(this.now()).toISOString(),
            binding: { endpointId: invocation.endpointId, environment: invocation.environment, capabilityVersion: invocation.capabilityVersion,
              providerRoute: capability.route, capabilityDefinitionDigest: capabilityInputDigest(capability), snapshotId: invocation.snapshotId, snapshotRevision: invocation.snapshotRevision,
              interactionId: invocation.interactionId, authorityContextRef: invocation.authorityContextRef,
              executionMode: dispatchCall.executionMode, deadlineAt: dispatchCall.deadlineAt },
            assertCurrent: () => {
              dispatchCall.signal.throwIfAborted();
              if (!dispatchCall.isCurrent() || Date.parse(dispatchCall.deadlineAt) <= this.now()) throw new Error('dispatch scope changed');
              this.auth.assertCurrent(context);
              if (!this.auth.canAdminister(context, assistantId)) throw new AuthenticationError(403, "assistant_scope_denied");
            }
          };
          const admission = this.admissions.admitGoverned(admissionInput);
          admittedRevision = admission.grantRevision;
          const claimed = this.admissions.claimGovernedDispatch({ ...admissionInput, now: new Date(this.now()).toISOString() });
          return { invocationId: admission.invocationId, status: claimed ? "admitted" : "unknown", grantRevision: admission.grantRevision };
        } catch {
          return admittedRevision === undefined ? undefined : { invocationId: invocation.invocationId, status: "unknown", grantRevision: admittedRevision };
        }
      }, () => new Date(this.now()).toISOString(), this.schemas);
      const grantCurrent=()=>{if(typeof body.grantId!=="string")return true;const grant=this.grants.get(body.grantId,context.principalId);return !!grant&&grant.assistantId===assistantId&&["active","consumed"].includes(grant.status)&&Date.parse(String(grant.terms.expiresAt))>this.now();};
      const scopedCall={...call,isCurrent:()=>call.isCurrent()&&grantCurrent()};
      const snapshot = await resolver.snapshot(scope, call);
      if (method === "GET" && parts.length === 6) return { status: 200, body: { ...base, tools: snapshot.capabilities, snapshotRevision: snapshot.revision, expiresAt: snapshot.expiresAt, status: "available", limitation: "Discovery and Skill activation do not grant invocation authority." } };
      if (method === "POST" && parts.length === 8 && parts[7] === "simulate") { const capability = snapshot.capabilities.find(item => item.id === parts[6]); return { status: 200, body: { ...base, status: capability?.simulationSupported ? "simulated" : "unknown", providerInvoked: false, liveEffects: false } }; }
      if (method === "POST" && parts.length === 8 && parts[7] === "invoke") { const capability = snapshot.capabilities.find(item => item.id === parts[6]); if (!capability) throw new AuthenticationError(404, "capability_not_found"); const result = await resolver.invoke({ ...scope, invocationId: identity!.invocationId, interactionId: identity!.interactionId, idempotencyKey: identity!.idempotencyKey, capabilityId: capability.id, capabilityVersion: capability.version, snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.revision, input: body.input },scopedCall); return { status: result.lifecycle === "succeeded" ? 200 : 403, body: { ...base, result } }; }
    }

    if(parts[5]==="skills"&&parts[7]==="simulate"&&parts.length===8&&method==="POST"){
      const row=this.database.connection.prepare("SELECT COALESCE((SELECT h.payload_json FROM local_skill_revisions h WHERE h.skill_id=s.skill_id ORDER BY h.revision DESC LIMIT 1),s.payload_json) AS payload_json FROM skills s WHERE skill_id=? AND assistant_id=?").get(parts[6]!,assistantId) as {payload_json:string}|undefined;
      if(!row)throw new AuthenticationError(404,"skill_not_found");
      const result=await new SkillExecutor(async()=>false,async()=>({lifecycle:"denied",reason:"simulation_has_no_dispatch"})).execute(JSON.parse(row.payload_json) as Skill,body.input,randomUUID(),call);
      return {status:200,body:{result,liveEffects:false,memoryWrites:false,grantsAuthority:false}};
    }
    return this.handleLocal(method,path,context,body);
    } catch(error) { if(error instanceof AuthenticationError)throw error;return {status:503,body:{code:"capability_unavailable",message:"The capability request could not finish under the current scope."}}; }
  }
  private skills(method: string, parts: string[], context: LocalContext, body: Record<string, unknown>, assistantId: string): SecurityResult {
    const current = parts[6] ? this.database.connection.prepare("SELECT payload_json FROM skills WHERE skill_id=? AND assistant_id=?").get(parts[6], assistantId) as { payload_json: string } | undefined : undefined;
    const active = current ? JSON.parse(current.payload_json) as Skill : undefined;
    const latest = active ? this.database.connection.prepare("SELECT payload_json FROM local_skill_revisions WHERE skill_id=? ORDER BY revision DESC LIMIT 1").get(active.skillId) as { payload_json: string } | undefined : undefined;
    const existing = latest ? JSON.parse(latest.payload_json) as Skill : active;
    if (method === "GET" && parts.length === 6) return { status: 200, body: { skills: (this.database.connection.prepare("SELECT COALESCE((SELECT h.payload_json FROM local_skill_revisions h WHERE h.skill_id=s.skill_id ORDER BY h.revision DESC LIMIT 1),s.payload_json) AS payload_json FROM skills s WHERE s.assistant_id=? ORDER BY s.created_at").all(assistantId) as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json) as Skill), grantsAuthority: false } };
    if (method === "GET" && existing && parts[7] === "history") return { status: 200, body: { revisions: (this.database.connection.prepare("SELECT payload_json FROM local_skill_revisions WHERE skill_id=? ORDER BY revision").all(existing.skillId) as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json) as Skill) } };
    if (method === "POST" && (parts.length === 6 || existing && parts[7] === "revisions")) {
      const proposed = object(body.skill); if (proposed.status !== "draft" || proposed.activationRef !== null || (proposed.assistantId !== undefined && proposed.assistantId !== assistantId) || (existing && body.expectedRevision !== existing.revision)) throw new AuthenticationError(409, "skill_draft_conflict");
      if (/(?:__proto__|constructor|prototype)/.test(JSON.stringify(proposed))) throw new AuthenticationError(422,"unsafe_skill_binding");
      const skill = { ...proposed, skillId: existing?.skillId ?? randomUUID(), assistantId, revision: existing ? existing.revision + 1 : 1, createdBy: context.principalId, createdAt: new Date(this.now()).toISOString() } as unknown as Skill;
      if (!this.validator.validate("https://lifestream.dev/contracts/skill/1.0.0", skill).valid) throw new AuthenticationError(422, "invalid_skill"); try { validateSkill(skill); } catch { throw new AuthenticationError(422, "invalid_skill"); }
      this.persistSkill(skill, existing?.revision); return { status: 201, body: { skill, grantsAuthority: false } };
    }
    if (method === "POST" && existing && parts.length === 8 && parts[7] === "activate") { if (body.expectedRevision !== existing.revision || existing.status !== "draft") throw new AuthenticationError(409, "skill_activation_conflict"); const next = { ...existing, revision: existing.revision + 1, status: "active" as const, activationRef: { reference: `human-review:${context.principalId}:${existing.skillId}:${existing.revision}`, sha256: createHash("sha256").update(JSON.stringify(existing)).digest("hex"), mediaType: "application/json", schemaRef: "https://lifestream.dev/contracts/skill/1.0.0", byteLength: Buffer.byteLength(JSON.stringify(existing)) } }; if(!this.validator.validate("https://lifestream.dev/contracts/skill/1.0.0",next).valid)throw new AuthenticationError(422,"invalid_skill_activation");this.persistSkill(next, existing.revision); return { status: 200, body: { skill: next, grantsAuthority: false } }; }

    return { status: 404, body: { code: "not_found", message: "Skill operation not found" } };
  }
  private persistSkill(skill: Skill, expected?: number): void {
    this.database.transaction(tx => {
      const current = tx.get<{ revision: number; status: string }>("SELECT revision,status FROM skills WHERE skill_id=?", skill.skillId);
      const latest = tx.get<{ revision: number }>("SELECT MAX(revision) AS revision FROM local_skill_revisions WHERE skill_id=?", skill.skillId)?.revision ?? current?.revision;
      if (latest !== expected) throw new AuthenticationError(409, "skill_revision_conflict");
      // A new draft is inert: the active executable remains selected until explicit activation.
      if (!current || current.status !== "active" || skill.status === "active") tx.run("INSERT INTO skills VALUES (?,?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payload_json=excluded.payload_json", skill.skillId, skill.assistantId, skill.revision, skill.status, JSON.stringify(skill), skill.createdAt);
      tx.run("INSERT INTO local_skill_revisions VALUES (?,?,?)", skill.skillId, skill.revision, JSON.stringify(skill));
    });
  }
}
