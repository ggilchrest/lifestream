import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PwceGatewayClient } from '../packages/providers-pwce/src/client.ts';
import { PwceTrustedDispatchClient } from '../packages/providers-pwce/src/dispatch.ts';
import { PWCE_DISPATCH_REQUEST_SCHEMA, PWCE_DISPATCH_RESPONSE_SCHEMA } from '../packages/providers-pwce/src/dispatch-bundle.ts';
const producer=resolve(process.env.PWCE_PRODUCER_ROOT ?? '../PWCE'), token=randomBytes(24).toString('hex'), dispatcherToken=randomBytes(24).toString('hex');
const host=spawn(process.execPath,['scripts/gateway-dispatch-fixture.mjs'],{cwd:producer,env:{PATH:process.env.PATH,PWCE_FIXTURE_TOKEN:token,PWCE_FIXTURE_DISPATCHER_TOKEN:dispatcherToken},stdio:['pipe','pipe','pipe']});
const exit=once(host,'exit'), lines=createInterface({input:host.stdout}), iterator=lines[Symbol.asyncIterator]();let stderr='';
host.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)host.kill('SIGTERM');});
async function readLine(){let timer;try { const item=await Promise.race([iterator.next(),exit.then(()=>{throw new Error('synthetic producer exited');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic producer response deadline exceeded')),10000);})]);assert.equal(item.done,false);assert.ok(item.value.length<4096);return JSON.parse(item.value); }finally{clearTimeout(timer);}}
async function stats(){host.stdin.write('stats\n');const result=await readLine();assert.equal(result.fixtureStats,true);return result.calls;}
const ajv=new Ajv2020({strict:false});addFormats(ajv);const validateRequest=ajv.compile(PWCE_DISPATCH_REQUEST_SCHEMA),validateResponse=ajv.compile(PWCE_DISPATCH_RESPONSE_SCHEMA);
let calls=0, wireCalls=0;
try {
 const ready=await readLine();assert.equal(ready.fixture,true);assert.equal(ready.liveEffects,false);assert.equal(ready.scenario,'trusted-dispatch');
 const url=new URL(ready.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
 const core=new PwceGatewayClient({baseUrl:ready.url,token});
 let discardReply=false;
 const client=new PwceTrustedDispatchClient({baseUrl:ready.url,token,dispatcherToken,fetchImpl:async (url,init)=>{
  const action=String(url).endsWith('/gateway/v1/dispatch');if(action){wireCalls++;assert.ok(validateRequest(JSON.parse(init.body)),JSON.stringify(validateRequest.errors));}
  const response=await fetch(url,init);
  if(action&&discardReply){discardReply=false;await response.arrayBuffer();throw new Error('synthetic discarded completed HTTP reply');}
  return response;
 }});
 const identity={assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'};
 const authority=await core.authority(['home.one'],undefined,identity);
 const scope={...identity,worldRef:'world.personal.v1',executionEnvironmentRef:'test'};
 const snapshot=await core.request({...scope,authorityContextRef:authority.authorityContextRef,operation:'capabilities.getSnapshot'});
 const input={...scope,requestId:randomUUID(),correlationId:randomUUID(),deadline:new Date(Date.now()+30_000).toISOString(),snapshotRef:snapshot.snapshotRef,capabilityRef:'home.light.set_level',capabilityVersion:'1.0.0',capabilityOperation:'light.set_level',siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5},idempotencyKey:randomUUID(),approvalRequired:false,approvalRef:null};
 const admitted=await client.authorizeDispatch(authority.authorityContextRef,input);assert.ok(validateResponse(admitted),JSON.stringify(validateResponse.errors));assert.equal(admitted.status,'admitted');assert.equal(await stats(),0);calls++;
 const duplicate=await client.authorizeDispatch(authority.authorityContextRef,input);assert.equal(duplicate.actionRef,admitted.actionRef);assert.equal(duplicate.duplicate,true);assert.equal(await stats(),0);calls++;
 const command={...input,actionRef:admitted.actionRef};discardReply=true;
 await assert.rejects(client.invoke(authority.authorityContextRef,command),{code:'unavailable'});assert.equal(await stats(),1);calls++;
 const completed=await client.invoke(authority.authorityContextRef,command);assert.ok(validateResponse(completed),JSON.stringify(validateResponse.errors));assert.equal(completed.status,'completed');assert.equal(await stats(),1);calls++;
 const recovered=await core.request({...scope,authorityContextRef:authority.authorityContextRef,operation:'capabilities.getInvocation',actionRef:admitted.actionRef});assert.equal(recovered.action.status,'succeeded');assert.equal(recovered.action.idempotencyKey,input.idempotencyKey);calls++;
 const unknownInput={...input,requestId:randomUUID(),idempotencyKey:randomUUID(),targetEntityId:'light.unknown'};
 const unknownAdmission=await client.authorizeDispatch(authority.authorityContextRef,unknownInput);
 const unknownCommand={...unknownInput,actionRef:unknownAdmission.actionRef};
 for(let i=0;i<2;i++){const reply=await client.invoke(authority.authorityContextRef,unknownCommand);assert.ok(validateResponse(reply),JSON.stringify(validateResponse.errors));assert.equal(reply.status,'outcome_unknown');}assert.equal(await stats(),2);calls++;
 const pendingInput={...input,requestId:randomUUID(),idempotencyKey:randomUUID()};const pending=await client.authorizeDispatch(authority.authorityContextRef,pendingInput);
 host.stdin.write('revoke\n');assert.equal((await readLine()).revoked,true);
 await assert.rejects(client.invoke(authority.authorityContextRef,{...pendingInput,actionRef:pending.actionRef}),{code:'authority_context_invalidated'});assert.equal(await stats(),2);calls++;
 console.log(JSON.stringify({checks:calls,wireCalls,targetCalls:2,fixtures:true,scope:'separate-process pinned dispatch transport; no canonical adapter, real effects or Human acceptance'}));
}finally{
 host.stdin.end('stop\n');let timer;
 try{await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(()=>{host.kill('SIGTERM');resolve();},3000);})]);}finally{clearTimeout(timer);lines.close();}
 assert.ok(!stderr.includes(token)&&!stderr.includes(dispatcherToken),'synthetic credentials must not appear in producer diagnostics');
 if(stderr)process.stderr.write(stderr);
}
