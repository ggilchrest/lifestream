import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameEpisodeSnapshot,gameEpisodeDigest} from '@lifestream/contracts/game-memory';
import type {GameHelpItem,GameExperienceEpisode} from '@lifestream/contracts/game-activity';
import type {ActivityOwner} from './game-activity.ts';
import type {Database,Transaction} from './database.ts';
export type GameHelpRetention={revision:number;policyRef:string;retentionMs:number;maximumItems:number;maximumBytes:number};
export type GameHelpOptions={
 maximumFences:number;scopeCurrent:(owner:Readonly<ActivityOwner>)=>boolean;quarantined:()=>boolean;
 retentionFor:(owner:Readonly<ActivityOwner>,activityId:string)=>GameHelpRetention|null;
 /** Actual independently retained canonical source ledger, not caller prose. */
 episodeFor:(owner:Readonly<ActivityOwner>,episodeId:string)=>GameExperienceEpisode|null;
 /** Read-only atomic joined source/lifecycle/recipient/attachment policy epoch. */
 boundaryRevision:()=>string|null;
 /** Existing inert source qualification: exact visible attempts/question,
  * native pause, recipient configuration and separate attachment custody. */
 pendingCurrent:(item:Readonly<GameHelpItem>,episode:Readonly<GameExperienceEpisode>)=>boolean;
 /** Qualified observed situation/action-result equivalence; exclude plan
  * wording, run/timeline reloads and configuration changes from independence. */
 situationKeyFor:(item:Readonly<GameHelpItem>,episode:Readonly<GameExperienceEpisode>)=>string|null;
 now?:()=>number;
};
type Row={help_id:string;owner_key:string;episode_id:string;episode_digest:string;family_key:string;policy_digest:string;revision:number;expires_at:number;state:string;payload_json:string|null;payload_digest:string|null};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameHelpItem';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const ownerKey=(o:ActivityOwner)=>hash([o.principalId,o.assistantId,o.relationshipId]);
const ownerOf=(e:GameExperienceEpisode|GameHelpItem):ActivityOwner=>({principalId:e.scope.principalId,assistantId:e.scope.assistantId,relationshipId:e.scope.relationshipId});
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const positive=(n:unknown,max:number):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=max;
const checked=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const unavailable=()=>Error('Current bounded pending game help unavailable');
/** Called inside existing source/forget/restore transactions. A pre-65
 * database has no help payload; it never acquires one via this cleanup. */
