import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncTraceExporter, mapTraceEvent, type ExportEvent, type TracePublishReceipt, type TraceSink } from "../src/observability/exporter.ts";

const event = (id: string, sequence = 1): ExportEvent => ({ id, traceId: "trace-1", sequence, environmentId: "env-dev", replayId: null, sourceCorrelationId: `source-${id}`, payload: { answer: "safe", apiKey: "do-not-export", nested: { password: "also-secret" } } });
const receipt = (ids: string[]): TracePublishReceipt => ({ receiptId: `receipt-${ids.join("-") || "empty"}`, acceptedEventIds: ids, rejectedEvents: [], receivedAt: "2026-09-07T00:00:00.000Z" });

test("mapping redacts secrets while preserving source and replay correlation", () => {
  const mapped = mapTraceEvent({ id: "e1", traceId: "t", sequence: 4, payload: { token: "secret", value: 2 } }, { environmentId: "env", replayId: "replay-1", sourceCorrelationId: "source-1" });
  assert.deepEqual(mapped.payload, { token: "[REDACTED]", value: 2 });
  assert.equal(mapped.replayId, "replay-1");
  assert.equal(mapped.sourceCorrelationId, "source-1");
});

test("sink outage defers export and never loses the outbox", async () => {
  const sink: TraceSink = { publish: async () => { throw new Error("offline"); } };
  const exporter = new AsyncTraceExporter(sink); exporter.enqueue(event("e1"));
  assert.equal((await exporter.flush()).status, "deferred"); assert.equal(exporter.pending().length, 1);
});

test("duplicate flush is single-flight and partial rejection retains only rejected events", async () => {
  let calls = 0;
  const sink: TraceSink = { publish: async ({ events }) => { calls++; return { ...receipt([events[0].id]), rejectedEvents: events.slice(1).map((item) => ({ eventId: item.id, reason: "invalid" })) }; } };
  const exporter = new AsyncTraceExporter(sink, 2); exporter.enqueue(event("e1", 1)); exporter.enqueue(event("e2", 2));
  const first = exporter.flush(); const second = exporter.flush(); assert.strictEqual(second, first); await first; assert.equal(calls, 1); assert.deepEqual(exporter.pending().map((item) => item.id), ["e2"]);
  assert.equal(exporter.highWater(), 1);
});

test("enqueue is synchronous so speech callers do not wait for the remote sink", () => {
  let resolve!: (value: TracePublishReceipt) => void;
  const sink: TraceSink = { publish: async () => new Promise((done) => { resolve = done; }) };
  const exporter = new AsyncTraceExporter(sink); exporter.enqueue(event("e1")); const pending = exporter.flush();
  assert.equal(exporter.pending().length, 1); resolve(receipt(["e1"])); return pending;
});

