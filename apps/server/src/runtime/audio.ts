import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import { SpeechSafeSegmenter } from "@lifestream/runtime/voice/segmenter";
import { buildCanonicalPrompt } from "@lifestream/runtime/inference/prompt";
import type { AudioFrame, SpeechToTextProvider } from "@lifestream/runtime/voice";
import type { VoxCpmProvider } from "@lifestream/providers-voxcpm";
import { defaultVoiceSettings, parseVoiceSettings, type VoiceSettings } from "./voice-settings.ts";
import { SpeechQueue } from "./speech-queue.ts";
import type { HostRuntimeInput } from "./inference.ts";
import {validateAudioFrame} from "@lifestream/runtime/voice";

type AudioRequest = { schemaVersion: "1.0.0"; requestId: string; correlationId: string; sessionId: string; expectedSessionRevision: number; endpointId: string; audioInputId: string; format: AudioFrame["format"]; voiceSettings?: VoiceSettings; assistantId?: string; relationshipId?: string };
type AudioClientMessage = { type: "start"; request: AudioRequest } | { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "commitTurn"; audioInputId: string; nextSequence: number; sampleCount: number } | { type: "interrupt"; interactionTraceId: string; reason: string } | { type: "stop"; audioInputId: string };
type AudioSocket = Pick<WebSocket, "send" | "close"> & { readyState: number };
const OPEN = 1;
const send = (socket: AudioSocket, message: Record<string, unknown>) => { if (socket.readyState === OPEN) socket.send(JSON.stringify(message)); };
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const response = (socket: AudioSocket, interactionTraceId: string, sequence: number, payload: Record<string, unknown>) => send(socket, { type: "response", event: { schemaVersion: "1.0.0", interactionTraceId, sequence, occurredAt: new Date().toISOString(), payload } });
const problem = (code: string, message: string, correlationId: string, retryable = false) => ({ code, message, retryable, correlationId, details: {} });
export const hasAudioEnergy = (dataBase64: string, threshold = 0.015): boolean => { const bytes = Buffer.from(dataBase64, "base64"); if (bytes.length < 2) return false; let energy = 0; for (let offset = 0; offset + 1 < bytes.length; offset += 2) { const sample = bytes.readInt16LE(offset) / 32768; energy += sample * sample; } return Math.sqrt(energy / (bytes.length / 2)) >= threshold; };

