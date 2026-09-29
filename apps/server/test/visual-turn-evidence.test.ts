import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import {unavailableVisualSelection} from '@lifestream/runtime/perception/observation';
import {VisualTurnEvidence,startVisualTurnEvidence} from '../src/runtime/visual-turn-evidence.ts';

function fixture(){
  let utc=Date.now(),mono=1000;
  const actor={principalId:randomUUID(),assistantId:randomUUID(),sessionId:randomUUID()};
  const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...actor,relationshipId:null,conversationId:randomUUID(),endpointId:randomUUID()},conversation:'[]',sourceRevisions:{conversation:'synthetic-1'}});
  const evidence=new VisualTurnEvidence({utcMs:()=>utc,monotonicMs:()=>mono});
  const open=(modality:'text'|'audio'='text')=>{
    const interactionId=randomUUID(),factory=evidence.observer(actor,unavailableVisualSelection('no_observations'),binding,null);
    assert.ok(factory);
    const recorder=startVisualTurnEvidence(factory,interactionId,modality);
    return {recorder,interactionId,finalize(){const turn=finalizePreparedTurn({assistantId:actor.assistantId,sessionId:actor.sessionId,interactionId,endpointId:binding.scope.endpointId,conversation:'[]',userInput:'PRIVATE_FIXTURE_INPUT',preparedTurnBinding:binding},()=>true),request=requestForFinalizedTurn(turn,binding,()=>true);recorder.finalized(turn,request);return request;}};
  };
  return {actor,binding,evidence,open,advance:(ms:number)=>{utc+=ms;mono+=ms;},rollback:()=>{utc--;},recover:()=>{utc+=2;}};
}

test('visual turn evidence drains asynchronously, evicts oldest at bounded capacities and isolates all actor fields',async()=>{
  const f=fixture();try{
    const ids:string[]=[];
    for(let i=0;i<140;i++){const turn=f.open();ids.push(turn.interactionId);turn.recorder.rejected('context_unavailable');}
    assert.equal(f.evidence.receipts(f.actor).length,0,'pending receipts are not synchronously published');
    await Promise.resolve();const first=f.evidence.receipts(f.actor);assert.equal(first.length,128);assert.equal(first[0]!.interactionId,ids[12]);assert.equal(first.at(-1)!.interactionId,ids.at(-1));
    for(let i=0;i<20;i++)f.open().recorder.rejected('cancelled');await Promise.resolve();assert.equal(f.evidence.receipts(f.actor).length,128);
    for(const key of ['principalId','assistantId','sessionId'] as const){assert.deepEqual(f.evidence.receipts({...f.actor,[key]:randomUUID()}),[]);assert.equal(f.evidence.observer({...f.actor,[key]:randomUUID()},unavailableVisualSelection('no_observations'),f.binding,null),undefined);}
    let getterCalls=0;const hostile={...f.actor};Object.defineProperty(hostile,'principalId',{get(){getterCalls++;return f.actor.principalId;}});assert.deepEqual(f.evidence.receipts(hostile),[]);assert.equal(getterCalls,0);
    assert.ok(first.every(item=>item.coverage==='bounded_best_effort'));assert.equal(Object.isFrozen(first),true);assert.equal(Reflect.set(first[0]!.lineage,'selectionReason','selected'),false);
  }finally{f.evidence.close();}
});

test('visual turn retention expires records without suppressing later active-turn settlement',async()=>{
  const f=fixture();try{
    const turn=f.open('audio');turn.finalize();turn.recorder.providerInvoked();turn.recorder.emitted('audio');turn.recorder.generationEnded('completed');turn.recorder.synthesisCompleted();await Promise.resolve();assert.equal(f.evidence.receipts(f.actor).length,5);
    f.advance(60000);assert.deepEqual(f.evidence.receipts(f.actor),[]);
    turn.recorder.endpointSettled('completed',4800);await Promise.resolve();const later=f.evidence.receipts(f.actor);assert.equal(later.length,1);assert.equal(later[0]!.stage,'endpointSettled');assert.equal(later[0]!.sequence,6);assert.equal(later[0]!.endpointAcknowledged,true);
    f.advance(60000);assert.deepEqual(f.evidence.receipts(f.actor),[]);
  }finally{f.evidence.close();}
});

test('visual turn close and clock rollback fence scheduled drains and old observer callbacks',async()=>{
  for(const mode of ['close','rollback'] as const){
    const f=fixture(),old=f.open();old.finalize();old.recorder.providerInvoked();
    if(mode==='close')f.evidence.close();else {f.rollback();assert.deepEqual(f.evidence.receipts(f.actor),[]);f.recover();}
    old.recorder.generationEnded('completed');old.recorder.ended('completed');
    if(mode==='rollback')f.open().recorder.rejected('cancelled');
    await Promise.resolve();const records=f.evidence.receipts(f.actor);
    assert.ok(records.every(item=>item.interactionId!==old.interactionId));assert.equal(records.length,mode==='close'?0:1);f.evidence.close();
  }
});

test('visual evidence requires the exact frozen binding and never upgrades fenced playback',async()=>{
  const f=fixture();try{
    const turn=f.open('audio'),request=turn.finalize();turn.recorder.providerInvoked();turn.recorder.emitted('audio');turn.recorder.synthesisCompleted();turn.recorder.playbackFenced('invalidated');turn.recorder.endpointSettled('completed',4800);turn.recorder.endpointSettled('stopped',100);turn.recorder.endpointSettled('stopped',100);await Promise.resolve();
    const records=f.evidence.receipts(f.actor);assert.equal(records.filter(item=>item.stage==='endpointSettled').length,1);assert.equal(records.at(-1)!.outcome,'stopped');assert.doesNotMatch(JSON.stringify(records),/PRIVATE_FIXTURE_INPUT/);assert.equal(Reflect.set(records[0]!.finalized!.sections[0]!,'kind','forged'),false);
    const forged=f.open();forged.recorder.finalized({binding:f.binding,preparedContext:null,sourceRevisions:{},sections:request.manifest.sections} as never,request);forged.recorder.providerInvoked();await Promise.resolve();assert.ok(f.evidence.receipts(f.actor).every(item=>item.interactionId!==forged.interactionId));
  }finally{f.evidence.close();}
});

test('visual evidence wrappers preserve observer receivers and contain factory, method and clock failures',()=>{
  let receiverCalls=0;
  const observer={rejected(){assert.equal(this,observer);receiverCalls++;},finalized(){throw Error('private diagnostic failure');},providerInvoked(){},generationEnded(){},emitted(){},synthesisCompleted(){},playbackFenced(){},endpointSettled(){},ended(){}};
  const safe=startVisualTurnEvidence(()=>observer,randomUUID(),'text');safe.rejected('cancelled');safe.finalized({} as never,{} as never);assert.equal(receiverCalls,1);
  assert.doesNotThrow(()=>startVisualTurnEvidence(()=>{throw Error('factory');},randomUUID(),'text').ended('failed'));
  const f=fixture(),broken=new VisualTurnEvidence({utcMs:()=>{throw Error('clock');},monotonicMs:()=>0});assert.equal(broken.observer(f.actor,unavailableVisualSelection('no_observations'),f.binding,null),undefined);assert.deepEqual(broken.receipts(f.actor),[]);broken.close();f.evidence.close();
});
