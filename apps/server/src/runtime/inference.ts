import {audit} from './bounded-audit.mjs';
import {textGenerationTiming,textProgressWindow} from './text-generation-window.ts';
import type {ConversationMemoryRecallDiagnostics} from './conversation-memory-context.ts';
import {startVisualTurnEvidence,type VisualTurnEvidenceFactory,type VisualTurnOutcome} from './visual-turn-evidence.ts';
import {observeConversation,type ConversationPort} from './conversation.ts';
import type {PreparedVisualContext,VisualContextSelection} from '@lifestream/runtime/perception/observation';
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { buildCanonicalPrompt, finalizePreparedTurn, requestForFinalizedTurn, type FinalizedTurn, type PreparedTurnBinding, type RuntimeSelfContext, type AssistantPersonaProjection } from "@lifestream/runtime/inference/prompt";
import type { InferenceProvider,InferenceRequest } from "@lifestream/runtime/inference";
import type { PreparedWorldContext, WorldContextPreparation } from "@lifestream/runtime/context/world";

type Body = Record<string, unknown>;
export type InferenceRuntimeIdentity = { profile: string; implementation: string; model: string; revision: string; fixture: boolean };
export type CurrentnessPredicate = 'turn_source_expiry'|'authorization'|'lifecycle'|'context_fingerprint'|'pending_help'|'experience_boundary'|'prepared_context_expiry';
export type CurrentnessComponent = 'warmth'|'persona_revision'|'relationship_context'|'runtime_self_context'|'retention_policy'|'conversation_content';
export type CurrentnessRuntimeField = 'audienceRevision'|'configurationRevision'|'presentationRevision'|'modalityFacts'|'runtimeStatus'|'inputModalities'|'outputModalities'|'endpointScope'|'audienceScope'|'sessionRevision'|'endpointId'|'endpointRevision'|'permissionState'|'limitations'|'sourceRevision';
export type CurrentnessVersionField = 'audienceRevision'|'presentationRevision'|'sessionRevision'|'endpointRevision';
export type HostCurrentnessDiagnostic = Readonly<{predicate:CurrentnessPredicate;result:'false'|'unavailable';checkedAtMs?:number;deadlineMs?:number;components?:readonly CurrentnessComponent[];runtimeFields?:readonly CurrentnessRuntimeField[];versions?:readonly Readonly<{field:CurrentnessVersionField;before:number;after:number}>[]}>;
export type HostRuntimeInput = { sourceBegin?:(id:string,modality:'text'|'voice')=>void; sourceNotice?:'source-linked-health/1'|'source-linked-calendar/1'; visualTurnEvidence?:VisualTurnEvidenceFactory; visualSelection?:VisualContextSelection; preparedTurnBinding?:PreparedTurnBinding; preparedVisualContext?:PreparedVisualContext; onCompleted?:(interactionId:string)=>void; onReplyCompleted?:(reply:{interactionId:string;userText:string;assistantText:string;deadlineAt:string;signal?:AbortSignal})=>Promise<void>; experienceSelection?:{id:string;topic:string;statement:string;nextStep:string}; prepareMemory?:(signal:AbortSignal)=>Promise<void>;admitMemory?:()=>boolean;memoryRecall?:ConversationMemoryRecallDiagnostics;prepareWorld?: WorldContextPreparation; preparedWorldContext?: PreparedWorldContext; admitWorld?: () => boolean; capabilityContext?: string; conversation?:ConversationPort; onInferenceRequest?: (request:InferenceRequest)=>void; inspection?: { fullPromptPreview: boolean }; endpointId?: string | null; assistantId: string; runtimeSelfContext: RuntimeSelfContext; profileProjection?: AssistantPersonaProjection; preparedRelationshipContext?: NonNullable<Parameters<typeof buildCanonicalPrompt>[0]["preparedRelationshipContext"]>; readCurrentnessDiagnostic?:()=>HostCurrentnessDiagnostic|undefined; admitActiveTurn?:()=>boolean; isCurrent: () => boolean };
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

