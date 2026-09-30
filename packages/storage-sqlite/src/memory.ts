import { randomUUID,createHash } from "node:crypto";
import {gameProjectionSnapshot,gameEpisodeFamilyKey,gameEpisodeDigest} from '@lifestream/contracts/game-memory';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {GameExperienceEpisode,GameMemoryBinding} from '@lifestream/contracts/game-activity';
import {validateVisualMemoryProjection} from '@lifestream/contracts/visual-memory';
import type { Database } from "./database.js";

export type MemoryRecord = { id: string; assistantId: string; content: string; provenance: Record<string, unknown>; lifecycle: Record<string, unknown>; createdAt: string };
type MemoryRow = { id: string; assistantId: string; content: string; provenance: string; lifecycle: string; createdAt: string };
export type MemoryLifecycleEvent = { memoryId: string; assistantId: string; revision: number; eventType: string; payload: Record<string, unknown>; occurredAt: string };
export type ForgetResult = { memoryId: string; assistantId: string; status: "forgotten"; contentRemoved: true; lifecycleRetained: true; externalCopies: "not-controlled"; revision: number };
const fromRow = (row: MemoryRow): MemoryRecord => ({ ...row, provenance: JSON.parse(row.provenance), lifecycle: JSON.parse(row.lifecycle) });

