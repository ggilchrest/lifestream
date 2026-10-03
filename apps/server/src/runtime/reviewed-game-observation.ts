import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync,readlinkSync,statSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameHostMessage,type GameHostAttach} from '@lifestream/contracts/game-host';
import type * as G from '@lifestream/contracts/game-activity';
import {ActivityCheckpointRepository,type Database} from '@lifestream/storage-sqlite';
import type {SglangInferenceProvider} from '@lifestream/providers-sglang';
import type {BackgroundWork,BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import type {GameHostOptions,GameHostJoin} from './game-host-port.ts';
import type {GameRuntimeOptions} from './game-host-runtime.ts';
import {createGameVisionDecoder} from './game-vision-decoder.ts';
import {createGameObservationReader} from './game-frame-interpretation.ts';

const model='/srv/lifestream/models/qwen3.8-27b-uncensored-fp8-q4_k_m/5bdf224e6f9b1e18c7598fea63e238e014ee8e3e/qwen3.8-27b-uncensored-fp8-q4_k_m.gguf';
const binary='/srv/lifestream/deployment/releases/llama-ct-7c1f73825337d883-20261002/bin/llama-server';
const projector='/srv/lifestream/deployment/staging/ct-vision-projector-test-20261002T2204/Qwen3.8-27B-Uncensored-FP8.mmproj-Q8_0.gguf';
const binarySha='7c1f73825337d8839d21debc4340ebdbca1da508a538cec50fe42f86e486d66f',projectorSha='a2c009ea5ab5479383729820f49163e067ee4e46817e8d875f0cead17ffd2c46';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const closed=(o:unknown,keys:string[]):boolean=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys.sort().join(',');
const digest=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const safe=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
export type ReviewedGameObservationRun={schemaVersion:'1.0.0';recordType:'reviewedGameObservationRun';approvedUntil:string;attachment:unknown;vision:{pid:number;processStartTicks:string;configurationDigest:string;qualificationRef:string;qualificationReceiptSha256:string;binarySha256:string;modelSha256:string;projectorSha256:string}};
export function validateReviewedGameObservationRun(raw:unknown):ReviewedGameObservationRun{
 const c=boundedGameDataSnapshot(raw,32768) as ReviewedGameObservationRun|null;
 if(!c||!closed(c,['schemaVersion','recordType','approvedUntil','attachment','vision'])||c.schemaVersion!=='1.0.0'||c.recordType!=='reviewedGameObservationRun'||!Number.isFinite(Date.parse(c.approvedUntil))||Date.parse(c.approvedUntil)<=Date.now()||Date.parse(c.approvedUntil)>Date.now()+120000||!closed(c.vision,['pid','processStartTicks','configurationDigest','qualificationRef','qualificationReceiptSha256','binarySha256','modelSha256','projectorSha256'])||!Number.isSafeInteger(c.vision.pid)||c.vision.pid<1||!/^[0-9]+$/.test(c.vision.processStartTicks)||typeof c.vision.qualificationRef!=='string'||!c.vision.qualificationRef.trim()||c.vision.qualificationRef.length>1024||![c.vision.configurationDigest,c.vision.qualificationReceiptSha256,c.vision.binarySha256,c.vision.modelSha256,c.vision.projectorSha256].every(digest)||c.vision.binarySha256!==binarySha||c.vision.projectorSha256!==projectorSha||c.vision.modelSha256!=='66bb238d41de38b11dd406d932d8fb97433d529022cef60f2f422b9221cae743')throw Error('Reviewed CT observation configuration unavailable');
 const attach=structuredClone(c.attachment) as GameHostAttach;
 if(!attach?.scope?.contextBinding||attach.scope.contextBinding.sessionId!==null||attach.scope.contextBinding.conversationId!==null)throw Error('Reviewed current-owner template unavailable');
 attach.scope.contextBinding.sessionId=attach.scope.runId;attach.scope.contextBinding.conversationId=attach.scope.runId;
 if(!gameHostMessage('attach',attach))throw Error('Reviewed current-owner template unavailable');
 return c;
}
/** Operator proof is checked against the actual finite native process, not
 * client metadata. Artifact hashes were measured before launching that PID. */
export function qualifiedCtVisionCurrent(c:ReviewedGameObservationRun,configurationDigest:string):boolean{
 try{
  if(process.platform!=='linux'||Date.now()>=Date.parse(c.approvedUntil)||c.vision.configurationDigest!==configurationDigest||readlinkSync('/proc/'+c.vision.pid+'/exe')!==binary)return false;
  const proc=readFileSync('/proc/'+c.vision.pid+'/stat','utf8');if(proc.slice(proc.lastIndexOf(')')+2).split(' ')[19]!==c.vision.processStartTicks)return false;
  const args=readFileSync('/proc/'+c.vision.pid+'/cmdline','utf8').split('\0');
  const expected:Record<string,string>={'--model':model,'--mmproj':projector,'--mmproj-device':'CUDA0','--ctx-size':'8192','--parallel':'1','--gpu-layers':'99','--batch-size':'128','--ubatch-size':'64','--image-min-tokens':'64','--image-max-tokens':'256','--host':'192.168.2.15','--port':'30000'};
  if(!Object.entries(expected).every(([key,value])=>args.filter(a=>a===key).length===1&&args[args.indexOf(key)+1]===value)||!args.includes('--mmproj-offload'))return false;
  if(statSync(model).size!==16810714976||statSync(projector).size!==629247584)return false;
  const environment=readFileSync('/proc/'+c.vision.pid+'/environ','utf8').split('\0');return environment.includes('CUDA_VISIBLE_DEVICES=GPU-9ae27554-5834-97a5-6d7c-487700258d05');
 }catch{return false;}
}
type Ports={database:()=>Database;provider:()=>SglangInferenceProvider|undefined;runBackground:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;runtimeCurrent:()=>boolean;visionCurrent:()=>boolean;configurationDigest:()=>string;artifactDirectory:()=>string;readFrame:(scope:Readonly<G.ActivityScope>,observation:Readonly<G.GameObservation>,shot:Readonly<G.GameScreenshot>)=>Buffer|null;closeAttachment:(join:GameHostJoin)=>void};
/** Concrete one-frame production composition. The launcher reads an operator
 * file; the server supplies its own database/provider/coordinator. No model
 * prompt, HTTP metadata or renderer can select these ports or grant authority. */
export function createReviewedGameObservationComposition(configuration:ReviewedGameObservationRun,ports:Ports){
 const c=validateReviewedGameObservationRun(configuration),pinned=JSON.stringify(c),template=c.attachment as GameHostAttach;
 let bound:GameHostAttach|undefined,approval:ReturnType<GameRuntimeOptions['resolveApproval']>,used=false,ended=false,visionUsed=false,expires=0,lastWall=Date.now(),active:GameHostJoin|undefined;
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const live=()=>{const now=Date.now();if(now<lastWall){controller.abort('clockChanged');return false;}lastWall=now;return !ended&&!controller.signal.aborted&&now<Date.parse(c.approvedUntil)&&(!bound||performance.now()<expires)&&isDeepStrictEqual(configuration,c)&&safe(ports.runtimeCurrent)&&safe(ports.visionCurrent)&&ports.configurationDigest()===c.vision.configurationDigest;};
 const current=(scope:Readonly<G.ActivityScope>)=>!!bound&&isDeepStrictEqual(scope,bound.scope)&&live();
 const finish=()=>{if(ended)return;ended=true;controller.abort('completed');clearTimeout(timer);if(active)ports.closeAttachment(active);};
 const gameRuntime:GameRuntimeOptions={resolveApproval:scope=>current(scope)?approval??null:null,sourceCurrent:current};
 const record=(data:unknown)=>{
  if(!bound)return;const directory=ports.artifactDirectory();mkdirSync(directory,{recursive:true,mode:0o700});
  const bytes=Buffer.from(JSON.stringify(data,null,2)+'\n');if(bytes.length>32768)throw Error('Observation receipt bound');
  const fd=openSync(join(directory,'game-observation-'+bound.scope.runId+'.json'),'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);bytes.fill(0);}
  const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 };
 const gameHost:GameHostOptions={ownedFrames:true,maxAttachments:1,maxDurationMs:5000,
  createRepository:database=>new ActivityCheckpointRepository(database,{maxRuns:1,maxReservations:1,maxCheckpointBytes:32768,scopeCurrent:()=>false,quarantined:()=>false,policyFor:()=>null,allowCreate:()=>false,checkpointCurrent:()=>false,transitionCurrent:()=>false,planningCurrent:()=>false,usageCurrent:()=>false}),
  resolveAttachment:(actor,metadata)=>{
   if(used||!live())return null;const expected=structuredClone(template),row=ports.database().connection.prepare("SELECT conversation_id FROM sessions WHERE id=? AND status='active'").get(actor.sessionId);
   if(!row||actor.principalId!==expected.scope.principalId||actor.sessionId!==metadata.scope.contextBinding.sessionId)return null;
   expected.scope.contextBinding.sessionId=actor.sessionId;expected.scope.contextBinding.conversationId=row.conversation_id as string;
   if(!isDeepStrictEqual(expected,metadata)||!actor.isCurrent(metadata.scope))return null;
   used=true;bound=structuredClone(metadata);expires=performance.now()+Math.min(30000,Date.parse(c.approvedUntil)-Date.now());
   approval={scope:structuredClone(bound.scope),approvedUntil:new Date(Math.min(Date.now()+30000,Date.parse(c.approvedUntil))).toISOString(),maximumRunMs:30000,maximumPlanningSteps:1,observations:true,campaignJournal:true,controllerInput:false,memoryEpisodes:false};
   timer=setTimeout(finish,Math.max(1,Date.parse(approval.approvedUntil)-Date.now()));timer.unref();
   const {protocol:_,...binding}=expected;return binding;
  },
  bindingCurrent:(actor,binding)=>current(binding.scope)&&actor.principalId===binding.scope.principalId&&actor.sessionId===binding.scope.contextBinding.sessionId,
  controllerCurrent:()=>false,
  boundary:{sourceAvailable:(scope,pins)=>current(scope)&&pins===bound?.pinsDigest,acceptObservation:(request,o)=>current(request.scope)&&isDeepStrictEqual(request.scope,o.scope)&&o.pinsDigest===bound?.pinsDigest&&o.facts.length===0&&o.visibleState.length===0,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false},
  onAttached:join=>{
   if(active||!current(join.scope)||!join.runtime?.isCurrent())throw Error('Concrete observation attachment unavailable');active=join;
   void (async()=>{
    const provider=ports.provider(),started=Date.now();let observation:G.GameObservation|null=null,failure:string|null=null;
    try{
     if(!provider||typeof provider.generateGameFrame!=='function')throw Error('Selected game-vision provider unavailable');
     const sourceCurrent=(scope:Readonly<G.ActivityScope>)=>current(scope)&&ports.provider()===provider&&join.runtime!.isCurrent();
     const decoder=createGameVisionDecoder({scope:join.scope,pinsDigest:bound!.pinsDigest,configurationRef:'reviewed-ct-observation:'+c.vision.qualificationReceiptSha256,decoderRevision:'1.0.0',manifestDigest:hash(pinned),loadedProjectorSha256:projectorSha,provider,runBackground:ports.runBackground,sourceCurrent:o=>sourceCurrent(o.scope),runtimeCurrent:()=>sourceCurrent(join.scope),admitOnce:()=>{if(visionUsed||!sourceCurrent(join.scope))return false;visionUsed=true;return true;},qualification:{preemptionBoundMs:10,slotReleaseBoundMs:250,reference:c.vision.qualificationRef,current:ports.visionCurrent},maximumDurationMs:5000,maximumObservationAgeMs:30000,maximumBytes:2097152,maximumLongEdge:1024,maximumOutputTokens:256});
     const observe=createGameObservationReader({decoder,sourceCurrent,pinsDigestFor:scope=>current(scope)?bound!.pinsDigest:null,readFrame:async(o,shot)=>ports.readFrame(join.scope,o,shot),maximumDurationMs:5000,maximumBytes:2097152,maximumLongEdge:1024,maximumObservationAgeMs:30000});
     observation=await observe(join,controller.signal);if(!sourceCurrent(join.scope))observation=null;
    }catch{failure='qualifiedCurrentObservationUnavailable';}
    finally{
     try{record({schemaVersion:'1.0.0',recordType:'boundedGameObservationReceipt',runId:join.scope.runId,scope:join.scope,attachmentId:join.attachmentId,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),state:observation?'observed':'unavailable',failure,observation,configurationDigest:c.vision.configurationDigest,qualificationRef:c.vision.qualificationRef,rawFramesRetained:false,planningCalls:0,controllerCalls:0,memoryWrites:0,visionCalls:visionUsed?1:0,meaningfulGameplayAccepted:false,nativeClosedPausedNeutral:'Windows must independently verify actual child shutdown'});}finally{finish();}
    }
   })().catch(()=>finish());
  }
 };
 return {gameHost,gameRuntime,stop:finish};
}