// The original guard captured these values when it failed. Reporting must not
// evaluate currentness again or copy arbitrary context/prompt values.
export function currentnessError(input:HostRuntimeInput) {
  let diagnostic:HostCurrentnessDiagnostic|undefined;
  try { diagnostic=input.readCurrentnessDiagnostic?.();if(diagnostic){audit.currentness(input,diagnostic);console.warn(JSON.stringify({event:'runtime_currentness_failed',...diagnostic}));} } catch { /* Optional diagnostics cannot change rejection or cleanup. */ }
  return {code:'runtime_input_stale',message:diagnostic?.predicate==='turn_source_expiry'&&diagnostic.result==='false'?'The reply context expired before completion.':'The interaction context changed. Please retry with the current scope.',...(diagnostic?{currentnessDiagnostic:diagnostic}:{})};
}

export async function streamMessage(response: ServerResponse, provider: InferenceProvider | undefined, body: Body, sessionId: string, aborted: AbortSignal, providerIdentity?: InferenceRuntimeIdentity, runtimeSelfContext?: RuntimeSelfContext, hostInput?: HostRuntimeInput): Promise<void> {
  const interactionId = randomUUID(), evidence=startVisualTurnEvidence(hostInput?.visualTurnEvidence,interactionId,'text');
  if (!provider) { evidence.rejected('provider_unavailable'); response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "inference_unavailable", message: "inference provider is unavailable" })); return; }
  if (typeof body.userInput !== "string" || !body.userInput.trim()) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "invalid_request", message: "userInput is required" })); return; }
  if(hostInput?.conversation)body.conversation=hostInput.conversation.read();
  const deadlineAt = new Date(Date.now() + textGenerationTiming.maximumDurationMs).toISOString();
  try { if(hostInput?.prepareMemory)await prepareHostMemory(hostInput,aborted);if(hostInput?.preparedRelationshipContext)body.preparedRelationshipContext=hostInput.preparedRelationshipContext; if (hostInput?.prepareWorld) await prepareHostWorld(hostInput, aborted); }
  catch { evidence.rejected(aborted.aborted?'cancelled':'context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current world context is unavailable." })); return; }
  if (aborted.aborted || hostInput && !hostInput.isCurrent()) { evidence.rejected(aborted.aborted?'cancelled':'context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current interaction context is unavailable." })); return; }
  const assistantId = typeof body.assistantId === "string" && body.assistantId ? body.assistantId : "assistant-neutral"; let request:InferenceRequest,finalized:FinalizedTurn;
  const admissionCurrent=()=>Date.now()<Date.parse(deadlineAt)&&!aborted.aborted&&(!hostInput||hostInput.isCurrent())&&(!hostInput?.admitWorld||hostInput.admitWorld());
  try { finalized = finalizePreparedTurn({ deadlineAt, ...(hostInput?.visualSelection?{visualOmissions:hostInput.visualSelection.omissions}:{}), ...(hostInput?.preparedTurnBinding?{preparedTurnBinding:hostInput.preparedTurnBinding}:{}), ...(hostInput?.preparedVisualContext?{preparedVisualContext:hostInput.preparedVisualContext}:{}), ...(hostInput?.experienceSelection?{experienceSelection:hostInput.experienceSelection}:{}), ...(hostInput?.preparedWorldContext ? { preparedWorldContext: hostInput.preparedWorldContext } : {}), assistantId, sessionId, interactionId, endpointId: typeof body.endpointId === "string" ? body.endpointId : null, userInput: body.userInput, ...(typeof body.conversation === "string" ? { conversation: body.conversation } : {}), ...(typeof body.memory === "string" ? { memory: body.memory } : {}), ...(typeof body.world === "string" ? { world: body.world } : {}), ...(hostInput?.capabilityContext ? { capabilities: hostInput.capabilityContext } : typeof body.capabilities === "string" ? { capabilities: body.capabilities } : {}), ...(body.preparedRelationshipContext && typeof body.preparedRelationshipContext === "object" ? { preparedRelationshipContext: body.preparedRelationshipContext as NonNullable<Parameters<typeof buildCanonicalPrompt>[0]["preparedRelationshipContext"]> } : {}), executionMode: body.executionMode === "replay" ? "replay" : "live", ...(runtimeSelfContext ? { runtimeSelfContext } : {}), ...(hostInput?.profileProjection ? { profileProjection: hostInput.profileProjection } : {}) },admissionCurrent);request=requestForFinalizedTurn(finalized,hostInput?.preparedTurnBinding,admissionCurrent); }
  catch { evidence.rejected('context_unavailable');response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "runtime_context_changed", message: "Current interaction context is unavailable." })); return; }

  evidence.finalized(finalized,request);
  // Explicit host diagnostics contain identity/timing only, never prompt text.
  const traceEnabled=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1',traceStart=performance.now();
  const trace=(phase:string,state?:string)=>{if(traceEnabled)try{console.info(JSON.stringify({event:'typed-stream-timing',interactionId,phase,observedAtMs:Date.now(),elapsedMs:Math.max(0,Math.round(performance.now()-traceStart)),...(state?{state}:{})}));}catch{}};
  if(traceEnabled)try{response.once?.('close',()=>trace('http-response-close',response.writableEnded?'ended':'disconnected'));}catch{}
  trace('stream-start');
  const controller = new AbortController(); const onAbort = () => {controller.abort(aborted.reason);trace('abort-forwarded');}; aborted.addEventListener("abort", onAbort, { once: true }); if (aborted.aborted) controller.abort(aborted.reason); const deadline = setTimeout(() => controller.abort(new Error("deadline")), Math.max(1, Date.parse(request.deadlineAt) - Date.now()));
  const progressWindow=textProgressWindow(controller);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" }); writeEvent(response, "interaction.started", { interactionId, sessionId, assistantId, ...(providerIdentity ? { provider: providerIdentity } : {}),...(hostInput?.sourceNotice?{sourceContextNotice:hostInput.sourceNotice}:{}) }); writeEvent(response, "input.manifest", request.manifest);
  if (hostInput?.inspection && hostInput.isCurrent()) {
    const view=hostInput.preparedRelationshipContext as import("@lifestream/runtime/context").CompiledRelationshipContext | undefined;
    writeEvent(response,"input.inspection",{scope:request.scope,compilerRevision:view?.compilerRevision??null,representationRevision:view?.representationRevision??null,configurationRevision:view?.configurationRevision??null,sourceRevisions:view?.sourceRevisions??[],selections:view?.selections??[],omissions:view?.omissions??[],budget:view?.budget??null,preparedContext:finalized.preparedContext?{schemaVersion:finalized.preparedContext.schemaVersion,viewId:finalized.preparedContext.viewId,revision:finalized.preparedContext.revision,invalidationKey:finalized.preparedContext.invalidationKey,builtAt:finalized.preparedContext.builtAt,freshUntil:finalized.preparedContext.freshUntil,sectionFragments:finalized.preparedContext.sections.length,sourceRevisions:finalized.preparedContext.sourceRevisions}:null,visual:visualInspection(hostInput,request),limitations:[...(view?.limitations??[]),"Inclusion and observed reply are not causal proof; no hidden reasoning is exposed."],retention:"this response only; no server inspection archive"});
    if(hostInput.inspection.fullPromptPreview)writeEvent(response,"input.prompt-preview",{sections:request.sections,expiresAt:new Date(Date.now()+30000).toISOString(),retention:"volatile explicit preview; clear on scope change or after 30 seconds"});
  }
  const requestedCapability = body.readOnlyCapability && typeof body.readOnlyCapability === "object" && !Array.isArray(body.readOnlyCapability) ? body.readOnlyCapability as Record<string, unknown> : undefined;
  if (requestedCapability && typeof requestedCapability.name === "string" && requestedCapability.name && requestedCapability.input && typeof requestedCapability.input === "object" && !Array.isArray(requestedCapability.input)) writeEvent(response, "capability.read-only", { name: requestedCapability.name, input: requestedCapability.input, effect: "read-only" });
  const abortCode = () => controller.signal.reason instanceof Error && controller.signal.reason.message === "deadline" ? "deadline_exceeded" : controller.signal.reason instanceof Error && controller.signal.reason.message === "inference_stalled" ? "inference_stalled" : "cancelled";
  const timedOut=()=>abortCode()!=="cancelled";
  let terminal = false,answer="",durableAnswer="",durableOverflow=false,lifecycleTerminalObserved=false,completionWritten=false,invoked=false,readyToInvoke=false;
  let outcome:VisualTurnOutcome='failed';
  const observeTerminal = () => {
    if (lifecycleTerminalObserved) return;
    lifecycleTerminalObserved = true;
    const state = outcome === 'completed' && completionWritten ? 'completed' : ['cancelled','disconnected','invalidated'].includes(outcome) || response.destroyed || response.writableEnded ? 'interrupted' : 'failed';
    observeConversation(hostInput?.conversation,{interactionId,role:'assistant',modality:'text',state});
    trace('terminal-observer-return',state);
  };
  try {
    if(controller.signal.aborted||hostInput&&!hostInput.isCurrent()){outcome=controller.signal.aborted?(timedOut()?'deadline':'cancelled'):'invalidated';evidence.rejected(outcome==='invalidated'?'context_unavailable':outcome);writeEvent(response,'interaction.error',{code:controller.signal.aborted?abortCode():'runtime_context_changed',message:'Current request scope is unavailable.'});terminal=true;return;}
    if (hostInput?.admitWorld && !hostInput.admitWorld()) throw new Error("World context expired before inference admission");
    hostInput?.conversation?.remember({interactionId,role:"user",text:body.userInput});
    observeConversation(hostInput?.conversation,{interactionId,role:'user',modality:'text',state:'completed',...(body.userInput.length <= 32768 ? {text:body.userInput} : {})});
    hostInput?.sourceBegin?.(interactionId,'text');
    observeConversation(hostInput?.conversation,{interactionId,role:'assistant',modality:'text',state:'accepted'});
    try{hostInput?.onInferenceRequest?.(request);}catch{/* Optional repetition bookkeeping cannot block an ordinary reply. */}
    if(!admissionCurrent()){terminal=true;const expired=Date.now()>=Date.parse(deadlineAt);outcome=expired?'deadline':aborted.aborted?'cancelled':'invalidated';evidence.rejected(expired?'deadline':aborted.aborted?'cancelled':'context_unavailable');controller.abort(expired?new Error('deadline'):undefined);writeEvent(response,'interaction.error',{code:expired?'deadline_exceeded':'runtime_input_stale',message:'The interaction context changed or expired before provider admission.'});return;}
    request=requestForFinalizedTurn(finalized,hostInput?.preparedTurnBinding,()=>!controller.signal.aborted&&admissionCurrent());
    // This marks the actual method call, not model execution or successful output.
    if(hostInput?.admitMemory&&!hostInput.admitMemory())throw Error('Memory context is no longer eligible for admission');
    readyToInvoke=true;
    const generate=provider.generate;if(typeof generate!=='function')throw Error('Inference provider method is unavailable');
    let stream:ReturnType<InferenceProvider['generate']>;
    try{stream=Reflect.apply(generate,provider,[request,{signal:controller.signal}]);}
    finally{invoked=true;evidence.providerInvoked();trace('provider-invoked');}
    for await (const chunk of stream) {
      // Buffered provider deltas may otherwise form one uninterrupted microtask
      // chain. Let pending HTTP disconnect/abort callbacks run, then retain all
      // original currentness checks before publishing or remembering this delta.
      await new Promise<void>(resolve=>setImmediate(resolve));
      if (response.destroyed) {outcome='disconnected';break;}
      if (hostInput && !hostInput.isCurrent()) { outcome='invalidated';terminal = true; controller.abort(); writeEvent(response, "interaction.error", currentnessError(hostInput)); break; }
      if (controller.signal.aborted) { outcome=timedOut()?'deadline':'cancelled';terminal = true; writeEvent(response, "interaction.error", { code: abortCode(), message: "Inference stopped before completion." }); break; }
      if (chunk.kind === "text") {if(chunk.text)progressWindow.progress();const writable=!response.destroyed&&!response.writableEnded;writeEvent(response, "message.delta", { interactionId, text: chunk.text ?? "" });if(chunk.text&&writable&&!response.destroyed)evidence.emitted('text');answer=(answer+(chunk.text??"")).slice(0,16001);hostInput?.conversation?.remember({interactionId,role:"assistant",text:answer,observation:"emitted"});
        if(writable&&!response.destroyed){
          // This complete durable buffer is independent of the original volatile
          // dialogue prefix. Overflow never publishes a retained complete prefix.
          if(!durableOverflow){const part=chunk.text??"";if(durableAnswer.length+part.length>32768){durableOverflow=true;durableAnswer="";}else durableAnswer+=part;}
          observeConversation(hostInput?.conversation,{interactionId,role:'assistant',modality:'text',state:'generating',...(durableOverflow?{}:{text:durableAnswer})});
        }
      }
      else if (chunk.kind === "capabilityRequest") writeEvent(response, "capability.read-only", chunk.capability);
      else if (chunk.kind === "error") { outcome='failed';terminal = true; writeEvent(response, "interaction.error", chunk.error); break; }
      else if (chunk.kind === "done") { outcome='completed';try{hostInput?.onCompleted?.(interactionId);}catch{/* Optional learning receipt must not interrupt an ordinary reply. */} terminal = true; writeEvent(response, "interaction.completed", { interactionId, ...(providerIdentity ? { provider: providerIdentity } : {}) }); completionWritten=!response.destroyed&&!response.writableEnded;break; }
    }
    // The provider iterator has closed and completion is already published.
    // Optional metadata must not relabel or add payload to that completed reply.
    if(outcome==='completed'){
      // Terminal metadata follows the closed primary iterator, before optional
      // title work can expire or retire its already completed source scope.
      observeTerminal();
      clearTimeout(deadline);progressWindow.close();
      try{await hostInput?.onReplyCompleted?.({interactionId,userText:body.userInput as string,assistantText:answer,deadlineAt});}catch{/* Optional metadata failure preserves the completed reply. */}
    }
    if (!terminal&&!response.destroyed)outcome=controller.signal.aborted?(timedOut()?'deadline':'cancelled'):'exhausted';
    if (!terminal && !response.destroyed) writeEvent(response, "interaction.error", { code: controller.signal.aborted ? abortCode() : "missing_provider_terminal", message: "Inference ended without a successful terminal." });
  } catch {
    if(Date.now()>=Date.parse(request.deadlineAt))controller.abort(new Error('deadline'));
    outcome=response.destroyed?'disconnected':controller.signal.aborted?(timedOut()?'deadline':'cancelled'):'failed';
    if (!terminal && !response.destroyed) writeEvent(response, "interaction.error", { code: controller.signal.aborted ? abortCode() : "inference_unavailable", message: "Inference could not complete." });
  } finally { observeTerminal();if(invoked)evidence.generationEnded(outcome);else evidence.rejected(readyToInvoke?'provider_unavailable':outcome==='deadline'?'deadline':outcome==='cancelled'?'cancelled':'context_unavailable');evidence.ended(response.destroyed||response.writableEnded?'disconnected':outcome);clearTimeout(deadline);progressWindow.close(); controller.abort(); aborted.removeEventListener("abort", onAbort); response.end();trace('stream-finished',outcome); }
}
