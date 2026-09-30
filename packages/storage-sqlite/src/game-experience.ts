import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameEpisodeSnapshot,gameEpisodeFamilyKey,gameEpisodeDigest} from '@lifestream/contracts/game-memory';
import type * as G from '@lifestream/contracts/game-activity';
import type {Database,Transaction} from './database.ts';
import type {ActivityOwner} from './game-activity.ts';
import type {GameMemorySourceOptions} from './memory.ts';
import {retireGameHelpForEpisode} from './game-help.ts';
type Row={episode_id:string;owner_key:string;revision:number;family_key:string;policy_digest:string;source_digest:string;expires_at:number;state:string;payload_json:string|null};
export type GameEpisodeRetention={retentionMs:number;retentionPolicyRef:string;maximumEpisodes:number;maximumBytes:number};
export type GameEpisodeSources={observations:G.GameObservation[];actions:G.GameActionReceipt[]};
export type GameEpisodeOptions={
 maximumFences:number;
 scopeCurrent:(owner:Readonly<ActivityOwner>)=>boolean;quarantined:()=>boolean;
 retentionFor:(owner:Readonly<ActivityOwner>,activityId:string)=>GameEpisodeRetention|null;
 /** Qualified recorded sources, never a model-supplied grant or free-form assertion. */
 sourceRecordsFor:(episode:Readonly<G.GameExperienceEpisode>)=>GameEpisodeSources|null;
 meaningfulGroundingCurrent:(episode:Readonly<G.GameExperienceEpisode>,sources:Readonly<GameEpisodeSources>)=>boolean;
 publicationCurrent:(episode:Readonly<G.GameExperienceEpisode>)=>boolean;
 /** Historical source/correction/privacy currency, independent of play authority. */
 retainedSourceCurrent:(episode:Readonly<G.GameExperienceEpisode>)=>boolean;
 now?:()=>number;
};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const ownerKey=(o:ActivityOwner)=>hash([o.principalId,o.assistantId,o.relationshipId]);
const ownerOf=(e:G.GameExperienceEpisode):ActivityOwner=>({principalId:e.scope.principalId,assistantId:e.scope.assistantId,relationshipId:e.scope.relationshipId});
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const checked=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const positive=(n:unknown,max:number):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=max;
function scrubProjections(tx:Transaction,id:string){
 retireGameHelpForEpisode(tx,id);
 for(const row of tx.all<{id:string;assistant_id:string;provenance_json:string;lifecycle_json:string}>("SELECT id,assistant_id,provenance_json,lifecycle_json FROM memories WHERE json_extract(provenance_json,'$.gameEpisodeId')=?",id)){
  const p=JSON.parse(row.provenance_json),l=JSON.parse(row.lifecycle_json);
  tx.run("UPDATE memories SET content='',provenance_json=?,lifecycle_json=? WHERE id=?",JSON.stringify({actor:p.actor,relationshipId:p.relationshipId,gameFamilyKey:p.gameFamilyKey,gameEpisodeKey:p.gameEpisodeKey,payloadRemoved:true}),JSON.stringify({status:'invalidated',revision:Number(l.revision)+1,contentRemoved:true}),row.id);
  tx.run('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=? AND assistant_id=?',JSON.stringify({payloadRemoved:true}),row.id,row.assistant_id);
 }
}
export function retireGameExperienceSource(tx:Transaction,id:string,owner:ActivityOwner,state:'forgotten'|'invalidated'){
 tx.run("UPDATE game_experience_episodes SET state=?,payload_json=NULL,revision=revision+1 WHERE episode_id=? AND owner_key=? AND state='retained'",state,id,ownerKey(owner));
 if(tx.get<{n:number}>('SELECT changes() AS n')!.n===1)scrubProjections(tx,id);
}
export function retireGameExperience(tx:Transaction,owner?:ActivityOwner):number{
 const rows=owner?tx.all<{episode_id:string}>("SELECT episode_id FROM game_experience_episodes WHERE owner_key=? AND state='retained'",ownerKey(owner)):tx.all<{episode_id:string}>("SELECT episode_id FROM game_experience_episodes WHERE state='retained'");
 for(const row of rows){tx.run("UPDATE game_experience_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE episode_id=?",row.episode_id);scrubProjections(tx,row.episode_id);}return rows.length;
}
/** Called by the existing isolated restore path before any restored source is
 * exposed. This never enables memory, gameplay, replay or native recovery. */
