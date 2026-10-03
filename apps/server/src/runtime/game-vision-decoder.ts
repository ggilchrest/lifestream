import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {inspectGamePng} from '@lifestream/providers-bizhawk';
import type {SglangInferenceProvider} from '@lifestream/providers-sglang';
import {SHARED_PROVIDER_PREEMPTION_BOUND_MS,SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS,type BackgroundWork,type BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameFrameDecoder} from './game-frame-interpretation.ts';

type Draft={kind:'menu'|'map'|'unknown';scene:string|null;text:{candidate:string;uncertainty:string}[];uncertainty:string};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const safe=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const digest=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&Buffer.byteLength(value)<=max;

/** Closed JSON only, including rejection of duplicate keys before JSON.parse.
 * No fence stripping, substring extraction, implicit coercion or OCR repair. */
export function parseGameVisionOutput(raw:string):Draft|null{
 try{
  if(Buffer.byteLength(raw)>8192)return null;
  let i=0;
  const whitespace=()=>{while(/[\t\r\n ]/.test(raw[i]??'!'))i++;};
  const string=()=>{const start=i++;for(;i<raw.length;i++){if(raw[i]==='\\'){i++;continue;}if(raw[i]==='"'){i++;return JSON.parse(raw.slice(start,i)) as string;}}throw Error('Unterminated JSON string');};
  const value=(depth:number):void=>{
   if(depth>8)throw Error('JSON depth');whitespace();const char=raw[i];
   if(char==='"'){string();return;}
   if(char==='{'){
    i++;whitespace();const keys=new Set<string>();if(raw[i]==='}'){i++;return;}
    for(;;){if(raw[i]!=='"')throw Error('JSON key');const key=string();if(keys.has(key))throw Error('Duplicate JSON key');keys.add(key);whitespace();if(raw[i++]!==':')throw Error('JSON colon');value(depth+1);whitespace();const next=raw[i++];if(next==='}')return;if(next!==',')throw Error('JSON object');whitespace();}
   }
   if(char==='['){i++;whitespace();if(raw[i]===']'){i++;return;}for(;;){value(depth+1);whitespace();const next=raw[i++];if(next===']')return;if(next!==',')throw Error('JSON array');}}
   const token=/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));if(!token)throw Error('JSON value');i+=token[0].length;
  };
  value(0);whitespace();if(i!==raw.length)return null;
  const draft=JSON.parse(raw) as Draft;
  if(!draft||Object.keys(draft).sort().join(',')!=='kind,scene,text,uncertainty'||!['menu','map','unknown'].includes(draft.kind)||draft.scene!==null&&!text(draft.scene,96)||!text(draft.uncertainty,96)||!Array.isArray(draft.text)||draft.text.length>3||draft.text.some(item=>!item||Object.keys(item).sort().join(',')!=='candidate,uncertainty'||!text(item.candidate,64)||!text(item.uncertainty,64)))return null;
  return draft;
 }catch{return null;}
}

export type GameVisionDecoderOptions={
 scope:Readonly<G.ActivityScope>;pinsDigest:string;configurationRef:string;decoderRevision:string;manifestDigest:string;loadedProjectorSha256:string;
 provider:Pick<SglangInferenceProvider,'generateGameFrame'>;
 /** Bind these functions to the existing server DiscoveryAdministration. Never
  * instantiate another coordinator or provider for the same live native slot. */
 runBackground:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;
 sourceCurrent:(observation:Readonly<G.GameObservation>)=>boolean;
 runtimeCurrent:()=>boolean;
 admitOnce:(observation:Readonly<G.GameObservation>)=>boolean;
 /** Exact vision runtime qualification, not generic priority advertisement. */
 qualification:{preemptionBoundMs:number;slotReleaseBoundMs:number;reference:string;current:()=>boolean};
 maximumDurationMs:number;maximumObservationAgeMs:number;maximumBytes:number;maximumLongEdge:number;maximumOutputTokens:number;
};

/** Existing frame custody -> same selected inference provider/coordinator ->
 * tentative source-bound facts. This never creates controller-visible fields,
 * enrolls a session, claims game progress, writes memory or retains raw frames. */