export const VOICE_TURN_DEADLINE_MS = 180_000;
export const SPEECH_SEGMENT_DEADLINE_MS = 45_000;
export type AudioOutputLease={current:()=>boolean;release:()=>void};
export type AudioDependencies = { stt: SpeechToTextProvider; inference: InferenceProvider; tts: VoxCpmProvider; inputCurrent?: (request: AudioRequest) => boolean; foregroundStarted?: (request:{assistantId?:string;relationshipId?:string})=>(()=>void); outputLease?: (endpointId:string,deadlineAt:string)=>AudioOutputLease; prepare?: (request: { assistantId?: string; relationshipId?: string; userInput: string; endpointId: string }) => HostRuntimeInput };
export type OutputOnlySpeech={conversation?:{assistantId:string;relationshipId:string;opportunityId:string;current:()=>boolean};text:string;interactionId:string;endpointId:string;deadlineAt:string;warmth:number;signal:AbortSignal;current:()=>boolean;beforeEmission:()=>void;emitted:()=>void;synthesized?:(signal:AbortSignal)=>Promise<void>;interrupted?:(reason:"expired"|"cancelled")=>void};

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
  private conversationTurns:Array<{assistantId:string;relationshipId:string|null;interactionId:string;role:"user"|"assistant";text:string;opportunityId?:string;current:()=>boolean}>=[];
  private rememberTurn(input:typeof this.conversationTurns[number]):void{
    this.conversationTurns=this.conversationTurns.filter(turn=>{try{return turn.current();}catch{return false;}});
    const previous=this.conversationTurns.findIndex(turn=>turn.interactionId===input.interactionId&&turn.role===input.role);
    if(previous>=0)this.conversationTurns.splice(previous,1);
    this.conversationTurns.push({...input,text:input.text.slice(-16000)});
    while(this.conversationTurns.length>20||this.conversationTurns.reduce((sum,turn)=>sum+Buffer.byteLength(turn.text,"utf8"),0)>60000)this.conversationTurns.shift();
  }
  private conversation(assistantId:string,relationshipId?:string):string{
    this.conversationTurns=this.conversationTurns.filter(turn=>{try{return turn.current();}catch{return false;}});
    const turns=this.conversationTurns.filter(turn=>turn.assistantId===assistantId&&turn.relationshipId===(relationshipId??null)).map(({role,text,opportunityId})=>({role,text,...(opportunityId?{opportunityId,observation:"emitted; reception not established"}:{})}));
    while(Buffer.byteLength(JSON.stringify(turns),"utf8")>65536)turns.shift();return JSON.stringify(turns);
  }
  private request: AudioRequest | undefined;
  private frames: AudioFrame[] = [];
  private controller: AbortController | undefined;
  private interactionTraceId: string | undefined;
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly lifetime=new AbortController();
  private pendingTurns = 0;
  private starting = false;
  private outputSettlement:Promise<void>|undefined;
  private voiceSettings: VoiceSettings = { ...defaultVoiceSettings };
  private sequence = 0;
  private currentInput: HostRuntimeInput | undefined;
  private readonly identity: { assistantId: string; environmentId: string; conversationId: string } = { assistantId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID() };

  constructor(socket: AudioSocket, deps: AudioDependencies, sessionId: string) { this.socket = socket; this.deps = deps; this.sessionId = sessionId; }

  belongsTo(sessionId:string):boolean{return this.sessionId===sessionId;}
  get outputConnected():boolean{return !this.closed&&this.socket.readyState===OPEN;}
  get outputAvailable():boolean{return this.outputConnected&&!this.controller&&!this.starting&&!this.pendingTurns;}
  /** Uses the established output transport without a start/input request, STT,
   * fabricated transcript or second inference call. Host policy owns admission. */
  async speakOutputOnly(input:OutputOnlySpeech):Promise<{samples:number;frames:number;mappingRevision:string;warmth:"unsupported";degradedDimensions:string[]}>{
    if(!this.outputAvailable||!this.deps.outputLease||!validUuid(input.interactionId)||!validUuid(input.endpointId)||!input.text.trim()||input.text.length>4000||!Number.isFinite(input.warmth)||input.warmth<0||input.warmth>1||input.current()!==true||input.signal.aborted)throw new Error("Output-only speech is unavailable");
    const deadline=Math.min(Date.parse(input.deadlineAt),Date.now()+SPEECH_SEGMENT_DEADLINE_MS);
    if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error("Output-only speech expired");
    const lease=this.deps.outputLease(input.endpointId,new Date(deadline).toISOString()),controller=new AbortController(),signal=AbortSignal.any([controller.signal,input.signal]);
    let settledOutput:()=>void=()=>{};this.outputSettlement=new Promise<void>(resolve=>{settledOutput=resolve;});
    this.controller=controller;this.interactionTraceId=input.interactionId;this.sequence=0;this.currentInput=undefined;
    const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
    let samples=0,frames=0,started=false,done=false,terminalSent=false,mappingRevision="unknown",settlement:Promise<void>|undefined,settled=false;
    const degraded=new Set<string>(["warmth"]),pacer=new PcmPacer(),segmentId=randomUUID(),decisionId=randomUUID();
    const current=()=>!this.closed&&this.socket.readyState===OPEN&&!signal.aborted&&Date.now()<deadline&&input.current()===true&&lease.current();
    const request={contractVersion:"2.0.0" as const,text:input.text,segmentId,format:{encoding:"pcm_s16le" as const,sampleRateHz:48000 as const,channels:1 as const},voiceProfile:{voiceRef:"fixture-voice-design",revision:1},decision:{decisionId,revision:1},delivery:{interactionId:input.interactionId,segmentId,decisionId,decisionRevision:1,deliveryMode:this.voiceSettings.deliveryMode,urgency:"low",pace:this.voiceSettings.pace,energy:this.voiceSettings.energy},deadlineAt:new Date(deadline).toISOString()};
    try{
      if(!current())throw new Error("Output-only ownership changed");
      const tts=this.deps.tts.withoutAdmissionRetries();
      for await(const event of bufferedStream(tts.synthesize(request,signal),signal,64,()=>controller.abort(),(pending,complete)=>{settlement=pending;settled=complete;})){
        if(!current()||done)throw new Error("Output-only speech became stale or emitted after terminal");
        if(mappingRevision!=="unknown"&&event.mappingRevision!==mappingRevision)throw new Error("Speech mapping changed");mappingRevision=event.mappingRevision;
        if(event.kind==="preAudio"){for(const d of event.degradedDimensions)degraded.add(d);continue;}
        if(event.kind==="terminal"){
          if(event.outcome!=="succeeded"||event.outputSamples!==samples||event.frameCount!==frames||!samples)throw new Error("Speech did not produce complete audio");
          for(const d of event.degradedDimensions)degraded.add(d);done=true;continue;
        }
        validateAudioFrame(event.frame,request.format);
        if(event.frame.sampleOffset!==samples||event.frame.sequence!==frames||Buffer.from(event.frame.dataBase64,"base64").length!==event.frame.sampleCount*2||samples+event.frame.sampleCount>48000*60)throw new Error("Speech frame accounting is invalid");
        await pacer.admit(event.frame.sampleCount,event.frame.format.sampleRateHz,signal);if(!current())throw new Error("Audio lease or policy changed before emission");
        if(!started){input.beforeEmission();if(!current())throw new Error("Output-only admission changed");response(this.socket,input.interactionId,this.sequence++,{type:"textDelta",text:input.text});started=true;input.emitted();if(input.conversation)this.rememberTurn({assistantId:input.conversation.assistantId,relationshipId:input.conversation.relationshipId,opportunityId:input.conversation.opportunityId,interactionId:input.interactionId,role:"assistant",text:input.text,current:input.conversation.current});}
        if(!current())throw new Error("Output-only ownership changed");
        send(this.socket,{type:"audio",interactionTraceId:input.interactionId,chunk:{segmentId:event.segmentId,frame:event.frame}});samples+=event.frame.sampleCount;frames++;
      }
      if(!done||!current())throw new Error("Output-only speech has no current successful terminal");
      response(this.socket,input.interactionId,this.sequence++,{type:"terminal",state:"completed",finalResponse:null,error:null});terminalSent=true;
      if(input.synthesized)await input.synthesized(signal);
      if(!current())throw new Error("Output-only playback was interrupted or expired");
      return {samples,frames,mappingRevision,warmth:"unsupported",degradedDimensions:[...degraded]};
    }catch(error){
      const cancelled=signal.aborted||!input.current()||!lease.current();if(cancelled)input.interrupted?.(Date.now()>=deadline?"expired":"cancelled");controller.abort();if(started)send(this.socket,{type:"stopPlayback",interactionTraceId:input.interactionId,reason:"output_only_cancelled_or_failed"});
      if(!terminalSent)response(this.socket,input.interactionId,this.sequence++,{type:"terminal",state:cancelled?"interrupted":"failed",finalResponse:null,error:problem("output_only_stopped","Output-only speech stopped; playback completion is not established.",input.interactionId)});throw error;
    }finally{clearTimeout(timer);controller.abort();const release=()=>{lease.release();this.controller=undefined;this.interactionTraceId=undefined;this.outputSettlement=undefined;settledOutput();};if(settlement&&!settled)void settlement.catch(()=>undefined).then(release);else release();}
  }

  close(): void { this.closed = true;this.lifetime.abort(); this.frames = [];this.conversationTurns=[]; this.voiceSettings = { ...defaultVoiceSettings }; this.request = undefined; this.controller?.abort(); this.socket.close(1001, "audio session closed"); }
  private ensureInputCurrent(request = this.request): boolean {
    if (!request) return !this.closed;
    let current = false;
    try { current = !this.closed && (this.deps.inputCurrent?.(request) ?? true); } catch { /* Failed authority lookup is not current input. */ }
    if (current) return true;
    if (!this.closed) {
      send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_input_scope_changed", "Audio session revision, endpoint or authority changed; reconnect microphone using the current session.", request.correlationId) });
      if (this.interactionTraceId) send(this.socket, { type: "stopPlayback", interactionTraceId: this.interactionTraceId, reason: "audio_input_scope_changed" });
      this.close();
    }
    return false;
  }
  invalidateIfStale(): void { if (!this.ensureInputCurrent()) return; if (this.currentInput && !this.currentInput.isCurrent()) { this.controller?.abort(); if (this.interactionTraceId) send(this.socket, { type: "stopPlayback", interactionTraceId: this.interactionTraceId, reason: "runtime_input_stale" }); } }

  async message(raw: string): Promise<void> {
    if (this.closed) return;
    let message: AudioClientMessage;
    try { message = JSON.parse(raw) as AudioClientMessage; } catch { this.socket.close(1003, "malformed JSON"); return; }
    if (message.type === "start") return this.start(message.request);
    if (message.type === "interrupt") { if (message.interactionTraceId === this.interactionTraceId) { this.controller?.abort(); send(this.socket, { type: "stopPlayback", interactionTraceId: message.interactionTraceId, reason: message.reason }); } return; }
    const request = this.request;
    if (!request || ((message.type === "frame" || message.type === "commitTurn" || message.type === "stop") && message.audioInputId !== request.audioInputId)) return send(this.socket, { type: "error", requestId: request?.requestId ?? randomUUID(), problem: problem("audio_input_identity_changed", "audio input identity changed", request?.correlationId ?? randomUUID()) });
    if (!this.ensureInputCurrent(request)) return;
    if (message.type === "frame") {
      const expectedSamples = this.sampleCount();
      if (message.frame.sequence !== this.frames.length || message.frame.sampleOffset !== expectedSamples || message.frame.format.encoding !== "pcm_s16le" || message.frame.format.sampleRateHz !== 16000 || message.frame.format.channels !== 1 || message.frame.sampleCount < 1 || message.frame.sampleCount > 4800 || Buffer.from(message.frame.dataBase64, "base64").length !== message.frame.sampleCount * 2) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_frame_invalid", "audio frame sequence, format, offset, or payload is invalid", request.correlationId) });
      if (expectedSamples + message.frame.sampleCount > 480_000) { send(this.socket, { type: "error", problem: problem("audio_input_limit", "Utterance exceeds 30 seconds; reconnect voice.", request.correlationId) }); this.close(); return; }
      // Audio energy is not speech. The endpoint sends an explicit interrupt
      // after speech qualification; this route must not bypass that gate.
      this.frames.push(message.frame); return;
    }
    if (message.type === "stop") { this.close(); return; }
    if (message.type !== "commitTurn") return;
    if (message.nextSequence !== this.frames.length || message.sampleCount !== this.sampleCount()) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_commit_invalid", "audio commit accounting is invalid", request.correlationId) });
    const frames = this.frames.slice(); this.frames = [];
    if (!frames.length || this.pendingTurns >= 3) { send(this.socket, { type: "error", problem: problem("audio_queue_limit", "Voice queue is full or empty input was committed; reconnect voice.", request.correlationId) }); this.close(); return; }
    const releaseForeground=this.deps.foregroundStarted?.(request);this.controller?.abort();
    const priorOutput=this.outputSettlement;this.pendingTurns++;
    this.turnQueue = this.turnQueue.then(async () => { if(priorOutput){
      try{await waitForPreviousOutput(priorOutput,this.lifetime.signal);}
      catch(error){send(this.socket,{type:"error",requestId:request.requestId,problem:problem("audio_previous_output_unsettled",error instanceof Error?error.message:"Previous output is unavailable",request.correlationId)});return;}
    }await this.runTurn(frames); }).finally(() => { this.pendingTurns--;releaseForeground?.(); });
    await this.turnQueue;
  }

  private async start(request: AudioRequest): Promise<void> {
    if (this.starting || this.request || !request || request.sessionId !== this.sessionId || request.schemaVersion !== "1.0.0" || !validUuid(request.requestId) || !validUuid(request.correlationId) || !validUuid(request.sessionId) || !validUuid(request.endpointId) || !validUuid(request.audioInputId) || !Number.isInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0 || request.format?.encoding !== "pcm_s16le" || request.format.sampleRateHz !== 16000 || request.format.channels !== 1) { this.close(); return; }
    if (!this.ensureInputCurrent(request)) return;
    this.starting = true;
    let settings: VoiceSettings;
    try { settings = parseVoiceSettings(request.voiceSettings); }
    catch (error) { send(this.socket, { type: "error", problem: { message: error instanceof Error ? error.message : "Invalid voice settings" } }); this.close(); return; }
    if (settings.description || settings.seed !== 0 || settings.reference) {
      const controls = await this.deps.tts.voiceControls();
      if (this.closed) return;
      if (!controls.description || (settings.reference && !controls.reference)) { send(this.socket, { type: "error", problem: { message: "Requested voice controls are unavailable on this sidecar. Clear them or use a supported profile." } }); this.close(); return; }
    }
    if (this.closed) return;
    this.voiceSettings = settings;
    if (this.deps.prepare) { try { const prepared = this.deps.prepare({ ...(request.assistantId ? { assistantId: request.assistantId } : {}), ...(request.relationshipId ? { relationshipId: request.relationshipId } : {}), endpointId: request.endpointId, userInput: "" }); this.identity.assistantId = prepared.assistantId; } catch { this.close(); return; } }
    if (!this.ensureInputCurrent(request)) return;
    this.request = request;this.starting=false;
    send(this.socket, { type: "accepted", identity: { ...this.identity, sessionId: request.sessionId, endpointId: request.endpointId, interactionTraceId: request.correlationId }, audioInputId: request.audioInputId });
  }

  private sampleCount(): number { return this.frames.reduce((total, frame) => total + frame.sampleCount, 0); }

  private async runTurn(frames: AudioFrame[]): Promise<void> {
    const request = this.request; if (!request || this.controller || !this.ensureInputCurrent(request)) return;
    this.controller = new AbortController(); this.interactionTraceId = randomUUID(); this.sequence = 0;
    const traceId = this.interactionTraceId; const deadlineAt = new Date(Date.now() + VOICE_TURN_DEADLINE_MS).toISOString();
    const controller = this.controller;
    let timedOut = false, internalFailure = false;
    let outputLease:AudioOutputLease|undefined;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, VOICE_TURN_DEADLINE_MS);
    send(this.socket, { type: "turnStarted", interactionTraceId: traceId });
    const current = () => this.ensureInputCurrent(request);
    const audio = async function* () { for (const frame of frames) { if (!current()) throw new Error("Audio input scope changed before recognition consumed the frame."); yield { type: "frame" as const, audioInputId: request.audioInputId, frame }; } yield { type: "end" as const, audioInputId: request.audioInputId, nextSequence: frames.length, sampleCount: frames.reduce((total, frame) => total + frame.sampleCount, 0) }; }();
    try {
      let transcript: string | undefined;
      for await (const stt of this.deps.stt.transcribe({ deadlineAt: new Date(Math.min(Date.parse(deadlineAt), Date.now() + 30_000)).toISOString(), now: () => new Date().toISOString() }, audio, this.controller.signal)) {
        if (!current()) throw new Error("Audio input scope changed during recognition.");
        if (stt.kind === "terminal" && stt.outcome !== "succeeded") throw new Error(`Speech recognition ${stt.outcome}; check the selected STT service and retry this turn.`);
        if (stt.kind !== "data" || stt.payload.type !== "committed" || transcript !== undefined) continue;
        transcript = stt.payload.text;
        send(this.socket, { type: "transcript", interactionTraceId: traceId, state: "committed", text: stt.payload.text });
      }
      // Finish recognition and its transport/deadline before starting the
      // independently bounded inference/speech phases. Never emit a completed
      // answer and only then discover a failed recognition terminal.
      if (!current()) throw new Error("Audio input scope changed after recognition.");
      if (transcript === undefined || !transcript.trim()) throw new Error("speech input did not produce a committed transcript");
      if (controller.signal.aborted) throw new Error("audio turn interrupted");
        this.currentInput = this.deps.prepare?.({ ...(request.assistantId ? { assistantId: request.assistantId } : {}), ...(request.relationshipId ? { relationshipId: request.relationshipId } : {}), endpointId: request.endpointId, userInput: transcript });
        outputLease=this.deps.outputLease?.(this.currentInput?.endpointId??request.endpointId,deadlineAt);
        const prompt = buildCanonicalPrompt({ assistantId: this.currentInput?.assistantId ?? this.identity.assistantId, sessionId: request.sessionId, interactionId: traceId, endpointId: this.currentInput?.endpointId ?? request.endpointId, userInput: transcript, conversation:this.conversation(this.currentInput?.assistantId??this.identity.assistantId,request.relationshipId), deadlineAt, executionMode: "live", voiceMode: true, ...(this.currentInput ? { runtimeSelfContext: this.currentInput.runtimeSelfContext, ...(this.currentInput.profileProjection ? { profileProjection: this.currentInput.profileProjection } : {}), ...(this.currentInput.preparedRelationshipContext ? { preparedRelationshipContext: this.currentInput.preparedRelationshipContext } : {}) } : {}) });
        const turnScope={assistantId:this.currentInput?.assistantId??this.identity.assistantId,relationshipId:request.relationshipId??null,interactionId:traceId,current:this.currentInput?.isCurrent??current};
        this.rememberTurn({...turnScope,role:"user",text:transcript});
        let answer = "";
        const segmenter = new SpeechSafeSegmenter(360);
        const queue = new SpeechQueue(controller.signal);
        const pacer = new PcmPacer();
        const decisionId = randomUUID();
        const tts = this.voiceSettings.description || this.voiceSettings.seed !== 0 || this.voiceSettings.reference ? this.deps.tts.withVoiceDesign({ description: this.voiceSettings.description, seed: this.voiceSettings.seed, reference: this.voiceSettings.reference }) : this.deps.tts;
        const voiceSettings=this.voiceSettings;
        const speak = async function* (text: string) {
        const speechDeadlineAt = new Date(Math.min(Date.parse(deadlineAt), Date.now() + SPEECH_SEGMENT_DEADLINE_MS)).toISOString();
        const segmentId = randomUUID();
        let speechSucceeded = false;
        let speechSamples = 0;
        for await (const speech of tts.synthesize({ contractVersion: "2.0.0", text, segmentId, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 }, voiceProfile: { voiceRef: "fixture-voice-design", revision: 1 }, decision: { decisionId, revision: 1 }, delivery: { interactionId: traceId, segmentId, decisionId, decisionRevision: 1, deliveryMode: voiceSettings.deliveryMode, urgency: "normal", pace: voiceSettings.pace, energy: voiceSettings.energy }, deadlineAt: speechDeadlineAt }, controller.signal)) {
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if (speech.kind === "data") { speechSamples += speech.frame.sampleCount; yield speech; }
          if (speech.kind === "terminal") {
            if (speech.outcome !== "succeeded") throw new Error(`speech synthesis ${speech.outcome}`);
            speechSucceeded = true;
          }
        }
        if (!speechSucceeded) throw new Error("speech synthesis returned no successful terminal");
        if (!speechSamples) throw new Error("speech synthesis returned no audio");
        if (controller.signal.aborted) throw new Error("audio turn interrupted");

        };
        const generation = (async () => {
        this.invalidateIfStale();if(controller.signal.aborted)throw new Error('audio turn interrupted');
        try{this.currentInput?.onInferenceRequest?.(prompt);}catch{/* Optional inclusion bookkeeping is not speech authority. */}
        for await (const chunk of this.deps.inference.generate(prompt, { signal: controller.signal })) {
          this.invalidateIfStale();
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if (chunk.kind === "text" && chunk.text) { answer += chunk.text; if (answer.length > 16_384) throw new Error("voice response text limit exceeded"); response(this.socket, traceId, this.sequence++, { type: "textDelta", text: chunk.text });this.rememberTurn({...turnScope,role:"assistant",text:answer}); for (const segment of segmenter.push(chunk.text)) await queue.put(segment.text); }
          if (chunk.kind === "capabilityRequest" && chunk.capability?.effect === "read-only") response(this.socket, traceId, this.sequence++, { type: "capabilityStatus", result: { capabilityName: chunk.capability.name, state: "selected", effect: "read-only", outcome: "notDispatched" } });
          if (chunk.kind === "error") throw new Error(chunk.error?.message ?? "inference failed");
        }
        if (!answer.trim()) throw new Error("inference returned no text");
        if (controller.signal.aborted) throw new Error("audio turn interrupted");
        for (const segment of segmenter.flush()) await queue.put(segment.text);
        queue.close();
        })().catch(error => { queue.close(error); throw error; });
        // Attach immediately; the consumer may still be producing PCM when
        // inference fails. Keep both activities bounded and settle both.
        void generation.catch(() => {});
        const synthesis=async function*(){for await(const text of queue)yield* speak(text);};
        try { for await (const speech of bufferedStream(synthesis(),controller.signal,64,()=>{if(!controller.signal.aborted){internalFailure=true;controller.abort();}})) {await pacer.admit(speech.frame.sampleCount,speech.frame.format.sampleRateHz,controller.signal);this.invalidateIfStale();if(controller.signal.aborted||outputLease&&!outputLease.current())throw new Error("audio context or output lease changed");send(this.socket,{type:"audio",interactionTraceId:traceId,chunk:{segmentId:speech.segmentId,frame:speech.frame}});} await generation; }
        catch (error) { internalFailure ||= !controller.signal.aborted; controller.abort(); queue.close(error); await generation.catch(() => {}); throw error; }
        this.invalidateIfStale();if(controller.signal.aborted)throw new Error("audio input changed before completion");
        response(this.socket, traceId, this.sequence++, { type: "terminal", state: "completed", finalResponse: null, error: null });
    } catch (error) {
      const interrupted = this.controller.signal.aborted && !timedOut && !internalFailure;
      response(this.socket, traceId, this.sequence++, { type: "terminal", state: interrupted ? "interrupted" : "failed", finalResponse: null, error: problem(interrupted ? "audio_interrupted" : timedOut ? "audio_deadline_exceeded" : "audio_turn_failed", timedOut ? "Voice turn exceeded its 180 second limit; you can try another turn." : error instanceof Error ? error.message : "audio turn failed", traceId, !interrupted) });
    } finally { clearTimeout(timer); outputLease?.release(); this.controller = undefined; this.interactionTraceId = undefined; this.currentInput = undefined; }
  }
}
import {PcmPacer} from './pcm-pacer.ts';
import {bufferedStream} from './buffered-stream.ts';
