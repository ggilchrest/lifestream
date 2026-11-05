import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Database,AssistantProfileRepository} from '@lifestream/storage-sqlite';
import {canonicalAuthSessionCustody} from '../src/auth/local-auth.ts';
import {reviseSessionEndpoint,readSessionEndpoint} from '../src/runtime/session-context.ts';
import {registerCanonicalPresenceConfiguration} from '../src/runtime/canonical-presence-owners.ts';
import {presenceTerminalCustodyRoles,createPresenceTerminalCustodyOwner,capturePresenceTerminalCustody,matchesPresenceTerminalCustody,capturePresenceAuthSessionCustody,matchesPresenceAuthSessionCustody,type PresenceTerminalCustodyOwners} from '../src/runtime/presence-terminal-custody.ts';
import {LocalAuthentication,type LocalContext} from '../src/auth/local-auth.ts';
import {AudienceCoordinator} from '../src/runtime/audience.ts';
import {createDailyPresence,handleDailyPresenceHttp,isDailyPresencePath,type DailyPresenceOptions} from '../src/composition/daily-presence.ts';

async function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'daily-presence-')),database=new Database({path:':memory:'});database.migrate();
 const installer=randomBytes(32).toString('hex'),auth=new LocalAuthentication(database,{stateDirectory:join(root,'auth'),installerToken:installer}),origin='http://127.0.0.1:33000';
 const claimed=await auth.setup('synthetic-owner',`synthetic-${randomBytes(24).toString('hex')}`,installer,origin),context=auth.hostSessionContext(claimed.session.sessionId);
 const audience=new AudienceCoordinator({sourceIds:['presence:fixture']});let calls=0,current=true;
 const unavailable=()=>{calls++;throw Error('No resource operation admitted by fixture');};
 const configuration:DailyPresenceOptions={revision:1,sourceId:'presence:fixture',composition:{broker:{resource:unavailable,acquireLease:unavailable,lease:unavailable,assertLease:unavailable,releaseLease:unavailable,renewLease:unavailable},selection:()=>null,enrollment:{confirmPurpose:unavailable,enroll:unavailable,load:unavailable,revoke:unavailable},owner:()=>undefined,frameCurrent:()=>false,execution:{revision:1,python:'/unavailable',pythonSha256:'0'.repeat(64),worker:'/unavailable/worker.py',workerSha256:'0'.repeat(64),recognizerSha256:'0'.repeat(64),model:{artifactRoot:'/unavailable',runtimeVersion:'4.12.0',modelRevision:'fixture:model',calibration:{revision:'fixture:calibration',modelRevision:'fixture:model',cosineThreshold:.7,margin:.05,detectionThreshold:.8,minFacePixels:10},detector:{path:'/unavailable/detector',bytes:1,sha256:'0'.repeat(64)},recognizer:{path:'/unavailable/recognizer',bytes:1,sha256:'0'.repeat(64)},provenanceApproved:true}}},retention:{directory:join(root,'absent-ledger'),enrollmentCurrent:()=>false,authorizeRemoval:()=>null},association:()=>null,current:()=>true,destination:()=>{calls++;return null;},setupActions:{stop:true,revoke:true}};
 const ports={database,authentication:auth,audience,configuration,current:()=>current};const presence=createDailyPresence(ports)!;
 t.after(()=>{presence.close();audience.close();database.close();rmSync(root,{recursive:true,force:true});});
 const request=async(path='/api/runtime/v1/camera-presence',body?:unknown,options:{token?:string;beforeBody?:()=>void;context?:LocalContext}={})=>{
  const req=Readable.from((async function*(){options.beforeBody?.();if(body!==undefined)yield Buffer.from(JSON.stringify(body));})()) as unknown as IncomingMessage;
  req.method=body===undefined?'GET':'POST';req.url=path;req.headers={'content-type':'application/json','x-lifestream-csrf':options.token??claimed.session.csrfToken};
  let status=0,value:any;const res=Object.assign(new EventEmitter(),{writableEnded:false,writeHead(code:number){status=code;},end(raw:string){value=JSON.parse(raw);this.writableEnded=true;}}) as unknown as ServerResponse;
  await handleDailyPresenceHttp({presence,authenticate:()=>auth.assertCurrent(options.context??context,false),csrf:(c,token)=>auth.csrf(c,token,false)},req,res,path);return {status,value};
 };
 return {root,ports,presence,request,auth,context,calls:()=>calls,retire:()=>current=false};
}

