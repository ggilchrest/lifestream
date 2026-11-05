import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {SglangGameFrameProvider,isGameFrameVisionWitness,type GameFrameProviderReceipt,type GameFrameVisionWitness} from '@lifestream/providers-sglang';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {DiscoveryAdministration} from '../admin/understanding.ts';
import {createSglangGameFrameDecoder} from './game-frame-decoder.ts';
import type {GameFrameInterpretationPorts} from './game-frame-interpretation.ts';
import {prepareGameVisionService} from './game-vision-service.ts';

// Per-frame allocation stays below the existing planning allocation;
// all calls still reserve against the unchanged 8192-token/eight-call run budget.
const maximumFrameOutputTokens=256;

type Session={preparationCurrent:(scope:G.ActivityScope)=>boolean;current:(scope:G.ActivityScope)=>boolean;resolveApproval:(scope:G.ActivityScope)=>any;executionConsent:(scope:G.ActivityScope)=>any};
/** Trusted composition of the selected local service, existing foreground
 * coordinator, and purpose-bound image adapter. Configuration cannot supply
 * callbacks or change the selected model, endpoint, persona or planner. */
export async function prepareGameVisionRuntime(options:{
 endpoint:string;model:string;modelRevision:string;descriptor:Parameters<typeof prepareGameVisionService>[0]['descriptor'];
 sceneIdentity?:true;processingTimeoutMs?:number;idleTimeoutMs?:number;slotAttemptTimeoutMs?:number;maximumObservationAgeMs?:number;
 selectionCurrent:()=>boolean;discovery:Pick<DiscoveryAdministration,'runSupervisedForeground'>;
 onFailure?:(value:Readonly<Record<string,unknown>>)=>void;
 onInterpretedObservation?:(value:Readonly<Record<string,unknown>>)=>void;
}){
 const {endpoint,model,modelRevision,selectionCurrent,discovery,onInterpretedObservation,onFailure}=options,descriptor=structuredClone(options.descriptor);
 const processingTimeoutMs=options.processingTimeoutMs??60000;
 if(!Number.isSafeInteger(processingTimeoutMs)||processingTimeoutMs<1||processingTimeoutMs>120000)throw Error('Invalid game image sanity timeout');
 const service=await prepareGameVisionService({endpoint,model,modelRevision,descriptor,selectionCurrent,...(options.idleTimeoutMs===undefined?{}:{idleTimeoutMs:options.idleTimeoutMs}),...(options.slotAttemptTimeoutMs===undefined?{}:{slotAttemptTimeoutMs:options.slotAttemptTimeoutMs})});
 const manifestDigest=createHash('sha256').update(JSON.stringify({model,modelRevision,projector:descriptor.projector.sha256,...(options.sceneIdentity?{sceneIdentity:true}:{})})).digest('hex');
 const configurationRef='game-frame-vision:'+manifestDigest;
 const provider=new SglangGameFrameProvider({endpoint,model,version:modelRevision,loadedProjectorSha256:descriptor.projector.sha256,dataEgressClass:'localOnly',
  ...(options.sceneIdentity?{sceneIdentity:true}:{}),capability:service.capability,available:()=>selectionCurrent()&&service.available(),maximumDurationMs:processingTimeoutMs,maximumInputTokens:8192,maximumOutputTokens:maximumFrameOutputTokens,
  maximumObservationAgeMs:options.maximumObservationAgeMs??180000,
  ...(process.env.LIFESTREAM_INFERENCE_API_KEY?{apiKey:process.env.LIFESTREAM_INFERENCE_API_KEY}:{})});
 return Object.freeze({
  ready:()=>selectionCurrent()&&service.available(),
  transportQuiescent:()=>service.quiescent(),
  identityCurrent:service.identityCurrent,
  forSession(scope:G.ActivityScope,session:Session):GameFrameInterpretationPorts{
   const pinnedScope=structuredClone(scope),receipts=new Map<string,GameFrameProviderReceipt>();
   let refusalReported=false;
   const report=(observation:Readonly<G.GameObservation>,details:Omit<GameFrameVisionWitness,'observationId'|'screenshotSha256'>)=>{
    if(refusalReported)return;
    try{
     const bound=boundedGameDataSnapshot(observation) as G.GameObservation|null;
     if(!bound||!isDeepStrictEqual(bound.scope,pinnedScope))return;
     const visionWitness=Object.freeze({...details,observationId:bound.observationId,screenshotSha256:bound.screenshots[0]?.sha256});
     if(!isGameFrameVisionWitness(visionWitness))return;
     refusalReported=true;
     if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'game-vision-first-refusal',runId:pinnedScope.runId,observedAtMs:Date.now(),visionWitness}));}catch{/* Diagnostics cannot change interpretation or its original failure callback. */}
     onFailure?.(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'game-vision',phase:'interpretation',reason:'interpretation_refused',visionWitness}));
    }catch{}
   };
   const current=()=>selectionCurrent()&&service.available()&&(session.preparationCurrent(pinnedScope)||session.current(pinnedScope));
   const sharedConsentCurrent=()=>current()&&(session.resolveApproval(pinnedScope)??session.executionConsent(pinnedScope))?.sharedInference===true;
   const key=(observation:Readonly<G.GameObservation>)=>observation.observationId+':'+observation.revision;
   const decoder=createSglangGameFrameDecoder({provider,configurationRef,decoderRevision:'1.0.0',manifestDigest,
    onRefusal:(observation,value)=>report(observation,{kind:'provider',...value}),
    current:observation=>isDeepStrictEqual(observation.scope,pinnedScope)&&current(),
    onReceipt:(observation,receipt)=>{
     if(!current()||receipt.screenshotSha256!==observation.screenshots[0]?.sha256||receipts.has(key(observation))||receipts.size>=16)throw Error('Game image receipt identity unavailable');
     receipts.set(key(observation),receipt);
    }});
   return Object.freeze({decoder,current,maximumDurationMs:processingTimeoutMs,onRefusal:(observation,value)=>report(observation,{kind:'interpreter',...value}),
    inference:Object.freeze({providerRevision:modelRevision,maximumInputTokens:8192,maximumOutputTokens:maximumFrameOutputTokens,
     run:work=>{
      if(work.steps.length!==1)throw Error('One bounded image interpretation step required');
      const step=work.steps[0]!;
      // The original scheduler retains its foreground lease during server
      // drain, including after the caller has already discarded late output.
      return discovery.runSupervisedForeground({key:work.key,deadlineAt:work.deadlineAt,current:work.current,admitOnce:work.admitOnce,publish:work.publish,sharingConsentCurrent:sharedConsentCurrent,
       steps:[async signal=>{const result=await service.runWhenIdle(()=>step(signal),signal);if(result===null)throw Error('Game image service unavailable');return result;}]});
     }}),
    onInterpretedObservation:observation=>{
     const receipt=receipts.get(key(observation));
     if(!receipt||!current()||!isDeepStrictEqual(observation.scope,pinnedScope)||receipt.screenshotSha256!==observation.screenshots[0]?.sha256)throw Error('Game interpretation receipt unavailable');
     receipts.delete(key(observation));
     const value=Object.freeze({schemaVersion:'ct-general-game-interpretation/1',annotationOrigin:'MODEL',observationId:observation.observationId,observationRevision:observation.revision,
      scopeDigest:createHash('sha256').update(JSON.stringify(pinnedScope)).digest('hex'),pinsDigest:observation.pinsDigest,timelineId:observation.scope.timelineId,timelineRevision:observation.scope.timelineRevision,
      frameNumber:observation.frameNumber,capturedAt:observation.capturedAt,receivedAt:observation.receivedAt,previousActionId:observation.previousActionId,interpretedAt:observation.interpretedAt,screenshot:observation.screenshots[0],controllerAuthority:false,
      configurationRef,receipt,facts:observation.facts.filter(fact=>fact.extractorRef===configurationRef),
      limitations:['Model appearance and OCR are uncertain image observations, not exact coordinates, hidden state, menu safety, controller authority or progress proof.']});
     const written:unknown=onInterpretedObservation?.(value);if(written&&typeof(written as any).then==='function')throw Error('Synchronous game interpretation evidence required');
    }} satisfies GameFrameInterpretationPorts);
  }
 });
}
