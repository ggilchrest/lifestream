import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {gameEpisodeSnapshot,gameEpisodeDigest} from '@lifestream/contracts/game-memory';
import {createContractValidator} from '@lifestream/contracts';
import type {GameExperienceEpisode,GameHelpItem} from '@lifestream/contracts/game-activity';
import type {Database,Transaction} from './database.ts';

/** Original input/channel evidence references, never a delivery or play grant.
 * The host must separately qualify the authenticated receipt on every reuse. */
export type GameEpisodeAdviceSource=Readonly<{
 adviceRef:string;helpId:string;helpRevision:number;memoryId:string;memoryRevision:number;
 sourceTurnRef:string;sourceSessionRef:string;receivedAt:string;
 questionDeliveryEvidenceRef:string;authenticatedReplyEvidenceRef:string;
}>;
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v:unknown)=>hash(JSON.stringify(canonical(v)));
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(v);
const present=(tx:Transaction)=>!!tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_episode_advice_sources'");
export const gameAdviceCustodyKey=(v:string)=>hash(v);
type Binding={source:GameEpisodeAdviceSource;memoryDigest:string;helpDigest:string;expiresAt:number};

/** Actual local Human-memory and original-question custody. This does not
 * authenticate the referenced channel receipt; the host's predicate must do so. */
