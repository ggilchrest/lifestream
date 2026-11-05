import {VoiceFailureTracker,providerFailureCode,type VoiceFailureDiagnostic} from './voice-failure.ts';
import {audit} from './bounded-audit.mjs';
import {startVisualTurnEvidence,type VisualTurnRecorder,type VisualTurnOutcome} from './visual-turn-evidence.ts';
import {textGenerationTiming,textProgressWindow} from './text-generation-window.ts';
import {AudioPlayback} from "./audio-playback.ts";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import {VoiceProducerFramer} from '../../../../packages/runtime/dist/voice/producer-framer.js';
import { VoiceResponseRouter, voiceUnitText } from "@lifestream/runtime/voice/response-router";
import { synthesizeSpeech } from "./preview-speech.ts";
import { SpeechSafeSegmenter } from "@lifestream/runtime/voice/segmenter";
import { finalizePreparedTurn, requestForFinalizedTurn } from "@lifestream/runtime/inference/prompt";
import type { AudioFrame, SpeechToTextProvider } from "@lifestream/runtime/voice";
import type { VoxCpmProvider } from "@lifestream/providers-voxcpm";
import { defaultVoiceSettings, parseVoiceSettings, synthesisReference, type VoiceSettings } from "./voice-settings.ts";
import type {VoiceBinding} from '../admin/saved-voices.ts';
import { SpeechQueue } from "./speech-queue.ts";
import { currentnessError, prepareHostMemory, prepareHostWorld, type HostRuntimeInput } from "./inference.ts";
import {observeConversation} from './conversation.ts';
import {validateAudioFrame} from "@lifestream/runtime/voice";

type AudioRequest = { continuationMode?:"ordered-v1"; schemaVersion: "1.0.0"; requestId: string; correlationId: string; sessionId: string; expectedSessionRevision: number; endpointId: string; audioInputId: string; format: AudioFrame["format"]; voiceSettings?: VoiceSettings; assistantId?: string; relationshipId?: string };
type AudioClientMessage = {type:"continueInput";audioInputId:string;afterCommitSequence:number} | {type:"playbackSettled";interactionTraceId:string;outcome:"completed"|"stopped";receivedSamples:number} | { type: "start"; request: AudioRequest } | { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "commitTurn"; audioInputId: string; nextSequence: number; sampleCount: number } | { type: "interrupt"; interactionTraceId: string; reason: string } | { type: "stop"; audioInputId: string };
type AudioSocket = Pick<WebSocket, "send" | "close"> & { readyState: number };
const OPEN = 1;
const VOICE_RESPONSE_TEXT_LIMIT=16_384;
// One logical utterance, including pre-roll and closing silence. No sliding window.
export const VOICE_INPUT_MAX_SAMPLES=1_440_000;
export const VOICE_INPUT_MAX_FRAMES=6_000;
const send = (socket: AudioSocket, message: Record<string, unknown>) => { if (socket.readyState !== OPEN) return false; socket.send(JSON.stringify(audit.socketMessage(socket,message)));audit.socketSent(socket,message); return true; };
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const response = (socket: AudioSocket, interactionTraceId: string, sequence: number, payload: Record<string, unknown>) => send(socket, { type: "response", event: { schemaVersion: "1.0.0", interactionTraceId, sequence, occurredAt: new Date().toISOString(), payload } });
const problem = (code: string, message: string, correlationId: string, retryable = false) => ({ code, message, retryable, correlationId, details: {} });
export const hasAudioEnergy = (dataBase64: string, threshold = 0.015): boolean => { const bytes = Buffer.from(dataBase64, "base64"); if (bytes.length < 2) return false; let energy = 0; for (let offset = 0; offset + 1 < bytes.length; offset += 2) { const sample = bytes.readInt16LE(offset) / 32768; energy += sample * sample; } return Math.sqrt(energy / (bytes.length / 2)) >= threshold; };

export const VOICE_TURN_DEADLINE_MS = 180_000;
export const SPEECH_SEGMENT_DEADLINE_MS = 45_000;
/** qualifyProgress freshly checks the original endpoint/session/authority and
 * current unexpired fenced owner, then renews it in the same synchronous call.
 * Legacy progress is renewal only and never replaces current() qualification. */
export type AudioOutputLease={current:()=>boolean;progress?:()=>boolean;qualifyProgress?:()=>boolean;release:()=>void};
type OrderedInput = {traceId:string;inputSequence:number;controller:AbortController;admitted:boolean;scopeChanged:boolean};
type OrderedAdmission = OrderedInput & {transcript:string;prepared:HostRuntimeInput|undefined;conversation:HostRuntimeInput['conversation'];priorConversation:string|undefined;deadlineAt:string;failure:VoiceFailureTracker};
export type AudioDependencies = { stt: SpeechToTextProvider; inference: InferenceProvider; tts: VoxCpmProvider; failureDiagnostic?:(record:VoiceFailureDiagnostic)=>void; resolveVoice?:(request:{assistantId?:string})=>VoiceBinding; acknowledgment?:(request:AudioRequest)=>{revision:number;binding:string;clipIds:string[]}|null; inputCurrent?: (request: AudioRequest) => boolean; foregroundStarted?: (request:{assistantId?:string;relationshipId?:string})=>(()=>void); outputLease?: (endpointId:string,deadlineAt:string)=>AudioOutputLease; prepare?: (request: { assistantId?: string; relationshipId?: string; userInput: string; endpointId: string }) => HostRuntimeInput };
export type SpeechExpressionObservation={speechStage:"providerReported"|"audioEmitted"|"synthesized";mappingRevision:string;disposition:"notObserved"|"fullyApplied"|"partiallyApplied"|"providerFailure"|"cancelled"|"timedOut";degradedDimensions:string[];appliedDelivery:{deliveryMode?:string;pace?:number;energy?:number}};
export type OutputOnlySpeech={assistantId?:string;urgency?:'low'|'critical';expressionObserved?:(observation:SpeechExpressionObservation)=>void;text:string;interactionId:string;endpointId:string;deadlineAt:string;warmth:number;signal:AbortSignal;current:()=>boolean;/** Pure trusted admission predicate, evaluated after extensible owner callbacks. */terminalAdmission?:()=>boolean;beforeEmission:()=>void;emitted:()=>void;synthesized?:(signal:AbortSignal)=>Promise<void>;interrupted?:(reason:"expired"|"cancelled")=>void};

