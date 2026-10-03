import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {inspectGamePng} from '@lifestream/providers-bizhawk';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameHostJoin} from './game-host-port.ts';

/** Reviewed pixels-only decoder. Capabilities are trusted installed-runtime
 * evidence; chat-template image markers alone are insufficient. */
export type GameFrameDecoder={
 purpose:'simulatedGame/gameFramebuffer';configurationRef:string;decoderRevision:string;manifestDigest:string;
 allowedVisibleFieldIds:readonly string[];
 capability:{kind:'nativeVisibleUi'}|{kind:'gameVision';vision:true;loadedProjectorSha256:string};
 current:(observation:Readonly<G.GameObservation>)=>boolean;
 decode:(input:Readonly<{purpose:'simulatedGame/gameFramebuffer';observation:Readonly<G.GameObservation>;screenshot:Readonly<G.GameScreenshot>;bytes:Buffer}>,signal:AbortSignal)=>Promise<{facts:G.PlayerVisibleFact[];visibleState:G.PlayerVisibleStateValue[]}|null>;
};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const safe=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Existing authenticated adapter -> purpose-bound owned PNG -> reviewed
 * decoder -> untrusted observation. This creates no model/provider/service,
 * field decoder qualification, permission, save evidence or retention. */
export function createGameObservationReader(options:{
 decoder?:GameFrameDecoder;
 sourceCurrent:(scope:Readonly<G.ActivityScope>)=>boolean;
 pinsDigestFor:(scope:Readonly<G.ActivityScope>)=>string|null;
 readFrame:(observation:Readonly<G.GameObservation>,screenshot:Readonly<G.GameScreenshot>,signal:AbortSignal)=>Promise<Buffer|null>;
 maximumDurationMs:number;maximumBytes:number;maximumLongEdge:number;maximumObservationAgeMs:number;
}){
 if(!Number.isSafeInteger(options.maximumDurationMs)||options.maximumDurationMs<1||options.maximumDurationMs>5000||!Number.isSafeInteger(options.maximumBytes)||options.maximumBytes<1||options.maximumBytes>8388608||!Number.isSafeInteger(options.maximumLongEdge)||options.maximumLongEdge<1||options.maximumLongEdge>4096||!Number.isSafeInteger(options.maximumObservationAgeMs)||options.maximumObservationAgeMs<1||options.maximumObservationAgeMs>30000)throw Error('Game interpretation bounds unavailable');
 const {decoder,sourceCurrent,pinsDigestFor,readFrame,maximumDurationMs,maximumBytes,maximumLongEdge,maximumObservationAgeMs}=options;
 const pinned=decoder?{...decoder,allowedVisibleFieldIds:[...decoder.allowedVisibleFieldIds],capability:{...decoder.capability}}:undefined;
 const configurationCurrent=()=>options.decoder===decoder&&options.sourceCurrent===sourceCurrent&&options.pinsDigestFor===pinsDigestFor&&options.readFrame===readFrame&&!!decoder&&!!pinned&&decoder.purpose===pinned.purpose&&decoder.configurationRef===pinned.configurationRef&&decoder.decoderRevision===pinned.decoderRevision&&decoder.manifestDigest===pinned.manifestDigest&&decoder.current===pinned.current&&decoder.decode===pinned.decode&&isDeepStrictEqual(decoder.allowedVisibleFieldIds,pinned.allowedVisibleFieldIds)&&isDeepStrictEqual(decoder.capability,pinned.capability);
 return async(join:GameHostJoin,external:AbortSignal,afterActionId:string|null=null):Promise<G.GameObservation|null>=>{
  // Missing capability fails before observation/frame retrieval. In particular,
  // a text-only serving runtime cannot receive game images through this hook.
  if(!pinned||!configurationCurrent()||pinned.purpose!=='simulatedGame/gameFramebuffer'||!pinned.configurationRef.trim()||Buffer.byteLength(pinned.configurationRef)>2048||!/^\d+\.\d+\.\d+$/.test(pinned.decoderRevision)||!digest(pinned.manifestDigest)||!['nativeVisibleUi','gameVision'].includes(pinned.capability.kind)||pinned.capability.kind==='gameVision'&&(pinned.capability.vision!==true||!digest(pinned.capability.loadedProjectorSha256)))return null;
  const controller=new AbortController(),signal=AbortSignal.any([external,controller.signal]),timer=setTimeout(()=>controller.abort(),maximumDurationMs);timer.unref();
  let lastWall=Date.now();
  const current=()=>{const now=Date.now();if(now<lastWall){controller.abort();return false;}lastWall=now;return !signal.aborted&&configurationCurrent()&&safe(()=>sourceCurrent(join.scope))&&safe(()=>join.runtime?.isCurrent()===true);};
  const bounded=<T>(promise:Promise<T>,dispose?:(value:T)=>void):Promise<T|null>=>new Promise(resolve=>{
   let done=false;const aborted=()=>{done=true;resolve(null);};if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
   promise.then(value=>{signal.removeEventListener('abort',aborted);if(done){dispose?.(value);return;}done=true;resolve(value);},()=>{signal.removeEventListener('abort',aborted);if(!done){done=true;resolve(null);}});
  });
  let bytes:Buffer|null=null;
  try{
   if(!current())return null;const pins=pinsDigestFor(join.scope);if(!digest(pins))return null;
   const request:G.GameObserveRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+maximumDurationMs).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:join.scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:pins,afterActionId,maxScreenshots:1}};
   const result=await bounded(join.adapter.observe(request,{signal,isCurrent:scope=>isDeepStrictEqual(scope,join.scope)&&current()}));
   if(!result||result.outcome.status!=='succeeded'||!current())return null;
   const observation=boundedGameDataSnapshot(result.outcome.payload?.observation) as G.GameObservation|null;
   if(!observation||!validator.validate(schema+'GameObservation',observation).valid||!isDeepStrictEqual(observation.scope,join.scope)||observation.pinsDigest!==pins||observation.previousActionId!==afterActionId||observation.screenshots.length!==1||!safe(()=>pinned.current(observation)))return null;
   freeze(observation);const shot=observation.screenshots[0]!,now=Date.now(),captured=Date.parse(observation.capturedAt);
   if(captured>now||now-captured>maximumObservationAgeMs||Date.parse(shot.expiresAt)<=now||shot.capturedAt!==observation.capturedAt||shot.frameNumber!==observation.frameNumber||shot.byteLength>maximumBytes)return null;
   bytes=await bounded(readFrame(observation,shot,signal),late=>late?.fill(0));
   if(!bytes||!current()||bytes.length!==shot.byteLength||createHash('sha256').update(bytes).digest('hex')!==shot.sha256)return null;
   const size=inspectGamePng(bytes,maximumLongEdge);if(size.width!==shot.width||size.height!==shot.height)return null;
   const data=boundedGameDataSnapshot(await bounded(pinned.decode({purpose:pinned.purpose,observation,screenshot:shot,bytes},signal)),32768) as {facts:G.PlayerVisibleFact[];visibleState:G.PlayerVisibleStateValue[]}|null;
   if(!data||Object.keys(data).sort().join(',')!=='facts,visibleState'||!current()||createHash('sha256').update(bytes).digest('hex')!==shot.sha256||Date.parse(shot.expiresAt)<=Date.now()||Date.now()-captured>maximumObservationAgeMs||!safe(()=>pinned.current(observation)))return null;
   if(!Array.isArray(data.facts)||!Array.isArray(data.visibleState)||data.facts.some(fact=>fact.untrusted!==true||fact.sourceKind!=='playerVisibleGameObservation'||fact.sourceScreenshotIds.length!==1||fact.sourceScreenshotIds[0]!==shot.screenshotId||fact.extractionKind==='visibleUiExtractor'&&fact.extractorRef!==pinned.configurationRef)||data.visibleState.some(field=>!pinned.allowedVisibleFieldIds.includes(field.fieldId)||field.visibility!=='visibleNow'||field.lastObservedRef!==observation.observationId||field.timelineId!==observation.scope.timelineId||field.decoderRevision!==pinned.decoderRevision||field.manifestDigest!==pinned.manifestDigest||Date.parse(field.observedAt)<captured||Date.parse(field.observedAt)>Date.now()||Date.parse(field.freshUntil)<=Date.now()||Date.parse(field.freshUntil)>Date.parse(shot.expiresAt)))return null;
   // A tentative vision-only decoder cannot replace independently qualified
   // native UI fields. Only still-fresh fields from this exact observation are
   // retained; the vision decoder contributes no controller-visible values.
   const visionOnly=pinned.capability.kind==='gameVision'&&pinned.allowedVisibleFieldIds.length===0&&data.visibleState.length===0;
   const nativeFields=visionOnly?observation.visibleState.filter(field=>field.visibility==='visibleNow'&&field.lastObservedRef===observation.observationId&&field.timelineId===observation.scope.timelineId&&Date.parse(field.observedAt)>=captured&&Date.parse(field.observedAt)<=Date.now()&&Date.parse(field.freshUntil)>Date.now()&&Date.parse(field.freshUntil)<=Date.parse(shot.expiresAt)):[];
   const interpreted={...observation,...data,...(visionOnly?{facts:[...observation.facts,...data.facts],visibleState:nativeFields}:{}),interpretedAt:new Date().toISOString(),providerConfigurationRef:pinned.configurationRef};
   return validator.validate(schema+'GameObservation',interpreted).valid&&current()?interpreted:null;
  }catch{return null;}finally{bytes?.fill(0);clearTimeout(timer);controller.abort();}
 };
}