test('absent optional configuration does not inspect any owner or create a host',()=>{
 let calls=0;const ports=new Proxy({configuration:undefined},{get(target,key){if(key==='configuration')return undefined;calls++;throw Error('owner accessed');}});
 assert.equal(createDailyPresence(ports as never),null);assert.equal(calls,0);assert.equal(isDailyPresencePath('/api/runtime/v1/camera-presence/setup'),true);assert.equal(isDailyPresencePath('/api/runtime/v1/camera-presence-other'),false);
});

test('configured adapter shares audience and one qualified Initiative owner; status and setup are inert',async t=>{
 const f=await fixture(t);assert.equal(f.presence.initiative,f.presence.host.lifecycle.initiative);assert.equal((f.presence.host.lifecycle as any).ports.audience,f.ports.audience);
 assert.equal(f.calls(),0);assert.equal(existsSync(join(f.root,'absent-ledger')),false);
 const status=await f.request(),review=await f.request('/api/runtime/v1/camera-presence/setup');
 assert.equal(status.status,200);assert.equal(status.value.state,'inactive');assert.equal(status.value.physicalCapture,'notStarted');assert.equal(status.value.enrollment,'notInspected');assert.equal(status.value.recognition,'notActivated');assert.equal(review.value.state,'unavailable');assert.equal(f.calls(),0);
 f.presence.invalidate();f.presence.close();f.presence.close();assert.equal(f.calls(),0);assert.equal((await f.request()).value.state,'unavailable');
});

test('original CSRF, closed body schema and current owner gate explicit operations',async t=>{
 const f=await fixture(t),command={operation:'stop',expectedRevision:1,idempotencyKey:'fixture-command-00001'};
 await assert.rejects(f.request(undefined,command,{token:'wrong'}),e=>(e as any).status===403);
 await assert.rejects(f.request(undefined,{...command,principalId:f.context.principalId}),e=>(e as any).status===422);
 assert.equal((await f.request(undefined,command)).value.state,'stopped');assert.equal(f.calls(),0);
 f.retire();assert.equal((await f.request()).value.state,'unavailable');await assert.rejects(f.request(undefined,{...command,idempotencyKey:'fixture-command-00002'}),e=>(e as any).status===403||(e as any).status===409);assert.equal(f.calls(),0);
});

test('body-time revocation and foreign effective context cannot enter an operation',async t=>{
 const f=await fixture(t),command={operation:'stop',expectedRevision:1,idempotencyKey:'fixture-command-revoke'};
 await assert.rejects(f.request(undefined,command,{context:{...f.context,contextRef:'foreign',effectiveContext:{actorId:f.context.principalId,effectiveUserId:'foreign'} as never}}));
 await assert.rejects(f.request(undefined,command,{beforeBody:()=>f.auth.logout(f.context)}));assert.equal(f.calls(),0);
});

test('absent host still returns original closed unavailable status and review after authentication',async()=>{
 for(const path of ['/api/runtime/v1/camera-presence','/api/runtime/v1/camera-presence/setup']){
  let authenticated=0,value:any;const request=Object.assign(Readable.from([]),{url:path,method:'GET',headers:{}}) as IncomingMessage;
  const response={writeHead(code:number){assert.equal(code,200);},end(body:string){value=JSON.parse(body);}} as ServerResponse;
  await handleDailyPresenceHttp({presence:null,authenticate:()=>{authenticated++;return {} as LocalContext;},csrf:()=>{throw Error('No write');}},request,response,path);
  assert.equal(authenticated,1);assert.equal(value.state,'unavailable');assert.equal(value.configurationRevision,null);assert.equal(Object.values(value.capabilities).every(v=>v===false),true);
 }
});

