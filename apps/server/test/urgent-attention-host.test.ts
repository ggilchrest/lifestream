import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import type {PwceCondition,PwceConditionResponse} from '@lifestream/providers-pwce';
import {UrgentAttentionHost} from '../src/runtime/urgent-attention-host.ts';
import type {UrgentAttentionFacts} from '../src/runtime/urgent-attention.ts';
const until=async(check:()=>boolean)=>{const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw Error('Timed out waiting for synthetic host state');await new Promise(resolve=>setTimeout(resolve,5));}};
function setup(t:any){
 const db=new Database({path:':memory:'});db.migrate();
 const scope={principalId:randomUUID(),assistantId:randomUUID(),endpointId:randomUUID()},binding={sourceRef:'source.synthetic',eventClass:'fixture.critical',worldRef:'world.test',siteRef:'site.test',zoneRef:'zone.test',label:'Synthetic condition'};
 const at=Date.now();const condition:PwceCondition={...binding,conditionRef:'pwce:condition:'+'a'.repeat(64),revision:1,sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'Synthetic bounded warning.',occurredAt:new Date(at).toISOString(),receivedAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString(),freshUntil:new Date(at+30000).toISOString(),expiresAt:new Date(at+60000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:1,limitations:['Synthetic only'],evidenceRefs:[]}};delete (condition as any).label;
 const facts:UrgentAttentionFacts={scope,sessionId:randomUUID(),sessionRevision:1,audienceRevision:1,authorizationRevision:1,authorized:true,privateAudience:true,attentionSuitable:true,outputReady:true};
 let snapshot:PwceCondition[]=[],pages:PwceCondition[][]=[],cursor=0,resync=false,ends=0,interrupts=0,speech=0;
 const envelope=(operation:'snapshot'|'changes',conditions:PwceCondition[]):PwceConditionResponse=>({profileId:'pwce-urgent-conditions.v1',profileVersion:'1.0.0',operation,status:resync?'resyncRequired':'ok',evaluatedAt:new Date().toISOString(),conditions:structuredClone(conditions),nextCursor:cursor,hasMore:false,resyncReason:resync?'cursorExpired':null,acknowledgment:null,replay:true});
 const source={snapshot:async()=>envelope('snapshot',snapshot),changes:async()=>{cursor++;return envelope('changes',pages.shift()??[]);}};
 const host=new UrgentAttentionHost(db,{baseUrl:'http://synthetic.invalid',token:'not-a-secret',worldRef:binding.worldRef,siteRef:binding.siteRef,replay:true,bindings:[binding],pollIntervalMs:250},source);
 const events:{event:string;data:any}[]=[];let onSend:(event:string,data:any)=>void=()=>{};
 const connection={scope,identity:{assistantRef:scope.assistantId,endpointRef:scope.endpointId,participantRefs:[scope.principalId],audienceRef:'private:test'},facts:()=>facts,send:(event:string,data:Record<string,unknown>)=>{events.push({event,data});onSend(event,data);return true;},end:()=>{ends++;},interrupt:async()=>{interrupts++;},speak:async(input:any)=>{speech++;input.beforeEmission();input.emitted();}};
 const configure=(modality:'text'|'speech'='text')=>host.runtime.configure(scope,{expectedRevision:host.runtime.settings(scope).revision,rules:[{sourceRef:binding.sourceRef,eventClass:binding.eventClass,enabled:true,bypassQuietHours:false}],modality,quietHours:null,snoozedUntil:null});
 const receipt=(data:any,stage:string)=>host.receipt(scope,facts.sessionId!,{operation:'receipt',deliveryId:data.id,receiptToken:data.receiptToken,stage});
 const automaticReceipts=()=>{onSend=(event,data)=>{if(event==='urgent.prepare')queueMicrotask(()=>receipt(data,'ready'));if(event==='urgent.delivery')queueMicrotask(()=>receipt(data,'endpointAccepted'));};};
 t.after(()=>{host.close();db.close();});return {db,scope,binding,condition,facts,host,connection,events,configure,receipt,automaticReceipts,setSnapshot:(v:PwceCondition[])=>{snapshot=v;},push:(...v:PwceCondition[][])=>{pages.push(...v);},resync:()=>{resync=true;},setSend:(fn:typeof onSend)=>{onSend=fn;},counts:()=>({ends,interrupts,speech})};
}

test('conditions require explicit source policy and endpoint readiness; emitted text is not Human acknowledgment',async t=>{
 const f=setup(t);f.configure();f.push([f.condition]);f.host.subscribe(f.connection);
 await until(()=>f.events.some(x=>x.event==='urgent.prepare'));
 assert.equal(f.counts().interrupts,0);assert.equal(f.events.some(x=>x.event==='urgent.delivery'),false);
 const prepare=f.events.find(x=>x.event==='urgent.prepare')!.data;
 for(const stage of [['ready'],['endpointAccepted'],{},null])assert.throws(()=>f.host.receipt(f.scope,f.facts.sessionId!,{operation:'receipt',deliveryId:prepare.id,receiptToken:prepare.receiptToken,stage}),/Invalid/);
 assert.throws(()=>f.host.receipt(f.scope,f.facts.sessionId!,{operation:'receipt',deliveryId:prepare.id,receiptToken:'foreign',stage:'ready'}));
 f.receipt(prepare,'ready');await until(()=>f.events.some(x=>x.event==='urgent.delivery'));
 let row=f.host.inspect(f.scope).deliveries[0]!;assert.equal(row.stage,'started');assert.equal(row.acknowledgedAt,null);
 f.receipt(prepare,'endpointAccepted');row=f.host.inspect(f.scope).deliveries[0]!;assert.equal(row.stage,'completed');assert.ok(row.endpointAcceptedAt);assert.equal(row.playbackCompletedAt,null);assert.equal(row.acknowledgedAt,null);assert.equal(f.counts().interrupts,1);
});

