import { voiceResponseFramingReason, voiceResponseFramingDetail, type VoiceResponseFramingDetail, type VoiceResponseFramingReason } from "@lifestream/runtime/voice/response-router";

/** Content-free failure origin. Error objects are keys, never diagnostic payloads. */
export const voiceFailureStages=['recognition','preparation','memory','world','admission','inference','framing','synthesis','delivery','settlement','transport','unknown'] as const;
export const voiceFailureCodes=['failed','provider_failed','provider_unavailable','provider_timeout','provider_cancelled','provider_protocol','invalid_response','missing_terminal','no_audio','scope_changed','input_limit','input_invalid','output_limit','deadline','stalled','cancelled','disconnected'] as const;
export type VoiceFailureStage=typeof voiceFailureStages[number];
export type VoiceFailureCode=typeof voiceFailureCodes[number];
export type VoiceFailureOrigin=Readonly<{stage:VoiceFailureStage;code:VoiceFailureCode}>;
export type VoiceFailureDiagnostic=Readonly<{event:'voice_turn_failure';version:1;interactionTraceId:string;stage:VoiceFailureStage;code:VoiceFailureCode;provider:'recognition'|'inference'|'synthesis'|'none';elapsedMs:number;framingReason?:VoiceResponseFramingReason;framingDetail?:VoiceResponseFramingDetail}>;
const validStage=(value:unknown):value is VoiceFailureStage=>typeof value==='string'&&(voiceFailureStages as readonly string[]).includes(value);
const validCode=(value:unknown):value is VoiceFailureCode=>typeof value==='string'&&(voiceFailureCodes as readonly string[]).includes(value);
export function providerFailureCode(code:unknown):VoiceFailureCode{
 switch(code){
  case 'timedOut':case 'deadline_exceeded':case 'deadlineExceeded':return 'provider_timeout';
  case 'cancelled':return 'provider_cancelled';
  case 'inference_unavailable':case 'providerUnavailable':return 'provider_unavailable';
  case 'malformed_provider_event':case 'malformedRequest':return 'provider_protocol';
  case 'response_limit':return 'output_limit';
  case 'invalid_canonical_request':return 'input_invalid';
  default:return 'provider_failed';
 }
}
export class VoiceFailureTracker{
 private readonly origins=new WeakMap<object,VoiceFailureOrigin>();
 private first:VoiceFailureOrigin|undefined;
 private emitted=false;
 constructor(private readonly interactionTraceId:string,private readonly emit:(record:VoiceFailureDiagnostic)=>void=record=>console.warn(JSON.stringify(record)),private readonly now:()=>number=()=>performance.now(),private readonly began=now()){}
 capture(error:unknown,stage:VoiceFailureStage,code:VoiceFailureCode='failed'):Error{
  const value=error instanceof Error?error:new Error('Voice reply failed');
  if(!this.origins.has(value)){const origin=Object.freeze({stage:validStage(stage)?stage:'unknown',code:validCode(code)?code:'failed'} as VoiceFailureOrigin);this.origins.set(value,origin);this.first??=origin;}
  return value;
 }
 at<T>(stage:VoiceFailureStage,work:()=>T,code:VoiceFailureCode='failed'):T{try{return work();}catch(error){throw this.capture(error,stage,code);}}
 async during<T>(stage:VoiceFailureStage,work:()=>Promise<T>,code:VoiceFailureCode='failed'):Promise<T>{try{return await work();}catch(error){throw this.capture(error,stage,code);}}
 async *stream<T>(stage:VoiceFailureStage,source:()=>AsyncIterable<T>,code:VoiceFailureCode='provider_failed'):AsyncGenerator<T>{try{yield*source();}catch(error){throw this.capture(error,stage,code);}}
 origin(error:unknown):VoiceFailureOrigin{return error instanceof Error&&this.origins.get(error)||this.first||Object.freeze({stage:'unknown',code:'failed'});}
 report(error:unknown,override?:VoiceFailureOrigin):VoiceFailureOrigin{
  const candidate=override??this.origin(error),origin=Object.freeze({stage:validStage(candidate.stage)?candidate.stage:'unknown',code:validCode(candidate.code)?candidate.code:'failed'} as VoiceFailureOrigin);
  if(!this.emitted){this.emitted=true;try{
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(this.interactionTraceId))return origin;
   const delta=this.now()-this.began,elapsedMs=Number.isFinite(delta)?Math.max(0,Math.min(600000,Math.round(delta))):0;
   const provider=['recognition','inference','synthesis'].includes(origin.stage)?origin.stage as 'recognition'|'inference'|'synthesis':'none';
   const framingReason=origin.stage==='framing'?voiceResponseFramingReason(error):undefined;
   const framingDetail=origin.stage==='framing'?voiceResponseFramingDetail(error):undefined;
   this.emit(Object.freeze({...(framingDetail===undefined?{}:{framingDetail}),...(framingReason===undefined?{}:{framingReason}),event:'voice_turn_failure',version:1,interactionTraceId:this.interactionTraceId,...origin,provider,elapsedMs}));
  }catch{/* Reporting cannot replace the original failure, response or cleanup. */}}
  return origin;
 }
}