test('sink outage keeps bounded pending evidence, admits no network work during enqueue and redacts at the actual boundary',async()=>{
 let calls=0;const exporter=new AsyncTraceExporter({async publish({events}){calls++;assert.equal(events[0]!.payload.apiKey,'[REDACTED]');assert.deepEqual(events[0]!.payload.nested,{password:'[REDACTED]'});throw Error('PRIVATE_PROVIDER_FAILURE');}},2,{maxEvents:2,maxBytes:2048,maxEventBytes:1024});
 assert.equal(exporter.enqueue(event('a')),'queued');assert.equal(exporter.enqueue(event('b',2)),'queued');assert.equal(exporter.enqueue(event('c',3)),'overflow');assert.equal(calls,0);assert.equal(exporter.usage().refusedEvents,1);assert.equal((await exporter.flush()).status,'deferred');assert.equal(exporter.pending().length,2);assert.equal(exporter.highWater(),-1);assert.equal(calls,1);assert.equal(exporter.enqueue(event('a')),'duplicate');
 exporter.close();assert.equal(exporter.usage().bytes,0);assert.equal(exporter.enqueue(event('x')),'closed');assert.deepEqual(await exporter.flush(),{status:'deferred',reason:'closed',pending:0});
});
test('whole content-bound batch identity distinguishes different events with the same sequence range',async()=>{
 const keys:string[]=[];const sink:TraceSink={async publish({idempotencyKey,events}){keys.push(idempotencyKey);return receipt(events.map(e=>e.id));}};
 const first=new AsyncTraceExporter(sink),second=new AsyncTraceExporter(sink);first.enqueue(event('a',1));second.enqueue(event('b',1));await first.flush();await second.flush();assert.notEqual(keys[0],keys[1]);assert.match(keys[0]!,/^trace-batch:sha256:[a-f0-9]{64}$/u);assert.doesNotMatch(keys[0]!,/env-dev|source-|do-not-export/u);
});
test('synchronous reentrant flush shares the original single flight and cannot fan out',async()=>{
 let exporter!:AsyncTraceExporter,reentrant:Promise<unknown>|undefined,calls=0;const sink:TraceSink={async publish({events}){calls++;reentrant=exporter.flush();return receipt(events.map(e=>e.id));}};exporter=new AsyncTraceExporter(sink);exporter.enqueue(event('a'));const first=exporter.flush();assert.equal(reentrant,first);assert.equal((await first).status,'accepted');assert.equal(calls,1);
});
test('unacknowledged or partially acknowledged source IDs never claim the whole batch was accepted',async()=>{
 let accepted:string[]=[];const exporter=new AsyncTraceExporter({async publish(){return receipt(accepted);}},2);exporter.enqueue(event('a',1));exporter.enqueue(event('b',2));assert.equal((await exporter.flush()).status,'partial');assert.equal(exporter.pending().length,2);assert.equal(exporter.highWater(),-1);accepted=['a'];assert.equal((await exporter.flush()).status,'partial');assert.deepEqual(exporter.pending().map(e=>e.id),['b']);accepted=['b'];assert.equal((await exporter.flush()).status,'accepted');assert.equal(exporter.pending().length,0);assert.equal(exporter.usage().bytes,0);
});
test('invalid foreign, duplicate, conflicting, executable and oversized receipts cannot clear pending data',async()=>{
 for(const mode of ['foreign','duplicate','conflict','unknown','getter','proxy','oversize','time'] as const){
  let touched=0;const exporter=new AsyncTraceExporter({async publish(){const value:any=receipt(['a']);if(mode==='foreign')value.acceptedEventIds=['foreign'];else if(mode==='duplicate')value.acceptedEventIds=['a','a'];else if(mode==='conflict')value.rejectedEvents=[{eventId:'a',reason:'invalid'}];else if(mode==='unknown')value.extra='private';else if(mode==='getter')Object.defineProperty(value,'receiptId',{get(){touched++;return 'private';},enumerable:true});else if(mode==='proxy')return new Proxy(value,{get(_target,key){if(key==='then')return undefined;touched++;throw Error('private');}});else if(mode==='oversize')value.receiptId='x'.repeat(257);else value.receivedAt='invalid';return value;}});exporter.enqueue(event('a'));const result=await exporter.flush();assert.deepEqual(result,{status:'deferred',reason:'invalid-receipt',pending:1});assert.equal(exporter.highWater(),-1);assert.equal(touched,0);assert.equal(exporter.pending().length,1);exporter.close();
 }
});
test('hung sink times out, observes cancellation and remains quarantined until actual settlement; late receipts do not consume sources',async()=>{
 let finish!:(r:TracePublishReceipt)=>void,calls=0,signal:AbortSignal|undefined;const exporter=new AsyncTraceExporter({publish(_batch,s){calls++;signal=s;return new Promise(resolve=>{finish=resolve;});}},2,{deadlineMs:50});exporter.enqueue(event('a'));assert.deepEqual(await exporter.flush(),{status:'deferred',reason:'timed-out',pending:1});assert.equal(signal!.aborted,true);assert.equal(exporter.usage().quarantined,true);for(let i=0;i<5;i++)assert.equal((await exporter.flush()).status,'deferred');assert.equal(calls,1);finish(receipt(['a']));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(exporter.pending().length,1);assert.equal(exporter.highWater(),-1);assert.equal(exporter.usage().quarantined,false);exporter.close();
});
test('cooperative deadline cancellation retains source and later explicit retry uses the identical idempotency key',async()=>{
 const keys:string[]=[];let fail=true;const exporter=new AsyncTraceExporter({publish({idempotencyKey,events},signal){keys.push(idempotencyKey);if(!fail)return Promise.resolve(receipt(events.map(e=>e.id)));return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}},2,{deadlineMs:50});exporter.enqueue(event('a'));assert.equal((await exporter.flush()).status,'deferred');await new Promise<void>(resolve=>setImmediate(resolve));fail=false;assert.equal((await exporter.flush()).status,'accepted');assert.equal(keys[0],keys[1]);assert.equal(exporter.pending().length,0);
});
test('close during in-flight publication cancels and clears private queued data; late receipt never restores it',async()=>{
 let finish!:(r:TracePublishReceipt)=>void,signal:AbortSignal|undefined;const exporter=new AsyncTraceExporter({publish(_batch,s){signal=s;return new Promise(resolve=>{finish=resolve;});}});exporter.enqueue(event('a'));const pending=exporter.flush();exporter.close();assert.equal(signal!.aborted,true);assert.deepEqual(await pending,{status:'deferred',reason:'closed',pending:0});finish(receipt(['a']));await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(exporter.pending(),[]);assert.equal(exporter.highWater(),-1);assert.equal(exporter.usage().completedIds,0);
});
test('recent completion dedup stays bounded without claiming perpetual or durable source history',async()=>{
 const exporter=new AsyncTraceExporter({async publish({events}){return receipt(events.map(e=>e.id));}},1,{maxCompletedIds:2});for(let i=0;i<5;i++){assert.equal(exporter.enqueue(event(String(i),i)),'queued');assert.equal((await exporter.flush()).status,'accepted');assert.ok(exporter.usage().completedIds<=2);}assert.equal(exporter.enqueue(event('4',4)),'duplicate');assert.equal(exporter.usage().dedupCoverage,'bounded_recent');assert.equal(exporter.usage().durable,false);assert.equal(exporter.usage().complete,false);exporter.close();
});
test('bad data/mapping and unsafe configuration cannot invoke getters or enter transport',()=>{
 let touched=0,calls=0;const exporter=new AsyncTraceExporter({async publish(){calls++;return receipt([]);}});const bad={...event('a'),payload:{get value(){touched++;return 'private';}}};assert.equal(exporter.enqueue(bad),'invalid');assert.throws(()=>mapTraceEvent(bad,{environmentId:'e',replayId:null,sourceCorrelationId:'s'}),/Invalid trace data/);assert.throws(()=>mapTraceEvent({id:'a',traceId:'t',sequence:1,payload:{}},new Proxy({environmentId:'e',replayId:null,sourceCorrelationId:'s'},{get(){touched++;throw Error('private');}})),/Invalid trace data/);assert.equal(touched,0);assert.equal(calls,0);assert.throws(()=>new AsyncTraceExporter({async publish(){return receipt([]);}},0));assert.throws(()=>new AsyncTraceExporter({async publish(){return receipt([]);}},1,{deadlineMs:Infinity}));exporter.close();
});
test('redaction expansion still respects the declared per-event and aggregate byte budgets',()=>{
 const exporter=new AsyncTraceExporter({async publish(){throw Error('must not enter');}},1,{maxEvents:2,maxBytes:1024,maxEventBytes:256});
 const payload=Object.fromEntries(Array.from({length:8},(_,i)=>['secret'+i,'']));assert.equal(exporter.enqueue({...event('expanded'),payload}),'invalid');assert.deepEqual(exporter.pending(),[]);assert.equal(exporter.usage().bytes,0);exporter.close();
});
