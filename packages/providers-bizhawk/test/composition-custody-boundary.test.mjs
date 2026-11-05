import {runGameObservationCommand} from '../../../apps/server/src/runtime/game-observation-deadline.ts';
import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
import {captureSupervisedGameFailure} from '../../../scripts/supervised-game-runtime.mjs';
import {nativeCustodyFixture} from './fixtures/native-custody-boundary.mjs';
// Execute the exact original composition observe method with inert ports. This
// isolates async boundary placement, not real actor/auth/engine performance.
function setup({legacy=false,slowActor=false,afterQuiescence=false,afterHandoff=false,sanityTiming}={}){
 const source=readFileSync(process.env.CT79_COMPOSITION_FILE??new URL('../../../apps/server/src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8'),a=source.indexOf('  observe:async(join,signal,afterActionId=null)=>{'),b=source.indexOf('\n  bindingFor:',a),h=source.indexOf(' const refreshSourceCustody=async signal=>'),e=source.indexOf('\n const metadata=',h);assert(a>=0&&b>a);const helper=h<0?'':source.slice(h,e),method=source.slice(a,b).replace(/,\s*$/,'');
 const f=nativeCustodyFixture(sanityTiming),events=[],frame=Buffer.from([1,2,3]),observation={scope:f.scope,observationId:randomUUID()},physical={...(legacy?{}:{refreshCustody:f.refresh}),wakePreparationReceipt:{}},configuration={maximumRunMs:80000,maximumCommandMs:captureGameSanityTiming(sanityTiming).commandRoundTripTimeoutMs,onFailure:v=>events.push(v),onNativePreparation:()=>{if(afterHandoff)f.advance(2100);},onObservation:()=>events.push('observed')};
 const deps={runGameObservationCommand,timing:captureGameSanityTiming(),physical,scope:f.scope,sourceCurrent:()=>!f.signal.aborted,configuration,current:()=>true,frameOwner:null,executionOwner:{},lifecycle:null,observeUntilFrameReviewed:options=>options.observe(),randomUUID,attach:{pinsDigest:f.pins},awaitClientQuiescence:async()=>{if(afterQuiescence)f.advance(2100);return true;},captureCtWakeHandoff:()=>({}),evidence:{frameForReview:()=>{assert.equal(f.check(),true,'Original source guard at frame capture');return {bytes:frame};}},captureCtObservationEvidence:()=>({}),reviewedScene:null,captureSupervisedGameFailure,goal:null};
 const observe=compileFunction('let waitingForFrame=false,lastObservation,wakeRequired=true,wakeJoined=false;'+helper+'return ({'+method+'}).observe;',Object.keys(deps))(...Object.values(deps));
 const join={adapter:{observe:async()=>{if(slowActor)f.advance(2001);assert.equal(f.check(),true,'Original source guard at native entry');return {outcome:{payload:{observation}}};}}};
 return {f,events,frame,observation,run:()=>observe(join,f.signal)};
}
test('composition refreshes expired custody at native entry and after original quiescence before frame capture',async()=>{
 const s=setup({afterQuiescence:true,afterHandoff:true});s.f.advance(2100);assert.equal(await s.run(),s.observation);assert.equal(s.f.calls(),3);assert.equal(s.events.includes('observed'),true);assert.deepEqual(s.frame,Buffer.alloc(3));
});
test('composition original actor work exceeding2s after refresh still refuses before native operation',async()=>{
 const s=setup({slowActor:true});s.f.advance(2100);await assert.rejects(s.run(),/Original source guard at native entry/);assert.equal(s.f.calls(),1);assert.equal(s.events.includes('observed'),false);
});
test('composition original cancellation refuses before read-only refresh',async()=>{
 const s=setup();s.f.abort();await assert.rejects(s.run(),error=>error.code==='cancelled'||error.message==='Native source refresh fenced');assert.equal(s.f.calls(),0);
});
test('composition absent optional physical port retains original observe path',async()=>{
 const s=setup({legacy:true});assert.equal(await s.run(),s.observation);assert.equal(s.f.calls(),0);assert.equal(s.events.includes('observed'),true);
});

test('original owner native options bind exact fixed refresh after supplied option spread',()=>{
 const text=readFileSync(process.env.CT79_NATIVE_OWNER_FILE??new URL('../src/owned-c72-native.ts',import.meta.url),'utf8'),a=text.search(/const native\s*=\s*\{\s*\.\.\.options.native/),b=text.indexOf(';',a);assert(a>=0&&b>a);const selected=text.slice(a,b),fixed=()=>{},supplied=()=>{};
 const deps={timing:captureGameSanityTiming(),options:{native:{refreshSourceCustody:supplied}},refreshCustody:fixed,facts:{},secret:Buffer.alloc(0),launch:{port:1},scope:{},pins:'a'.repeat(64),boundary:{},evidence:{admitRelease:()=>false},ownedFailure:()=>{}};
 const native=compileFunction(stripTypeScriptTypes(selected,{mode:'strip'})+';return native;',Object.keys(deps))(...Object.values(deps));assert.equal(native.refreshSourceCustody,fixed);assert.notEqual(native.refreshSourceCustody,supplied);
});

test('age-only stale healthy custody past30s refreshes through original composition before native entry',async()=>{
 const s=setup({sanityTiming:{}});s.f.advance(31000);assert.equal(s.f.check(),false,'full custody proof is stale');assert.equal(await s.run(),s.observation);assert(s.f.calls()>=1);assert.equal(s.f.check(),true);assert(s.events.includes('observed'));
});
