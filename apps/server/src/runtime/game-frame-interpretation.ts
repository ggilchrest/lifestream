import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {inspectGamePng} from '@lifestream/providers-bizhawk';
import type {GameFrameInterpreterRefusal} from '@lifestream/providers-sglang';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameHostJoin} from './game-host-port.ts';
import type {BackgroundWork,BackgroundResult} from '@lifestream/runtime/understanding/coordinator';

/** Reviewed pixels-only decoder. Capabilities are trusted installed-runtime
 * evidence; chat-template image markers alone are insufficient. */
export type GameFrameDecoder={
 purpose:'simulatedGame/gameFramebuffer';configurationRef:string;decoderRevision:string;manifestDigest:string;
 allowedVisibleFieldIds:readonly string[];
 capability:{kind:'nativeVisibleUi'}|{kind:'gameVision';vision:true;loadedProjectorSha256:string};
 current:(observation:Readonly<G.GameObservation>)=>boolean;
 decode:(input:Readonly<{purpose:'simulatedGame/gameFramebuffer';priorScene?:Readonly<{observationId:string;description:string}>;observation:Readonly<G.GameObservation>;screenshot:Readonly<G.GameScreenshot>;bytes:Buffer}>,signal:AbortSignal,onUsage?:(usage:GameFrameModelUsage)=>void)=>Promise<{facts:G.PlayerVisibleFact[];visibleState:G.PlayerVisibleStateValue[]}|null>;
};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const safe=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export type GameFrameInferencePorts={
 /** Existing host scheduler and original finite game model/token accounting.
  * A vision call is model work; these bounds are reservations, not measured usage. */
 maximumInputTokens:number;maximumOutputTokens:number;providerRevision:string;
 run:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;
};
export type GameFrameModelUsage=Readonly<{inputTokens:number;outputTokens:number;providerRevision:string;completionRef:string}>;
export type GameFrameInferenceAccounting={
 priorScene?:Readonly<{observationId:string;description:string}>;
 admitOnce:(candidate:Readonly<{providerRevision:string;maximumInputTokens:number;maximumOutputTokens:number}>)=>boolean;
 settleUsage:(usage:GameFrameModelUsage)=>boolean;
};
export type GameFrameRefusalReporter=(observation:Readonly<G.GameObservation>,value:GameFrameInterpreterRefusal)=>void;
export type GameObservationInterpretationOptions={
 decoder?:GameFrameDecoder;
 onRefusal?:GameFrameRefusalReporter;
 sourceCurrent:(scope:Readonly<G.ActivityScope>)=>boolean;
 pinsDigestFor:(scope:Readonly<G.ActivityScope>)=>string|null;
 readFrame:(observation:Readonly<G.GameObservation>,screenshot:Readonly<G.GameScreenshot>,signal:AbortSignal)=>Promise<Buffer|null>;
 observationCurrent?:(observation:Readonly<G.GameObservation>)=>boolean;
 inference?:GameFrameInferencePorts;
 maximumDurationMs:number;maximumBytes:number;maximumLongEdge:number;maximumObservationAgeMs:number;
};
export type GameFrameInterpretationPorts={
 decoder:GameFrameDecoder;onRefusal?:GameFrameRefusalReporter;inference?:GameFrameInferencePorts;maximumDurationMs:number;
 /** Trusted service/session currency also fences later planning/native work. */
 current?:()=>boolean;
 /** Trusted metadata publication only. This cannot approve an image or action. */
 onInterpretedObservation?:(observation:Readonly<G.GameObservation>)=>void;
};
/** Interprets an ALREADY observed/approved frame. It never calls observe and
 * cannot promote model appearance/OCR into trusted controller-domain fields. */
export function createGameObservationInterpreter(options:GameObservationInterpretationOptions){
 const owned=pipeline(options);return (join:GameHostJoin,observation:Readonly<G.GameObservation>,signal:AbortSignal,accounting?:GameFrameInferenceAccounting)=>owned.interpret(join,observation,signal,observation.previousActionId,true,accounting);
}
/** Legacy authenticated reader retains its single observe and overall deadline.
 * The same validated interpreter does the frame work without a second observe. */
