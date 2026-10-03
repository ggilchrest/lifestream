import type {ConversationMemoryRecallDiagnostics} from './conversation-memory-context.ts';
import {startVisualTurnEvidence,type VisualTurnEvidenceFactory,type VisualTurnOutcome} from './visual-turn-evidence.ts';
import type {ConversationPort} from './conversation.ts';
import type {PreparedVisualContext,VisualContextSelection} from '@lifestream/runtime/perception/observation';
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { buildCanonicalPrompt, finalizePreparedTurn, requestForFinalizedTurn, type FinalizedTurn, type PreparedTurnBinding, type RuntimeSelfContext, type AssistantPersonaProjection } from "@lifestream/runtime/inference/prompt";
import type { InferenceProvider,InferenceRequest } from "@lifestream/runtime/inference";
import type { PreparedWorldContext, WorldContextPreparation } from "@lifestream/runtime/context/world";

type Body = Record<string, unknown>;
export type InferenceRuntimeIdentity = { profile: string; implementation: string; model: string; revision: string; fixture: boolean };
export type HostRuntimeInput = { prepareMemory?:(signal:AbortSignal)=>Promise<void>; memoryRecall?:ConversationMemoryRecallDiagnostics; visualTurnEvidence?:VisualTurnEvidenceFactory; visualSelection?:VisualContextSelection; preparedTurnBinding?:PreparedTurnBinding; preparedVisualContext?:PreparedVisualContext; onCompleted?:(interactionId:string)=>void; experienceSelection?:{id:string;topic:string;statement:string;nextStep:string}; prepareWorld?: WorldContextPreparation; preparedWorldContext?: PreparedWorldContext; admitWorld?: () => boolean; capabilityContext?: string; conversation?:ConversationPort; onInferenceRequest?: (request:InferenceRequest)=>void; inspection?: { fullPromptPreview: boolean }; endpointId?: string | null; assistantId: string; runtimeSelfContext: RuntimeSelfContext; profileProjection?: AssistantPersonaProjection; preparedRelationshipContext?: NonNullable<Parameters<typeof buildCanonicalPrompt>[0]["preparedRelationshipContext"]>; isCurrent: () => boolean };
/** Idempotent host-owned optional stage. Default ordinary turns have no hook. */
export async function prepareHostMemory(input:HostRuntimeInput|undefined,signal:AbortSignal):Promise<void>{
 if(!input?.prepareMemory)return;
 if(signal.aborted||!input.isCurrent())throw Error('Runtime memory scope is unavailable');
 const prepare=input.prepareMemory;delete input.prepareMemory;
 await prepare(signal);
 if(signal.aborted||!input.isCurrent())throw Error('Runtime memory scope changed');
}
export async function prepareHostWorld(input: HostRuntimeInput | undefined, signal: AbortSignal): Promise<void> {
  if (!input?.prepareWorld) return;
  if (!input.isCurrent() || signal.aborted) throw new Error("Runtime world scope is unavailable");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const combined = AbortSignal.any([signal, controller.signal]);
  let onAbort = () => {};
  try {
    const lease = await Promise.race([input.prepareWorld(combined), new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("World preparation cancelled")); combined.addEventListener("abort", onAbort, { once: true }); if (combined.aborted) onAbort(); })]);
    if (combined.aborted || !input.isCurrent() || !lease.isCurrent()) throw new Error("Runtime world scope changed");
    const current = input.isCurrent;
    input.preparedWorldContext = lease.context; input.admitWorld = lease.isCurrent;
    input.isCurrent = () => current() && lease.isSnapshotCurrent();
  } finally { clearTimeout(timer); combined.removeEventListener("abort", onAbort); }
}
const writeEvent = (response: ServerResponse, event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function visualInspection(input:HostRuntimeInput,request:InferenceRequest) {
  const selection=input.visualSelection;if(!selection)return null;
  const view=selection.view,section=request.sections.find(item=>item.kind==='conversation');
  // Inspection describes the actual finalized prompt, never a newer scene.
  if(view!==(input.preparedVisualContext??null)||view&&view.conversationSectionDigest!==section?.contentDigest)return null;
  return {
    reason:selection.reason,considered:selection.considered,selected:view?.observations.length??0,
    selectedBytes:view?.selectedTextBytes??0,omissions:selection.omissions,
    prepared:view?{viewId:view.viewId,revision:view.revision,invalidationKey:view.invalidationKey,sourceRevision:view.sourceRevision,requestId:view.requestId,
      observationIds:view.observations.map(item=>item.observationId),frameIds:[...new Set(view.observations.flatMap(item=>item.frameIds))],
      capturedAtEarliestMs:view.capturedAtEarliestMs,capturedAtLatestMs:view.capturedAtLatestMs,selectedAtMs:view.selectedAtMs,expiresAtMs:view.expiresAtMs,
      sourceBindingRef:view.scope.sourceBindingRef,captureConfigurationRevision:view.scope.captureConfigurationRevision,audienceRevision:view.scope.audienceRevision,provider:view.provider,
      conversationSectionDigest:section!.contentDigest}:null,
    limitation:'Selection at preparation time only; not proof of generated mention, delivered output, image accuracy or retained memory. No scene text or raw media is included.'
  };
}

export async function streamMessage(response: ServerResponse, provider: InferenceProvider | undefined, body: Body, sessionId: string, aborted: AbortSignal, providerIdentity?: InferenceRuntimeIdentity, runtimeSelfContext?: RuntimeSelfContext, hostInput?: HostRuntimeInput): Promise<void> {
  const interactionId = randomUUID(), evidence=startVisualTurnEvidence(hostInput?.visualTurnEvidence,interactionId,'text');
  if (!provider) { evidence.rejected('provider_unavailable'); response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "inference_unavailable", message: "inference provider is unavailable" })); return; }
  if (typeof body.userInput !== "string" || !body.userInput.trim()) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "invalid_request", message: "userInput is required" })); return; }
  if(hostInput?.conversation)body.conversation=hostInput.conversation.read();
  const deadlineAt = new Date(Date.now() + 30_000).toISOString();
  try { if(hostInput?.prepareMemory)await prepareHostMemory(hostInput,aborted); if(hostInput?.preparedRelationshipContext)body.preparedRelationshipContext=hostInput.preparedRelationshipContext; if (hostInput?.prepareWorld) await prepareHostWorld(hostInput, aborted); }
  catch { evidence.rejected(aborted.aborted?'cancelled':'context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current interaction context is unavailable." })); return; }
  if (aborted.aborted || hostInput && !hostInput.isCurrent()) { evidence.rejected(aborted.aborted?'cancelled':'context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current interaction context is unavailable." })); return; }
  const assistantId = typeof body.assistantId === "string" && body.assistantId ? body.assistantId : "assistant-neutral"; let request:InferenceRequest,finalized:FinalizedTurn;
  const admissionCurrent=()=>Date.now()<Date.parse(deadlineAt)&&!aborted.aborted&&(!hostInput||hostInput.isCurrent())&&(!hostInput?.admitWorld||hostInput.admitWorld());
  try { finalized = finalizePreparedTurn({ deadlineAt, ...(hostInput?.visualSelection?{visualOmissions:hostInput.visualSelection.omissions}:{}), ...(hostInput?.preparedTurnBinding?{preparedTurnBinding:hostInput.preparedTurnBinding}:{}), ...(hostInput?.preparedVisualContext?{preparedVisualContext:hostInput.preparedVisualContext}:{}), ...(hostInput?.experienceSelection?{experienceSelection:hostInput.experienceSelection}:{}), ...(hostInput?.preparedWorldContext ? { preparedWorldContext: hostInput.preparedWorldContext } : {}), assistantId, sessionId, interactionId, endpointId: typeof body.endpointId === "string" ? body.endpointId : null, userInput: body.userInput, ...(typeof body.conversation === "string" ? { conversation: body.conversation } : {}), ...(typeof body.memory === "string" ? { memory: body.memory } : {}), ...(typeof body.world === "string" ? { world: body.world } : {}), ...(hostInput?.capabilityContext ? { capabilities: hostInput.capabilityContext } : typeof body.capabilities === "string" ? { capabilities: body.capabilities } : {}), ...(body.preparedRelationshipContext && typeof body.preparedRelationshipContext === "object" ? { preparedRelationshipContext: body.preparedRelationshipContext as NonNullable<Parameters<typeof buildCanonicalPrompt>[0]["preparedRelationshipContext"]> } : {}), executionMode: body.executionMode === "replay" ? "replay" : "live", ...(runtimeSelfContext ? { runtimeSelfContext } : {}), ...(hostInput?.profileProjection ? { profileProjection: hostInput.profileProjection } : {}) },admissionCurrent);request=requestForFinalizedTurn(finalized,hostInput?.preparedTurnBinding,admissionCurrent); }
  catch { evidence.rejected('context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current interaction context is unavailable." })); return; }

  evidence.finalized(finalized,request);
  const controller = new AbortController(); const onAbort = () => controller.abort(aborted.reason); aborted.addEventListener("abort", onAbort, { once: true }); if (aborted.aborted) controller.abort(aborted.reason); const deadline = setTimeout(() => controller.abort(new Error("deadline")), Math.max(1, Date.parse(request.deadlineAt) - Date.now()));
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" }); writeEvent(response, "interaction.started", { interactionId, sessionId, assistantId, ...(providerIdentity ? { provider: providerIdentity } : {}) }); writeEvent(response, "input.manifest", request.manifest);
  if (hostInput?.inspection && hostInput.isCurrent()) {
    const view=hostInput.preparedRelationshipContext as import("@lifestream/runtime/context").CompiledRelationshipContext | undefined;
    writeEvent(response,"input.inspection",{scope:request.scope,compilerRevision:view?.compilerRevision??null,representationRevision:view?.representationRevision??null,configurationRevision:view?.configurationRevision??null,sourceRevisions:view?.sourceRevisions??[],...(hostInput.memoryRecall?{memoryRecall:hostInput.memoryRecall}:{}),selections:view?.selections??[],omissions:view?.omissions??[],budget:view?.budget??null,preparedContext:finalized.preparedContext?{schemaVersion:finalized.preparedContext.schemaVersion,viewId:finalized.preparedContext.viewId,revision:finalized.preparedContext.revision,invalidationKey:finalized.preparedContext.invalidationKey,builtAt:finalized.preparedContext.builtAt,freshUntil:finalized.preparedContext.freshUntil,sectionFragments:finalized.preparedContext.sections.length,sourceRevisions:finalized.preparedContext.sourceRevisions}:null,visual:visualInspection(hostInput,request),limitations:[...(view?.limitations??[]),"Inclusion and observed reply are not causal proof; no hidden reasoning is exposed."],retention:"this response only; no server inspection archive"});
    if(hostInput.inspection.fullPromptPreview)writeEvent(response,"input.prompt-preview",{sections:request.sections,expiresAt:new Date(Date.now()+30000).toISOString(),retention:"volatile explicit preview; clear on scope change or after 30 seconds"});
  }
  const requestedCapability = body.readOnlyCapability && typeof body.readOnlyCapability === "object" && !Array.isArray(body.readOnlyCapability) ? body.readOnlyCapability as Record<string, unknown> : undefined;
  if (requestedCapability && typeof requestedCapability.name === "string" && requestedCapability.name && requestedCapability.input && typeof requestedCapability.input === "object" && !Array.isArray(requestedCapability.input)) writeEvent(response, "capability.read-only", { name: requestedCapability.name, input: requestedCapability.input, effect: "read-only" });
  const abortCode = () => controller.signal.reason instanceof Error && controller.signal.reason.message === "deadline" ? "deadline_exceeded" : "cancelled";
  let terminal = false,answer="",invoked=false,readyToInvoke=false;
  let outcome:VisualTurnOutcome='failed';
  try {
    if(controller.signal.aborted||hostInput&&!hostInput.isCurrent()){outcome=controller.signal.aborted?(abortCode()==='deadline_exceeded'?'deadline':'cancelled'):'invalidated';evidence.rejected(outcome==='invalidated'?'context_unavailable':outcome);writeEvent(response,'interaction.error',{code:controller.signal.aborted?abortCode():'runtime_context_changed',message:'Current request scope is unavailable.'});terminal=true;return;}
    if (hostInput?.admitWorld && !hostInput.admitWorld()) throw new Error("World context expired before inference admission");
    hostInput?.conversation?.remember({interactionId,role:"user",text:body.userInput});
    try{hostInput?.onInferenceRequest?.(request);}catch{/* Optional repetition bookkeeping cannot block an ordinary reply. */}
    if(!admissionCurrent()){terminal=true;const expired=Date.now()>=Date.parse(deadlineAt);outcome=expired?'deadline':aborted.aborted?'cancelled':'invalidated';evidence.rejected(expired?'deadline':aborted.aborted?'cancelled':'context_unavailable');controller.abort(expired?new Error('deadline'):undefined);writeEvent(response,'interaction.error',{code:expired?'deadline_exceeded':'runtime_input_stale',message:'The interaction context changed or expired before provider admission.'});return;}
    request=requestForFinalizedTurn(finalized,hostInput?.preparedTurnBinding,()=>!controller.signal.aborted&&admissionCurrent());
    // This marks the actual method call, not model execution or successful output.
    readyToInvoke=true;
    const generate=provider.generate;if(typeof generate!=='function')throw Error('Inference provider method is unavailable');
    let stream:ReturnType<InferenceProvider['generate']>;
    try{stream=Reflect.apply(generate,provider,[request,{signal:controller.signal}]);}
    finally{invoked=true;evidence.providerInvoked();}
    for await (const chunk of stream) {
      if (response.destroyed) {outcome='disconnected';break;}
      if (hostInput && !hostInput.isCurrent()) { outcome='invalidated';terminal = true; controller.abort(); writeEvent(response, "interaction.error", { code: "runtime_input_stale", message: "The interaction context changed. Please retry with the current scope." }); break; }
      if (controller.signal.aborted) { outcome=abortCode()==='deadline_exceeded'?'deadline':'cancelled';terminal = true; writeEvent(response, "interaction.error", { code: abortCode(), message: "Inference stopped before completion." }); break; }
      if (chunk.kind === "text") {const writable=!response.destroyed&&!response.writableEnded;writeEvent(response, "message.delta", { interactionId, text: chunk.text ?? "" });if(chunk.text&&writable&&!response.destroyed)evidence.emitted('text');answer=(answer+(chunk.text??"")).slice(0,16001);hostInput?.conversation?.remember({interactionId,role:"assistant",text:answer,observation:"emitted"});}
      else if (chunk.kind === "capabilityRequest") writeEvent(response, "capability.read-only", chunk.capability);
      else if (chunk.kind === "error") { outcome='failed';terminal = true; writeEvent(response, "interaction.error", chunk.error); break; }
      else if (chunk.kind === "done") { outcome='completed';try{hostInput?.onCompleted?.(interactionId);}catch{/* Optional learning receipt must not interrupt an ordinary reply. */} terminal = true; writeEvent(response, "interaction.completed", { interactionId, ...(providerIdentity ? { provider: providerIdentity } : {}) }); break; }
    }
    if (!terminal&&!response.destroyed)outcome=controller.signal.aborted?(abortCode()==='deadline_exceeded'?'deadline':'cancelled'):'exhausted';
    if (!terminal && !response.destroyed) writeEvent(response, "interaction.error", { code: controller.signal.aborted ? abortCode() : "missing_provider_terminal", message: "Inference ended without a successful terminal." });
  } catch {
    if(Date.now()>=Date.parse(request.deadlineAt))controller.abort(new Error('deadline'));
    outcome=response.destroyed?'disconnected':controller.signal.aborted?(abortCode()==='deadline_exceeded'?'deadline':'cancelled'):'failed';
    if (!terminal && !response.destroyed) writeEvent(response, "interaction.error", { code: controller.signal.aborted ? abortCode() : "inference_unavailable", message: "Inference could not complete." });
  } finally { if(invoked)evidence.generationEnded(outcome);else evidence.rejected(readyToInvoke?'provider_unavailable':outcome==='deadline'?'deadline':outcome==='cancelled'?'cancelled':'context_unavailable');evidence.ended(response.destroyed||response.writableEnded?'disconnected':outcome);clearTimeout(deadline); controller.abort(); aborted.removeEventListener("abort", onAbort); response.end(); }
}