test('canonical endpoint material changes and mode:none retire held custody before writes; exact no-op preserves it',async t=>{
 const f=await fixture(t),db=f.ports.database,id=f.context.sessionId;
 const first=reviseSessionEndpoint(db,id,{mode:'text',audienceScope:'unknown',expectedRevision:0},false,f.context.principalId);
 const owners=canonicalAuthSessionCustody(f.auth,db)!;assert.ok(owners);
 const capture=()=>{const ticket=capturePresenceAuthSessionCustody(owners)!;assert.ok(ticket);return ()=>matchesPresenceAuthSessionCustody(ticket,owners);};
 const noOp=capture();const same=reviseSessionEndpoint(db,id,{mode:'text',audienceScope:'unknown',expectedRevision:first.revision},false,f.context.principalId);assert.equal(same.revision,first.revision);assert.equal(noOp(),true);
 let held=capture(),writes=0;const transaction=db.transaction.bind(db);
 db.transaction=operation=>transaction(tx=>{const run=tx.run.bind(tx);tx.run=(sql,...parameters)=>{if(/^(?:INSERT OR REPLACE INTO interaction_endpoints|UPDATE sessions SET revision)/.test(sql)){writes++;assert.equal(held(),false,'custody retired before material SQL');}return run(sql,...parameters);};return operation(tx);});
 let release!:()=>void,outputs=0;const gate=new Promise<void>(r=>release=r),late=(async()=>{await gate;if(held())outputs++;})();
 const changed=reviseSessionEndpoint(db,id,{mode:'text',audienceScope:'authenticatedSession',expectedRevision:same.revision},false,f.context.principalId);assert.equal(held(),false);release();await late;assert.equal(outputs,0);assert.ok(writes>=2);
 held=capture();const ended=reviseSessionEndpoint(db,id,{mode:'none',audienceScope:'unknown',expectedRevision:changed.revision},false,f.context.principalId);assert.equal(ended.endpoint,null);assert.equal(held(),false);assert.equal(readSessionEndpoint(db,id).revision,ended.revision);
 const rejected=capture();assert.throws(()=>reviseSessionEndpoint(db,id,{mode:'text',audienceScope:'unknown',expectedRevision:changed.revision},false,f.context.principalId),/revision/);assert.equal(rejected(),true);
});

test('retained canonical profile repository publishes the R12 configuration fence before activation',async t=>{
 const f=await fixture(t),db=f.ports.database,configuration=registerCanonicalPresenceConfiguration(db);assert.ok(configuration,'real package export participates in canonical custody');
 const owners=Object.freeze(Object.fromEntries(presenceTerminalCustodyRoles.map(role=>[role,role==='configuration'?configuration:createPresenceTerminalCustodyOwner(role).handle]))) as PresenceTerminalCustodyOwners;
 const capture=()=>{const ticket=capturePresenceTerminalCustody(owners)!;assert.ok(ticket);return ()=>matchesPresenceTerminalCustody(ticket,owners);};
 const repo=new AssistantProfileRepository(db),assistantId=randomUUID(),profileId=randomUUID();const profile={schemaVersion:'2.0.0' as const,assistantId,profileId,revision:1,status:'draft' as const,corePersona:{canonicalName:'Synthetic',identityStatement:'Synthetic fixture',values:['v'],prohibitions:['p'],relationshipBoundaries:['b'],styleBoundaries:['s']},adaptivePersonaPolicy:{dimensions:[]},createdAt:'2026-09-06T00:00:00Z',createdBy:'test'};
 const draft=capture();repo.create(profile);assert.equal(draft(),true);
 const held=capture(),transaction=db.transaction.bind(db);let writes=0;
 db.transaction=operation=>transaction(tx=>{const run=tx.run.bind(tx);tx.run=(sql,...parameters)=>{if(sql.startsWith('UPDATE assistant_profiles')){writes++;assert.equal(held(),false,'configuration retired before profile SQL');}return run(sql,...parameters);};return operation(tx);});
 repo.activate(profileId,null,'human','synthetic review','2026-09-06T00:00:00Z');assert.equal(held(),false);assert.ok(writes>0);
});