async function waitForPreviousOutput(previous:Promise<void>,signal:AbortSignal):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
  try{await Promise.race([previous,new Promise<void>((_,reject)=>{
    abort=()=>reject(new Error("Previous speech output has not settled; no new recognition or generation was started."));
    timer=setTimeout(abort,15000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  })]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

export class AudioSession {
  private readonly socket: AudioSocket;
  private readonly deps: AudioDependencies;
  private readonly sessionId: string;
  private request: AudioRequest | undefined;
  private frames: AudioFrame[] = [];
  private bufferedSamples=0;
  private controller: AbortController | undefined;
  private interactionTraceId: string | undefined;
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly lifetime=new AbortController();
  private pendingTurns = 0;
  private committedInputs=0;
  private activeInputSequence=0;
  private inputAdmitted=false;
  private supersededInputsThrough=0;
  private inputHalted=false;
  private recognition:OrderedInput|undefined;
  private blockedCommit:{nextSequence:number;sampleCount:number}|undefined;
  private starting = false;
  private outputSettlement:Promise<void>|undefined;
  private playback:AudioPlayback|undefined;
  private voiceBinding:VoiceBinding|undefined;
  private voiceSettings: VoiceSettings = { ...defaultVoiceSettings };
  private sequence = 0;
  private currentInput: HostRuntimeInput | undefined;
  private currentEvidence:VisualTurnRecorder|undefined;
  private turnInvalidated=false;
  private replyMetadata:{interactionId:string;controller:AbortController;current:()=>boolean}|undefined;
  private readonly identity: { assistantId: string; environmentId: string; conversationId: string } = { assistantId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID() };

  constructor(socket: AudioSocket, deps: AudioDependencies, sessionId: string) { this.socket = socket; this.deps = deps; this.sessionId = sessionId; }

  belongsTo(sessionId:string):boolean{return this.sessionId===sessionId;}
  /** Actual owner state, not telemetry, gates explicit history selection.
   * Never retire accepted work, pending output or even uncommitted PCM. */
  canRetireForHistorySelection(sessionId:string):boolean {
    return this.sessionId===sessionId&&!this.closed&&this.socket.readyState===OPEN&&this.request!==undefined
      &&!this.starting&&!this.controller&&!this.recognition&&this.pendingTurns===0
      &&!this.outputSettlement&&!this.playback&&this.frames.length===0&&this.bufferedSamples===0
      &&!this.blockedCommit&&!this.currentInput&&!this.currentEvidence&&!this.replyMetadata
      &&!this.inputAdmitted&&this.activeInputSequence===0;
  }
  /** Caller preflights every relevant owner and its auth/CAS/lease/fence first,
   * synchronously. Logical closure precedes any external close/audit callback. */
  retireForHistorySelection(sessionId:string):boolean {
    if(!this.canRetireForHistorySelection(sessionId))return false;
    this.closed=true;
    this.request=undefined;
    try{this.close();return true;}catch{return false;}
  }
  /** Read-only scalar diagnostics; no authority, callbacks or settlement changes. */
  get historyBlockingStatus():Readonly<{closed:boolean;transportOpen:boolean;requestBound:boolean;workPending:boolean;outputPending:boolean}>{
    return Object.freeze({closed:this.closed,transportOpen:this.socket.readyState===OPEN,requestBound:this.request!==undefined,workPending:!!this.controller||!!this.recognition||this.starting||this.pendingTurns>0,outputPending:this.outputSettlement!==undefined});
  }
  get outputConnected():boolean{return !this.closed&&this.socket.readyState===OPEN;}
  get outputAvailable():boolean{return this.outputConnected&&!this.controller&&!this.starting&&!this.pendingTurns;}
  /** A host-admitted critical condition may stop output, but never bypass its
   * existing playback settlement or acquire a second owner. Input stays closed
   * on an output-only connection; pending microphone turns are not promoted. */
  async interruptOutput(signal:AbortSignal,current:()=>boolean):Promise<void>{
    if(signal.aborted||!current()||!this.outputConnected)throw new Error('Critical output scope is unavailable');
    const previous=this.outputSettlement;
    this.cancelReplyMetadata();this.playback?.interrupt();this.controller?.abort();
    if(this.interactionTraceId)send(this.socket,{type:'stopPlayback',interactionTraceId:this.interactionTraceId,reason:'critical_condition'});
    if(previous)await waitForPreviousOutput(previous,signal);
    if(signal.aborted||!current()||!this.outputAvailable)throw new Error('Previous output has not settled for critical delivery');
  }
  /** Uses the established output transport without a start/input request, STT,
   * fabricated transcript or second inference call. Host policy owns admission. */
  async speakOutputOnly(input:OutputOnlySpeech):Promise<{samples:number;frames:number;mappingRevision:string;warmth:"unsupported";degradedDimensions:string[]}>{
    if(!this.outputAvailable||!this.deps.outputLease||!validUuid(input.interactionId)||!validUuid(input.endpointId)||!input.text.trim()||input.text.length>4000||!Number.isFinite(input.warmth)||input.warmth<0||input.warmth>1||input.current()!==true||input.signal.aborted)throw new Error("Output-only speech is unavailable");
    const terminalAdmission=input.terminalAdmission;
    const voice=this.deps.resolveVoice?.(input),settings=voice?.settings??this.voiceSettings;
    const deadline=Math.min(Date.parse(input.deadlineAt),Date.now()+SPEECH_SEGMENT_DEADLINE_MS);
    if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error("Output-only speech expired");
    const lease=this.deps.outputLease(input.endpointId,new Date(deadline).toISOString()),controller=new AbortController(),signal=AbortSignal.any([controller.signal,input.signal]);
    const playback=this.playback=new AudioPlayback(input.interactionId,new Date(deadline).toISOString(),()=>{controller.abort();send(this.socket,{type:"stopPlayback",interactionTraceId:input.interactionId,reason:"output_only_stopped_or_expired"});});
    let settledOutput:()=>void=()=>{};this.outputSettlement=new Promise<void>(resolve=>{settledOutput=resolve;});
    this.controller=controller;this.interactionTraceId=input.interactionId;this.sequence=0;this.currentInput=undefined;
    let deadlineElapsed=false;const timer=setTimeout(()=>{deadlineElapsed=true;controller.abort();},Math.max(1,deadline-Date.now()));
    let samples=0,frames=0,started=false,done=false,terminalSent=false,mappingRevision="unknown",settlement:Promise<void>|undefined,settled=false;
    const degraded=new Set<string>(["warmth"]),pacer=new PcmPacer(),segmentId=randomUUID(),decisionId=randomUUID();
    let expressionStage:SpeechExpressionObservation['speechStage']='providerReported',disposition:SpeechExpressionObservation['disposition']='notObserved',appliedDelivery:SpeechExpressionObservation['appliedDelivery']={};
    const observeExpression=()=>input.expressionObserved?.({speechStage:expressionStage,mappingRevision,disposition,degradedDimensions:[...degraded],appliedDelivery:{...appliedDelivery}});

    const current=()=>!this.closed&&this.socket.readyState===OPEN&&!signal.aborted&&Date.now()<deadline&&input.current()===true&&lease.current()&&(voice?.current()??true)&&(!terminalAdmission||terminalAdmission()===true);
    const request={contractVersion:"2.0.0" as const,text:input.text,segmentId,format:{encoding:"pcm_s16le" as const,sampleRateHz:48000 as const,channels:1 as const},voiceProfile:voice?.voiceProfile??{voiceRef:"fixture-voice-design",revision:1},decision:{decisionId,revision:1},delivery:{interactionId:input.interactionId,segmentId,decisionId,decisionRevision:1,deliveryMode:settings.deliveryMode,urgency:input.urgency??"low",pace:settings.pace,energy:settings.energy},deadlineAt:new Date(deadline).toISOString()};
    try{
      if(!current())throw new Error("Output-only ownership changed");
      let tts=this.deps.tts.withoutAdmissionRetries();if(settings.description||settings.seed!==0||settings.reference)tts=tts.withVoiceDesign({description:settings.description,seed:settings.seed,reference:synthesisReference(settings)});
      for await(const event of bufferedStream(synthesizeSpeech(tts,request,signal),signal,64,()=>controller.abort(),(pending,complete)=>{settlement=pending;settled=complete;})){
        if(!current()||done)throw new Error("Output-only speech became stale or emitted after terminal");
        if(mappingRevision!=="unknown"&&event.mappingRevision!==mappingRevision)throw new Error("Speech mapping changed");mappingRevision=event.mappingRevision;
        if(event.kind==="preAudio"){for(const d of event.degradedDimensions)degraded.add(d);disposition=['fullyApplied','partiallyApplied'].includes(event.disposition)?event.disposition:'notObserved';const delivery=event.delivery??{};appliedDelivery={...(delivery.deliveryMode===undefined?{}:{deliveryMode:delivery.deliveryMode as string}),...(delivery.pace===undefined?{}:{pace:delivery.pace as number}),...(delivery.energy===undefined?{}:{energy:delivery.energy as number})};observeExpression();continue;}
        if(event.kind==="terminal"){
          for(const d of event.degradedDimensions)degraded.add(d);if(['fullyApplied','partiallyApplied','providerFailure','cancelled','timedOut'].includes(event.disposition))disposition=event.disposition;observeExpression();
          if(event.outcome!=="succeeded"||event.outputSamples!==samples||event.frameCount!==frames||!samples)throw new Error("Speech did not produce complete audio");
          for(const d of event.degradedDimensions)degraded.add(d);done=true;continue;
        }
        validateAudioFrame(event.frame,request.format);
        if(event.frame.sampleOffset!==samples||event.frame.sequence!==frames||Buffer.from(event.frame.dataBase64,"base64").length!==event.frame.sampleCount*2||samples+event.frame.sampleCount>48000*60)throw new Error("Speech frame accounting is invalid");
        await pacer.admit(event.frame.sampleCount,event.frame.format.sampleRateHz,signal);if(!current())throw new Error("Audio lease or policy changed before emission");
        if(!started){input.beforeEmission();if(!current())throw new Error("Output-only admission changed");response(this.socket,input.interactionId,this.sequence++,{type:"textDelta",text:input.text});started=true;input.emitted();}
        if(!current())throw new Error("Output-only ownership changed");
        playback.emittedOutput(event.frame.sampleCount);send(this.socket,{type:"audio",interactionTraceId:input.interactionId,chunk:{segmentId:event.segmentId,frame:event.frame}});samples+=event.frame.sampleCount;frames++;if(frames===1){expressionStage="audioEmitted";observeExpression();}
      }
      if(!done||!current())throw new Error("Output-only speech has no current successful terminal");
      playback.synthesized();playback.producerSettled();expressionStage="synthesized";observeExpression();response(this.socket,input.interactionId,this.sequence++,{type:"terminal",state:"completed",finalResponse:null,error:null});terminalSent=true;
      if(input.synthesized)await input.synthesized(signal);
      await playback.settled;
      if(!current())throw new Error("Output-only playback was interrupted or expired");
      return {samples,frames,mappingRevision,warmth:"unsupported",degradedDimensions:[...degraded]};
    }catch(error){
      const cancelled=signal.aborted||!input.current()||!lease.current();if(cancelled)input.interrupted?.(deadlineElapsed||playback.deadlineExpired||Date.now()>=deadline?"expired":"cancelled");controller.abort();if(started)playback.interrupt();
      if(!terminalSent)response(this.socket,input.interactionId,this.sequence++,{type:"terminal",state:cancelled?"interrupted":"failed",finalResponse:null,error:problem("output_only_stopped","Output-only speech stopped; playback completion is not established.",input.interactionId)});throw error;
    }finally{clearTimeout(timer);controller.abort();const release=()=>{lease.release();this.controller=undefined;this.interactionTraceId=undefined;this.outputSettlement=undefined;this.playback=undefined;settledOutput();};if(settlement&&!settled)void settlement.catch(()=>undefined).then(()=>playback.producerSettled());else playback.producerSettled();void playback.settled.then(release);}
  }

  private cancelReplyMetadata(interactionId?:string):void{const pending=this.replyMetadata;if(pending&&(interactionId===undefined||pending.interactionId===interactionId)){pending.controller.abort();if(this.replyMetadata===pending)this.replyMetadata=undefined;}}
  private queueReplyMetadata(host:HostRuntimeInput|undefined,reply:{interactionId:string;userText:string;assistantText:string;deadlineAt:string},turnSignal:AbortSignal):void{
    const callback=host?.onReplyCompleted;if(!host||!callback)return;
    this.cancelReplyMetadata();const pending={interactionId:reply.interactionId,controller:new AbortController(),current:()=>host.isCurrent()};this.replyMetadata=pending;
    const signal=AbortSignal.any([turnSignal,this.lifetime.signal,pending.controller.signal]);
    // Never await optional catalog metadata in the speech producer/consumer or
    // terminal path. The original helper owns its finite three-second bound.
    setImmediate(()=>{
      if(signal.aborted){if(this.replyMetadata===pending)this.replyMetadata=undefined;return;}
      void Promise.resolve().then(()=>callback({...reply,signal})).catch(()=>{/* Optional metadata cannot change completed text, speech or playback. */}).finally(()=>{if(this.replyMetadata===pending)this.replyMetadata=undefined;});
    });
  }
  close(): void { audit.forTrace(this.interactionTraceId,"socket_closed",{});audit.socketClosed(this.socket);this.cancelReplyMetadata();this.closed = true;this.currentEvidence?.endpointSettled('disconnected');this.lifetime.abort();this.recognition?.controller.abort(); this.frames = [];this.bufferedSamples=0;this.blockedCommit=undefined; this.voiceSettings = { ...defaultVoiceSettings }; this.request = undefined; this.playback?.interrupt(); this.controller?.abort(); this.socket.close(1001, "audio session closed"); }
  private ensureInputCurrent(request = this.request): boolean {
    if (!request) return !this.closed;
    let current = false;
    try { current = !this.closed && (this.deps.inputCurrent?.(request) ?? true) && (this.voiceBinding?.current()??true); } catch { /* Failed authority lookup is not current input. */ }
    if (current) return true;
    this.turnInvalidated=true;if(this.recognition)this.recognition.scopeChanged=true;
    if (!this.closed) {
      send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_input_scope_changed", "Audio session revision, endpoint or authority changed; reconnect microphone using the current session.", request.correlationId) });
      if (this.interactionTraceId) send(this.socket, { type: "stopPlayback", interactionTraceId: this.interactionTraceId, reason: "audio_input_scope_changed" });
      this.close();
    }
    return false;
  }
  invalidateIfStale(): void { if (!this.ensureInputCurrent()) return;try{if(this.replyMetadata&&!this.replyMetadata.current())this.cancelReplyMetadata();}catch{this.cancelReplyMetadata();} if (this.currentInput && !this.currentInput.isCurrent()) { if(!this.turnInvalidated)currentnessError(this.currentInput);this.turnInvalidated=true;this.playback?.interrupt(); this.controller?.abort(); if (this.interactionTraceId) send(this.socket, { type: "stopPlayback", interactionTraceId: this.interactionTraceId, reason: "runtime_input_stale" }); } }

  private rejectUncommitted(request:AudioRequest,code:string,message:string):void {
    if(request.continuationMode){this.frames=[];this.bufferedSamples=0;this.blockedCommit=undefined;this.inputHalted=true;}
    send(this.socket,{type:'error',requestId:request.requestId,...(request.continuationMode?{inputScope:'uncommittedInput',acceptedInputsPreserved:true}:{}),problem:problem(code,message,request.correlationId)});
  }
  /** A continuation withdraws reply work, never custody of accepted input. */
  private supersedeRepliesThrough(inputSequence:number):void {
    this.supersededInputsThrough=Math.max(this.supersededInputsThrough,inputSequence);
    if(this.recognition?.admitted&&this.recognition.inputSequence<=this.supersededInputsThrough)this.recognition.controller.abort();
    if(this.controller&&(this.activeInputSequence===0||this.activeInputSequence<=this.supersededInputsThrough&&this.inputAdmitted)){
      this.playback?.interrupt();this.controller.abort();
      if(this.interactionTraceId)send(this.socket,{type:'stopPlayback',interactionTraceId:this.interactionTraceId,reason:'continued_input'});
    }
  }

  async message(raw: string): Promise<void> {
    if (this.closed) return;
    let message: AudioClientMessage;
    try { message = JSON.parse(raw) as AudioClientMessage; } catch { this.socket.close(1003, "malformed JSON"); return; }
    if(audit.controlMessage(this.socket,message))return;
    if (message?.type === "playbackSettled") {
      const evidence=this.currentEvidence;
      if (this.playback?.acknowledge(message)) {audit.forTrace(message.interactionTraceId,"playback_settlement",{outcome:message.outcome,receivedSamples:message.receivedSamples});
        if(message.outcome==='stopped')evidence?.endpointSettled('stopped',message.receivedSamples);
        else if(this.ensureInputCurrent() && this.currentInput?.isCurrent()){
          evidence?.endpointSettled('completed',message.receivedSamples);
          try { this.currentInput.onCompleted?.(message.interactionTraceId); } catch { /* Optional mention bookkeeping cannot change playback settlement. */ }
        }else evidence?.endpointSettled('invalidated');
      }
      return;
    }
    if (!message || typeof message !== "object") { this.socket.close(1003, "malformed audio message"); return; }
    if (message.type === "start") return this.start(message.request);
    if (message.type === "interrupt") {if(this.recognition?.traceId===message.interactionTraceId)this.recognition.controller.abort(); this.cancelReplyMetadata(message.interactionTraceId);if (message.interactionTraceId === this.interactionTraceId) { this.playback?.interrupt(); this.controller?.abort(); send(this.socket, { type: "stopPlayback", interactionTraceId: message.interactionTraceId, reason: message.reason }); } return; }
    const request = this.request;
    if (!request || ((message.type === "frame" || message.type === "commitTurn" || message.type === "stop" || message.type === "continueInput") && message.audioInputId !== request.audioInputId)) return void send(this.socket, { type: "error", requestId: request?.requestId ?? randomUUID(), problem: problem("audio_input_identity_changed", "audio input identity changed", request?.correlationId ?? randomUUID()) });
    if (!this.ensureInputCurrent(request)) return;
    if(message.type==='continueInput'){
      if(request.continuationMode!=='ordered-v1')return void send(this.socket,{type:'error',problem:problem('audio_continuation_unavailable','Ordered continuation was not negotiated.',request.correlationId)});
      if(Object.keys(message).sort().join(',')!=='afterCommitSequence,audioInputId,type'||!Number.isSafeInteger(message.afterCommitSequence)||message.afterCommitSequence<0||message.afterCommitSequence!==this.committedInputs)return void send(this.socket,{type:'error',problem:problem('audio_continuation_invalid','Continuation does not match the latest accepted input.',request.correlationId)});
      this.supersedeRepliesThrough(message.afterCommitSequence);
      send(this.socket,{type:'inputContinued',audioInputId:request.audioInputId,afterCommitSequence:message.afterCommitSequence});return;
    }
    if (message.type === "frame") {
      if(this.inputHalted){send(this.socket,{type:'error',inputScope:'uncommittedInput',acceptedInputsPreserved:true,problem:problem('audio_input_halted','Input capture is halted; accepted input is still settling.',request.correlationId)});return;}
      if(this.blockedCommit){send(this.socket,{type:'inputBackpressure',audioInputId:request.audioInputId,afterCommitSequence:this.committedInputs,availableInputs:Math.max(0,3-this.pendingTurns)});return;}
      const expectedSamples = this.sampleCount();
      if (message.frame.sequence !== this.frames.length || message.frame.sampleOffset !== expectedSamples || message.frame.format.encoding !== "pcm_s16le" || message.frame.format.sampleRateHz !== 16000 || message.frame.format.channels !== 1 || !Number.isSafeInteger(message.frame.sampleCount) || message.frame.sampleCount < 1 || message.frame.sampleCount > 4800 || Buffer.from(message.frame.dataBase64, "base64").length !== message.frame.sampleCount * 2) return this.rejectUncommitted(request,"audio_frame_invalid","audio frame sequence, format, offset, or payload is invalid");
      if (expectedSamples + message.frame.sampleCount > VOICE_INPUT_MAX_SAMPLES || this.frames.length>=VOICE_INPUT_MAX_FRAMES) { send(this.socket, { type: "error", ...(request.continuationMode?{inputScope:'uncommittedInput',acceptedInputsPreserved:true}:{}),problem: problem("audio_input_limit", "Utterance exceeds the 90-second or 6000-frame limit; input was discarded. Start again when ready.", request.correlationId) });
        if(request.continuationMode){this.frames=[];this.bufferedSamples=0;this.blockedCommit=undefined;this.inputHalted=true;}else this.close();return; }
      // Audio energy is not speech. The endpoint sends an explicit interrupt
      // after speech qualification; this route must not bypass that gate.
      this.frames.push(message.frame);this.bufferedSamples+=message.frame.sampleCount; return;
    }
    if (message.type === "stop") { this.close(); return; }
    if (message.type !== "commitTurn") return;
    if(this.inputHalted)return void send(this.socket,{type:'error',inputScope:'uncommittedInput',acceptedInputsPreserved:true,problem:problem('audio_input_halted','Input capture is halted; accepted input is still settling.',request.correlationId)});
    if (message.nextSequence !== this.frames.length || message.sampleCount !== this.sampleCount()) return this.rejectUncommitted(request,"audio_commit_invalid","audio commit accounting is invalid");
    if(request.continuationMode==='ordered-v1'&&this.frames.length&&this.pendingTurns>=3){
      this.blockedCommit={nextSequence:message.nextSequence,sampleCount:message.sampleCount};
      send(this.socket,{type:'inputBackpressure',audioInputId:request.audioInputId,afterCommitSequence:this.committedInputs,availableInputs:0});return;
    }
    const frames = this.frames.slice(); this.frames = [];this.bufferedSamples=0;this.blockedCommit=undefined;
    if (!frames.length || this.pendingTurns >= 3) { send(this.socket, { type: "error", problem: problem("audio_queue_limit", "Voice queue is full or empty input was committed; reconnect voice.", request.correlationId) }); if(!request.continuationMode)this.close();return; }
    this.cancelReplyMetadata();const releaseForeground=this.deps.foregroundStarted?.(request);
    if(request.continuationMode==='ordered-v1')this.supersedeRepliesThrough(this.committedInputs);
    else {this.playback?.interrupt();this.controller?.abort();}
    const inputSequence=++this.committedInputs;
    this.pendingTurns++;let transcriptCommitted=false;
    if(request.continuationMode)send(this.socket,{type:'inputQueued',audioInputId:request.audioInputId,inputSequence,availableInputs:Math.max(0,3-this.pendingTurns)});
    this.turnQueue = this.turnQueue.then(async () => { const priorOutput=this.outputSettlement;if(priorOutput&&!request.continuationMode){
      try{await waitForPreviousOutput(priorOutput,this.lifetime.signal);}
      catch(error){send(this.socket,{type:"error",requestId:request.requestId,problem:problem("audio_previous_output_unsettled",error instanceof Error?error.message:"Previous output is unavailable",request.correlationId)});return;}
    }transcriptCommitted=await this.runTurn(frames,inputSequence); }).finally(() => { frames.length=0;this.pendingTurns--;releaseForeground?.();if(request.continuationMode&&!this.closed)send(this.socket,{type:'inputSettled',audioInputId:request.audioInputId,inputSequence,transcriptCommitted,availableInputs:Math.max(0,3-this.pendingTurns)}); });
    await this.turnQueue;
  }

  private async start(request: AudioRequest): Promise<void> {
    if (this.starting || this.request || !request || request.continuationMode!==undefined&&request.continuationMode!=="ordered-v1" || request.sessionId !== this.sessionId || request.schemaVersion !== "1.0.0" || !validUuid(request.requestId) || !validUuid(request.correlationId) || !validUuid(request.sessionId) || !validUuid(request.endpointId) || !validUuid(request.audioInputId) || !Number.isInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0 || request.format?.encoding !== "pcm_s16le" || request.format.sampleRateHz !== 16000 || request.format.channels !== 1) { this.close(); return; }
    if (!this.ensureInputCurrent(request)) return;
    this.starting = true;
    let settings: VoiceSettings;
    try { this.voiceBinding=this.deps.resolveVoice?.(request);settings = request.voiceSettings===undefined&&this.voiceBinding?this.voiceBinding.settings:parseVoiceSettings(request.voiceSettings); }
    catch (error) { send(this.socket, { type: "error", problem: { message: error instanceof Error ? error.message : "Invalid voice settings" } }); this.close(); return; }
    if (settings.description || settings.seed !== 0 || settings.reference) {
      const controls = await this.deps.tts.voiceControls();
      if (this.closed) return;
      if (((settings.description || settings.seed !== 0) && !controls.description) || (settings.reference && !controls.reference)) { send(this.socket, { type: "error", problem: { message: "Requested voice controls are unavailable on this sidecar. Clear them or use a supported profile." } }); this.close(); return; }
    }
    if (this.closed) return;
    this.voiceSettings = settings;
    if (this.deps.prepare) { try { const prepared = this.deps.prepare({ ...(request.assistantId ? { assistantId: request.assistantId } : {}), ...(request.relationshipId ? { relationshipId: request.relationshipId } : {}), endpointId: request.endpointId, userInput: "" }); this.identity.assistantId = prepared.assistantId; } catch { this.close(); return; } }
    if (!this.ensureInputCurrent(request)) return;
    this.request = request;this.starting=false;
    send(this.socket, { type: "accepted", ...(request.continuationMode?{continuationMode:request.continuationMode,inputCapacity:3}:{}), identity: { ...this.identity, sessionId: request.sessionId, endpointId: request.endpointId, interactionTraceId: request.correlationId }, audioInputId: request.audioInputId });
  }

  private sampleCount(): number { return this.bufferedSamples; }

  /** Accepted input has its own controller and can settle before old output does. */
  private async recognizeOrderedInput(frames:AudioFrame[],request:AudioRequest,input:OrderedInput):Promise<OrderedAdmission|undefined>{
    const {controller,traceId,inputSequence}=input,failure=new VoiceFailureTracker(traceId,this.deps.failureDiagnostic);
    const deadlineAt=new Date(Date.now()+VOICE_TURN_DEADLINE_MS).toISOString(),timer=setTimeout(()=>{timedOut=true;controller.abort();},30_000);
    let timedOut=false;
    const expired=()=>{if(Date.now()>=Date.parse(deadlineAt)||Date.now()>=recognitionDeadline){timedOut=true;controller.abort();}return controller.signal.aborted;};
    const recognitionDeadline=Math.min(Date.parse(deadlineAt),Date.now()+30_000);
    const current=()=>this.ensureInputCurrent(request);
    audit.bindTrace(traceId);audit.event('asr_begin');for(const frame of frames)audit.pcm('input_audio',frame);
    send(this.socket,{type:'turnStarted',interactionTraceId:traceId,inputSequence});
    const audio=async function*(){for(const frame of frames){if(expired()||!current())throw Error('Audio input is no longer current');yield {type:'frame' as const,audioInputId:request.audioInputId,frame};}yield {type:'end' as const,audioInputId:request.audioInputId,nextSequence:frames.length,sampleCount:frames.reduce((n,f)=>n+f.sampleCount,0)};};
    try{
      let transcript:string|undefined,succeeded=false;
      for await(const event of failure.stream('recognition',()=>this.deps.stt.transcribe({deadlineAt:new Date(recognitionDeadline).toISOString(),now:()=>new Date().toISOString()},audio(),controller.signal))){
        if(expired()||!current())throw Error('Audio input is no longer current');
        if(event.kind==='terminal'){if(event.outcome!=='succeeded')throw failure.capture(Error('Speech recognition did not succeed'),'recognition',providerFailureCode(event.outcome));succeeded=true;}
        if(event.kind==='data'&&event.payload.type==='committed'&&transcript===undefined)transcript=event.payload.text;
      }
      if(expired()||!current())throw Error('Audio input is no longer current');
      if(!succeeded)throw failure.capture(Error('Speech recognition returned no successful terminal'),'recognition','missing_terminal');
      if(!transcript?.trim())throw failure.capture(Error('Speech input did not produce a committed transcript'),'recognition','invalid_response');
      audit.event('asr_end',{characters:transcript.length});audit.content('speech_text',transcript,'input');audit.event('prepare_begin');
      const prepared=failure.at('preparation',()=>this.deps.prepare?.({...(request.assistantId?{assistantId:request.assistantId}:{}),...(request.relationshipId?{relationshipId:request.relationshipId}:{}),endpointId:request.endpointId,userInput:transcript!}));
      audit.bindPrepared(prepared);audit.event('prepare_end');
      if(expired()||!current()||prepared&&!prepared.isCurrent())throw failure.capture(Error('Audio input changed before transcript admission'),'admission','scope_changed');
      const conversation=prepared?.conversation,priorConversation=conversation?.read();
      conversation?.remember({interactionId:traceId,role:'user',text:transcript});
      observeConversation(conversation,{interactionId:traceId,role:'user',modality:'voice',state:'completed',...(transcript.length<=32768?{text:transcript}:{})});
      input.admitted=true;
      send(this.socket,{type:'transcript',interactionTraceId:traceId,inputSequence,transcriptRevision:1,state:'committed',text:transcript});
      return {...input,transcript,prepared,conversation,priorConversation,deadlineAt,failure};
    }catch(error){
      const failureOrigin=failure.report(error,input.scopeChanged?{stage:'admission',code:'scope_changed'}:this.closed?{stage:'transport',code:'disconnected'}:timedOut?{stage:'recognition',code:'provider_timeout'}:controller.signal.aborted?{stage:'transport',code:'cancelled'}:undefined);
      const interrupted=controller.signal.aborted&&!timedOut;
      response(this.socket,traceId,0,{type:'terminal',state:interrupted?'interrupted':'failed',finalResponse:null,failureOrigin,error:problem(interrupted?'audio_interrupted':'audio_turn_failed','Voice input was not admitted.',traceId,!interrupted)});
      return undefined;
    }finally{clearTimeout(timer);}
  }
  private async runTurn(frames:AudioFrame[],inputSequence:number):Promise<boolean>{
    const request=this.request;let committed=false,input:OrderedInput|undefined;
    try{
      if(!request||!this.ensureInputCurrent(request)||!request.continuationMode&&this.controller)return false;
      await audit.runTurn(this.socket,request,async()=>{
        if(!request.continuationMode){committed=await this.runAuditedTurn(frames,request,inputSequence);return;}
        input={traceId:randomUUID(),inputSequence,controller:new AbortController(),admitted:false,scopeChanged:false};this.recognition=input;
        const admitted=await this.recognizeOrderedInput(frames,request,input);if(!admitted)return;
        committed=true;frames.length=0;
        const interrupted=()=>admitted.controller.signal.aborted||inputSequence<=this.supersededInputsThrough;
        try{
          if(interrupted())throw Error('Reply superseded by continued input');
          const prior=this.outputSettlement;if(prior)await waitForPreviousOutput(prior,AbortSignal.any([this.lifetime.signal,admitted.controller.signal]));
          if(interrupted())throw Error('Reply superseded by continued input');
          if(!this.ensureInputCurrent(request))throw Error('Audio input is no longer current');
          await this.runAuditedTurn(frames,request,inputSequence,admitted);
        }catch(error){
          const cancelled=interrupted()||this.closed||input.scopeChanged;
          const failureOrigin=admitted.failure.report(error,cancelled?{stage:input.scopeChanged?'admission':'transport',code:input.scopeChanged?'scope_changed':this.closed?'disconnected':'cancelled'}:{stage:'settlement',code:'stalled'});
          response(this.socket,admitted.traceId,0,{type:'terminal',state:cancelled?'interrupted':'failed',finalResponse:null,failureOrigin,error:problem(cancelled?'audio_interrupted':'audio_previous_output_unsettled',cancelled?'Reply superseded or input scope ended.':'Input was retained, but earlier output has not settled.',admitted.traceId,!cancelled)});
        }
      });
      return committed;
    }finally{frames.length=0;if(input&&this.recognition===input)this.recognition=undefined;}
  }
  private async runAuditedTurn(frames: AudioFrame[],request:AudioRequest,inputSequence:number,admitted?:OrderedAdmission): Promise<boolean> {
    this.activeInputSequence=inputSequence;this.inputAdmitted=!!admitted;
    this.controller = admitted?.controller??new AbortController(); this.interactionTraceId = admitted?.traceId??randomUUID(); this.sequence = 0;
    const traceId = this.interactionTraceId; const deadlineAt = admitted?.deadlineAt??new Date(Date.now() + VOICE_TURN_DEADLINE_MS).toISOString();
    const controller = this.controller;const failure=admitted?.failure??new VoiceFailureTracker(traceId,this.deps.failureDiagnostic);if(!admitted){audit.bindTrace(traceId);audit.event("asr_begin");for(const frame of frames)audit.pcm("input_audio",frame);}
    let timedOut = false, internalFailure = false,invoked=false,readyToInvoke=false,activeTurn=false,transcriptCommitted=!!admitted;
    let progressWindow:ReturnType<typeof textProgressWindow>|undefined;
    let evidence=startVisualTurnEvidence(undefined,traceId,'audio'),outcome:VisualTurnOutcome='failed';
    let conversation:HostRuntimeInput['conversation'],priorConversation:string|undefined,historyStarted=false,historyTerminal=false;
    const finishHistory=(state:'completed'|'failed'|'interrupted')=>{
      if(!historyStarted||historyTerminal)return;historyTerminal=true;
      observeConversation(conversation,{interactionId:traceId,role:'assistant',modality:'voice',state});
    };
    this.turnInvalidated=false;
    let outputLease:AudioOutputLease|undefined, playback:AudioPlayback|undefined, producerSettlement:Promise<void>|undefined, producerSettled=true;
    const timer = setTimeout(() => { if(activeTurn){if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'audio-turn-target-missed',interactionId:traceId,targetMs:VOICE_TURN_DEADLINE_MS}));return;}timedOut = true; controller.abort(); }, Math.max(1,Date.parse(deadlineAt)-Date.now()));
    if(!admitted)send(this.socket, { type: "turnStarted", interactionTraceId: traceId,...(request.continuationMode?{inputSequence}: {}) });
    const current = () => this.ensureInputCurrent(request);
    const audio = async function* () { for (const frame of frames) { if (!current()) throw new Error("Audio input scope changed before recognition consumed the frame."); yield { type: "frame" as const, audioInputId: request.audioInputId, frame }; } yield { type: "end" as const, audioInputId: request.audioInputId, nextSequence: frames.length, sampleCount: frames.reduce((total, frame) => total + frame.sampleCount, 0) }; }();
    try {
      let transcript=admitted?.transcript??'',transcriptSeen=!!admitted;
      if(!admitted){
      const diagnostic=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1',recognitionBegan=diagnostic?performance.now():0;
      let consumedFrames=0,consumedSamples=0,partialEvents=0,committedEvents=0,committedCharacters=0,providerTerminal='unreported',recognitionOutcome='failed';
      let inputSamples=0,energy=0,peak=0;
      if(diagnostic)for(const frame of frames){const bytes=Buffer.from(frame.dataBase64,'base64');try{for(let offset=0;offset<bytes.length;offset+=2){const value=bytes.readInt16LE(offset);energy+=value*value;peak=Math.max(peak,Math.abs(value));inputSamples++;}}finally{bytes.fill(0);}}
      const countedAudio=async function*(){for await(const item of audio){if(item.type==='frame'){consumedFrames++;consumedSamples+=item.frame.sampleCount;}yield item;}};
      try{
      for await (const stt of this.deps.stt.transcribe({ deadlineAt: new Date(Math.min(Date.parse(deadlineAt), Date.now() + 30_000)).toISOString(), now: () => new Date().toISOString() }, diagnostic?countedAudio():audio, this.controller.signal)) {
        if (controller.signal.aborted) throw new Error("audio turn interrupted");
        if (!current()) throw new Error("Audio input scope changed during recognition.");
        if(stt.kind==='terminal')providerTerminal=['succeeded','rejected','cancelled','timedOut','failed'].includes(stt.outcome)?stt.outcome:'unreported';
        if(stt.kind==='data'){if(stt.payload.type==='partial')partialEvents++;if(stt.payload.type==='committed'){committedEvents++;committedCharacters+=stt.payload.text.length;}}
        if (stt.kind === "terminal" && stt.outcome !== "succeeded") throw failure.capture(new Error(`Speech recognition ${stt.outcome}; check the selected STT service and retry this turn.`),'recognition',providerFailureCode(stt.outcome));
        if (stt.kind !== "data" || stt.payload.type !== "committed" || transcriptSeen) continue;
        transcript = stt.payload.text;transcriptSeen=true;
        if(!request.continuationMode)send(this.socket, { type: "transcript", interactionTraceId: traceId, state: "committed", text: stt.payload.text });
      }
      // Finish recognition and its transport/deadline before starting the
      // independently bounded inference/speech phases. Never emit a completed
      // answer and only then discover a failed recognition terminal.
      if (controller.signal.aborted) throw new Error("audio turn interrupted");
      if (!current()) throw new Error("Audio input scope changed after recognition.");
      if(request.continuationMode&&providerTerminal!=='succeeded')throw failure.capture(new Error('Speech recognition returned no successful terminal'),'recognition','missing_terminal');
      if (transcript === undefined || !transcript.trim()){recognitionOutcome='empty';throw failure.capture(new Error("speech input did not produce a committed transcript"),'recognition','invalid_response');}
      if (controller.signal.aborted) throw new Error("audio turn interrupted");
      recognitionOutcome='recognized';audit.event("asr_end",{characters:transcript.length});audit.content("speech_text",transcript,"input");audit.event("prepare_begin");
      }catch(error){throw failure.capture(error,'recognition','provider_failed');}finally{
        // Counts and signal levels from the already admitted volatile input only.
        // Never log PCM, transcript text, device identity or provider messages.
        if(diagnostic)try{console.info(JSON.stringify({event:'audio-recognition-summary',interactionId:traceId,observedAtMs:Date.now(),elapsedMs:Math.round((performance.now()-recognitionBegan)*100)/100,committedFrames:frames.length,committedSamples:inputSamples,inputDurationMs:inputSamples/16,consumedFrames,consumedSamples,inputRms:Math.round(Math.sqrt(energy/Math.max(1,inputSamples))/32768*1e6)/1e6,inputPeak:peak/32768,partialEvents,committedEvents,committedCharacters,providerTerminal,outcome:this.turnInvalidated?'invalidated':controller.signal.aborted?'cancelled':recognitionOutcome}));}catch{/* Diagnostics cannot change recognition or its original terminal. */}
      }
        this.currentInput = failure.at('preparation',()=>this.deps.prepare?.({ ...(request.assistantId ? { assistantId: request.assistantId } : {}), ...(request.relationshipId ? { relationshipId: request.relationshipId } : {}), endpointId: request.endpointId, userInput: transcript }));
        audit.bindPrepared(this.currentInput);audit.event('prepare_end');evidence=startVisualTurnEvidence(this.currentInput?.visualTurnEvidence,traceId,'audio');this.currentEvidence=evidence;
      }else{
        this.currentInput=admitted.prepared;conversation=admitted.conversation;priorConversation=admitted.priorConversation;
        evidence=startVisualTurnEvidence(this.currentInput?.visualTurnEvidence,traceId,'audio');this.currentEvidence=evidence;
      }

        if (this.currentInput?.prepareMemory) {audit.event("memory_begin");await failure.during('memory',()=>prepareHostMemory(this.currentInput!, controller.signal));audit.event("memory_end");}
        if (this.currentInput?.prepareWorld) {audit.event("world_begin");await failure.during('world',()=>prepareHostWorld(this.currentInput!, controller.signal));audit.event("world_end");}
        const turnInput=this.currentInput;
        const admissionCurrent=()=>{
          if(!activeTurn&&Date.now()>=Date.parse(deadlineAt)){timedOut=true;controller.abort();playback?.interrupt();return false;}
          return !controller.signal.aborted&&current()&&this.currentInput===turnInput&&(!turnInput||turnInput.isCurrent())&&(!turnInput?.admitWorld||turnInput.admitWorld())&&(!outputLease||outputLease.current());
        };
        const finalized = failure.at('admission',()=>finalizePreparedTurn({ ...(this.currentInput?.visualSelection?{visualOmissions:this.currentInput.visualSelection.omissions}:{}), ...(this.currentInput?.preparedTurnBinding?{preparedTurnBinding:this.currentInput.preparedTurnBinding}:{}), ...(this.currentInput?.preparedVisualContext?{preparedVisualContext:this.currentInput.preparedVisualContext}:{}), ...(this.currentInput?.preparedWorldContext ? { preparedWorldContext: this.currentInput.preparedWorldContext } : {}), ...(this.currentInput?.capabilityContext ? { capabilities: this.currentInput.capabilityContext } : {}), assistantId: this.currentInput?.assistantId ?? this.identity.assistantId, sessionId: request.sessionId, interactionId: traceId, endpointId: this.currentInput?.endpointId ?? request.endpointId, userInput: transcript, ...(this.currentInput?.conversation?{conversation:priorConversation??this.currentInput.conversation.read()}:{}), deadlineAt, executionMode: "live", voiceMode: true, ...(this.currentInput ? { runtimeSelfContext: this.currentInput.runtimeSelfContext, ...(this.currentInput.profileProjection ? { profileProjection: this.currentInput.profileProjection } : {}), ...(this.currentInput.preparedRelationshipContext ? { preparedRelationshipContext: this.currentInput.preparedRelationshipContext } : {}) } : {}), ...(this.currentInput?.experienceSelection?{experienceSelection:this.currentInput.experienceSelection}:{}) },admissionCurrent));
        const prompt=failure.at('admission',()=>requestForFinalizedTurn(finalized,turnInput?.preparedTurnBinding,admissionCurrent));
        evidence.finalized(finalized,prompt);
        outputLease=failure.at('admission',()=>this.deps.outputLease?.(turnInput?.endpointId??request.endpointId,deadlineAt));
        if(outputLease){audit.event("lease_acquired");playback=this.playback=new AudioPlayback(traceId,deadlineAt,()=>{if(playback?.deadlineExpired)evidence.endpointSettled('timeout');else evidence.playbackFenced(this.closed?'disconnected':this.turnInvalidated?'invalidated':'cancelled');controller.abort();send(this.socket,{type:"stopPlayback",interactionTraceId:traceId,reason:"endpoint_playback_stopped_or_expired"});},turnInput?.admitActiveTurn?textGenerationTiming.noProgressMs:undefined);this.outputSettlement=playback.settled;}
        if(!request.continuationMode){
          conversation=this.currentInput?.conversation;conversation?.remember({interactionId:traceId,role:"user",text:transcript});
          observeConversation(conversation,{interactionId:traceId,role:'user',modality:'voice',state:'completed',...(transcript.length<=32768?{text:transcript}:{})});
        }
        this.currentInput?.sourceBegin?.(traceId,'voice');if(this.currentInput?.sourceNotice)send(this.socket,{type:'sourceContextNotice',interactionTraceId:traceId,notice:this.currentInput.sourceNotice});
        historyStarted=true;observeConversation(conversation,{interactionId:traceId,role:'assistant',modality:'voice',state:'accepted'});
        let answer = "";
        let observedAnswer="",allTextEmitted=true;
        const segmenter = new SpeechSafeSegmenter(360,{firstClauseMinChars:64,deterministicBoundaries:true});
        const router = new VoiceResponseRouter();
        const producerFramer=new VoiceProducerFramer();
        let previousChannel: "speech" | "display" | undefined;
        controller.signal.addEventListener("abort",()=>{producerFramer.cancel();router.cancel();segmenter.cancel();},{once:true});
        const queue = new SpeechQueue(controller.signal,{maximumQueuedCharacters:VOICE_RESPONSE_TEXT_LIMIT});
        const pacer = new PcmPacer();
        const decisionId = randomUUID();
        const tts = failure.at('synthesis',()=>this.voiceSettings.description || this.voiceSettings.seed !== 0 || this.voiceSettings.reference ? this.deps.tts.withVoiceDesign({ description: this.voiceSettings.description, seed: this.voiceSettings.seed, reference: synthesisReference(this.voiceSettings) }) : this.deps.tts);
        const voiceSettings=this.voiceSettings,voiceProfile=request.voiceSettings!==undefined?{voiceRef:"session-preview",revision:1}:this.voiceBinding?.voiceProfile??{voiceRef:"configured-default",revision:1};
        const speak = async function* (text: string) {try{
        const speechDeadlineAt = new Date(activeTurn?Date.now()+SPEECH_SEGMENT_DEADLINE_MS:Math.min(Date.parse(deadlineAt), Date.now() + SPEECH_SEGMENT_DEADLINE_MS)).toISOString();
        const segmentId = randomUUID();audit.event("tts_begin",{characters:text.length});audit.content("speech_text",text,"output");
        let speechSucceeded = false;
        let speechSamples = 0;
        if(!admissionCurrent())throw failure.capture(new Error('Audio source or output authority changed before synthesis'),'synthesis','scope_changed');
        for await (const speech of tts.synthesize({ contractVersion: "2.0.0", text, segmentId, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 }, voiceProfile, decision: { decisionId, revision: 1 }, delivery: { interactionId: traceId, segmentId, decisionId, decisionRevision: 1, deliveryMode: voiceSettings.deliveryMode, urgency: "normal", pace: voiceSettings.pace, energy: voiceSettings.energy }, deadlineAt: speechDeadlineAt }, controller.signal)) {
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if(speech.kind === "preAudio")audit.event("tts_pre_audio");if (speech.kind === "data") { audit.event("tts_pcm",{samples:speech.frame.sampleCount});audit.pcm("output_audio",speech.frame);speechSamples += speech.frame.sampleCount; yield speech; }
          if (speech.kind === "terminal") {audit.event("tts_terminal",{outcome:speech.outcome,samples:speechSamples});
            if (speech.outcome !== "succeeded") throw failure.capture(new Error(`speech synthesis ${speech.outcome}`),'synthesis',providerFailureCode(speech.outcome));
            speechSucceeded = true;
          }
        }
        if (!speechSucceeded) throw failure.capture(new Error("speech synthesis returned no successful terminal"),'synthesis','missing_terminal');
        if (!speechSamples) throw failure.capture(new Error("speech synthesis returned no audio"),'synthesis','no_audio');
        if (controller.signal.aborted) throw new Error("audio turn interrupted");

        }catch(error){throw failure.capture(error,'synthesis','provider_failed');}};
        const generation = (async () => {
        this.invalidateIfStale();if(controller.signal.aborted)throw new Error('audio turn interrupted');
        if (this.currentInput?.admitWorld && !this.currentInput.admitWorld()) throw failure.capture(new Error("World context expired before speech inference admission"),'world','scope_changed');
        if(!controller.signal.aborted&&current()&&(!outputLease||outputLease.current())){try{const catalog=this.deps.acknowledgment?.(request);if(catalog?.clipIds.length){playback?.emittedOutput();send(this.socket,{type:'acknowledgment',interactionTraceId:traceId,catalog});}}catch{/* Optional cached presentation cannot fail an ordinary reply. */}}
        try{this.currentInput?.onInferenceRequest?.(prompt);}catch{/* Optional inclusion bookkeeping is not speech authority. */}
        this.invalidateIfStale();
        const admittedPrompt=failure.at('admission',()=>requestForFinalizedTurn(finalized,turnInput?.preparedTurnBinding,admissionCurrent));
        if(turnInput?.admitActiveTurn){if(!turnInput.admitActiveTurn())throw failure.capture(Error('Voice context is no longer eligible for admission'),'admission','scope_changed');activeTurn=true;progressWindow=textProgressWindow(controller);}
        if(turnInput?.admitMemory&&!turnInput.admitMemory())throw failure.capture(Error('Memory context is no longer eligible for admission'),'memory','scope_changed');
        readyToInvoke=true;audit.event("admission",{activeTurn:activeTurn?1:0,modality:"voice"});audit.event("generation_begin");
        const generate=this.deps.inference.generate;if(typeof generate!=='function')throw failure.capture(Error('Inference provider method is unavailable'),'inference','provider_unavailable');
        let stream:ReturnType<InferenceProvider['generate']>;
        try{stream=failure.at('inference',()=>Reflect.apply(generate,this.deps.inference,[admittedPrompt,{signal:controller.signal,...(activeTurn?{activeTurn:{noProgressMs:textGenerationTiming.noProgressMs}}:{})}]));}
        finally{invoked=true;evidence.providerInvoked();}
        const publishUnits=async(units:ReturnType<VoiceResponseRouter["push"]>)=>{
          for(const unit of units){
            this.invalidateIfStale();if(controller.signal.aborted)throw Error("Voice response cancelled");
            if(unit.channel==='display'&&previousChannel==='speech')for(const segment of segmenter.flush()){this.invalidateIfStale();if(controller.signal.aborted)throw Error('Voice response cancelled');await queue.put(segment.text);}
            const text=voiceUnitText(unit,previousChannel);previousChannel=unit.channel;
            answer+=text;if(answer.length>VOICE_RESPONSE_TEXT_LIMIT)throw failure.capture(Error("voice response text limit exceeded"),'framing','output_limit');
            if(response(this.socket,traceId,this.sequence++,{type:"textDelta",text})){
              evidence.emitted('text');observedAnswer+=text;
              observeConversation(conversation,{interactionId:traceId,role:'assistant',modality:'voice',state:'generating',text:observedAnswer});
            }else allTextEmitted=false;
            conversation?.remember({interactionId:traceId,role:"assistant",text:answer,observation:"emitted"});
            if(unit.channel==="speech")for(const segment of segmenter.push(text,{completeTextUnit:true})){this.invalidateIfStale();if(controller.signal.aborted)throw Error("Voice response cancelled");await queue.put(segment.text);}
          }
        };
        let terminalSeen=false;
        for await (const chunk of failure.stream('inference',()=>stream)) {
          this.invalidateIfStale();
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if (chunk.kind === "text" && chunk.text) { const text=chunk.text;if(activeTurn){if(outputLease?.qualifyProgress?outputLease.qualifyProgress()!==true:outputLease?.progress?.()===false)throw failure.capture(Error("Audio output ownership changed"),'delivery','scope_changed');progressWindow?.progress();playback?.progress();}await failure.during('framing',()=>publishUnits(failure.at('framing',()=>router.push(producerFramer.push(text)),'invalid_response')),'invalid_response'); }
          if (chunk.kind === "capabilityRequest" && chunk.capability?.effect === "read-only") response(this.socket, traceId, this.sequence++, { type: "capabilityStatus", result: { capabilityName: chunk.capability.name, state: "selected", effect: "read-only", outcome: "notDispatched" } });
          if(chunk.kind==='done'){terminalSeen=true;break;}
          if (chunk.kind === "error") throw failure.capture(new Error(chunk.error?.message ?? "inference failed"),'inference',providerFailureCode(chunk.error?.code));
        }
        audit.event('generation_end',{terminalSeen:terminalSeen?1:0,characters:answer.length});evidence.generationEnded(terminalSeen?'completed':'exhausted');
        if(!terminalSeen)throw failure.capture(Error("Voice generation ended without a terminal"),'inference','missing_terminal');
        await failure.during('framing',()=>publishUnits(failure.at('framing',()=>router.push(producerFramer.finish()),'invalid_response')),'invalid_response');
        await failure.during('framing',()=>publishUnits(failure.at('framing',()=>router.finish(),'invalid_response')),'invalid_response');
        if (!answer.trim()) throw failure.capture(new Error("inference returned no text"),'framing','invalid_response');
        if (controller.signal.aborted) throw new Error("audio turn interrupted");
        // Canonical text completion belongs to the closed generation, not later
        // synthesis or endpoint playback. Stop cannot relabel completed text.
        finishHistory(!allTextEmitted?'interrupted':terminalSeen?'completed':'failed');
        for (const segment of segmenter.flush()){this.invalidateIfStale();if(controller.signal.aborted)throw Error("Voice response cancelled");await queue.put(segment.text);}
        queue.close();
        if(terminalSeen&&allTextEmitted&&!controller.signal.aborted)this.queueReplyMetadata(turnInput,{interactionId:traceId,userText:transcript!,assistantText:answer,deadlineAt},controller.signal);
        })().catch(error => {error=failure.capture(error,'admission','failed');audit.event("generation_error");producerFramer.cancel();router.cancel();segmenter.cancel();evidence.generationEnded(this.closed?'disconnected':this.turnInvalidated?'invalidated':timedOut?'deadline':controller.signal.aborted?'cancelled':'failed');queue.close(error); throw error; });
        // Attach immediately; the consumer may still be producing PCM when
        // inference fails. Keep both activities bounded and settle both.
        void generation.catch(() => {});
        const synthesis=async function*(){for await(const text of queue)yield* speak(text);};
        try { for await (const speech of bufferedStream(synthesis(),controller.signal,64,()=>{if(!controller.signal.aborted){internalFailure=true;controller.abort();}},(pending,complete)=>{producerSettlement=pending;producerSettled=complete;})) {await pacer.admit(speech.frame.sampleCount,speech.frame.format.sampleRateHz,controller.signal);this.invalidateIfStale();const qualifyProgress=activeTurn?outputLease?.qualifyProgress:undefined;if(controller.signal.aborted||outputLease&&!(qualifyProgress?qualifyProgress.call(outputLease)===true:outputLease.current()))throw failure.capture(new Error("audio context or output lease changed"),'delivery','scope_changed');if(activeTurn){if(!qualifyProgress&&outputLease?.progress?.()===false)throw failure.capture(Error("Audio output ownership changed"),'delivery','scope_changed');progressWindow?.progress();playback?.progress();}playback?.emittedOutput(speech.frame.sampleCount);if(send(this.socket,{type:"audio",interactionTraceId:traceId,chunk:{segmentId:speech.segmentId,frame:speech.frame}}))evidence.emitted('audio');} await generation; }
        catch (error) { error=failure.capture(error,'delivery','failed');audit.event("tts_error");internalFailure ||= !controller.signal.aborted; controller.abort(); queue.close(error); await generation.catch(() => {}); throw error; }
        this.invalidateIfStale();if(controller.signal.aborted)throw new Error("audio input changed before completion");
        playback?.synthesized();evidence.synthesisCompleted();
        if (!playback) { try { this.currentInput?.onCompleted?.(traceId); } catch { /* Software emission only; no physical playback claim. */ } }
        outcome=this.outputConnected?'completed':'disconnected';
        response(this.socket, traceId, this.sequence++, { type: "terminal", state: "completed", finalResponse: null, error: null });
    } catch (error) {
      if(!activeTurn&&Date.now()>=Date.parse(deadlineAt)){timedOut=true;controller.abort();playback?.interrupt();}
      const stalled=controller.signal.reason instanceof Error&&controller.signal.reason.message==='inference_stalled';internalFailure ||= stalled;
      outcome=this.closed?'disconnected':this.turnInvalidated?'invalidated':timedOut?'deadline':controller.signal.aborted&&!internalFailure?'cancelled':'failed';
      const interrupted = this.controller.signal.aborted && !timedOut && !internalFailure;
      const failureOrigin=failure.report(error,this.turnInvalidated?{stage:'admission',code:'scope_changed'}:this.closed?{stage:'transport',code:'disconnected'}:stalled?{stage:'inference',code:'stalled'}:interrupted?{stage:'transport',code:'cancelled'}:timedOut?{stage:failure.origin(error).stage==='unknown'?'admission':failure.origin(error).stage,code:'deadline'}:undefined);
      response(this.socket, traceId, this.sequence++, { type: "terminal", state: interrupted ? "interrupted" : "failed", finalResponse: null, failureOrigin, error: problem(stalled?"audio_stalled":interrupted ? "audio_interrupted" : timedOut ? "audio_deadline_exceeded" : "audio_turn_failed", stalled?"Voice stopped making progress; you can try another turn.":timedOut ? "Voice setup exceeded its admission limit; you can try another turn." : error instanceof Error ? error.message : "audio turn failed", traceId, !interrupted) });
    } finally {
      finishHistory(['cancelled','disconnected','invalidated'].includes(outcome)?'interrupted':'failed');
      if(!invoked)evidence.rejected(readyToInvoke?'provider_unavailable':outcome==='deadline'?'deadline':outcome==='cancelled'?'cancelled':'context_unavailable');evidence.ended(outcome);
      clearTimeout(timer);progressWindow?.close();
      audit.event("turn_finally",{outcome});const release=()=>{try{if(outputLease){outputLease.release();audit.forTrace(traceId,"lease_released",{outcome});}}catch(error){failure.report(failure.capture(error,'settlement'));}finally{this.currentEvidence=undefined;this.controller=undefined;this.interactionTraceId=undefined;this.currentInput=undefined;this.playback=undefined;this.outputSettlement=undefined;this.activeInputSequence=0;this.inputAdmitted=false;}};
      if(playback){
        const guard=playback;
        if(producerSettlement&&!producerSettled)void producerSettlement.catch(()=>undefined).then(()=>guard.producerSettled());else guard.producerSettled();
        void guard.settled.then(release);
      }else release();
    }
    return transcriptCommitted;
  }
}
import {PcmPacer} from './pcm-pacer.ts';
import {bufferedStream} from './buffered-stream.ts';
