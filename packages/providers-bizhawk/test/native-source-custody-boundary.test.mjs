import test from 'node:test';
import assert from 'node:assert/strict';
import {Duplex,PassThrough} from 'node:stream';
import {createHmac,randomUUID} from 'node:crypto';
import {gameCampaignFixture} from '../../runtime/test/fixtures/game-campaign.ts';
import {nativeCustodyFixture} from './fixtures/native-custody-boundary.mjs';
const {createAuthenticatedGameTransport,GameControlFrameDecoder,encodeGameControlFrame}=await import(process.env.CT79_TRANSPORT_MODULE??new URL('../src/transport.ts',import.meta.url));
function setup(t,options={}){
 const f=nativeCustodyFixture(),a=new PassThrough(),b=new PassThrough(),host=Duplex.from({readable:a,writable:b}),peer=Duplex.from({readable:b,writable:a}),secret=Buffer.alloc(32,23),scope=gameCampaignFixture().input.observation.scope,messages=[],waiting=[];let decoded=0;
 const decoder=new GameControlFrameDecoder(text=>{const value=JSON.parse(text);if(value.type==='challenge')peer.write(encodeGameControlFrame(JSON.stringify({type:'authenticate',proof:createHmac('sha256',secret).update(JSON.stringify(value)).digest('hex')})));else if(value.type!=='authenticated'){const next=waiting.shift();if(next)next(value);else messages.push(value);}});peer.on('data',data=>decoder.push(data));peer.on('error',()=>{});
 const transport=createAuthenticatedGameTransport(host,{pairingSecret:secret,scope,pinsDigest:'a'.repeat(64),authenticationTimeoutMs:500,sessionDurationMs:10000,boundary:{providerRef:'scripted-peer',maxDurationMs:3000,sourceAvailable:()=>f.check(),acceptObservation:()=>true},onDisconnect:()=>{},refreshSourceCustody:signal=>f.refresh(signal),enrichObservation:(_r,o)=>{decoded++;assert.equal(f.check(),true,'Original2s guard before enrichment');return o;},...options});
 t.after(()=>{transport.close();host.destroy();peer.destroy();});
 const request=()=>({schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+3000).toISOString(),cancellationId:randomUUID(),executionMode:'simulation',scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:'a'.repeat(64),afterActionId:null,maxScreenshots:1}});
 const reply=r=>{const o=gameCampaignFixture().input.observation;o.scope=scope;return {schemaVersion:'1.0.0',operation:r.operation,requestId:r.requestId,correlationId:r.correlationId,providerRef:'scripted-peer',completedAt:new Date().toISOString(),outcome:{status:'succeeded',error:null,payload:{observation:o,reconciledAction:null}}};};
 return {f,transport,peer,request,reply,next:()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiting.push(resolve)),decoded:()=>decoded};
}
test('delayed original wire result refreshes exact custody before first unchanged decoder source guard',async t=>{
 const s=setup(t);await s.transport.ready;const request=s.request(),pending=s.transport.adapter.observe(request,{signal:s.f.signal,isCurrent:()=>s.f.check()}),sent=await s.next();s.f.advance(2100);assert.equal(s.f.now()-s.f.inspection(),2100);s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));const result=await pending;assert.equal(result.requestId,request.requestId);assert.equal(s.f.calls(),1);assert.equal(s.decoded(),1);assert.equal(s.f.check(),true);assert.equal(s.transport.isQuiescent(),true);
});
test('pending exact refresh remains nonquiescent and uses original signal until it settles',async t=>{
 const s=setup(t);await s.transport.ready;const pending=s.transport.adapter.observe(s.request(),{signal:s.f.signal,isCurrent:()=>true}),sent=await s.next();s.f.advance(2100);s.f.hold();s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));for(let i=0;i<12;i++)await Promise.resolve();assert.equal(s.transport.isQuiescent(),false);assert.equal(s.decoded(),0);s.f.release();await pending;assert.equal(s.transport.isQuiescent(),true);
});
test('cancelled original request and late refresh cannot decode or accept a native observation',async t=>{
 const s=setup(t);await s.transport.ready;const pending=s.transport.adapter.observe(s.request(),{signal:s.f.signal,isCurrent:()=>true});void pending.catch(()=>{});const sent=await s.next();s.f.advance(2100);s.f.hold();s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));for(let i=0;i<12;i++)await Promise.resolve();s.f.abort();await assert.rejects(pending);assert.equal(s.transport.isQuiescent(),false,'Late refresh is still tracked after request cancellation');s.f.release();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(s.decoded(),0);assert.equal(s.f.inspection()<s.f.now(),true);
});
test('original deadline after refresh refuses before enrichment without replacing request horizon',async t=>{
 let refreshed=0;const s=setup(t,{refreshSourceCustody:async()=>{refreshed++;t.mock.method(Date,'now',()=>Date.parse(request.deadlineAt)+1);}});await s.transport.ready;const request=s.request(),pending=s.transport.adapter.observe(request,{signal:s.f.signal,isCurrent:()=>true}),sent=await s.next();s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));await assert.rejects(pending);assert.equal(refreshed,1);assert.equal(s.decoded(),0);
});
test('changed source during exact refresh remains denied, never decoder admission',async t=>{
 const s=setup(t);await s.transport.ready;const pending=s.transport.adapter.observe(s.request(),{signal:s.f.signal,isCurrent:()=>true});void pending.catch(()=>{});const sent=await s.next();s.f.advance(2100);s.f.hold();s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));for(let i=0;i<12;i++)await Promise.resolve();s.f.withdraw();s.f.release();await assert.rejects(pending);assert.equal(s.decoded(),0);assert.deepEqual(s.f.ownerFailures,[{stage:'inspect-poll',predicate:'installation_current',exceptionClass:'Error'}]);
});
test('slow original context work after refresh still refuses the unchanged2s guard',async t=>{
 const s=setup(t);await s.transport.ready;let late=false;const pending=s.transport.adapter.observe(s.request(),{signal:s.f.signal,isCurrent:()=>{if(late){late=false;s.f.advance(2001);}return true;}}),sent=await s.next();s.f.advance(2100);late=true;s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));await assert.rejects(pending);assert.equal(s.f.calls(),1);assert.equal(s.decoded(),1);assert.equal(s.f.check(),false);
});
test('nonfunction optional refresh is refused at original transport construction',t=>{assert.throws(()=>setup(t,{refreshSourceCustody:true}));});

test('withdrawn original context after wire refresh denies before enrichment',async t=>{
 const s=setup(t);await s.transport.ready;let available=true;const pending=s.transport.adapter.observe(s.request(),{signal:s.f.signal,isCurrent:()=>available}),sent=await s.next();s.f.advance(2100);available=false;s.peer.write(encodeGameControlFrame(JSON.stringify(s.reply(sent))));await assert.rejects(pending);assert.equal(s.f.calls(),1);assert.equal(s.decoded(),0);
});
