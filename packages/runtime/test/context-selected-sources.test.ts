import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compileRelationshipContext,formatPreparedRelationshipContext,selectedRelationshipSources,type RelationshipContextRecord} from '../src/context/builder.ts';
import {finalizePreparedTurn,createPreparedTurnBinding} from '../src/inference/prompt.ts';
const base={userInput:'Please explain the azure issue.',audienceScope:'authenticatedSession' as const,profileRevision:'p:1',relationshipRevision:'r:1',configurationRevision:'c:1'};
const record=(memoryRecord=true):RelationshipContextRecord=>({id:randomUUID(),content:'azure convention',revision:1,sourceFamily:randomUUID(),status:'approved',use:'relevant',personalization:true,mention:true,...(memoryRecord?{memoryRecord:true}:{})});

test('final source metadata omits memory displaced by discovery without changing actual formatter allocation',()=>{
 const memory={...record(),id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},context=compileRelationshipContext({...base,records:[memory]});assert.ok(context.selections.some(s=>s.id===memory.id));
 context.discoveryContent='azure '.repeat(70);
 assert.doesNotMatch(formatPreparedRelationshipContext(context),new RegExp(memory.id));
 assert.deepEqual(selectedRelationshipSources(context),[]);
});

test('mandatory and convention-rendered sources survive optional displacement; relationship UUIDs are not memory IDs',()=>{
 const memory=record(),relationship=record(false),correction={...record(),use:'correction' as const};
 const context=compileRelationshipContext({...base,records:[memory,relationship,correction],representation:'conventionOriented'});context.discoveryContent='azure '.repeat(70);
 const selected=selectedRelationshipSources(context)!;assert.ok(selected.some(s=>s.id===memory.id&&s.memoryRecord));assert.ok(selected.some(s=>s.id===correction.id&&s.memoryRecord));assert.ok(selected.some(s=>s.id===relationship.id&&!s.memoryRecord));
 assert.match(formatPreparedRelationshipContext(context),new RegExp(memory.id));
});

test('unknown audience, withdrawn records and legacy or malformed selection metadata cannot invent selected memory',()=>{
 const memory=record();assert.deepEqual(selectedRelationshipSources(compileRelationshipContext({...base,records:[memory],audienceScope:'unknown'})),[]);
 assert.deepEqual(selectedRelationshipSources(compileRelationshipContext({...base,records:[{...memory,status:'candidate'}]})),[]);
 const context=compileRelationshipContext({...base,records:[memory]});const {selections,...legacy}=context;assert.equal(selectedRelationshipSources(legacy),undefined);assert.equal(selectedRelationshipSources({...context,selections:[null as never]}),undefined);
});

test('actual finalized request pins only rendered marked memory UUIDs; non-memory UUIDs and displaced sources are excluded',()=>{
 const memory={...record(),id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},relationship={...record(false),id:'ffffffff-ffff-4fff-8fff-ffffffffffff'},context=compileRelationshipContext({...base,records:[memory,relationship]});
 const scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:randomUUID(),conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID()};
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation:'[]',sourceRevisions:{relationship:context.relationshipRevision,configuration:context.configurationRevision}});
 const input={assistantId:scope.assistantId,sessionId:scope.sessionId,interactionId:randomUUID(),endpointId:scope.endpointId,conversation:'[]',preparedTurnBinding:binding,preparedRelationshipContext:context};
 const first=finalizePreparedTurn(input,()=>true);assert.deepEqual(first.selectedMemoryIds,[memory.id]);assert.equal(Object.isFrozen(first.selectedMemoryIds),true);
 context.discoveryContent='azure '.repeat(70);assert.deepEqual(finalizePreparedTurn(input,()=>true).selectedMemoryIds,[]);assert.deepEqual(first.selectedMemoryIds,[memory.id],'later mutable preparation cannot rewrite the frozen original source list');
});
