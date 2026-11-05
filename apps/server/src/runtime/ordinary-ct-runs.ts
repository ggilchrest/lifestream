import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {GameHostError} from './game-host-port.ts';

/** A configured ordinary task is a reusable seed, never a replayable run.
 * Each selection keeps identity, source pins and limits, and gets new ledger,
 * timeline and native-file identities. No files, consent or grants are copied. */
export function freshOrdinaryCtConfiguration(seed:any){
 const identities=[...['runId','activityId','campaignId','timelineId'].map(key=>seed.template[key]),seed.campaign?.journal?.journalId,seed.campaign?.checkpoint?.checkpointId].filter((value):value is string=>typeof value==='string');
 const ids=new Map([...new Set(identities)].map(value=>[value,randomUUID()]));
 const copy=(value:any):any=>typeof value==='string'?(ids.get(value)??value):Array.isArray(value)?value.map(copy):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,copy(child)])):value;
 const value=copy(seed),root=value.nativePreparation?.stateRoot;
 if(value.nativeInstallation?.kind!=='c72-container'||typeof root!=='string')throw Error('Ordinary CT native preparation required');
 value.nativeInstallation.configurationFile=join(root,'facts',value.template.runId+'.json');
 if(value.nativeInstallation.frameManifestFile!==undefined)value.nativeInstallation.frameManifestFile=join(root,'facts',value.template.runId+'.frame.json');
 // The seed's retained journal is not a reusable source of memories/advice.
 // New Start authorizes this configured task, not resurrection of old sources.
 if(value.campaign.journal){
  const goal=value.campaign.checkpoint.goalSummary;
  if(typeof goal!=='string'||!goal.trim())throw Error('Configured ordinary CT goal required');
  const entryId=randomUUID(),goalId=randomUUID(),time=new Date().toISOString();
  value.campaign.journal={...value.campaign.journal,revision:1,accessRevision:1,lifecycle:'active',summary:goal,summaryEntryIds:[entryId],entries:[{entryId,kind:'nextStep',epistemicKind:'inference',content:goal,sourceRefs:['urn:lifestream:ct-configured-run:'+value.template.runId],sourceSessionRef:'configured-task-not-human-advice',recordedAt:time,limitations:['Configured task goal for this fresh run; not prior memory, human advice, an observation, a model result or controller authority.']}],goals:[{goalId,description:goal,revision:1,status:'active',sourceEntryIds:[entryId],supersedesGoalId:null,updatedAt:time}],updatedAt:time};
  value.campaign.checkpoint.recordedAt=time;
  if(value.campaign.binding)value.campaign.binding.entryBindings=[{entryId,runId:value.template.runId,timelineId:value.template.timelineId,sourceObservationIds:[],sourceActionIds:[],sourceAdviceRefs:[],ordinarySaveDigest:null,currentDisposition:'current'}];
 }
 return value;
}

/** One existing backend at a time. Selection is inert; explicit Bind, reviews
 * and Start remain with the original owners. Active model work or unresolved
 * effects block replacement; unknown usage may stay held only against a
 * canonically closed, permanently retired checkpoint. */
export function createOrdinaryCtRunOwner(seed:any,construct:(configuration:any)=>any,retireRuntime:(runId:string,release:boolean,actor:any)=>void,onSelected:(configuration:any)=>void=()=>{}){
 let configuration=freshOrdinaryCtConfiguration(seed),owner=construct(configuration),changing=false,closed=false;
 onSelected(configuration);
 const available=()=>{if(closed||changing)throw new GameHostError(409,'game_run_transition_pending');};
 const nextRun=async(actor:any)=>{
  available();const previous=owner,state=previous.status(actor);
  if(!state.contextReady||(!state.started&&state.retired!==true)||state.state!=='stopped'||previous.cleanupConfirmed()!==true)throw new GameHostError(409,'game_run_cleanup_required');
  retireRuntime(configuration.template.runId,false,actor);
  const scope=previous.scope;
  changing=true;
  try{
   await previous.close();
   if(previous.cleanupConfirmed()!==true)throw new GameHostError(409,'game_run_cleanup_required');
   if(closed)throw new GameHostError(409,'game_run_transition_pending');
   if(actor.isCurrent(scope)!==true)throw new GameHostError(403,'game_session_scope_denied');
   retireRuntime(configuration.template.runId,true,actor);
   const next=freshOrdinaryCtConfiguration(seed),replacement=construct(next);
   configuration=next;owner=replacement;onSelected(next);return owner.status(actor);
  }finally{changing=false;}
 };
 const facade:any={nextRun,get selectedRunId(){return configuration.template.runId;},async close(){if(closed)return;closed=true;await owner.close();}};
 for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))){
  if(name==='close')continue;
  if(name==='status'){facade.status=(actor:any)=>{available();if(owner.retireExpiredBootstrap?.(actor)===true){const next=freshOrdinaryCtConfiguration(seed),replacement=construct(next);configuration=next;owner=replacement;onSelected(next);}const value=owner.status(actor);const restartAvailable=value.contextReady===true&&(value.started===true||value.retired===true)&&value.state==='stopped'&&owner.cleanupConfirmed()===true;return {...value,restartAvailable,readyForPlay:value.readyForPlay===true||restartAvailable&&value.startBudget?.available===true};};continue;}
  if('value'in descriptor&&typeof descriptor.value==='function')facade[name]=(...args:any[])=>{if(!['invalidate','timingCurrent','executionReady','executionQuiescent','cleanupConfirmed','bindingMatches'].includes(name))available();return owner[name](...args);};
  else Object.defineProperty(facade,name,{enumerable:true,get:()=>owner[name]});
 }
 return Object.freeze(facade);
}