export function retireGameHelpForEpisode(tx:Transaction,episodeId:string){
 if(!tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_help_items'"))return;
 tx.run("UPDATE game_help_items SET state='invalidated',payload_json=NULL,payload_digest=NULL,revision=revision+1 WHERE episode_id=? AND state='pending'",episodeId);
}
/** A pending metadata ledger only. No dispatcher, enrollment, retries,
 * attachment bytes, automatic resume or channel-outcome mutation exists. */
export class GameHelpRepository{
 private readonly db:Database;private readonly options:Readonly<GameHelpOptions>;
 constructor(db:Database,options:GameHelpOptions){if(!positive(options.maximumFences,8192))throw unavailable();this.db=db;this.options=Object.freeze({...options});}
 private time(){const now=(this.options.now??Date.now)(),floor=Number(this.db.connection.prepare('SELECT observed_at FROM game_help_clock WHERE singleton=1').get()!.observed_at);if(!Number.isSafeInteger(now)||now<floor||!Number.isFinite(new Date(now).getTime()))throw Error('Game help clock unavailable');this.db.connection.prepare('UPDATE game_help_clock SET observed_at=? WHERE singleton=1').run(now);return now;}
 private owner(raw:ActivityOwner){const o=boundedGameDataSnapshot(raw) as ActivityOwner|null,uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(v);if(!o||Object.keys(o).sort().join(',')!=='assistantId,principalId,relationshipId'||!uuid(o.principalId)||!uuid(o.assistantId)||o.relationshipId!==null&&!uuid(o.relationshipId))throw unavailable();return freeze(o);}
 private policy(o:ActivityOwner,activityId:string){
  if(!checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(o)))throw unavailable();
  const p=boundedGameDataSnapshot(this.options.retentionFor(o,activityId)) as GameHelpRetention|null,memory=this.db.connection.prepare('SELECT revision FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id IS ? AND enabled=1').get(o.principalId,o.assistantId,o.relationshipId);
  if(!memory||!p||Object.keys(p).sort().join(',')!=='maximumBytes,maximumItems,policyRef,retentionMs,revision'||!positive(p.revision,2147483647)||typeof p.policyRef!=='string'||!p.policyRef.trim()||Buffer.byteLength(p.policyRef)>2048||!positive(p.retentionMs,2147483647)||!positive(p.maximumItems,128)||!positive(p.maximumBytes,16384))throw unavailable();
  return freeze({...p,memoryRevision:Number(memory.revision)});
 }
 private source(o:ActivityOwner,id:string,now:number){const e=gameEpisodeSnapshot(this.options.episodeFor(o,id),now);if(!e||e.episodeId!==id||!isDeepStrictEqual(ownerOf(e),o))return null;const row=this.db.connection.prepare("SELECT source_digest,payload_json FROM game_experience_episodes WHERE episode_id=? AND state='retained'").get(id);if(!row||row.source_digest!==gameEpisodeDigest(e)||row.payload_json!==JSON.stringify(e))return null;return freeze(e);}
 private revision(){const r=this.options.boundaryRevision();if(typeof r!=='string'||!r.trim()||Buffer.byteLength(r)>1024)throw unavailable();return r;}
 private bound(item:GameHelpItem,e:GameExperienceEpisode,now:number){const same=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));return validator.validate(schema,item).valid&&['queued','deferred'].includes(item.status)&&item.attemptsSummary===e.summary&&item.question.trim().length>0&&isDeepStrictEqual(item.scope,e.scope)&&Date.parse(item.queuedAt)>=Date.parse(e.recordedAt)&&Date.parse(item.queuedAt)<=now&&same(item.attemptedActionIds,e.sourceActionIds)&&same(item.sourceObservationIds,e.sourceObservationIds)&&item.attachmentStatus==='queued'&&[item.sentAt,item.messageSentEvidenceRef,item.attachmentSentEvidenceRef,item.deliveryEvidenceRef,item.replyAdviceRef,item.authenticatedReplyEvidenceRef,item.attachmentTransferredEvidenceRef,item.attachmentDeliveryEvidenceRef].every(x=>x===null);}
 private current(item:GameHelpItem,e:GameExperienceEpisode,p:ReturnType<GameHelpRepository['policy']>,revision:string,situation:string){try{const o=ownerOf(item),fresh=this.source(o,e.episodeId,this.time());if(!fresh||gameEpisodeDigest(fresh)!==gameEpisodeDigest(e)||!isDeepStrictEqual(this.policy(o,item.scope.activityId),p)||this.revision()!==revision||this.options.situationKeyFor(item,e)!==situation||this.options.pendingCurrent(item,e)!==true)return false;const after=this.source(o,e.episodeId,this.time());return !!after&&gameEpisodeDigest(after)===gameEpisodeDigest(e)&&isDeepStrictEqual(this.policy(o,item.scope.activityId),p)&&this.revision()===revision;}catch{return false;}}
 queue(raw:{item:GameHelpItem;episodeId:string;expiresAt:number}):boolean{
  const now=this.time(),v=boundedGameDataSnapshot(raw,32768) as typeof raw|null;if(!v||Object.keys(v).sort().join(',')!=='episodeId,expiresAt,item'||!validator.validate(schema,v.item).valid||typeof v.episodeId!=='string'||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now)return false;freeze(v);
  const item=v.item,o=this.owner(ownerOf(item)),p=this.policy(o,item.scope.activityId),e=this.source(o,v.episodeId,now);if(!e||!this.bound(item,e,now)||v.expiresAt>Math.min(now+p.retentionMs,Date.parse(e.expiresAt))||Buffer.byteLength(JSON.stringify(item))>p.maximumBytes)return false;
  const revision=this.revision(),situation=this.options.situationKeyFor(item,e);if(typeof situation!=='string'||!/^[a-f0-9]{64}$/u.test(situation)||!this.current(item,e,p,revision,situation))return false;const family=hash([ownerKey(o),item.scope.activityId,item.scope.campaignId,situation]);
  return this.db.transaction(tx=>{
   if(tx.get('SELECT 1 FROM game_help_items WHERE help_id=? OR family_key=?',item.helpId,family))return false;
   if(tx.get<{n:number}>('SELECT count(*) AS n FROM game_help_items')!.n>=this.options.maximumFences||tx.get<{n:number}>('SELECT count(*) AS n FROM game_help_items WHERE owner_key=?',ownerKey(o))!.n>=p.maximumItems)throw Error('Game help capacity exceeded');
   if(!this.current(item,e,p,revision,situation))return false;
   tx.run("INSERT INTO game_help_items VALUES(?,?,?,?,?,?,1,?,'pending',?,?)",item.helpId,ownerKey(o),e.episodeId,gameEpisodeDigest(e),family,hash(p),v.expiresAt,JSON.stringify(item),hash(item));
   if(!this.current(item,e,p,revision,situation)||this.time()>=v.expiresAt||!this.current(item,e,p,revision,situation)||this.time()>=v.expiresAt)throw unavailable();return true;
  });
 }
 private erase(row:Row,state:'forgotten'|'expired'|'invalidated'){this.db.connection.prepare('UPDATE game_help_items SET state=?,payload_json=NULL,payload_digest=NULL,revision=revision+1 WHERE help_id=? AND revision=? AND state=?').run(state,row.help_id,row.revision,'pending');}
 get(raw:ActivityOwner,id:string){
  const o=this.owner(raw),now=this.time();if(!checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(o)))return null;
  const row=this.db.connection.prepare('SELECT * FROM game_help_items WHERE help_id=? AND owner_key=?').get(id,ownerKey(o)) as Row|undefined;if(!row||row.state!=='pending'||!row.payload_json)return null;if(now>=row.expires_at){this.erase(row,'expired');return null;}
  let item:GameHelpItem;try{item=JSON.parse(row.payload_json);if(!validator.validate(schema,item).valid||hash(item)!==row.payload_digest||item.helpId!==row.help_id||!isDeepStrictEqual(ownerOf(item),o))throw unavailable();}catch{this.erase(row,'invalidated');return null;}
  freeze(item);let e:GameExperienceEpisode|null,p:ReturnType<GameHelpRepository['policy']>;try{p=this.policy(o,item.scope.activityId);e=this.source(o,row.episode_id,now);}catch{return null;}
  if(!e||gameEpisodeDigest(e)!==row.episode_digest||row.policy_digest!==hash(p)||!this.bound(item,e,now)){this.erase(row,'invalidated');return null;}
  try{const revision=this.revision(),situation=this.options.situationKeyFor(item,e);if(typeof situation!=='string'||row.family_key!==hash([ownerKey(o),item.scope.activityId,item.scope.campaignId,situation])||!this.current(item,e,p,revision,situation)||this.time()>=row.expires_at)return null;const latest=this.db.connection.prepare('SELECT revision,state,payload_digest FROM game_help_items WHERE help_id=?').get(row.help_id);if(latest?.revision!==row.revision||latest.state!=='pending'||latest.payload_digest!==row.payload_digest)return null;return freeze({item,revision:row.revision,episodeId:e.episodeId,pinsDigest:e.pinsDigest,sourceBoundaryRevision:revision,expiresAt:row.expires_at,sendAuthority:false as const,resumeAuthority:false as const});}catch{return null;}
 }
 /** Retained original question lineage only. Native pause/current recipient
  * qualification is deliberately separate from historical custody. This view
  * supplies no question delivery, new planning, send or resume authority. */
 getForHistory(raw:ActivityOwner,id:string){
  const o=this.owner(raw),now=this.time();if(!checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(o)))return null;
  const row=this.db.connection.prepare('SELECT * FROM game_help_items WHERE help_id=? AND owner_key=?').get(id,ownerKey(o)) as Row|undefined;if(!row||row.state!=='pending'||!row.payload_json)return null;if(now>=row.expires_at){this.erase(row,'expired');return null;}
  let item:GameHelpItem;try{item=JSON.parse(row.payload_json);if(!validator.validate(schema,item).valid||hash(item)!==row.payload_digest||item.helpId!==row.help_id||!isDeepStrictEqual(ownerOf(item),o))throw unavailable();}catch{this.erase(row,'invalidated');return null;}
  freeze(item);try{const p=this.policy(o,item.scope.activityId),e=this.source(o,row.episode_id,now);if(!e||gameEpisodeDigest(e)!==row.episode_digest||row.policy_digest!==hash(p)||!this.bound(item,e,now)){this.erase(row,'invalidated');return null;}
   const after=this.source(o,row.episode_id,this.time()),latest=this.db.connection.prepare('SELECT revision,state,payload_digest FROM game_help_items WHERE help_id=?').get(row.help_id);if(!after||gameEpisodeDigest(after)!==gameEpisodeDigest(e)||!isDeepStrictEqual(this.policy(o,item.scope.activityId),p)||latest?.revision!==row.revision||latest.state!=='pending'||latest.payload_digest!==row.payload_digest||this.time()>=row.expires_at)return null;
   return freeze({item,revision:row.revision,episodeId:e.episodeId,pinsDigest:e.pinsDigest,expiresAt:row.expires_at,planningAuthority:false as const,sendAuthority:false as const,resumeAuthority:false as const});
  }catch{return null;}
 }
 inspect(raw:ActivityOwner){const o=this.owner(raw);this.time();if(!checked(()=>this.options.quarantined()===false&&this.options.scopeCurrent(o)))return [];return (this.db.connection.prepare('SELECT help_id FROM game_help_items WHERE owner_key=? ORDER BY help_id LIMIT 128').all(ownerKey(o)) as {help_id:string}[]).map(r=>{const pending=this.get(o,r.help_id),row=this.db.connection.prepare('SELECT revision,state FROM game_help_items WHERE help_id=?').get(r.help_id)!;return {helpId:r.help_id,revision:Number(row.revision),state:String(row.state),pending};});}
 forget(raw:ActivityOwner,id:string,expectedRevision:number){const o=this.owner(raw);this.time();if(!positive(expectedRevision,2147483647)||!checked(()=>this.options.scopeCurrent(o)))throw unavailable();const row=this.db.connection.prepare('SELECT * FROM game_help_items WHERE help_id=? AND owner_key=?').get(id,ownerKey(o)) as Row|undefined;if(row?.state==='forgotten'&&row.revision===expectedRevision+1)return;if(!row||row.state!=='pending'||row.revision!==expectedRevision)throw Error('Game help revision conflict');this.erase(row,'forgotten');}
}