export function createGameVisionDecoder(options:GameVisionDecoderOptions):GameFrameDecoder{
 const scope=boundedGameDataSnapshot(options.scope) as G.ActivityScope|null;
 if(!scope||!validator.validate(schema+'ActivityScope',scope).valid||!digest(options.pinsDigest)||!digest(options.manifestDigest)||!digest(options.loadedProjectorSha256)||!text(options.configurationRef,2048)||!/^\d+\.\d+\.\d+$/.test(options.decoderRevision)||![options.maximumDurationMs,options.maximumObservationAgeMs,options.maximumBytes,options.maximumLongEdge,options.maximumOutputTokens].every(n=>Number.isSafeInteger(n)&&n>=1)||options.maximumDurationMs>5000||options.maximumObservationAgeMs>30000||options.maximumBytes>2097152||options.maximumLongEdge>4096||options.maximumOutputTokens>256||!options.provider||typeof options.provider.generateGameFrame!=='function'||![options.runBackground,options.sourceCurrent,options.runtimeCurrent,options.admitOnce,options.qualification?.current].every(fn=>typeof fn==='function')||!text(options.qualification.reference,2048)||!Number.isFinite(options.qualification.preemptionBoundMs)||options.qualification.preemptionBoundMs<0||options.qualification.preemptionBoundMs>SHARED_PROVIDER_PREEMPTION_BOUND_MS||!Number.isFinite(options.qualification.slotReleaseBoundMs)||options.qualification.slotReleaseBoundMs<0||options.qualification.slotReleaseBoundMs>SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS)throw Error('Qualified game-vision configuration unavailable');
 const pinned={...options,scope,provider:options.provider,generate:options.provider.generateGameFrame,qualification:{...options.qualification}};
 const configurationCurrent=()=>Object.keys(pinned).filter(key=>!['scope','generate','qualification'].includes(key)).every(key=>(options as unknown as Record<string,unknown>)[key]===(pinned as unknown as Record<string,unknown>)[key])&&isDeepStrictEqual(options.scope,scope)&&options.provider.generateGameFrame===pinned.generate&&isDeepStrictEqual(options.qualification,pinned.qualification)&&safe(pinned.runtimeCurrent)&&safe(pinned.qualification.current);
 const current=(observation:Readonly<G.GameObservation>)=>configurationCurrent()&&isDeepStrictEqual(observation.scope,scope)&&observation.pinsDigest===pinned.pinsDigest&&safe(()=>pinned.sourceCurrent(observation));
 const decoder:GameFrameDecoder={purpose:'simulatedGame/gameFramebuffer',configurationRef:pinned.configurationRef,decoderRevision:pinned.decoderRevision,manifestDigest:pinned.manifestDigest,allowedVisibleFieldIds:[],capability:{kind:'gameVision',vision:true,loadedProjectorSha256:pinned.loadedProjectorSha256},current,
  decode:async(input,external)=>{
   let owned:Buffer|undefined;
   const controller=new AbortController(),signal=AbortSignal.any([external,controller.signal]);
   let interval:ReturnType<typeof setInterval>|undefined,timer:ReturnType<typeof setTimeout>|undefined,lastWall=Date.now();
   const live=()=>{const now=Date.now();if(now<lastWall){controller.abort('clockChanged');return false;}lastWall=now;return !signal.aborted&&current(input.observation);};
   try{
    const observation=boundedGameDataSnapshot(input.observation) as G.GameObservation|null,shot=boundedGameDataSnapshot(input.screenshot) as G.GameScreenshot|null;
    if(input.purpose!=='simulatedGame/gameFramebuffer'||!observation||!shot||!validator.validate(schema+'GameObservation',observation).valid||!live()||observation.screenshots.length!==1||!isDeepStrictEqual(observation.screenshots[0],shot)||shot.mediaType!=='image/png'||shot.frameNumber!==observation.frameNumber||shot.capturedAt!==observation.capturedAt||!Buffer.isBuffer(input.bytes)||input.bytes.length!==shot.byteLength||input.bytes.length>pinned.maximumBytes||hash(input.bytes)!==shot.sha256)return null;
    const now=Date.now(),captured=Date.parse(observation.capturedAt),expires=Date.parse(shot.expiresAt);
    if(!Number.isFinite(captured)||!Number.isFinite(expires)||captured>now||now-captured>pinned.maximumObservationAgeMs||expires<=now)return null;
    const size=inspectGamePng(input.bytes,pinned.maximumLongEdge);if(size.width!==shot.width||size.height!==shot.height)return null;
    const deadline=Math.min(now+pinned.maximumDurationMs,captured+pinned.maximumObservationAgeMs,expires);
    owned=Buffer.from(input.bytes);let result:{facts:G.PlayerVisibleFact[];visibleState:G.PlayerVisibleStateValue[]}|null=null;
    timer=setTimeout(()=>controller.abort('deadline'),Math.max(1,deadline-Date.now()));timer.unref();
    interval=setInterval(()=>{if(!live()||Date.now()>=deadline||hash(owned!)!==shot.sha256)controller.abort('sourceChanged');},10);interval.unref();
    const work=await pinned.runBackground<Draft>({key:'game-vision:'+observation.observationId,deadlineAt:deadline,sharedInference:true,priority:'P2',providerPreemptionBoundMs:pinned.qualification.preemptionBoundMs,providerSlotReleaseBoundMs:pinned.qualification.slotReleaseBoundMs,current:()=>live()&&Date.now()<deadline,
     admitOnce:()=>live()&&pinned.admitOnce(observation),
     steps:[async workSignal=>{
      const combined=AbortSignal.any([signal,workSignal]);let output='',chunks=0,done=false;
      for await(const chunk of pinned.generate.call(pinned.provider,{purpose:'simulatedGame/gameFramebuffer',png:owned!,sha256:shot.sha256,width:shot.width,height:shot.height,deadlineAt:new Date(deadline).toISOString(),maximumOutputTokens:pinned.maximumOutputTokens,current:()=>live()&&Date.now()<deadline},{signal:combined})){
       if(combined.aborted||!live()){controller.abort('sourceChanged');throw Error('Game vision cancelled');}
       if(++chunks>512||done)throw Error('Invalid game vision terminal');
       if(chunk.kind==='text'&&typeof chunk.text==='string'){output+=chunk.text;if(Buffer.byteLength(output)>8192)throw Error('Game vision output bound');}
       else if(chunk.kind==='done')done=true;
       else throw Error('Unusable game vision response');
      }
      if(combined.aborted||!done||!live())throw Error('Incomplete game vision');
      const draft=parseGameVisionOutput(output);if(!draft)throw Error('Invalid closed game vision JSON');return draft;
     }],
     publish:draft=>{
      if(!live()||Date.now()>=deadline||hash(input.bytes)!==shot.sha256)return false;
      const limitations=['Model interpretation is uncalibrated and may hallucinate.','Only one sampled frame; no continuous awareness, hidden state, progress, save or input authority.','OCR candidates cannot become controller-visible fields or verified game state.'];
      const fact=(description:string,uncertainty:string):G.PlayerVisibleFact=>({factId:randomUUID(),description,epistemicKind:'inference',sourceScreenshotIds:[shot.screenshotId],extractionKind:'screenPixels',extractorRef:pinned.configurationRef,uncertainty,limitations:[...limitations],sourceKind:'playerVisibleGameObservation',untrusted:true});
      const facts:G.PlayerVisibleFact[]=[];
      if(draft.kind!=='unknown')facts.push(fact('Tentative frame kind: '+draft.kind,draft.uncertainty));
      if(draft.scene)facts.push(fact('Tentative scene: '+draft.scene,draft.uncertainty));
      for(const item of draft.text)facts.push(fact('Unverified OCR candidate: '+JSON.stringify(item.candidate),item.uncertainty+' '+draft.uncertainty));
      if(facts.some(item=>!validator.validate(schema+'PlayerVisibleFact',item).valid))return false;
      result={facts,visibleState:[]};return true;
     }});
    return work.state==='published'&&live()&&hash(input.bytes)===shot.sha256?result:null;
   }catch{return null;}finally{controller.abort();if(timer)clearTimeout(timer);if(interval)clearInterval(interval);owned?.fill(0);}
  }
 };
 return decoder;
}