export function createGameObservationReader(options:GameObservationInterpretationOptions){return pipeline(options).read;}
function pipeline(options:GameObservationInterpretationOptions){
 if(!Number.isSafeInteger(options.maximumDurationMs)||options.maximumDurationMs<1||options.maximumDurationMs>120000||!Number.isSafeInteger(options.maximumBytes)||options.maximumBytes<1||options.maximumBytes>8388608||!Number.isSafeInteger(options.maximumLongEdge)||options.maximumLongEdge<1||options.maximumLongEdge>4096||!Number.isSafeInteger(options.maximumObservationAgeMs)||options.maximumObservationAgeMs<1||options.maximumObservationAgeMs>300000)throw Error('Game interpretation bounds unavailable');
 const {decoder,sourceCurrent,pinsDigestFor,readFrame,observationCurrent,inference,maximumDurationMs,maximumBytes,maximumLongEdge,maximumObservationAgeMs}=options;
 const pinned=decoder?{...decoder,allowedVisibleFieldIds:[...decoder.allowedVisibleFieldIds],capability:{...decoder.capability}}:undefined;
 const fixedInference=inference?{...inference}:undefined;
 const configurationCurrent=()=>options.decoder===decoder&&options.sourceCurrent===sourceCurrent&&options.pinsDigestFor===pinsDigestFor&&options.readFrame===readFrame&&options.observationCurrent===observationCurrent&&options.inference===inference&&(!inference||!!fixedInference&&Object.entries(fixedInference).every(([key,value])=>(inference as any)[key]===value))&&!!decoder&&!!pinned&&decoder.purpose===pinned.purpose&&decoder.configurationRef===pinned.configurationRef&&decoder.decoderRevision===pinned.decoderRevision&&decoder.manifestDigest===pinned.manifestDigest&&decoder.current===pinned.current&&decoder.decode===pinned.decode&&isDeepStrictEqual(decoder.allowedVisibleFieldIds,pinned.allowedVisibleFieldIds)&&isDeepStrictEqual(decoder.capability,pinned.capability);
 const qualified=()=>!!pinned&&configurationCurrent()&&pinned.purpose==='simulatedGame/gameFramebuffer'&&!!pinned.configurationRef.trim()&&Buffer.byteLength(pinned.configurationRef)<=2048&&/^\d+\.\d+\.\d+$/.test(pinned.decoderRevision)&&digest(pinned.manifestDigest)&&['nativeVisibleUi','gameVision'].includes(pinned.capability.kind)&&(pinned.capability.kind!=='gameVision'||pinned.capability.vision===true&&digest(pinned.capability.loadedProjectorSha256)&&!!fixedInference&&typeof fixedInference.run==='function'&&typeof fixedInference.providerRevision==='string'&&fixedInference.providerRevision.trim().length>0&&Buffer.byteLength(fixedInference.providerRevision)<=512&&Number.isSafeInteger(fixedInference.maximumInputTokens)&&fixedInference.maximumInputTokens>=1&&fixedInference.maximumInputTokens<=32768&&Number.isSafeInteger(fixedInference.maximumOutputTokens)&&fixedInference.maximumOutputTokens>=1&&fixedInference.maximumOutputTokens<=4096);
 const wait=<T>(promise:Promise<T>,signal:AbortSignal,dispose?:(value:T)=>void):Promise<T|null>=>new Promise(resolve=>{
  let done=false;const aborted=()=>{done=true;resolve(null);};if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',aborted);if(done){dispose?.(value);return;}done=true;resolve(value);},()=>{signal.removeEventListener('abort',aborted);if(!done){done=true;resolve(null);}});
 });
 const interpret=async(join:GameHostJoin,raw:Readonly<G.GameObservation>,external:AbortSignal,afterActionId:string|null=null,preserveNative=true,accounting?:GameFrameInferenceAccounting):Promise<G.GameObservation|null>=>{
  let reported=false;const refuse=(reason:GameFrameInterpreterRefusal['reason'],schedulerState?:GameFrameInterpreterRefusal['schedulerState']):null=>{if(!reported){reported=true;try{options.onRefusal?.(raw,Object.freeze({reason,...(schedulerState?{schedulerState}:{})}));}catch{}}return null;};
  if(!qualified())return refuse('qualification');
  if(pinned!.capability.kind==='gameVision'&&(!accounting||typeof accounting.admitOnce!=='function'||typeof accounting.settleUsage!=='function'))return refuse('accounting_required');
  const controller=new AbortController(),signal=AbortSignal.any([external,controller.signal]),began=Date.now(),monoDeadline=performance.now()+maximumDurationMs,timer=setTimeout(()=>controller.abort(),maximumDurationMs);timer.unref();
  let lastWall=began,bytes:Buffer|null=null;
  const observation=boundedGameDataSnapshot(raw) as G.GameObservation|null;
  const accountingPin=accounting?{...accounting}:undefined;
  let currentReason:GameFrameInterpreterRefusal['reason']='source_current';
  const current=()=>{const now=Date.now();if(now<lastWall){currentReason='clock_changed';controller.abort();return false;}lastWall=now;
   if(signal.aborted){currentReason='cancelled';return false;}if(!(now<began+maximumDurationMs&&performance.now()<monoDeadline)){currentReason='deadline';return false;}
   if(!configurationCurrent()){currentReason='configuration_changed';return false;}
   if(accounting&&!(!!accountingPin&&Object.entries(accountingPin).every(([key,value])=>(accounting as any)[key]===value))){currentReason='accounting_changed';return false;}
   if(!safe(()=>sourceCurrent(join.scope))){currentReason='source_current';return false;}
   if(!safe(()=>join.runtime?.isCurrent()===true)){currentReason='runtime_current';return false;}
   if(observationCurrent&&!(!!observation&&safe(()=>observationCurrent(observation)))){currentReason='observation_current';return false;}return true;
  };
  try{
   if(!observation||!validator.validate(schema+'GameObservation',observation).valid||!isDeepStrictEqual(observation.scope,join.scope)||observation.pinsDigest!==pinsDigestFor(join.scope)||observation.previousActionId!==afterActionId||observation.screenshots.length!==1)return refuse('observation_validation');
   if(!current())return refuse(currentReason);if(!safe(()=>pinned!.current(observation)))return refuse('decoder_current');
   freeze(observation);const shot=observation.screenshots[0]!,now=Date.now(),captured=Date.parse(observation.capturedAt);
   if(captured>now||now-captured>maximumObservationAgeMs||Date.parse(shot.expiresAt)<=now||shot.capturedAt!==observation.capturedAt||shot.frameNumber!==observation.frameNumber||shot.byteLength>maximumBytes)return refuse('observation_expired');
   bytes=await wait(readFrame(observation,shot,signal),signal,late=>late?.fill(0));
   if(!bytes)return refuse('frame_read');if(!current())return refuse(currentReason);
   if(bytes.length!==shot.byteLength||createHash('sha256').update(bytes).digest('hex')!==shot.sha256)return refuse('frame_integrity');
   const size=inspectGamePng(bytes,maximumLongEdge);if(size.width!==shot.width||size.height!==shot.height)return refuse('frame_dimensions');
   type Data={facts:G.PlayerVisibleFact[];visibleState:G.PlayerVisibleStateValue[]};let decoded:Data|null=null,usage:GameFrameModelUsage|undefined,usageSeen=false,usageInvalid=false;
   const receiveUsage=(raw:GameFrameModelUsage)=>{
    if(usageSeen){usageInvalid=true;return;}usageSeen=true;
    const value=boundedGameDataSnapshot(raw,4096) as GameFrameModelUsage|null;
    if(!value||Object.keys(value).sort().join(',')!=='completionRef,inputTokens,outputTokens,providerRevision'||!fixedInference||value.providerRevision!==fixedInference.providerRevision||!Number.isSafeInteger(value.inputTokens)||value.inputTokens<0||value.inputTokens>fixedInference.maximumInputTokens||!Number.isSafeInteger(value.outputTokens)||value.outputTokens<0||value.outputTokens>fixedInference.maximumOutputTokens||typeof value.completionRef!=='string'||value.completionRef.length<1||Buffer.byteLength(value.completionRef)>512||!current()){usageInvalid=true;return;}
    usage=Object.freeze(value);
   };
   const decode=async(inner:AbortSignal)=>current()?pinned!.decode({...(accountingPin?.priorScene?{priorScene:accountingPin.priorScene}:{}),purpose:pinned!.purpose,observation,screenshot:shot,bytes:bytes!},AbortSignal.any([signal,inner]),receiveUsage):null;
   if(pinned!.capability.kind==='gameVision'){
    const bounds=Object.freeze({providerRevision:fixedInference!.providerRevision,maximumInputTokens:fixedInference!.maximumInputTokens,maximumOutputTokens:fixedInference!.maximumOutputTokens});let attempted=false,admitted=false,entered=false,published=false;
    const work:BackgroundWork<Data|null>={key:'game-frame:'+observation.observationId+':'+observation.revision,deadlineAt:Math.min(began+maximumDurationMs,Date.parse(shot.expiresAt)),current,sharedInference:true,priority:'P2',admitOnce:()=>{if(attempted||!current())return false;attempted=true;admitted=accountingPin!.admitOnce(bounds)===true&&current();return admitted;},steps:[async inner=>{if(!admitted||entered||!current())return null;entered=true;return await decode(inner);}],publish:value=>{if(published||!value||!usage||usageInvalid||!current())return false;published=true;decoded=value;return true;}};
    const status=await wait(fixedInference!.run(work),signal);if(status?.state!=='published')return refuse('scheduler_not_published',status&&['suppressed','cancelled','failed'].includes(status.state)?status.state:'unavailable');
   }else decoded=await wait(decode(signal),signal);
   const data=boundedGameDataSnapshot(decoded,32768) as Data|null;
   if(!data||Object.keys(data).sort().join(',')!=='facts,visibleState')return refuse('decoder_output');
   if(!current())return refuse(currentReason);
   if(createHash('sha256').update(bytes).digest('hex')!==shot.sha256)return refuse('frame_integrity');
   if(Date.parse(shot.expiresAt)<=Date.now()||Date.now()-captured>maximumObservationAgeMs)return refuse('observation_expired');
   if(!safe(()=>pinned!.current(observation)))return refuse('decoder_current');
   if(!Array.isArray(data.facts)||!Array.isArray(data.visibleState)||pinned!.capability.kind==='gameVision'&&data.visibleState.length!==0||data.facts.some(fact=>fact.untrusted!==true||fact.sourceKind!=='playerVisibleGameObservation'||fact.sourceScreenshotIds.length!==1||fact.sourceScreenshotIds[0]!==shot.screenshotId||fact.extractorRef!==pinned!.configurationRef)||data.visibleState.some(field=>!pinned!.allowedVisibleFieldIds.includes(field.fieldId)||field.visibility!=='visibleNow'||field.lastObservedRef!==observation.observationId||field.timelineId!==observation.scope.timelineId||field.decoderRevision!==pinned!.decoderRevision||field.manifestDigest!==pinned!.manifestDigest||Date.parse(field.observedAt)<captured||Date.parse(field.observedAt)>Date.now()||Date.parse(field.freshUntil)<=Date.now()||Date.parse(field.freshUntil)>Date.parse(shot.expiresAt)))return refuse('output_provenance');
   if(preserveNative&&data.visibleState.some(field=>observation.visibleState.some(native=>native.fieldId===field.fieldId)))return refuse('native_field_collision');
   const interpreted={...observation,facts:preserveNative?[...observation.facts,...data.facts]:data.facts,visibleState:preserveNative?[...observation.visibleState,...data.visibleState]:data.visibleState,interpretedAt:new Date().toISOString(),providerConfigurationRef:pinned!.configurationRef};
   if(new Set(interpreted.facts.map(f=>f.factId)).size!==interpreted.facts.length)return refuse('duplicate_fact');
   if(!validator.validate(schema+'GameObservation',interpreted).valid)return refuse('interpreted_schema');if(!current())return refuse(currentReason);
   if(pinned!.capability.kind==='gameVision'&&(!usage||usageInvalid||accountingPin!.settleUsage(usage)!==true||!current()))return refuse('usage_settlement');
   return preserveNative?freeze(interpreted):interpreted;
  }catch{return refuse('exception');}finally{bytes?.fill(0);clearTimeout(timer);controller.abort();}
 };
 const read=async(join:GameHostJoin,external:AbortSignal,afterActionId:string|null=null,accounting?:GameFrameInferenceAccounting):Promise<G.GameObservation|null>=>{
  if(!qualified()||pinned!.capability.kind==='gameVision'&&(!accounting||typeof accounting.admitOnce!=='function'||typeof accounting.settleUsage!=='function'))return null;
  const controller=new AbortController(),signal=AbortSignal.any([external,controller.signal]),timer=setTimeout(()=>controller.abort(),maximumDurationMs);timer.unref();
  let lastWall=Date.now();const current=()=>{const now=Date.now();if(now<lastWall){controller.abort();return false;}lastWall=now;return !signal.aborted&&configurationCurrent()&&safe(()=>sourceCurrent(join.scope))&&safe(()=>join.runtime?.isCurrent()===true);};
  try{
   if(!current())return null;const pins=pinsDigestFor(join.scope);if(!digest(pins))return null;
   const request:G.GameObserveRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+maximumDurationMs).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:join.scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:pins,afterActionId,maxScreenshots:1}};
   const result=await wait(join.adapter.observe(request,{signal,isCurrent:scope=>isDeepStrictEqual(scope,join.scope)&&current()}),signal);
   if(!result||result.outcome.status!=='succeeded'||!current())return null;
   return await interpret(join,result.outcome.payload?.observation as G.GameObservation,signal,afterActionId,false,accounting);
  }catch{return null;}finally{clearTimeout(timer);controller.abort();}
 };
 return {interpret,read};
}