export function gameAdviceCustodyBinding(db:Database,e:GameExperienceEpisode,raw:unknown,now:number,policyDigest:string):Binding|null{
 const s=boundedGameDataSnapshot(raw,8192) as GameEpisodeAdviceSource|null;
 if(!s||Object.keys(s).sort().join(',')!=='adviceRef,authenticatedReplyEvidenceRef,helpId,helpRevision,memoryId,memoryRevision,questionDeliveryEvidenceRef,receivedAt,sourceSessionRef,sourceTurnRef'||!uuid(s.helpId)||!uuid(s.memoryId)||!Number.isSafeInteger(s.helpRevision)||s.helpRevision<1||!Number.isSafeInteger(s.memoryRevision)||s.memoryRevision<1||typeof s.adviceRef!=='string'||!s.adviceRef.startsWith('game-advice:')||!uuid(s.adviceRef.slice(12))||!e.adviceRefs.includes(s.adviceRef)||![s.sourceTurnRef,s.sourceSessionRef,s.questionDeliveryEvidenceRef,s.authenticatedReplyEvidenceRef].every(v=>typeof v==='string'&&v.trim()&&Buffer.byteLength(v)<=1024)||!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/Time',s.receivedAt).valid||Date.parse(s.receivedAt)>Date.parse(e.occurredTo)||Date.parse(s.receivedAt)>now)return null;
 try{
 const m=db.connection.prepare('SELECT assistant_id,content,provenance_json,lifecycle_json,created_at FROM memories WHERE id=?').get(s.memoryId) as {assistant_id:string;content:string;provenance_json:string;lifecycle_json:string;created_at:string}|undefined;
 const h=db.connection.prepare('SELECT * FROM game_help_items WHERE help_id=?').get(s.helpId) as {owner_key:string;episode_id:string;episode_digest:string;revision:number;state:string;payload_json:string|null;payload_digest:string;expires_at:number}|undefined;
 if(!m||Buffer.byteLength(m.content)>8192||Buffer.byteLength(m.provenance_json)>16384||Buffer.byteLength(m.lifecycle_json)>8192||!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/Time',m.created_at).valid||!h||!h.payload_json||Buffer.byteLength(h.payload_json)>32768||h.state!=='pending'||!h.payload_json||h.revision!==s.helpRevision||now>=h.expires_at||Date.parse(e.expiresAt)>h.expires_at)return null;
  const original=db.connection.prepare('SELECT state,payload_json,source_digest,policy_digest,expires_at FROM game_experience_episodes WHERE episode_id=?').get(h.episode_id) as {state:string;payload_json:string|null;source_digest:string;policy_digest:string;expires_at:number}|undefined;
  if(!original||original.state!=='retained'||!original.payload_json||Buffer.byteLength(original.payload_json)>16384||original.expires_at<=now||original.policy_digest!==policyDigest)return null;
  const episode=gameEpisodeSnapshot(JSON.parse(original.payload_json),now);if(!episode||gameEpisodeDigest(episode)!==original.source_digest||original.source_digest!==h.episode_digest||episode.pinsDigest!==e.pinsDigest||!isDeepStrictEqual(episode.scope,e.scope))return null;
  const active=db.connection.prepare("SELECT 1 FROM memory_lifecycle_events WHERE assistant_id=? AND ((memory_id=? AND event_type='lifecycleChanged' AND json_extract(payload_json,'$.status')='active') OR (event_type='correctionApplied' AND json_extract(payload_json,'$.correctionId')=?)) LIMIT 1").get(e.scope.assistantId,s.memoryId,s.memoryId);if(!active)return null;
  const p=JSON.parse(m.provenance_json),l=JSON.parse(m.lifecycle_json),item=JSON.parse(h.payload_json) as GameHelpItem;
  if(m.assistant_id!==e.scope.assistantId||p.actor!==e.scope.principalId||p.relationshipId!==e.scope.relationshipId||p.sourceTurnRef!==s.sourceTurnRef||p.sourceFamily!==`turn:${s.sourceTurnRef}`||p.epistemicStatus!=='userStatement'||p.transformation!=='exact-attributed-quote-v1'||p.gameEpisodeId||p.visualEpisodeId||l.status!=='active'||l.revision!==s.memoryRevision||l.contentRemoved===true||!m.content.startsWith('User stated: ')||m.content.length<=13||Date.parse(m.created_at)<Date.parse(s.receivedAt)||Date.parse(m.created_at)>now||!validator.validate(schema+'GameHelpItem',item).valid||digest(item)!==h.payload_digest||item.helpId!==s.helpId||!isDeepStrictEqual(item.scope,e.scope)||Date.parse(item.queuedAt)>Date.parse(s.receivedAt)||h.owner_key!==digest([e.scope.principalId,e.scope.assistantId,e.scope.relationshipId]))return null;
  return {source:Object.freeze(s),memoryDigest:digest(m),helpDigest:h.payload_digest,expiresAt:h.expires_at};
 }catch{return null;}
}

export function storeGameAdviceCustody(tx:Transaction,e:GameExperienceEpisode,bindings:readonly Binding[]){
 for(const b of bindings)tx.run('INSERT INTO game_episode_advice_sources VALUES(?,?,?,?,?,?,?)',e.episodeId,hash(b.source.adviceRef),hash(b.source.memoryId),hash(b.source.helpId),b.memoryDigest,b.helpDigest,JSON.stringify(b.source));
}
export function retainedGameAdviceCustody(db:Database,e:GameExperienceEpisode,now:number,policyDigest:string):readonly GameEpisodeAdviceSource[]|null{
 if(!e.adviceRefs.length)return [];
 const rows=db.connection.prepare('SELECT * FROM game_episode_advice_sources WHERE episode_id=? LIMIT 9').all(e.episodeId) as {advice_key:string;memory_key:string;help_key:string;memory_digest:string;help_digest:string;source_json:string|null}[];
 if(rows.length!==e.adviceRefs.length)return null;
 const result:GameEpisodeAdviceSource[]=[];
 for(const r of rows){let b:Binding|null=null;try{b=r.source_json?gameAdviceCustodyBinding(db,e,JSON.parse(r.source_json),now,policyDigest):null;}catch{}if(!b||r.advice_key!==hash(b.source.adviceRef)||r.memory_key!==hash(b.source.memoryId)||r.help_key!==hash(b.source.helpId)||r.memory_digest!==b.memoryDigest||r.help_digest!==b.helpDigest||result.some(s=>s.adviceRef===b!.source.adviceRef))return null;result.push(b.source);}
 return Object.freeze(result);
}

function scrubEpisode(tx:Transaction,id:string){
 const help=tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_help_items'")?tx.all<{help_id:string}>('SELECT help_id FROM game_help_items WHERE episode_id=?',id):[];
 if(help.length)tx.run("UPDATE game_help_items SET state='invalidated',payload_json=NULL,payload_digest=NULL,revision=revision+1 WHERE episode_id=? AND state='pending'",id);
 for(const row of tx.all<{id:string;assistant_id:string;provenance_json:string;lifecycle_json:string}>("SELECT id,assistant_id,provenance_json,lifecycle_json FROM memories WHERE json_extract(provenance_json,'$.gameEpisodeId')=?",id)){
  const p=JSON.parse(row.provenance_json),l=JSON.parse(row.lifecycle_json);
  tx.run("UPDATE memories SET content='',provenance_json=?,lifecycle_json=? WHERE id=?",JSON.stringify({actor:p.actor,relationshipId:p.relationshipId,gameFamilyKey:p.gameFamilyKey,gameEpisodeKey:p.gameEpisodeKey,payloadRemoved:true}),JSON.stringify({status:'invalidated',revision:Number(l.revision)+1,contentRemoved:true}),row.id);
  tx.run('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=? AND assistant_id=?',JSON.stringify({payloadRemoved:true}),row.id,row.assistant_id);
 }
 if(present(tx))tx.run('UPDATE game_episode_advice_sources SET source_json=NULL WHERE episode_id=?',id);
 return help.map(h=>h.help_id);
}
/** Iterative, finite local dependency erasure; no callback or reconstruction.
 * Hashed identity fences survive, while every derived source payload is removed. */
export function retireGameAdviceDependents(tx:Transaction,kind:'memory'|'help',id:string){
 if(!present(tx))return;
 const select=(k:'memory'|'help',value:string)=>tx.all<{episode_id:string}>(`SELECT episode_id FROM game_episode_advice_sources WHERE ${k}_key=?`,hash(value)).map(r=>r.episode_id);
 const queue=select(kind,id),seen=new Set<string>();
 for(let i=0;i<queue.length;i++){
  const episodeId=queue[i]!;if(seen.has(episodeId))continue;seen.add(episodeId);
  tx.run("UPDATE game_experience_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE episode_id=? AND state='retained'",episodeId);
  if(tx.get<{n:number}>('SELECT changes() AS n')!.n===0)continue;
  for(const helpId of scrubEpisode(tx,episodeId))queue.push(...select('help',helpId));
 }
}
export function eraseGameEpisodeDerivedPayloads(tx:Transaction,id:string){for(const helpId of scrubEpisode(tx,id))retireGameAdviceDependents(tx,'help',helpId);}