test('baseline and later revisions of the same episode cannot produce historical automatic output',async t=>{
 const f=setup(t);f.configure();f.automaticReceipts();f.setSnapshot([f.condition]);f.push([{...f.condition,revision:2,sourceRevision:2,transition:'update'}]);f.host.subscribe(f.connection);
 await until(()=>f.events.filter(x=>x.event==='urgent.status'&&x.data.state==='connected').length>=2);
 assert.equal(f.events.some(x=>x.event==='urgent.prepare'),false);assert.equal(f.counts().interrupts,0);
});

test('source resync and audience revision changes cancel output and retire transport without replay',async t=>{
 for(const reason of ['resync','audience']){
  const f=setup(t);f.configure();f.automaticReceipts();f.push([f.condition]);f.host.subscribe(f.connection);
  await until(()=>f.host.inspect(f.scope).deliveries[0]?.stage==='completed');
  if(reason==='resync')f.resync();else{f.facts.audienceRevision++;f.host.reconcile();}
  await until(()=>f.counts().ends===1);assert.ok(f.events.some(x=>x.event==='urgent.cancel'));assert.equal(f.host.inspect(f.scope).connected,false);
 }
});

test('scope loss while critical interruption awaits settlement never emits its warning',async t=>{
 const f=setup(t);f.configure();let entered=false,release!:()=>void;f.connection.interrupt=async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});};
 f.setSend((event,data)=>{if(event==='urgent.prepare')queueMicrotask(()=>f.receipt(data,'ready'));});f.push([f.condition]);f.host.subscribe(f.connection);await until(()=>entered);
 f.facts.privateAudience=false;f.host.reconcile();release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.events.some(x=>x.event==='urgent.delivery'),false);assert.equal(f.counts().ends,1);
});

test('duplicate subscribers are refused and quiet or disabled policy never interrupts',async t=>{
 const f=setup(t);f.push([f.condition]);f.host.subscribe(f.connection);assert.throws(()=>f.host.subscribe(f.connection),/active/);
 await until(()=>f.events.filter(x=>x.event==='urgent.status'&&x.data.state==='connected').length>=2);assert.equal(f.counts().interrupts,0);assert.equal(f.events.some(x=>x.event==='urgent.prepare'),false);
});

test('speech completes only after transport settlement and explicit endpoint acceptance',async t=>{
 const f=setup(t);f.configure('speech');f.automaticReceipts();let settle!:()=>void,started=false;
 f.connection.speak=async input=>{input.beforeEmission();input.emitted();started=true;await new Promise<void>(resolve=>{settle=resolve;});};
 f.push([f.condition]);f.host.subscribe(f.connection);await until(()=>started&&f.host.inspect(f.scope).deliveries[0]?.stage==='delivered');
 assert.equal(f.host.inspect(f.scope).deliveries[0]!.playbackCompletedAt,null);settle();await until(()=>f.events.some(x=>x.event==='urgent.completed'));
 assert.ok(f.host.inspect(f.scope).deliveries[0]!.playbackCompletedAt);assert.equal(f.host.inspect(f.scope).deliveries[0]!.acknowledgedAt,null);
});

test('fast speech settlement waits for its slower HTTP acceptance receipt',async t=>{
 const f=setup(t);f.configure('speech');f.setSend((event,data)=>{if(event==='urgent.prepare')queueMicrotask(()=>f.receipt(data,'ready'));});
 f.push([f.condition]);f.host.subscribe(f.connection);await until(()=>f.counts().speech===1);
 assert.equal(f.host.inspect(f.scope).deliveries[0]!.stage,'started');assert.equal(f.events.some(x=>x.event==='urgent.cancel'),false);
 const delivery=f.events.find(x=>x.event==='urgent.delivery')!.data;f.receipt(delivery,'endpointAccepted');await until(()=>f.events.some(x=>x.event==='urgent.completed'));
 assert.equal(f.host.inspect(f.scope).deliveries[0]!.stage,'completed');
});

test('a later Human acknowledgment cannot leave completed display output immune to expiry',async t=>{
 const f=setup(t);f.configure();f.automaticReceipts();f.push([f.condition]);f.host.subscribe(f.connection);
 await until(()=>f.host.inspect(f.scope).deliveries[0]?.stage==='completed');
 const row=f.host.inspect(f.scope).deliveries[0]!;f.host.runtime.control(f.scope,{action:'acknowledge',deliveryId:row.id,expectedRevision:row.revision});
 (f.host as any).stopJob(row.id,'condition_expired');const cancelled=f.host.inspect(f.scope).deliveries[0]!;
 assert.equal(cancelled.stage,'cancelled');assert.ok(cancelled.acknowledgedAt);assert.ok(cancelled.endpointAcceptedAt);assert.equal(f.events.filter(x=>x.event==='urgent.cancel').length,1);
});