export type GameMemorySourceOptions={
 maximumCandidates:number;
 resolveSource:(binding:Readonly<GameMemoryBinding>)=>GameExperienceEpisode|null;
 /** Independent memory consent/retention, not game enrollment or permission. */
 memoryPolicyCurrent:(episode:Readonly<GameExperienceEpisode>)=>boolean;
 /** Retained historical source/correction/forgetting/restore boundary. */
 sourceCurrent:(episode:Readonly<GameExperienceEpisode>)=>boolean;
 now?:()=>number;
};
const gameMarked=(r:MemoryRecord)=>!!r.provenance.gameEpisodeId||!!(r.provenance.canonical as {extensions?:Record<string,unknown>}|undefined)?.extensions?.['lifestream.localGameActivity'];
const freezeGame=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freezeGame(child);Object.freeze(v);}return v;};
export class MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly events = new Map<string, MemoryLifecycleEvent[]>();
  private readonly database: Database | undefined;
  private observedVisualTime=-Infinity;
  private visualNow(){return this.observedVisualTime=Math.max(this.observedVisualTime,Date.now());}
  private readonly gameSources:Readonly<GameMemorySourceOptions>|undefined;
  private observedGameTime=-Infinity;private checkingGame=false;
  constructor(database?: Database,gameSources?:GameMemorySourceOptions) {
    this.database = database;
    if(gameSources&&(!Number.isSafeInteger(gameSources.maximumCandidates)||gameSources.maximumCandidates<1||gameSources.maximumCandidates>128))throw new Error('Game memory candidate bound unavailable');
    this.gameSources=gameSources?Object.freeze({...gameSources}):undefined;
  }
  private gameSourceAvailable(record:MemoryRecord):boolean{
    if(!gameMarked(record))return true;
    const host=this.gameSources;if(!host||!this.database||this.checkingGame)return false;this.checkingGame=true;
    try{
      const now=(host.now??Date.now)();if(!Number.isSafeInteger(now)||now<this.observedGameTime)return false;this.observedGameTime=now;
      const canonical=record.provenance.canonical as {extensions?:Record<string,unknown>}|undefined;
      const binding=boundedGameDataSnapshot(canonical?.extensions?.['lifestream.localGameActivity']) as GameMemoryBinding|null;if(!binding)return false;freezeGame(binding);
      const projection=gameProjectionSnapshot({schemaVersion:'1.0.0',recordType:'gameMemoryProjection',episode:host.resolveSource(binding),memoryRecord:canonical},now);if(!projection)return false;
      const e=freezeGame(projection.episode),m=projection.memoryRecord;
      if(record.id!==m.memoryId||record.assistantId!==m.assistantId||record.content!==m.content||record.createdAt!==m.createdAt||record.provenance.actor!==e.scope.principalId||record.provenance.relationshipId!==e.scope.relationshipId||record.provenance.gameEpisodeId!==e.episodeId||record.provenance.gameEpisodeRevision!==e.revision||record.provenance.gameEpisodeDigest!==gameEpisodeDigest(e)||record.provenance.gameEpisodeKey!==createHash('sha256').update(e.episodeId).digest('hex')||record.provenance.gameFamilyKey!==gameEpisodeFamilyKey(e)||record.lifecycle.status!=='candidate'||record.lifecycle.kind!=='experiential'||record.lifecycle.factuality!=='unverified'||record.lifecycle.confidence!==m.confidence||record.lifecycle.revision!==1||record.lifecycle.lastReinforcedAt!==null)return false;
      if(host.memoryPolicyCurrent(e)!==true||host.sourceCurrent(e)!==true)return false;
      const end=(host.now??Date.now)();if(!Number.isSafeInteger(end)||end<now||end>=Date.parse(e.expiresAt))return false;this.observedGameTime=end;
      return host.memoryPolicyCurrent(e)===true&&host.sourceCurrent(e)===true;
    }catch{return false;}finally{this.checkingGame=false;}
  }
  private guardGameWrite(record:MemoryRecord){
    if(!gameMarked(record))return;
    if(!this.gameSourceAvailable(record))throw new Error('Game memory source or independent consent unavailable');
    const host=this.gameSources!,db=this.database!;
    const duplicate=db.connection.prepare("SELECT id FROM memories WHERE json_extract(provenance_json,'$.gameFamilyKey')=? OR json_extract(provenance_json,'$.gameEpisodeKey')=? LIMIT 1").get(record.provenance.gameFamilyKey as string,record.provenance.gameEpisodeKey as string);
    if(duplicate)throw new Error('Game memory source already retained or excluded');
    const n=db.connection.prepare("SELECT count(*) AS n FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(provenance_json,'$.relationshipId') IS ? AND json_extract(provenance_json,'$.gameFamilyKey') IS NOT NULL").get(record.assistantId,record.provenance.actor as string,record.provenance.relationshipId as string|null)!.n as number;
    if(n>=host.maximumCandidates)throw new Error('Game memory scope capacity exceeded');
  }
  private visualSourceAvailable(record:MemoryRecord):boolean {
    if(!record.provenance.visualEpisodeId)return true;
    if(!this.database)return false;
    const row=this.database.connection.prepare("SELECT revision,payload_json FROM visual_observation_episodes WHERE episode_id=? AND state='retained' AND expires_at>?").get(String(record.provenance.visualEpisodeId),this.visualNow()) as {revision:number;payload_json:string}|undefined;
    if(!row||row.revision!==record.provenance.visualEpisodeRevision||!['candidate','active','contradicted'].includes(String(record.lifecycle.status)))return false;
    try{const episode=JSON.parse(row.payload_json);if(record.lifecycle.status==='active'){if(!this.database.connection.prepare('SELECT 1 FROM visual_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1 AND revision=?').get(episode.scope.principalId,episode.scope.assistantId,episode.scope.relationshipId,episode.processingPolicyRevision)||!this.database.connection.prepare('SELECT 1 FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1').get(episode.scope.principalId,episode.scope.assistantId,episode.scope.relationshipId))return false;if(record.provenance.visualOccurredAt!==episode.occurredAt||record.provenance.visualExpiresAt!==episode.expiresAt||record.provenance.visualSourceFamily!==episode.independenceKeys[0]||JSON.stringify(record.provenance.visualUncertainty)!==JSON.stringify(episode.observations.map((o:{uncertainty:string})=>o.uncertainty))||JSON.stringify(record.provenance.visualLimitations)!==JSON.stringify([...new Set(episode.observations.flatMap((o:{limitations:string[];subject:{limitations:string[]}})=>[...o.limitations,...o.subject.limitations]))]))return false;}const canonical=record.provenance.canonical as {memoryId?:unknown;content?:unknown};return episode.scope.principalId===record.provenance.actor&&episode.scope.relationshipId===record.provenance.relationshipId&&episode.sourceDigest===record.provenance.visualSourceDigest&&canonical?.memoryId===record.id&&canonical.content===record.content&&(canonical as {status?:unknown}).status===record.lifecycle.status&&validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:canonical}).valid;}catch{return false;}
  }
  /** Typed retained-source candidate; no activation or reflection consent is inferred. */
  saveGameProjection(raw:unknown):MemoryRecord{
    const p=gameProjectionSnapshot(raw,(this.gameSources?.now??Date.now)());if(!p)throw new Error('Invalid game memory projection');
    const {episode:e,memoryRecord:m}=p;
    return this.save({id:m.memoryId,assistantId:m.assistantId,content:m.content,createdAt:m.createdAt,
      provenance:{actor:e.scope.principalId,relationshipId:e.scope.relationshipId,gameEpisodeId:e.episodeId,gameEpisodeRevision:e.revision,gameEpisodeDigest:gameEpisodeDigest(e),gameEpisodeKey:createHash('sha256').update(e.episodeId).digest('hex'),gameFamilyKey:gameEpisodeFamilyKey(e),canonical:m},
      lifecycle:{kind:m.kind,factuality:m.factuality,confidence:m.confidence,sensitivity:m.sensitivity,status:m.status,revision:1,lastReinforcedAt:null,contradictedBy:[]}});
  }
  save(record: MemoryRecord): MemoryRecord {
    const copy = structuredClone(record);
    this.guardGameWrite(copy);
    if (this.database) {
      try { this.database.transaction((tx) => { this.guardGameWrite(copy);tx.run("INSERT INTO memories (id, assistant_id, content, provenance_json, lifecycle_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, copy.content, JSON.stringify(copy.provenance), JSON.stringify(copy.lifecycle), copy.createdAt); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, 1, "created", JSON.stringify(copy.lifecycle), copy.createdAt);if(!this.gameSourceAvailable(copy))throw new Error("Game memory changed during write"); }); }
      catch { throw new Error("memory is immutable"); }
    } else { if (this.records.has(copy.id)) throw new Error("memory is immutable"); this.records.set(copy.id, copy); this.events.set(copy.id, [{ memoryId: copy.id, assistantId: copy.assistantId, revision: 1, eventType: "created", payload: structuredClone(copy.lifecycle), occurredAt: copy.createdAt }]); }
    return structuredClone(copy);
  }
  // Canonical memory and lifecycle records; the cold-path queue is not another memory store.
  admitAutomatic(records: MemoryRecord[], actor: string, directCorrection: boolean): string[] {
    if(!this.database)throw new Error("Automatic memory requires durable storage");
    if(records.length>6)throw new Error("Automatic memory admission bound exceeded");
    return this.database.transaction(tx=>records.map(record=>{
      if(gameMarked(record))throw new Error("Game sources require typed memory admission");
      if(record.provenance.actor!==actor||typeof record.provenance.automaticMemoryKey!=="string"||!record.content||record.content.length>1200)throw new Error("Invalid automatic memory provenance");
      const existing=tx.get<{id:string}>("SELECT id FROM memories WHERE id=? AND assistant_id=?",record.id,record.assistantId);if(existing)return existing.id;
      if(tx.get("SELECT memory_key FROM automatic_memory_exclusions WHERE principal_id=? AND assistant_id=? AND memory_key=?",actor,record.assistantId,record.provenance.automaticMemoryKey))return "excluded";
      const priors=tx.all<MemoryRow>("SELECT id,assistant_id AS assistantId,content,provenance_json AS provenance,lifecycle_json AS lifecycle,created_at AS createdAt FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(provenance_json,'$.automaticMemoryKey')=? AND json_extract(lifecycle_json,'$.status') IN ('active','candidate','contradicted') ORDER BY created_at DESC LIMIT 32",record.assistantId,actor,record.provenance.automaticMemoryKey),prior=priors[0];
      if(prior?.content===record.content)return prior.id;
      const count=tx.get<{n:number}>("SELECT count(*) AS n FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(lifecycle_json,'$.status')='active'",record.assistantId,actor)!.n;if(count>=240&&!prior)throw new Error("Automatic memory scope capacity exceeded");
      const conflict=!!prior&&!directCorrection;
      const lifecycle={...record.lifecycle,status:conflict?"candidate":"active",revision:2,lastReinforcedAt:null,contradictedBy:conflict?priors.map(p=>p.id):[],...(conflict?{needsReview:true}:{})};
      for(const prior of priors){const old=JSON.parse(prior.lifecycle),next={...old,status:directCorrection?"superseded":"contradicted",revision:Number(old.revision)+1,changedBy:actor,...(directCorrection?{supersededBy:record.id}:{contradictedBy:[...new Set([...(old.contradictedBy??[]),record.id])],needsReview:true})};
        tx.run("UPDATE memories SET lifecycle_json=? WHERE id=?",JSON.stringify(next),prior.id);
        const revision=tx.get<{n:number}>("SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?",prior.id)!.n;
        tx.run("INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)",prior.id,record.assistantId,revision,directCorrection?"correctionApplied":"contradictionObserved",JSON.stringify({actor,correctionId:directCorrection?record.id:null,contradictedBy:directCorrection?[]:[record.id],sourceTurnRef:record.provenance.sourceTurnRef}),record.createdAt);
      }
      tx.run("INSERT INTO memories VALUES (?,?,?,?,?,?)",record.id,record.assistantId,record.content,JSON.stringify(record.provenance),JSON.stringify(lifecycle),record.createdAt);
      tx.run("INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)",record.id,record.assistantId,1,"created",JSON.stringify({...record.lifecycle,status:"candidate",revision:1}),record.createdAt);
      tx.run("INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)",record.id,record.assistantId,2,conflict?"conflictNeedsReview":"lifecycleChanged",JSON.stringify(lifecycle),record.createdAt);
      return record.id;
    }));
  }
  saveMany(records: MemoryRecord[]): void {
    if (this.database) {
      this.database.transaction((tx) => { for (const record of records) { const copy = structuredClone(record);this.guardGameWrite(copy); tx.run("INSERT INTO memories (id, assistant_id, content, provenance_json, lifecycle_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, copy.content, JSON.stringify(copy.provenance), JSON.stringify(copy.lifecycle), copy.createdAt); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", copy.id, copy.assistantId, 1, "created", JSON.stringify(copy.lifecycle), copy.createdAt);if(!this.gameSourceAvailable(copy))throw new Error("Game memory changed during write"); } });
      return;
    }
    const seen = new Set<string>(); for (const record of records) { if (seen.has(record.id) || this.records.has(record.id)) throw new Error("memory is immutable"); seen.add(record.id); }
    for (const record of records) this.save(record);
  }
  get(assistantId: string, id: string): MemoryRecord | undefined {
    if (this.database) { const row = this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? AND id = ?").get(assistantId, id) as MemoryRow | undefined;const record=row?fromRow(row):undefined;return record&&this.visualSourceAvailable(record)&&this.gameSourceAvailable(record)?record:undefined; }
    const record = this.records.get(id); return record?.assistantId === assistantId&&this.visualSourceAvailable(record)&&this.gameSourceAvailable(record) ? structuredClone(record) : undefined;
  }
  list(assistantId: string): MemoryRecord[] {
    if (this.database) return (this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id = ? ORDER BY id").all(assistantId) as MemoryRow[]).map(fromRow).filter(record=>this.visualSourceAvailable(record)&&this.gameSourceAvailable(record));
    return [...this.records.values()].filter((record) => record.assistantId === assistantId&&this.visualSourceAvailable(record)&&this.gameSourceAvailable(record)).map((record) => structuredClone(record));
  }
  /** Same bounded relationship cache boundary; visual payload/policy changes and
   * expiry alter its fingerprint before a prepared view or reply is reused. */
  contextBoundaryRows(assistantId:string,actor:string){
    if(!this.database)return this.contextRecords(assistantId,actor).map(r=>({id:r.id,revision:r.lifecycle.revision}));
    return this.database.connection.prepare("SELECT m.id,json_extract(m.lifecycle_json,'$.revision') AS revision,v.revision AS visualRevision,v.expires_at AS visualExpiry,v.payload_json AS visualSource,CASE WHEN v.episode_id IS NOT NULL THEN m.provenance_json ELSE NULL END AS memorySource FROM memories m LEFT JOIN visual_observation_episodes v ON v.episode_id=json_extract(m.provenance_json,'$.visualEpisodeId') WHERE m.assistant_id=? AND json_extract(m.provenance_json,'$.actor')=? AND json_extract(m.lifecycle_json,'$.status')='active' AND (json_extract(m.provenance_json,'$.visualEpisodeId') IS NULL OR (v.state='retained' AND v.expires_at>? AND EXISTS (SELECT 1 FROM visual_memory_policies p WHERE p.scope_key=v.scope_key AND p.enabled=1 AND p.revision=json_extract(v.payload_json,'$.processingPolicyRevision')) AND EXISTS (SELECT 1 FROM automatic_memory_policies p WHERE p.principal_id=json_extract(m.provenance_json,'$.actor') AND p.assistant_id=m.assistant_id AND p.relationship_id=json_extract(m.provenance_json,'$.relationshipId') AND p.enabled=1))) ORDER BY m.id LIMIT 257").all(assistantId,actor,this.visualNow());
  }
  contextRecords(assistantId: string, actor: string): MemoryRecord[] {
    if (this.database) return (this.database.connection.prepare("SELECT id, assistant_id AS assistantId, content, provenance_json AS provenance, lifecycle_json AS lifecycle, created_at AS createdAt FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(lifecycle_json,'$.status')='active' AND (EXISTS (SELECT 1 FROM memory_lifecycle_events e WHERE e.assistant_id=memories.assistant_id AND e.memory_id=memories.id AND e.event_type='lifecycleChanged' AND json_extract(e.payload_json,'$.status')='active') OR EXISTS (SELECT 1 FROM memory_lifecycle_events e WHERE e.assistant_id=memories.assistant_id AND e.event_type='correctionApplied' AND json_extract(e.payload_json,'$.correctionId')=memories.id)) ORDER BY id LIMIT 257").all(assistantId, actor) as MemoryRow[]).map(fromRow).filter(record=>this.visualSourceAvailable(record)&&this.gameSourceAvailable(record));
    return this.list(assistantId).filter(record => record.provenance.actor === actor && record.lifecycle.status === "active" && (this.history(assistantId,record.id).some(event=>event.eventType==="lifecycleChanged"&&event.payload.status==="active") || [...this.events.values()].some(events=>events.some(event=>event.assistantId===assistantId&&event.eventType==="correctionApplied"&&event.payload.correctionId===record.id)))).slice(0,257);
  }
  contextRecordIds(assistantId: string, actor: string): string[] {
    if (this.database) return this.contextRecords(assistantId,actor).map(record=>record.id);
    return this.list(assistantId).filter(record => record.provenance.actor === actor && record.lifecycle.status === "active" && (this.history(assistantId,record.id).some(event=>event.eventType==="lifecycleChanged"&&event.payload.status==="active") || [...this.events.values()].some(events=>events.some(event=>event.assistantId===assistantId&&event.eventType==="correctionApplied"&&event.payload.correctionId===record.id)))).slice(0,257).map(record => record.id);
  }
  search(assistantId: string, query: string, limit = 20): MemoryRecord[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return this.list(assistantId).filter((record) => record.content.toLocaleLowerCase().includes(normalized)).slice(0, Math.max(1, Math.min(100, limit)));
  }
  history(assistantId: string, id: string): MemoryLifecycleEvent[] {
    if (this.database) {
      return (this.database.connection.prepare("SELECT memory_id AS memoryId, assistant_id AS assistantId, revision, event_type AS eventType, payload_json AS payload, occurred_at AS occurredAt FROM memory_lifecycle_events WHERE assistant_id = ? AND memory_id = ? ORDER BY revision").all(assistantId, id) as { memoryId: string; assistantId: string; revision: number; eventType: string; payload: string; occurredAt: string }[]).map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
    }
    const record = this.records.get(id); return record?.assistantId === assistantId ? structuredClone(this.events.get(id) ?? []) : [];
  }
  proposeCorrection(assistantId: string, id: string, proposedContent: string, actor: string): MemoryLifecycleEvent | undefined {
    const existing = this.get(assistantId, id); if (!existing || existing.lifecycle.contentRemoved || !["active","candidate"].includes(String(existing.lifecycle.status))) return undefined;
    if(gameMarked(existing))throw new Error('Game episodes require source-aware correction and lifecycle');
    if(existing.provenance.visualEpisodeId)throw new Error('Visual observations require typed source correction');
    const occurredAt = new Date().toISOString(); const payload = { proposedContent, status: "needsReview", actor };
    const revision = this.database ? this.database.transaction((tx) => { const nextRevision = tx.get<{ revision: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_lifecycle_events WHERE memory_id = ? AND assistant_id = ?", id, assistantId)?.revision ?? 1; tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, nextRevision, "correctionProposed", JSON.stringify(payload), occurredAt); return nextRevision; }) : (this.events.get(id)?.at(-1)?.revision ?? 0) + 1;
    if (!this.database) { const events = this.events.get(id) ?? []; events.push({ memoryId: id, assistantId, revision, eventType: "correctionProposed", payload, occurredAt }); this.events.set(id, events); }
    return { memoryId: id, assistantId, revision, eventType: "correctionProposed", payload, occurredAt };
  }
  applyCorrection(assistantId: string, id: string, proposalRevision: number, expectedRevision: number, actor: string): MemoryRecord {
    const existing = this.get(assistantId, id), history = this.history(assistantId, id);
    if(existing&&gameMarked(existing))throw new Error('Game episodes require source-aware correction and lifecycle');
    const proposal = history.filter(event => event.eventType === "correctionProposed").at(-1);
    if (!existing || existing.lifecycle.revision !== expectedRevision || !["active", "candidate"].includes(String(existing.lifecycle.status)) || proposal?.revision !== proposalRevision || typeof proposal.payload.proposedContent !== "string") throw new Error("correction revision conflict");
    const now = new Date().toISOString(), nextId = randomUUID();
    const corrected: MemoryRecord = { ...structuredClone(existing), id: nextId, content: proposal.payload.proposedContent, provenance: { ...existing.provenance, actor, correctionOf: id, correctionProposalRevision: proposalRevision, sourceRevision: expectedRevision }, lifecycle: { ...existing.lifecycle, status: existing.lifecycle.status, revision: 1, changedBy: actor, supersedes: id }, createdAt: now };
    const retired = { ...existing.lifecycle, status: "superseded", revision: expectedRevision + 1, supersededBy: nextId, changedBy: actor };
    const event: MemoryLifecycleEvent = { memoryId: id, assistantId, revision: (history.at(-1)?.revision ?? 0) + 1, eventType: "correctionApplied", payload: { correctionId: nextId, proposalRevision, actor }, occurredAt: now };
    if (this.database) this.database.transaction(tx => {
      const currentEvent = tx.get<{ revision: number }>("SELECT MAX(revision) AS revision FROM memory_lifecycle_events WHERE memory_id=? AND assistant_id=?", id, assistantId);
      if (currentEvent?.revision !== event.revision - 1) throw new Error("correction revision conflict");
      tx.run("UPDATE memories SET lifecycle_json=? WHERE id=? AND assistant_id=? AND json_extract(lifecycle_json,'$.revision')=?", JSON.stringify(retired), id, assistantId, expectedRevision);
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error("correction revision conflict");
      tx.run("INSERT INTO memories VALUES (?,?,?,?,?,?)", corrected.id, assistantId, corrected.content, JSON.stringify(corrected.provenance), JSON.stringify(corrected.lifecycle), now);
      tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?,?,?,?,?,?)", id, assistantId, event.revision, event.eventType, JSON.stringify(event.payload), now);
      tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?,?,?,?,?,?)", corrected.id, assistantId, 1, "created", JSON.stringify(corrected.lifecycle), now);
    });
    else { this.records.set(id, { ...existing, lifecycle: retired }); this.save(corrected); this.events.set(id, [...history, event]); }
    return structuredClone(corrected);
  }
  transition(assistantId: string, id: string, status: string, actor: string, reason?: string, expectedRevision?: number): MemoryRecord | undefined {
    const allowed = new Set(["candidate", "active", "superseded", "invalidated", "contradicted"]);
    if (!allowed.has(status)) throw new Error("unsupported memory lifecycle status");
    const existing = this.get(assistantId, id); if (!existing) return undefined;
    if(gameMarked(existing))throw new Error('Game episodes require source-aware correction and lifecycle');
    if(existing.provenance.visualEpisodeId)throw new Error('Visual candidates require source-aware lifecycle admission');
    const previousRevision = typeof existing.lifecycle.revision === "number" ? existing.lifecycle.revision : 1;
    if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw new Error("memory revision conflict");
    const currentStatus = typeof existing.lifecycle.status === "string" ? existing.lifecycle.status : "candidate";
    const validTransition = currentStatus === "candidate" ? ["active", "invalidated", "contradicted", "superseded"].includes(status) : currentStatus === "active" ? ["invalidated", "contradicted", "superseded"].includes(status) : false;
    if (!validTransition) throw new Error("invalid memory lifecycle transition");
    const lifecycle = { ...existing.lifecycle, status, revision: previousRevision + 1, changedBy: actor, ...(reason ? { reason } : {}) };
    if (this.database) {
      this.database.transaction((tx) => { const eventRevision = tx.get<{ revision: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_lifecycle_events WHERE memory_id = ? AND assistant_id = ?", id, assistantId)?.revision ?? 1; tx.run("UPDATE memories SET lifecycle_json = ? WHERE assistant_id = ? AND id = ? AND json_extract(lifecycle_json, '$.revision') = ? AND json_extract(lifecycle_json, '$.status') = ?", JSON.stringify(lifecycle), assistantId, id, previousRevision, currentStatus); if ((tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) !== 1) throw new Error("memory revision conflict"); tx.run("INSERT INTO memory_lifecycle_events (memory_id, assistant_id, revision, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", id, assistantId, eventRevision, "lifecycleChanged", JSON.stringify(lifecycle), new Date().toISOString()); });
      return this.get(assistantId, id);
    }
    const updated = { ...existing, lifecycle }; this.records.set(id, updated); const events = this.events.get(id) ?? []; events.push({ memoryId: id, assistantId, revision: (events.at(-1)?.revision ?? 0) + 1, eventType: "lifecycleChanged", payload: structuredClone(lifecycle), occurredAt: new Date().toISOString() }); this.events.set(id, events); return structuredClone(updated);
  }
  forget(assistantId: string, id: string, actor: string, reason = "source forgotten", expectedRevision?: number): ForgetResult | undefined {
    let existing = this.get(assistantId, id);
    // Forgetting must still erase private retained payload after policy/source
    // withdrawal; that withdrawal is never permission to retain a hidden copy.
    if(!existing&&this.database){const raw=this.database.connection.prepare('SELECT id,assistant_id AS assistantId,content,provenance_json AS provenance,lifecycle_json AS lifecycle,created_at AS createdAt FROM memories WHERE assistant_id=? AND id=?').get(assistantId,id) as MemoryRow|undefined;const record=raw?fromRow(raw):undefined;if(record&&gameMarked(record)&&record.provenance.actor===actor)existing=record;}
    if (!existing) return undefined;
    if(gameMarked(existing)&&existing.provenance.actor!==actor)throw new Error('Game memory owner unavailable');
    const previousRevision = typeof existing.lifecycle.revision === "number" ? existing.lifecycle.revision : 1;
    if (expectedRevision !== undefined && expectedRevision !== previousRevision) throw new Error("memory revision conflict");
    const revision = previousRevision + 1; const occurredAt = new Date().toISOString(); void reason;
    const lifecycle = { status: "invalidated", revision, changedBy: actor, reason: "owner-local forget", forgottenAt: occurredAt, contentRemoved: true };
    const provenance = { actor: existing.provenance.actor ?? actor, payloadRemoved: true,...(typeof existing.provenance.gameFamilyKey==='string'?{relationshipId:existing.provenance.relationshipId,gameFamilyKey:existing.provenance.gameFamilyKey,gameEpisodeKey:existing.provenance.gameEpisodeKey}: {}) };
    const journalRevision = (this.history(assistantId,id).at(-1)?.revision ?? 0) + 1;
    const payload = { status: "invalidated", contentRemoved: true };
    if (this.database) this.database.transaction(tx => {
      if(typeof existing.provenance.automaticMemoryKey==="string")tx.run("INSERT OR IGNORE INTO automatic_memory_exclusions VALUES (?,?,?,?)",String(existing.provenance.actor??actor),assistantId,existing.provenance.automaticMemoryKey,occurredAt);
      tx.run("UPDATE memories SET content='', provenance_json=?, lifecycle_json=? WHERE assistant_id=? AND id=? AND json_extract(lifecycle_json,'$.revision')=?",JSON.stringify(provenance),JSON.stringify(lifecycle),assistantId,id,previousRevision);
      if(tx.get<{changes:number}>("SELECT changes() AS changes")?.changes!==1)throw new Error("memory revision conflict");
      tx.run("UPDATE memory_lifecycle_events SET payload_json=? WHERE assistant_id=? AND memory_id=?",JSON.stringify({payloadRemoved:true}),assistantId,id);
      tx.run("INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)",id,assistantId,journalRevision,"forgotten",JSON.stringify(payload),occurredAt);
      if(existing.provenance.visualEpisodeId){tx.run("UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=? AND assistant_id=?",JSON.stringify({payloadRemoved:true}),`visual-episode:${existing.provenance.visualEpisodeId}`,assistantId);tx.run("UPDATE visual_observation_episodes SET state='forgotten',payload_json=NULL,revision=revision+1 WHERE episode_id=? AND state='retained' AND json_extract(payload_json,'$.memoryRecordId')=?",existing.provenance.visualEpisodeId,id);}
    });
    else {this.records.set(id,{...existing,content:"",provenance,lifecycle});this.events.set(id,[...(this.events.get(id)??[]).map(event=>({...event,payload:{payloadRemoved:true}})),{memoryId:id,assistantId,revision:journalRevision,eventType:"forgotten",payload,occurredAt}]);}
    return { memoryId: id, assistantId, status: "forgotten", contentRemoved: true, lifecycleRetained: true, externalCopies: "not-controlled", revision };
  }
}
