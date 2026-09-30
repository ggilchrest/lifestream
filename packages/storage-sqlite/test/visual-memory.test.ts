import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {VisualMemoryRepository,visualEpisodeSourceDigest} from '../src/visual-memory.ts';
import {visualEpisode,visualOwner} from './fixtures/visual-episode.ts';
const initial=Date.parse('2026-09-29T12:00:00Z');
function setup(t:import('node:test').TestContext){let now=initial;const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());const repo=new VisualMemoryRepository(db,()=>now),owner=visualOwner();const policy=repo.configure(owner,true,0,86400000);return {db,repo,owner,policy,advance:(ms:number)=>now+=ms,now:()=>now,make:(session?:string)=>visualEpisode(owner,policy,now,session)};}
test('typed visual episode retains uncertainty, identity and no raw media or invented owner quote',t=>{
 const f=setup(t),{episode,admission}=f.make();assert.equal(f.repo.admit(f.owner,episode,admission).state,'retained');
 const saved=f.repo.inspect(f.owner,true).episodes[0]!.episode!;assert.equal(saved.state,'retained');assert.equal(saved.observations[0]!.confidence,null);assert.equal(saved.rawMediaRetained,false);assert.equal(saved.memoryRecordId,null);assert.equal(saved.memoryFactuality,'unverified');assert.deepEqual(episode.state,'candidate');
 assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM memories').get()!.n,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM automatic_memory_work').get()!.n,0);
 assert.equal(f.repo.inspect({...f.owner,principalId:randomUUID()},true).episodes.length,0);assert.equal(f.repo.inspect(f.owner,false).episodes.length,0);
});
test('closed schema and cross-field metadata reject forged evidence and oversized episodes',t=>{
 const f=setup(t);for(const change of [e=>{e.rawMediaRetained=true;},e=>{e.memoryFactuality='verified';},e=>{e.sourceDigest='f'.repeat(64);},e=>{e.sourceObservationIds=[randomUUID()];},e=>{e.observations[0].sourceTurnRef='forged-turn';},e=>{e.memoryRecordId=randomUUID();},e=>{e.summary='é'.repeat(4000);}]){const v=f.make();change(v.episode as any);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'invalidEpisode');}assert.equal(f.repo.inspect(f.owner,true).episodes.length,0);
});
test('fresh host scope, explicit policy and visual association are independently required',t=>{
 const f=setup(t);let v=f.make();assert.equal(f.repo.admit({...f.owner,principalId:randomUUID()},v.episode,v.admission).state,'policyDenied');
 for(const change of [a=>{a.current=false;},a=>{a.scope.audienceRevision++;},a=>{a.scope.sessionRevision++;},a=>{a.scope.relationshipId=randomUUID();}]){v=f.make();change(v.admission as any);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'scopeChanged');}
 v=f.make();v.episode.observations[0]!.subject.binding='unidentified';v.episode.sourceDigest=visualEpisodeSourceDigest(v.episode);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'unattributedSubject');
 v=f.make();v.admission.verifiedSubjectRef='different-visual-subject';assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'unattributedSubject');
 assert.throws(()=>f.repo.configure(visualOwner(),true,0,null),/Invalid/);assert.throws(()=>f.repo.configure(f.owner,true,0,1000),/conflict/);
});
test('source family, observation and frame fences prevent retries, paraphrase and multi-camera reinforcement',t=>{
 const f=setup(t),v=f.make();assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'retained');
 for(const source of ['family','observation','frame']){const w=f.make();if(source==='family'){w.episode.observations[0]!.independenceKey=v.episode.independenceKeys[0]!;w.episode.independenceKeys=[v.episode.independenceKeys[0]!];}if(source==='observation'){w.episode.observations[0]!.observationId=v.episode.sourceObservationIds[0]!;w.episode.sourceObservationIds=[v.episode.sourceObservationIds[0]!];}if(source==='frame')w.episode.observations[0]!.sourceFrameIds=[...v.episode.observations[0]!.sourceFrameIds];w.episode.summary='A differently phrased retry from another camera.';w.episode.sourceDigest=visualEpisodeSourceDigest(w.episode);assert.equal(f.repo.admit(f.owner,w.episode,w.admission).state,'duplicateSource');}
 assert.equal(f.repo.inspect(f.owner,true).episodes.length,1);
});
test('appearance per subject/session and twelve rolling-hour episodes include forgotten evidence in quotas',t=>{
 const f=setup(t),session=randomUUID(),v=f.make(session);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'retained');assert.equal(f.repo.admit(f.owner,f.make(session).episode,f.make(session).admission).state,'scopeChanged');const same=f.make(session);assert.equal(f.repo.admit(f.owner,same.episode,same.admission).state,'appearanceBound');
 f.repo.forget(f.owner,v.episode.episodeId,1);const forgottenRetry=f.make(session);assert.equal(f.repo.admit(f.owner,forgottenRetry.episode,forgottenRetry.admission).state,'appearanceBound');
 for(let i=1;i<12;i++){const next=f.make(session);next.admission.reason='meaningfulChange';assert.equal(f.repo.admit(f.owner,next.episode,next.admission).state,'retained');}
 let next=f.make(session);next.admission.reason='meaningfulChange';assert.equal(f.repo.admit(f.owner,next.episode,next.admission).state,'sessionBound');
 assert.equal(f.repo.inspect(f.owner,true,2).complete,false);f.advance(3600000);next=f.make(session);next.admission.reason='meaningfulChange';assert.equal(f.repo.admit(f.owner,next.episode,next.admission).state,'retained');
});
test('expiry removes stored payload at the boundary and cannot resurrect after clock rollback',t=>{
 const f=setup(t),v=f.make();v.episode.expiresAt=new Date(f.now()+1000).toISOString();assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'retained');f.advance(1000);const retired=f.repo.inspect(f.owner,true).episodes[0]!;assert.equal(retired.state,'expired');assert.equal(retired.episode,null);f.advance(-500);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'duplicateSource');assert.equal(f.db.connection.prepare('SELECT payload_json FROM visual_observation_episodes').get()!.payload_json,null);
});
test('stale source, fabricated chronology and excessive retention cannot enter durable memory',t=>{
 const f=setup(t);for(const change of [e=>{e.observations[0].expiresAt=new Date(initial).toISOString();},e=>{e.observations[0].interpretedAt=new Date(initial+1).toISOString();},e=>{e.expiresAt=new Date(initial+86400001).toISOString();},e=>{e.occurredAt=new Date(initial-1).toISOString();}]){const v=f.make();change(v.episode as any);v.episode.sourceDigest=visualEpisodeSourceDigest(v.episode);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'sourceExpired');}
});
test('transaction failure rolls back payload and dedup fences before a successful retry',t=>{
 const f=setup(t),v=f.make();f.db.exec("CREATE TRIGGER fail_visual_sources BEFORE INSERT ON visual_episode_sources BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");assert.throws(()=>f.repo.admit(f.owner,v.episode,v.admission),/synthetic/);assert.equal(f.repo.inspect(f.owner,true).episodes.length,0);f.db.exec('DROP TRIGGER fail_visual_sources');assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'retained');
});
test('forget is scoped, revision guarded and removes content while preserving replay fences',t=>{
 const f=setup(t),v=f.make();assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'retained');assert.throws(()=>f.repo.forget({...f.owner,principalId:randomUUID()},v.episode.episodeId,1),/conflict/);assert.throws(()=>f.repo.forget(f.owner,v.episode.episodeId,2),/conflict/);f.repo.forget(f.owner,v.episode.episodeId,1);assert.equal(f.repo.inspect(f.owner,true).episodes[0]!.state,'forgotten');assert.equal(f.repo.inspect(f.owner,true).episodes[0]!.episode,null);assert.equal(f.repo.admit(f.owner,v.episode,v.admission).state,'duplicateSource');
});
test('restart preserves typed episodes and fences; policy withdrawal and restore retire payloads and consent',t=>{
 const root=mkdtempSync(join(tmpdir(),'ls-visual-memory-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'state.sqlite'),owner=visualOwner();let db=new Database({path});db.migrate();let repo=new VisualMemoryRepository(db,()=>initial);let policy=repo.configure(owner,true,0,86400000);const v=visualEpisode(owner,policy,initial);assert.equal(repo.admit(owner,v.episode,v.admission).state,'retained');db.close();db=new Database({path});db.migrate();t.after(()=>db.close());repo=new VisualMemoryRepository(db,()=>initial);assert.equal(repo.inspect(owner,true).episodes[0]!.episode!.sourceDigest,v.episode.sourceDigest);assert.equal(repo.admit(owner,v.episode,v.admission).state,'duplicateSource');policy=repo.configure(owner,false,1,86400000);assert.equal(repo.inspect(owner,true).episodes[0]!.episode,null);assert.equal(repo.admit(owner,v.episode,v.admission).state,'policyDenied');policy=repo.configure(owner,true,2,86400000);const w=visualEpisode(owner,policy,initial);assert.equal(repo.admit(owner,w.episode,w.admission).state,'retained');assert.equal(repo.quarantine(),1);assert.equal(repo.policy(owner).enabled,false);assert.equal(repo.inspect(owner,true).episodes.every(e=>e.episode===null),true);assert.equal(repo.admit(owner,w.episode,w.admission).state,'policyDenied');
});
