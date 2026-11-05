import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Duplex} from 'node:stream';
import {IncomingMessage,ServerResponse} from 'node:http';
import {loadProfile} from '../src/config/loader.ts';
import {audit,createAudit} from '../src/runtime/bounded-audit.mjs';
import {calendarPolicyPin,calendarPolicyResponse} from '../../../packages/contracts/src/mobile-context-calendar-policy-owner.ts';
import {calendarSettingsControlPin,calendarSelectionDigest} from '../../../packages/contracts/src/mobile-context-calendar-settings-control.ts';
import {calendarSelectedDeliveryPin} from '../../../packages/contracts/src/mobile-context-calendar-selected-delivery.ts';
import {mobileCalendarDeliveryPin} from '../../../packages/contracts/src/mobile-context-calendar-delivery.ts';
const auditRoot=mkdtempSync(join(tmpdir(),'calendar-policy-audit-'));chmodSync(auditRoot,0o700);
Object.assign(audit,createAudit({root:auditRoot,timers:false}),{start(){}});
const {createLifestreamServer}=await import('../src/index.ts');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
/** The only synthetic transport seam is local address metadata and streams.
 * No listening socket, provider probe, readiness override or authority stub. */
export async function createCalendarSyntheticFixture(){
 const root=mkdtempSync(join(tmpdir(),'calendar-original-policy-'));chmodSync(root,0o700);
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const consent=new Set<string>(),invalidations:unknown[]=[],transcript:unknown[]=[],installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 const options={config,personalPhoneAccess:{mode:'authenticatedSession',authenticatedAfterMs:0},audiencePrivacy:{},historyRetention:{mode:'disabled'},historyStateRoot:root,localAuth:{stateDirectory:join(root,'auth'),installerToken},mobileContext:{schemaPlan:'calendar-policy/1',calendarPolicyOwner:{finite:{allowedDurationDays:[2],allowedAnchors:['sourceEnd','firstAuthoritativeImport']}},maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50,sourceSafetyInitialization:'initializeEmpty',createCalendarGovernance:()=>({
  // Explicit synthetic collection consent is a lowest fixture input. Actual
  // classification/retention/custody/run capture are supplied by the real owner.
  allowed:(a:any,e:any,use:string)=>use==='collect'&&a.current()&&e.principalId===a.principalId&&e.endpointId===a.endpointId&&consent.has(a.principalId+':'+e.sourceNamespace),
  capturePolicy:()=>null,retention:()=>null,recordCurrent:()=>false,
  invalidate:(a:any,id:string,reason:string)=>{if(!a.current())throw Error('synthetic_context_changed');invalidations.push({principalId:a.principalId,id,reason});}
 })}};
 let app=createLifestreamServer(options as any),owner:any;
 const origin='http://127.0.0.1:52997';
 const bindTransport=()=>{app.address=()=>({host:'127.0.0.1',port:52997});app.server.listen=(()=>{queueMicrotask(()=>app.server.emit('listening'));return app.server;}) as any;};bindTransport();
 const raw=async(method:string,path:string,headers:Record<string,string>,body:Buffer)=>{
  assert.ok(['/api/auth/v1/setup','/api/auth/v1/user-context','/api/runtime/v1/session-context','/api/runtime/v1/mobile-context','/api/runtime/v1/mobile-context-policy'].includes(path),'closed synthetic driver route');
  assert.ok(body.length<=262144);const socket=new Duplex({read(){},write(_chunk,_encoding,done){done();}});Object.defineProperty(socket,'remoteAddress',{value:'127.0.0.1'});
  const req=new IncomingMessage(socket as any);req.method=method;req.url=path;req.httpVersion='1.1';req.httpVersionMajor=1;req.httpVersionMinor=1;req.complete=true;req.headers={host:'127.0.0.1:52997',origin,'content-type':'application/json',...headers,'content-length':String(body.length)};req.rawHeaders=Object.entries(req.headers).flatMap(([k,v])=>[k,String(v)]);
  const res=new ServerResponse(req),chunks:Buffer[]=[];res.assignSocket(socket as any);
  const write=res.write.bind(res),end=res.end.bind(res);
  res.write=((chunk:any,...args:any[])=>{chunks.push(Buffer.from(chunk));return (write as any)(chunk,...args);}) as any;
  res.end=((chunk?:any,...args:any[])=>{if(chunk!==undefined&&chunk!==null)chunks.push(Buffer.from(chunk));return (end as any)(chunk,...args);}) as any;
  const response=await new Promise<{status:number;headers:Record<string,unknown>;body:Buffer}>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic_handler_timeout:'+path)),5000);res.once('finish',()=>{clearTimeout(timer);resolve({status:res.statusCode,headers:res.getHeaders(),body:Buffer.concat(chunks)});});res.once('error',reject);app.server.emit('request',req,res);req.push(body);req.push(null);});socket.destroy();
  transcript.push({method,path,requestBodyBase64:body.toString('base64'),status:response.status,responseBodyBase64:response.body.toString('base64')});return response;
 };
 const request=async(path:string,body?:unknown,extra:Record<string,string>={})=>{const r=await raw(body===undefined?'GET':'POST',path,{...(owner?{cookie:owner.cookie,'x-lifestream-csrf':owner.csrf,...(owner.contextRef?{'x-lifestream-user-context':owner.contextRef}:{})}:{}),...extra},body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body)));return {...r,json:()=>JSON.parse(r.body.toString('utf8'))};};
 try{
  await app.start();
  const setup=await request('/api/auth/v1/setup',{username:'synthetic-calendar-owner',password,installerToken});assert.equal(setup.status,201,setup.body.toString());const session=setup.json().session;owner={principalId:session.principalId,sessionId:session.sessionId,csrf:session.csrfToken,cookie:String(setup.headers['set-cookie']).split(';')[0],contextRef:''};
  owner.contextRef=(await request('/api/auth/v1/user-context')).json().contextRef;
  const initial=(await request('/api/runtime/v1/session-context')).json();const bound=await request('/api/runtime/v1/session-context',{expectedRevision:initial.revision,mode:'text',audienceScope:'authenticatedSession',endpointClass:'personalCompanion',bindingKey:randomUUID()});assert.equal(bound.status,200,bound.body.toString());const endpointId=bound.json().endpoint.endpointId;
  owner.contextRef=(await request('/api/auth/v1/user-context')).json().contextRef;
  const control=(e:any,action:any)=>({schemaVersion:'1.0.0',operationId:randomUUID(),target:{principalId:owner.principalId,endpointId,collector:'eventKit',enrollmentId:e?.enrollmentId??null,sourceNamespace:e?.sourceNamespace??null,expectedRevision:e?.revision??0},action});
  const applyControl=async(r:any)=>{const response=await request('/api/runtime/v1/mobile-context',{producerPin:calendarSettingsControlPin,operation:'control',payload:r});assert.equal(response.status,200,response.body.toString());const result=response.json().result;assert.equal(result.kind,'terminal',JSON.stringify(result));assert.equal(result.outcome.status,'applied');return result.outcome.enrollment;};
  const callPolicy=async(operation:string,payload:any,extra:any={})=>{const r=await request('/api/runtime/v1/mobile-context-policy',{producerPin:calendarPolicyPin,operation,payload,...extra});assert.equal(r.status,200,r.body.toString());assert.ok(calendarPolicyResponse(r.json()));return r.json().result;};
  const decide=async(r:any)=>{const preview=await callPolicy('preview',r);assert.equal(preview.kind,'ready',JSON.stringify(preview));assert.equal((await callPolicy('apply',r,{previewDigest:preview.digest})).kind,'observed');const terminal=await callPolicy('reconcile',r);assert.equal(terminal.kind,'terminal');assert.equal(terminal.binding.family,'calendarPolicy');return terminal;};
  return {get app(){return app;},root,origin,owner,endpointId,request,raw,control,applyControl,callPolicy,decide,transcript,invalidations,
   grantSyntheticCollection:(e:any)=>consent.add(owner.principalId+':'+e.sourceNamespace),
   async enroll(){let e=await applyControl(control(null,{kind:'enroll'}));e=await applyControl(control(e,{kind:'bindSource',binding:{createNew:true}}));return applyControl(control(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:{categories:['CalendarEvent'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true},syncWindow:{schemaVersion:'1.0.0',lookBackDays:1,lookAheadDays:3,timeZone:'America/Chicago'}}}));},
   mapping:()=>({operationId:randomUUID(),command:'approveMapping',expectedRevision:0,scope:{kind:'classification',category:'CalendarEvent'},classification:'personal'}),
   retention:(e:any,choice:any={mode:'indefinite'},expectedRevision=0)=>({operationId:randomUUID(),command:'setRawRetention',expectedRevision,mappingRevision:1,scope:{kind:'rawRetention',principalId:owner.principalId,collector:'eventKit',sourceNamespace:e.sourceNamespace,category:'CalendarEvent'},choice}),
   selected(e:any){const item=JSON.parse(readFileSync(new URL('../../../packages/contracts/test/fixtures/mobile-context-calendar-delivery.json',import.meta.url),'utf8')).vectors[3].item;item.change.eventId=randomUUID();item.change.enrollmentId=e.enrollmentId;item.change.expectedPolicyRevision=e.revision;item.change.source.namespace=e.sourceNamespace;const selection={principalId:owner.principalId,endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:item.change.source.containerId,accountId:item.change.source.accountId}]};return {producerPin:calendarSelectedDeliveryPin,operation:'ingestSelected',payload:{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,selection,run:{anchorAt:'2026-11-01T18:00:00.123Z',startAt:'2026-10-31T17:00:00.123Z',endAt:'2026-11-04T18:00:00.123Z',timeZone:'America/Chicago',configurationRevision:e.revision,selectionDigest:calendarSelectionDigest(selection)},items:[item]}};},
   checkpoint(){return {sql:sha(readFileSync(config.storage.databasePath)),journal:sha(readFileSync(app.admin.recovery.journal.directory+'/journal.json')),records:Number(app.database.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n)};},
   async reopen(){await app.shutdown();app=createLifestreamServer({...options,mobileContext:{...options.mobileContext,sourceSafetyInitialization:'requireExisting'}} as any);bindTransport();await app.start();},
   async close(){await app.shutdown();rmSync(root,{recursive:true,force:true});}
  };
 }catch(error){await app.shutdown();rmSync(root,{recursive:true,force:true});throw error;}
}
if(process.env.LIFESTREAM_CALENDAR_SYNTHETIC_DRIVER!=='1'){
 test('actual non-listening authenticated Calendar flow needs explicit original mapping, retention and independent collection consent',async()=>{
  const f=await createCalendarSyntheticFixture();try{const e=await f.enroll(),send=f.selected(e);
   assert.equal(f.app.server.listening,false);assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).status,403);
   await f.decide(f.mapping());assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).status,403);
   const retention=await f.decide(f.retention(e));assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).status,403);
   f.grantSyntheticCollection(e);const response=await f.request('/api/runtime/v1/mobile-context',send);assert.equal(response.status,200,response.body.toString());assert.equal(response.json().result.receipts[0].outcome,'accepted');assert.equal(f.checkpoint().records,1);assert.equal(f.app.database.connection.prepare('SELECT count(*) n FROM mobile_context_policy_records').get()!.n,1);
   assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).json().result.receipts[0].outcome,'duplicate');
   const before=f.checkpoint();assert.deepEqual(await f.callPolicy('reconcile',retention.original),retention);assert.deepEqual(f.checkpoint(),before);
   await f.reopen();assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).json().result.receipts[0].outcome,'duplicate');assert.equal(f.checkpoint().records,1);
  }finally{await f.close();}
 });
 test('real owner refuses changed selection, out-of-window whole prefix, missing CSRF and legacy opaque run',async()=>{
  const f=await createCalendarSyntheticFixture();try{const e=await f.enroll();await f.decide(f.mapping());await f.decide(f.retention(e));f.grantSyntheticCollection(e);const send=f.selected(e),bad=structuredClone(send);bad.payload.items[0].change.source.containerId='not selected';
   assert.equal((await f.request('/api/runtime/v1/mobile-context',bad)).status,403);const rounded=structuredClone(send);rounded.payload.run.startAt='2026-10-31T05:00:00Z';assert.equal((await f.request('/api/runtime/v1/mobile-context',rounded)).status,403);
   assert.equal((await f.request('/api/runtime/v1/mobile-context',send,{'x-lifestream-csrf':'invalid'})).status,403);
   const {selection,...payload}=send.payload;assert.equal((await f.request('/api/runtime/v1/mobile-context',{producerPin:calendarSettingsControlPin,operation:'ingestScoped',payload})).status,403);assert.equal(f.checkpoint().records,0);
   const policy=await f.request('/api/runtime/v1/mobile-context',{producerPin:mobileCalendarDeliveryPin,operation:'calendar',payload:{schemaVersion:'1.0.0',operation:'policy',enrollmentId:e.enrollmentId}});assert.equal(policy.json().result.effective.collectionAllowed,true);assert.deepEqual(policy.json().result.effective.uses,[]);
  }finally{await f.close();}
 });
 test('Calendar indefinite needs an actual confirmed preview; finite change preserves first import and old terminal custody',async()=>{
  const f=await createCalendarSyntheticFixture();try{const e=await f.enroll();await f.decide(f.mapping());const original=f.retention(e);
   assert.equal((await f.callPolicy('apply',original)).kind,'held');assert.equal(f.app.database.connection.prepare("SELECT count(*) n FROM mobile_context_policy_decisions WHERE kind='rawRetention'").get()!.n,0);
   const terminal=await f.decide(original);f.grantSyntheticCollection(e);const send=f.selected(e);assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).json().result.receipts[0].outcome,'accepted');
   const first=f.app.database.connection.prepare('SELECT first_authoritative_import_at t FROM mobile_context_policy_records').get()!.t;
   await f.decide(f.retention(e,{mode:'finite',durationDays:2,anchor:'firstAuthoritativeImport'},1));assert.equal(f.app.database.connection.prepare('SELECT expires_at FROM mobile_context_records').get()!.expires_at,new Date(Date.parse(String(first))+2*86400000).toISOString());
   assert.equal(f.app.database.connection.prepare('SELECT first_authoritative_import_at t FROM mobile_context_policy_records').get()!.t,first);assert.deepEqual(await f.callPolicy('reconcile',original),terminal);
   const revoke={operationId:randomUUID(),command:'revokeMapping',expectedRevision:1,scope:{kind:'classification',category:'CalendarEvent'}};await f.decide(revoke);
   assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).status,403);assert.equal(f.checkpoint().records,1);
  }finally{await f.close();}
 });
 test('whole prefix rejects a later out-of-window item before importing its valid sibling or starting import custody',async()=>{
  const f=await createCalendarSyntheticFixture();try{const e=await f.enroll();await f.decide(f.mapping());await f.decide(f.retention(e));f.grantSyntheticCollection(e);const send=f.selected(e),later=structuredClone(send.payload.items[0]);later.change.eventId=randomUUID();later.change.source.upstreamId='outside-window';later.change.record.time.start.at='2026-11-10T12:00:00Z';later.change.record.time.end.at='2026-11-10T13:00:00Z';send.payload.items.push(later);
   assert.equal((await f.request('/api/runtime/v1/mobile-context',send)).status,403);assert.equal(f.checkpoint().records,0);assert.equal(f.app.database.connection.prepare('SELECT count(*) n FROM mobile_context_policy_records').get()!.n,0);assert.equal(f.app.admin.recovery.journal.sourceSnapshot().acceptedImports?.length??0,0);
  }finally{await f.close();}
 });
}
