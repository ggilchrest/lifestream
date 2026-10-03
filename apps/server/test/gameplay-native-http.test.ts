import test from 'node:test';
import assert from 'node:assert/strict';
import {CampaignJournalRepository} from '@lifestream/storage-sqlite';
import {gameMemoryContextRecord} from '../src/runtime/game-memory.ts';
import {gameplayHttpFixture} from './fixtures/gameplay-http.ts';

test('paired owned readback/HTTP/prepared planning/SQLite settlement/journal/memory and exact old-lease shutdown', {timeout:15000},async t=>{
 const f=gameplayHttpFixture();t.after(()=>f.close());await f.start();await f.completion();
 assert.equal(f.requests.length,1,JSON.stringify(f.statuses));assert.equal(f.controls(),1);assert.equal(f.observations(),3);
 assert.equal(f.shutdowns(),1);assert.equal(f.episodes.length,1,JSON.stringify(f.statuses));
 assert.equal(f.statuses.find(s=>s.state==='episodePublication')?.retained,true);
 assert.equal(f.statuses.find(s=>s.state==='stopped')?.nativeShutdownConfirmed,true,JSON.stringify(f.statuses));
 assert.equal(f.client.snapshot.pauseConfirmation,'confirmed');
 const row=f.repository.get(f.o,f.scope.runId)!;
 assert.equal(row.used.actions,1);assert.equal(row.used.frames,2);assert.equal(row.used.wallMs,13,'Measured native12.75ms rounds up; HTTP time is not charged as native usage');
 assert.equal(row.checkpoint.campaignJournalRef.revision,3);assert.equal(row.checkpoint.saveArtifact,null);
 const journal=new CampaignJournalRepository(f.db,f.journalOptions).get(f.o,row.checkpoint.campaignJournalRef.journalId)!;
 assert.ok(journal.entries.some(e=>e.kind==='currentSituation'&&e.content==='The visible gate remains closed.'));
 assert.equal(journal.goals.some(g=>g.status==='completed'),false);
 const episode=f.episodeSource.get(f.o,f.episodes[0]!.episodeId)!;assert.equal(episode.rawEvidenceAvailability,'notRetained');assert.match(episode.summary,/remains closed/);
 const record=f.memories.contextRecords(f.scope.assistantId,f.scope.principalId).find(item=>item.provenance.gameEpisodeId===episode.episodeId)!;
 assert.ok(record);assert.match(gameMemoryContextRecord(record).content,/Historical game memory/);assert.match(gameMemoryContextRecord(record).content,/remains closed/);
 assert.equal(f.runtime.isCurrent(),false);assert.equal(f.routes.filter(r=>r==='shutdown').length,1);
 assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'settled');
});

for(const mode of ['noUsage','badUsage'] as const)test('paired '+mode+' cannot settle controller or ground a memory',{timeout:15000},async t=>{
 const f=gameplayHttpFixture(mode);t.after(()=>f.close());await f.start();await f.completion();
 assert.equal(f.controls(),1);assert.equal(f.episodes.length,0);assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');
 assert.equal(f.repository.get(f.o,f.scope.runId)!.used.actions,0);assert.equal(f.statuses.some(s=>s.state==='requiresReconciliation'),true);
});

test('paired lost result acknowledgement cannot redispatch the entered native action',{timeout:15000},async t=>{
 const f=gameplayHttpFixture('lostResultAck');t.after(()=>f.close());await f.start();await f.completion();
 assert.equal(f.controls(),1);assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'settled');
 assert.equal(f.routes.filter(route=>route==='admit').length<=3,true); // Two observations and the single action, never an action retry.
 assert.equal(f.routes.filter(route=>route==='shutdown').length,1);
});

test('paired unqualified shutdown remains requiresReconciliation even with successful controller ingress',{timeout:15000},async t=>{
 const f=gameplayHttpFixture('noShutdown');t.after(()=>f.close());await f.start();await f.completion();
 assert.equal(f.controls(),1);assert.equal(f.shutdowns(),1);assert.equal(f.statuses.find(s=>s.nativeShutdownConfirmed===false)?.state,'requiresReconciliation');assert.equal(f.client.snapshot.pauseConfirmation,'unconfirmed');
});