export const quarantineGameExperience=(db:Database)=>db.transaction(tx=>retireGameExperience(tx));
export class GameExperienceRepository{
 private readonly db:Database;private readonly options:Readonly<GameEpisodeOptions>;private readonly maximumFences:number;
 constructor(db:Database,options:GameEpisodeOptions){if(!positive(options.maximumFences,8192))throw Error('Game episode bound unavailable');this.db=db;this.options=Object.freeze({...options});this.maximumFences=options.maximumFences;}
 private time(){const now=(this.options.now??Date.now)(),floor=this.db.connection.prepare('SELECT observed_at FROM game_experience_clock WHERE singleton=1').get()!.observed_at as number;if(!Number.isSafeInteger(now)||now<floor||!Number.isFinite(new Date(now).getTime()))throw Error('Game episode clock unavailable');this.db.connection.prepare('UPDATE game_experience_clock SET observed_at=? WHERE singleton=1').run(now);return now;}
 private owner(raw:ActivityOwner){const o=boundedGameDataSnapshot(raw) as ActivityOwner|null,uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(s);if(!o||Object.keys(o).sort().join(',')!=='assistantId,principalId,relationshipId'||!uuid(o.principalId)||!uuid(o.assistantId)||o.relationshipId!==null&&!uuid(o.relationshipId))throw Error('Game episode owner unavailable');return freeze(o);}
 private policy(o:ActivityOwner,id:string){
  if(!checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(o)))throw Error('Game memory scope unavailable');
  const p=boundedGameDataSnapshot(this.options.retentionFor(o,id)) as GameEpisodeRetention|null;
  const memory=this.db.connection.prepare('SELECT revision FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id IS ? AND enabled=1').get(o.principalId,o.assistantId,o.relationshipId);
  if(!memory||!p||Object.keys(p).sort().join(',')!=='maximumBytes,maximumEpisodes,retentionMs,retentionPolicyRef'||!positive(p.retentionMs,2147483647)||!positive(p.maximumEpisodes,128)||!positive(p.maximumBytes,16384)||typeof p.retentionPolicyRef!=='string'||!p.retentionPolicyRef.trim()||Buffer.byteLength(p.retentionPolicyRef)>2048)throw Error('Independent game memory retention unavailable');
  return freeze({memoryRevision:Number(memory.revision),...p});
 }
 private current(e:G.GameExperienceEpisode,p:ReturnType<GameExperienceRepository['policy']>){try{return this.options.retainedSourceCurrent(e)===true&&isDeepStrictEqual(this.policy(ownerOf(e),e.scope.activityId),p);}catch{return false;}}
 private row(id:string){return this.db.connection.prepare('SELECT * FROM game_experience_episodes WHERE episode_id=?').get(id) as Row|undefined;}
 private erase(row:Row,state:'invalidated'|'expired'|'forgotten'){this.db.transaction(tx=>{tx.run('UPDATE game_experience_episodes SET state=?,payload_json=NULL,revision=revision+1 WHERE episode_id=? AND revision=?',state,row.episode_id,row.revision);scrubProjections(tx,row.episode_id);});}
 private sources(e:G.GameExperienceEpisode,now:number):GameEpisodeSources|null{
  const s=boundedGameDataSnapshot(this.options.sourceRecordsFor(e),131072) as GameEpisodeSources|null;
  if(!s||Object.keys(s).sort().join(',')!=='actions,observations'||!Array.isArray(s.observations)||!Array.isArray(s.actions)||s.observations.length!==e.sourceObservationIds.length||s.actions.length!==e.sourceActionIds.length)return null;
  const observations=new Map(s.observations.map(o=>[o.observationId,o])),actions=new Map(s.actions.map(a=>[a.actionId,a]));
  if(observations.size!==s.observations.length||actions.size!==s.actions.length||!e.sourceObservationIds.every(id=>observations.has(id))||!e.sourceActionIds.every(id=>actions.has(id)))return null;
  if(s.observations.some(o=>!validator.validate(schema+'GameObservation',o).valid||!isDeepStrictEqual(o.scope,e.scope)||o.pinsDigest!==e.pinsDigest||o.frameNumber<e.frameRange.from||o.frameNumber>e.frameRange.to||Date.parse(o.capturedAt)<Date.parse(e.occurredFrom)||Date.parse(o.capturedAt)>Date.parse(e.occurredTo)||Date.parse(o.receivedAt)<Date.parse(o.capturedAt)||Date.parse(o.receivedAt)>now||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<Date.parse(o.receivedAt)||Date.parse(o.interpretedAt)>now)||o.screenshots.some(f=>f.frameNumber!==o.frameNumber||f.capturedAt!==o.capturedAt)))return null;
  if(!isDeepStrictEqual([...e.sourceAdmissionIds].sort(),s.actions.map(a=>a.admissionId).sort())||s.actions.some(a=>!validator.validate(schema+'GameActionReceipt',a).valid||!isDeepStrictEqual(a.scope,e.scope)||!['started','completed','failed','cancelled','outcomeUnknown'].includes(a.disposition)||a.startedAt===null||a.beforeFrame===null||a.beforeFrame<e.frameRange.from||a.beforeFrame>e.frameRange.to||Date.parse(a.startedAt)<Date.parse(e.occurredFrom)||Date.parse(a.recordedAt)>Date.parse(e.recordedAt)||Date.parse(a.startedAt)>Date.parse(a.recordedAt)||a.completedAt!==null&&(Date.parse(a.completedAt)<Date.parse(a.startedAt)||Date.parse(a.completedAt)>Date.parse(a.recordedAt))||a.afterFrame!==null&&(a.afterFrame<a.beforeFrame||a.afterFrame>e.frameRange.to)||!s.observations.some(o=>(o.previousActionId===a.actionId||a.resultingObservationIds.includes(o.observationId))&&o.frameNumber>=a.beforeFrame!&&Date.parse(o.capturedAt)>=Date.parse(a.startedAt!))))return null;
  return freeze(s);
 }
 admit(raw:G.GameExperienceEpisode):boolean{
  const now=this.time(),e=gameEpisodeSnapshot(raw,now);if(!e)return false;freeze(e);const o=freeze(ownerOf(e)),p=this.policy(o,e.scope.activityId);
  if(e.rawEvidenceAvailability!=='notRetained'||e.adviceRefs.length>0||e.retentionPolicyRef!==p.retentionPolicyRef||Date.parse(e.expiresAt)>Date.parse(e.occurredFrom)+p.retentionMs||Buffer.byteLength(JSON.stringify(e))>p.maximumBytes)return false;
  const sources=this.sources(e,now);if(!sources||!checked(()=>this.options.meaningfulGroundingCurrent(e,sources)&&this.options.publicationCurrent(e))||!this.current(e,p))return false;
  const sourceKeys=[...e.sourceObservationIds.map(id=>'observation:'+id),...e.sourceActionIds.map(id=>'action:'+id)].map(id=>hash([ownerKey(o),e.scope.campaignId,id]));
  return this.db.transaction(tx=>{
   if(this.row(e.episodeId)||tx.get('SELECT 1 FROM game_experience_episodes WHERE family_key=?',gameEpisodeFamilyKey(e))||sourceKeys.some(k=>tx.get('SELECT 1 FROM game_experience_sources WHERE source_key=?',k)))return false;
   if(tx.get<{n:number}>('SELECT count(*) AS n FROM game_experience_episodes')!.n>=this.maximumFences||tx.get<{n:number}>('SELECT count(*) AS n FROM game_experience_episodes WHERE owner_key=?',ownerKey(o))!.n>=p.maximumEpisodes)throw Error('Game episode capacity exceeded');
   if(!this.current(e,p)||!checked(()=>this.options.publicationCurrent(e)))return false;
   tx.run("INSERT INTO game_experience_episodes VALUES(?,?,?,?,?,?,?,'retained',?)",e.episodeId,ownerKey(o),e.revision,gameEpisodeFamilyKey(e),hash(p),gameEpisodeDigest(e),Date.parse(e.expiresAt),JSON.stringify(e));
   for(const k of sourceKeys)tx.run('INSERT INTO game_experience_sources VALUES(?,?)',k,e.episodeId);
   const finalSources=this.sources(e,this.time());
   if(!finalSources||!isDeepStrictEqual(finalSources,sources)||!checked(()=>this.options.meaningfulGroundingCurrent(e,finalSources)&&this.options.publicationCurrent(e))||!this.current(e,p)||!isDeepStrictEqual(this.sources(e,this.time()),sources)||tx.get<{revision:number}>('SELECT revision FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id IS ? AND enabled=1',o.principalId,o.assistantId,o.relationshipId)?.revision!==p.memoryRevision||this.time()>=Date.parse(e.expiresAt))throw Error('Game episode changed during admission');return true;
  });
 }
 get(ownerValue:ActivityOwner,id:string):G.GameExperienceEpisode|null{
  const o=this.owner(ownerValue),now=this.time(),row=this.row(id);if(!row||row.owner_key!==ownerKey(o)||row.state!=='retained'||!row.payload_json)return null;
  if(row.expires_at<=now){this.erase(row,'expired');return null;}
  let e:G.GameExperienceEpisode|null=null;try{e=gameEpisodeSnapshot(JSON.parse(row.payload_json),now);}catch{}if(!e||e.episodeId!==row.episode_id||e.revision!==row.revision||gameEpisodeFamilyKey(e)!==row.family_key||gameEpisodeDigest(e)!==row.source_digest||Date.parse(e.expiresAt)!==row.expires_at||!isDeepStrictEqual(ownerOf(e),o)){this.erase(row,'invalidated');return null;}
  freeze(e);let p:ReturnType<GameExperienceRepository['policy']>;try{p=this.policy(o,e.scope.activityId);}catch{return null;}
  if(row.policy_digest!==hash(p)||!this.current(e,p)){this.erase(row,'invalidated');return null;}
  return freeze(e);
 }
 inspect(ownerValue:ActivityOwner){const o=this.owner(ownerValue);this.time();if(!checked(()=>this.options.scopeCurrent(o)&&this.options.quarantined()===false))return [];return (this.db.connection.prepare('SELECT episode_id,revision,state FROM game_experience_episodes WHERE owner_key=? ORDER BY episode_id LIMIT 128').all(ownerKey(o)) as {episode_id:string;revision:number;state:string}[]).map(row=>{const episode=this.get(o,row.episode_id),current=this.row(row.episode_id)!;return {episodeId:row.episode_id,revision:current.revision,state:current.state,episode};});}
 forget(ownerValue:ActivityOwner,id:string,expectedRevision:number){const o=this.owner(ownerValue);this.time();if(!checked(()=>this.options.scopeCurrent(o)))throw Error('Game episode owner unavailable');const row=this.row(id);if(!row||row.owner_key!==ownerKey(o)||row.revision!==expectedRevision||row.state!=='retained')throw Error('Game episode revision conflict');this.erase(row,'forgotten');}
 sweep(){const now=this.time();for(const row of this.db.connection.prepare("SELECT * FROM game_experience_episodes WHERE state='retained'").all() as Row[]){let e:G.GameExperienceEpisode|null=null;try{e=row.payload_json?gameEpisodeSnapshot(JSON.parse(row.payload_json),now):null;}catch{}if(row.expires_at<=now)this.erase(row,'expired');else if(!e||gameEpisodeDigest(e)!==row.source_digest)this.erase(row,'invalidated');else if(e){try{const p=this.policy(ownerOf(e),e.scope.activityId);if(row.policy_digest!==hash(p)||!this.current(e,p))this.erase(row,'invalidated');}catch{if(checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(ownerOf(e))))this.erase(row,'invalidated');}}}}
 memorySources(maximumCandidates:number):GameMemorySourceOptions{return {maximumCandidates,now:()=>this.time(),resolveSource:binding=>{const row=this.row(binding.episodeId);if(!row?.payload_json)return null;const e=JSON.parse(row.payload_json) as G.GameExperienceEpisode;const found=this.get(ownerOf(e),binding.episodeId);return found&&found.revision===binding.episodeRevision?found:null;},memoryPolicyCurrent:e=>{try{return !!this.policy(ownerOf(e),e.scope.activityId);}catch{return false;}},sourceCurrent:e=>{const found=this.get(ownerOf(e),e.episodeId);return found!==null&&isDeepStrictEqual(found,e);}};}
}
